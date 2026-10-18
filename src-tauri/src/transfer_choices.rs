use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Overwrite,
    Skip,
    KeepBoth,
    Cancel,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub token: String,
    pub source: String,
    pub destination: String,
    pub source_directory: bool,
    pub target_directory: bool,
    pub can_overwrite: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub token: String,
    pub action: Choice,
    pub apply_all: bool,
}
#[derive(Default)]
struct Pending {
    prompt: Option<Prompt>,
    answer: Option<Decision>,
}
#[derive(Default)]
pub struct Exchange {
    pending: Mutex<Pending>,
    changed: Condvar,
    defaults: Mutex<HashMap<(bool, bool), Choice>>,
}
#[derive(Default)]
pub struct Broker {
    slots: Mutex<HashMap<String, (String, Arc<Exchange>)>>,
}
pub struct Operation {
    broker: Arc<Broker>,
    id: String,
    pub exchange: Arc<Exchange>,
}
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut slots) = self.broker.slots.lock() {
            if slots
                .get(&self.id)
                .is_some_and(|(_, v)| Arc::ptr_eq(v, &self.exchange))
            {
                slots.remove(&self.id);
            }
        }
    }
}
impl Broker {
    pub fn begin(self: &Arc<Self>, id: &str, owner: &str) -> Result<Operation, String> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "Transfer choice lock failed")?;
        if slots.len() >= 16 || slots.contains_key(id) {
            return Err("Transfer choice operation already exists or limit reached".into());
        }
        let exchange = Arc::new(Exchange::default());
        slots.insert(id.into(), (owner.into(), exchange.clone()));
        Ok(Operation {
            broker: self.clone(),
            id: id.into(),
            exchange,
        })
    }
    fn slot(&self, id: &str, owner: &str) -> Result<Option<Arc<Exchange>>, String> {
        let slots = self
            .slots
            .lock()
            .map_err(|_| "Transfer choice lock failed")?;
        match slots.get(id) {
            Some((label, v)) if label == owner => Ok(Some(v.clone())),
            Some(_) => Err("Transfer belongs to another window".into()),
            None => Ok(None),
        }
    }
    pub fn pending(&self, id: &str, owner: &str) -> Result<Option<Prompt>, String> {
        let Some(slot) = self.slot(id, owner)? else {
            return Ok(None);
        };
        let p = slot
            .pending
            .lock()
            .map_err(|_| "Transfer choice lock failed")?;
        Ok(p.prompt.clone())
    }
    pub fn choose(&self, id: &str, owner: &str, decision: Decision) -> Result<(), String> {
        let slot = self.slot(id, owner)?.ok_or("Transfer no longer waiting")?;
        let mut p = slot
            .pending
            .lock()
            .map_err(|_| "Transfer choice lock failed")?;
        let prompt = p.prompt.as_ref().ok_or("Transfer no longer waiting")?;
        if prompt.token != decision.token
            || p.answer.is_some()
            || decision.action == Choice::Overwrite && !prompt.can_overwrite
        {
            return Err("Stale or unsupported conflict choice".into());
        }
        p.answer = Some(decision);
        slot.changed.notify_all();
        Ok(())
    }
}
impl Exchange {
    #[cfg(test)]
    pub fn test_policy(choice: Choice) -> Self {
        let value = Self::default();
        for a in [false, true] {
            for b in [false, true] {
                value.defaults.lock().unwrap().insert((a, b), choice);
            }
        }
        value
    }
    pub fn ask(
        &self,
        source: &str,
        destination: &str,
        source_directory: bool,
        target_directory: bool,
        stop: &AtomicBool,
    ) -> Result<Choice, String> {
        crate::file_ops::check(stop)?;
        if let Some(choice) = self
            .defaults
            .lock()
            .map_err(|_| "Transfer choice lock failed")?
            .get(&(source_directory, target_directory))
            .copied()
        {
            if choice == Choice::Cancel {
                stop.store(true, Ordering::SeqCst);
                return Err("Transfer cancelled".into());
            }
            return Ok(choice);
        }
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| "Transfer token unavailable")?;
        let token = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let mut p = self
            .pending
            .lock()
            .map_err(|_| "Transfer choice lock failed")?;
        if p.prompt.is_some() {
            return Err("Transfer already awaiting a choice".into());
        }
        p.prompt = Some(Prompt {
            token,
            source: source.into(),
            destination: destination.into(),
            source_directory,
            target_directory,
            can_overwrite: !source_directory && !target_directory,
        });
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
                p.prompt = None;
                p.answer = None;
                return Err("Transfer cancelled or confirmation expired".into());
            }
            if let Some(answer) = p.answer.take() {
                p.prompt = None;
                if answer.action == Choice::Cancel {
                    stop.store(true, Ordering::SeqCst);
                    return Err("Transfer cancelled".into());
                }
                if answer.apply_all {
                    self.defaults
                        .lock()
                        .map_err(|_| "Transfer choice lock failed")?
                        .insert((source_directory, target_directory), answer.action);
                }
                return Ok(answer.action);
            }
            p = self
                .changed
                .wait_timeout(p, Duration::from_millis(100))
                .map_err(|_| "Transfer choice lock failed")?
                .0;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[test]
    fn prompts_are_owner_scoped_and_stale_or_type_unsafe_answers_rejected() {
        let broker = Arc::new(Broker::default());
        let operation = broker.begin("id", "window-a").unwrap();
        let exchange = operation.exchange.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker =
            std::thread::spawn(move || exchange.ask("/source", "/dest", true, false, &stop));
        let prompt = loop {
            if let Some(p) = broker.pending("id", "window-a").unwrap() {
                break p;
            }
            std::thread::yield_now();
        };
        assert!(broker.pending("id", "window-b").is_err());
        assert!(broker
            .choose(
                "id",
                "window-a",
                Decision {
                    token: "stale".into(),
                    action: Choice::Skip,
                    apply_all: false
                }
            )
            .is_err());
        assert!(broker
            .choose(
                "id",
                "window-a",
                Decision {
                    token: prompt.token.clone(),
                    action: Choice::Overwrite,
                    apply_all: true
                }
            )
            .is_err());
        broker
            .choose(
                "id",
                "window-a",
                Decision {
                    token: prompt.token,
                    action: Choice::KeepBoth,
                    apply_all: true,
                },
            )
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), Choice::KeepBoth);
        drop(operation);
        assert!(broker.pending("id", "window-a").unwrap().is_none());
    }
    #[test]
    fn cancel_policy_marks_stop_and_never_returns_a_write_choice() {
        let exchange = Exchange::test_policy(Choice::Cancel);
        let stop = AtomicBool::new(false);
        assert!(exchange.ask("/s", "/d", false, false, &stop).is_err());
        assert!(stop.load(Ordering::SeqCst));
    }
    #[test]
    fn cancellation_and_scope_release_do_not_wait_for_frontend() {
        let broker = Arc::new(Broker::default());
        let operation = broker.begin("id", "window").unwrap();
        let exchange = operation.exchange.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker =
            std::thread::spawn(move || exchange.ask("/s", "/d", false, false, &worker_stop));
        while broker.pending("id", "window").unwrap().is_none() {
            std::thread::yield_now();
        }
        stop.store(true, Ordering::SeqCst);
        assert!(worker.join().unwrap().is_err());
        drop(operation);
        assert!(broker.begin("id", "window").is_ok());
    }
    #[test]
    fn apply_all_is_limited_to_one_operation_and_type_pair() {
        let broker = Arc::new(Broker::default());
        let operation = broker.begin("a", "window").unwrap();
        let exchange = operation.exchange.clone();
        let worker = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            assert_eq!(
                exchange.ask("/s", "/d", false, false, &stop).unwrap(),
                Choice::Skip
            );
            assert_eq!(
                exchange.ask("/s2", "/d2", false, false, &stop).unwrap(),
                Choice::Skip
            );
        });
        let p = loop {
            if let Some(p) = broker.pending("a", "window").unwrap() {
                break p;
            }
            std::thread::yield_now();
        };
        broker
            .choose(
                "a",
                "window",
                Decision {
                    token: p.token,
                    action: Choice::Skip,
                    apply_all: true,
                },
            )
            .unwrap();
        worker.join().unwrap();
        drop(operation);
        let other = broker.begin("b", "window").unwrap();
        assert!(other.exchange.defaults.lock().unwrap().is_empty());
    }
}
