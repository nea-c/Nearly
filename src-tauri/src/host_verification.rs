use crate::sftp::{ObservedHostKey, Profile};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(120);
const MAX_WORKERS: usize = 16;
const MAX_ENTRIES: usize = 128;

pub fn endpoint(profile: &Profile) -> Result<String, String> {
    let host = profile.host.trim();
    if host.is_empty()
        || host.len() > 1024
        || host.chars().any(|c| c.is_control() || c.is_whitespace())
        || profile.port == 0
    {
        return Err("A valid host and port are required for host-key verification".into());
    }
    serde_json::to_string(&(host.to_ascii_lowercase(), profile.port))
        .map_err(|_| "Cannot identify server endpoint".into())
}
fn request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Invalid host-key request id".into());
    }
    Ok(())
}
fn snapshot(profile: &Profile) -> Result<String, String> {
    endpoint(profile)?;
    let value = serde_json::to_string(profile).map_err(|_| "Cannot snapshot host-key target")?;
    if value.len() > 16384 {
        return Err("Host-key target profile is too large".into());
    }
    Ok(value)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub request_id: String,
    pub token: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub expires_in_seconds: u64,
}
#[derive(Default)]
pub struct HostVerification {
    state: Mutex<State>,
    changed: Condvar,
}
#[derive(Default)]
struct State {
    closing: bool,
    workers: usize,
    entries: HashMap<String, Entry>,
}
struct Entry {
    snapshot: String,
    stop: Arc<AtomicBool>,
    candidate: Option<Candidate>,
    expires: Instant,
}
impl State {
    fn prune(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, entry| {
            if entry.expires <= now {
                entry.stop.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
    }
}
pub struct Probe {
    owner: Arc<HostVerification>,
    id: String,
    profile: Profile,
    stop: Arc<AtomicBool>,
    installed: bool,
}
impl HostVerification {
    pub fn request_pending(&self,id:&str)->Result<bool,String>{let mut state=self.state.lock().map_err(|_|"Host verification lock failed")?;state.prune();Ok(state.entries.get(id).is_some_and(|e|e.candidate.is_none()&&!e.stop.load(Ordering::SeqCst)))}
    // The IPC owner must additionally check the authoritative endpoint ledger
    // under its settings mutex, both before begin and before approval.
    pub fn begin(self: &Arc<Self>, id: &str, profile: &Profile) -> Result<Probe, String> {
        request_id(id)?;
        if !profile.host_key.trim().is_empty() {
            return Err("A pinned server must use strict verification; initial approval cannot replace a saved key".into());
        }
        if profile.auth != "key" || profile.mode != "sftp" {
            return Err("Host-key approval is available for SFTP key profiles".into());
        }
        let snapshot = snapshot(profile)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host-key state unavailable")?;
        state.prune();
        if state.closing {
            return Err("Application closing".into());
        }
        if state.workers >= MAX_WORKERS || state.entries.len() >= MAX_ENTRIES {
            return Err(
                "Host-key verification capacity reached; wait for pending requests to expire"
                    .into(),
            );
        }
        if state.entries.contains_key(id) {
            return Err("Host-key request was cancelled, consumed, or already started; use a new request id".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        state.entries.insert(
            id.into(),
            Entry {
                snapshot,
                stop: stop.clone(),
                candidate: None,
                expires: Instant::now() + TTL,
            },
        );
        state.workers += 1;
        Ok(Probe {
            owner: self.clone(),
            id: id.into(),
            profile: profile.clone(),
            stop,
            installed: false,
        })
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        request_id(id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host-key state unavailable")?;
        state.prune();
        if state.closing {
            return Ok(());
        }
        if let Some(entry) = state.entries.get_mut(id) {
            entry.stop.store(true, Ordering::SeqCst);
            entry.candidate = None;
            entry.expires = Instant::now() + TTL;
        } else {
            if state.entries.len() >= MAX_ENTRIES {
                return Err("Host-key cancellation capacity reached".into());
            }
            // A cancel can arrive before the async probe command is dispatched.
            state.entries.insert(
                id.into(),
                Entry {
                    snapshot: String::new(),
                    stop: Arc::new(AtomicBool::new(true)),
                    candidate: None,
                    expires: Instant::now() + TTL,
                },
            );
        }
        Ok(())
    }
    pub fn approve<F>(
        &self,
        id: &str,
        token: &str,
        profile: &Profile,
        persist: F,
    ) -> Result<Profile, String>
    where
        F: FnOnce(&Profile) -> Result<(), String>,
    {
        request_id(id)?;
        let expected = snapshot(profile)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host-key state unavailable")?;
        state.prune();
        if state.closing {
            return Err("Application closing".into());
        }
        let entry = state
            .entries
            .get_mut(id)
            .ok_or("Host-key candidate expired or was cancelled; probe again")?;
        if entry.stop.load(Ordering::SeqCst) || entry.snapshot != expected {
            return Err(
                "Host-key candidate no longer matches this profile or was cancelled".into(),
            );
        }
        let candidate = entry
            .candidate
            .as_ref()
            .ok_or("Host-key probe has not produced a candidate")?;
        if candidate.token != token {
            return Err("Host-key approval token does not match".into());
        }
        let mut approved = profile.clone();
        approved.host_key = candidate.fingerprint.clone();
        // Consume atomically, even if persistence fails. The settings owner
        // writes trusted state before returning; failed requests must re-probe.
        entry.candidate = None;
        entry.stop.store(true, Ordering::SeqCst);
        entry.expires = Instant::now() + TTL;
        persist(&approved)?;
        Ok(approved)
    }
    pub fn try_begin_close<F>(&self, check: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host-key state unavailable")?;
        if state.closing {
            return Err("Application closing".into());
        }
        if state.workers != 0 {
            return Err("Host-key verification is still running. Cancel it and wait for completion before closing".into());
        }
        check()?;
        state.closing = true;
        for entry in state.entries.values() {
            entry.stop.store(true, Ordering::SeqCst);
        }
        state.entries.clear();
        Ok(())
    }
    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        state.closing = true;
        for entry in state.entries.values() {
            entry.stop.store(true, Ordering::SeqCst);
        }
        while state.workers != 0 {
            state = self.changed.wait(state).unwrap();
        }
        state.entries.clear();
    }
}
impl Probe {
    pub fn profile(&self) -> &Profile {
        &self.profile
    }
    pub fn stop(&self) -> &AtomicBool {
        &self.stop
    }
    pub fn finish(mut self, observed: ObservedHostKey) -> Result<Candidate, String> {
        let fingerprint = crate::sftp::canonical_fingerprint(&observed.fingerprint)?;
        if observed.algorithm.is_empty() || observed.algorithm.len() > 128 {
            return Err("Unsupported server host-key algorithm".into());
        }
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "Secure host-key token generation failed")?;
        let candidate = Candidate {
            request_id: self.id.clone(),
            token: random.iter().map(|b| format!("{b:02x}")).collect(),
            host: self.profile.host.clone(),
            port: self.profile.port,
            algorithm: observed.algorithm,
            fingerprint,
            expires_in_seconds: TTL.as_secs(),
        };
        {
            let mut state = self
                .owner
                .state
                .lock()
                .map_err(|_| "Host-key state unavailable")?;
            state.prune();
            if state.closing || self.stop.load(Ordering::SeqCst) {
                return Err("Host-key probe cancelled or application closing".into());
            }
            let entry = state
                .entries
                .get_mut(&self.id)
                .ok_or("Host-key request expired")?;
            if !Arc::ptr_eq(&entry.stop, &self.stop) || entry.candidate.is_some() {
                return Err("Host-key request no longer active".into());
            }
            entry.candidate = Some(candidate.clone());
            entry.expires = Instant::now() + TTL;
            self.installed = true;
        }
        Ok(candidate)
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        let mut state = self.owner.state.lock().unwrap();
        if !self.installed {
            if let Some(entry) = state.entries.get_mut(&self.id) {
                if Arc::ptr_eq(&entry.stop, &self.stop) {
                    entry.stop.store(true, Ordering::SeqCst);
                    entry.candidate = None;
                    entry.expires = Instant::now() + TTL;
                }
            }
        }
        state.workers = state.workers.saturating_sub(1);
        self.owner.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            id: "generated".into(),
            name: "Generated only".into(),
            host: "LOCALHOST".into(),
            port: 2222,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: "must-not-be-opened.ppk".into(),
            host_key: String::new(),
        }
    }
    fn observed() -> crate::sftp::ObservedHostKey {
        crate::sftp::ObservedHostKey {
            algorithm: "ssh-ed25519".into(),
            fingerprint: format!("SHA256:{}", "A".repeat(43)),
        }
    }
    #[test]
    fn candidate_is_frozen_one_use_and_persisted_before_returning() {
        let manager = Arc::new(HostVerification::default());
        let p = profile();
        let candidate = manager
            .begin("request-a", &p)
            .unwrap()
            .finish(observed())
            .unwrap();
        assert_eq!(candidate.host, p.host);
        assert_eq!(candidate.port, p.port);
        assert!(candidate.token.len() >= 32);
        let mut edited = p.clone();
        edited.user = "other".into();
        assert!(manager
            .approve("request-a", &candidate.token, &edited, |_| panic!(
                "must not persist changed target"
            ))
            .is_err());
        assert!(manager
            .approve("request-a", "wrong-token", &p, |_| panic!(
                "must not persist invalid token"
            ))
            .is_err());
        let mut persisted = false;
        let approved = manager
            .approve("request-a", &candidate.token, &p, |approved| {
                persisted = true;
                assert_eq!(approved.host_key, observed().fingerprint);
                Ok(())
            })
            .unwrap();
        assert!(persisted);
        assert_eq!(approved.user, p.user);
        assert!(manager
            .approve("request-a", &candidate.token, &p, |_| panic!(
                "replayed token"
            ))
            .is_err());
    }
    #[test]
    fn early_cancel_late_completion_and_expired_candidates_cannot_approve() {
        let manager = Arc::new(HostVerification::default());
        let p = profile();
        manager.cancel("early").unwrap();
        assert!(manager.begin("early", &p).is_err());
        let probe = manager.begin("late", &p).unwrap();
        manager.cancel("late").unwrap();
        assert!(probe.stop().load(Ordering::SeqCst));
        assert!(probe.finish(observed()).is_err());
        let c = manager
            .begin("expired", &p)
            .unwrap()
            .finish(observed())
            .unwrap();
        manager
            .state
            .lock()
            .unwrap()
            .entries
            .get_mut("expired")
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert!(manager
            .approve("expired", &c.token, &p, |_| panic!("expired approval"))
            .is_err());
    }
    #[test]
    fn failed_persistence_consumes_candidate_without_claiming_success() {
        let manager = Arc::new(HostVerification::default());
        let p = profile();
        let c = manager
            .begin("failed-save", &p)
            .unwrap()
            .finish(observed())
            .unwrap();
        assert!(manager
            .approve("failed-save", &c.token, &p, |_| Err(
                "generated write failure".into()
            ))
            .err()
            .unwrap()
            .contains("write failure"));
        assert!(manager
            .approve("failed-save", &c.token, &p, |_| panic!("replay"))
            .is_err());
        assert!(manager.begin("new-probe", &p).is_ok());
    }
    #[test]
    fn workers_and_history_are_bounded_and_close_cancels_only_owned_probes() {
        let manager = Arc::new(HostVerification::default());
        let p = profile();
        let probes: Vec<_> = (0..16)
            .map(|i| manager.begin(&format!("owned-{i}"), &p).unwrap())
            .collect();
        assert!(manager.begin("overflow", &p).is_err());
        assert!(manager.try_begin_close(|| Ok(())).is_err());
        assert!(probes.iter().all(|p| !p.stop().load(Ordering::SeqCst)));
        for i in 0..16 {
            manager.cancel(&format!("owned-{i}")).unwrap();
        }
        assert!(probes.iter().all(|p| p.stop().load(Ordering::SeqCst)));
        drop(probes);
        assert!(manager
            .try_begin_close(|| Err("engine busy".into()))
            .is_err());
        assert!(manager.begin("still-open", &p).is_ok());
        assert!(manager.try_begin_close(|| Ok(())).is_ok());
        assert!(manager.begin("after-close", &p).is_err());
        manager.shutdown();
    }
    #[test]
    fn endpoint_scope_is_server_not_username_and_pinned_profile_cannot_probe() {
        let mut p = profile();
        let mut other = p.clone();
        other.host = " localhost ".into();
        other.user = "other".into();
        assert_eq!(endpoint(&p).unwrap(), endpoint(&other).unwrap());
        assert_eq!(endpoint(&p).unwrap(), "[\"localhost\",2222]");
        p.host_key = observed().fingerprint;
        assert!(Arc::new(HostVerification::default())
            .begin("pinned", &p)
            .is_err());
    }
    #[test]
    fn cancellation_is_request_local_and_recent_request_history_is_bounded() {
        let manager = Arc::new(HostVerification::default());
        let p = profile();
        let a = manager.begin("a", &p).unwrap();
        let b = manager.begin("b", &p).unwrap();
        manager.cancel("a").unwrap();
        assert!(a.finish(observed()).is_err());
        let candidate = b.finish(observed()).unwrap();
        assert!(manager
            .approve("b", &candidate.token, &p, |_| Ok(()))
            .is_ok());
        for i in 0..126 {
            manager.cancel(&format!("cancelled-{i}")).unwrap();
        }
        assert_eq!(manager.state.lock().unwrap().entries.len(), 128);
        assert!(manager.cancel("overflow").is_err());
        assert!(manager.begin("new-overflow", &p).is_err());
        for entry in manager.state.lock().unwrap().entries.values_mut() {
            entry.expires = Instant::now() - Duration::from_secs(1);
        }
        assert!(manager.begin("after-expiration", &p).is_ok());
    }
    #[test]
    fn shutdown_cancels_and_waits_for_probe_worker_cleanup() {
        let manager = Arc::new(HostVerification::default());
        let p = profile();
        let probe = manager.begin("shutdown", &p).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let closing = manager.clone();
        let worker = std::thread::spawn(move || {
            closing.shutdown();
            tx.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !probe.stop().load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(probe.stop().load(Ordering::SeqCst));
        assert!(
            rx.try_recv().is_err(),
            "Shutdown must wait until the transport lease is dropped"
        );
        drop(probe);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert!(manager.begin("after-shutdown", &p).is_err());
    }
}
