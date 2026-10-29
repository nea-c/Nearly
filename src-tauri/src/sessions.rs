use crate::sftp::{Entry, Profile};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};
use zeroize::Zeroizing;

const MAX_SESSIONS: usize = 16;
const MAX_USERS: usize = 16;
#[derive(Default)]
pub struct Sessions {
    state: Mutex<State>,
    changed: Condvar,
}
#[derive(Default)]
struct State {
    closing: bool,
    slots: HashMap<String, Slot>,
    users: usize,
}
#[derive(PartialEq)]
enum Phase {
    Prepared,
    Connecting,
    Connected,
}
struct Slot {
    stop: Arc<AtomicBool>,
    phase: Phase,
    credentials: Option<Arc<Credentials>>,
    users: usize,
    connecting: usize,
    linked: Vec<std::sync::Weak<AtomicBool>>,
}
struct Credentials {
    browse: crate::browse_transport::BrowseTransport<crate::sftp::Connection>,
    profile: Profile,
    secret: Zeroizing<String>,
}
pub struct Lease {
    owner: Arc<Sessions>,
    id: String,
    stop: Arc<AtomicBool>,
    credentials: Option<Arc<Credentials>>,
    initial: bool,
    installed: bool,
    connection_attempt: bool,
}
#[derive(Serialize)]
pub struct Connected {
    pub path: String,
    pub entries: Vec<Entry>,
}

impl Sessions {
    /// Strict observation used while native probation already blocks admissions.
    pub(crate) fn probation_idle(&self)->Result<bool,String>{
        let state=self.state.lock().map_err(|_|"Session lock failed")?;
        Ok(!state.closing&&state.slots.is_empty()&&state.users==0)
    }
    pub fn connected_profile(&self,id:&str)->Result<Option<Profile>,String>{let state=self.state.lock().map_err(|_|"Session lock failed")?;Ok(state.slots.get(id).filter(|slot|slot.phase==Phase::Connected).and_then(|slot|slot.credentials.as_ref()).map(|c|c.profile.clone()))}
    pub fn window_busy(&self, ids: &[String]) -> Result<bool, String> {
        let state=self.state.lock().map_err(|_| "Session lock failed")?;
        Ok(ids.iter().any(|id| state.slots.get(id).is_some_and(|slot|slot.phase==Phase::Prepared||slot.phase==Phase::Connecting||slot.connecting!=0)))
    }
    pub fn try_begin_close<F>(&self, check_engine: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        // Lock order is sessions -> engine lifecycle gate. Engine code never
        // calls session methods while retaining its own locks.
        let mut state = self
            .state
            .lock()
            .map_err(|_| "接続状態を確認できないため終了できません。".to_string())?;
        if state.closing {
            return Err("終了処理中です。しばらくお待ちください。".into());
        }
        if state.slots.values().any(|slot| {
            slot.phase == Phase::Prepared || slot.phase == Phase::Connecting || slot.connecting != 0
        }) {
            return Err("接続処理中のタブがあります。接続をキャンセルし、処理の完了後にもう一度ウィンドウを閉じてください。".into());
        }
        check_engine()?;
        // Seal registration before releasing the session lock. An engine
        // refusal above leaves sessions open and every cancellation unchanged.
        state.closing = true;
        Ok(())
    }
    pub fn prepare(&self, id: &str) -> Result<(), String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err("Invalid session id".into());
        }
        let mut state = self.state.lock().map_err(|_| "Session lock failed")?;
        if state.closing {
            return Err("Application closing".into());
        }
        if let Some(slot) = state.slots.get(id) {
            if slot.phase == Phase::Connected && !slot.stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            return Err("Session is already prepared, connecting, or disconnecting".into());
        }
        if state.slots.len() >= MAX_SESSIONS {
            return Err("At most 16 tab sessions".into());
        }
        state.slots.insert(
            id.into(),
            Slot {
                stop: Arc::new(AtomicBool::new(false)),
                phase: Phase::Prepared,
                credentials: None,
                users: 0,
                connecting: 0,
                linked: vec![],
            },
        );
        Ok(())
    }
    pub fn connect(
        self: &Arc<Self>,
        id: &str,
        profile: Profile,
        secret: Zeroizing<String>,
    ) -> Result<Lease, String> {
        if secret.len() > 65536 {
            return Err("Session passphrase exceeds supported size".into());
        }
        let mut state = self.state.lock().map_err(|_| "Session lock failed")?;
        if state.closing || state.users >= MAX_USERS {
            return Err("Application closing or session worker limit reached".into());
        }
        let slot = state
            .slots
            .get_mut(id)
            .ok_or("Prepare the session before connecting")?;
        if slot.stop.load(Ordering::SeqCst) {
            return Err("Session connection cancelled".into());
        }
        let initial = slot.phase == Phase::Prepared;
        let credentials = match slot.phase {
            Phase::Prepared => {
                slot.phase = Phase::Connecting;
                Arc::new(Credentials {
                    profile,
                    secret,
                    browse: Default::default(),
                })
            }
            Phase::Connecting => return Err("Session connection is already running".into()),
            Phase::Connected => slot
                .credentials
                .as_ref()
                .ok_or("Session credentials unavailable")?
                .clone(),
        };
        let stop = slot.stop.clone();
        slot.users += 1;
        slot.connecting += 1;
        state.users += 1;
        Ok(Lease {
            owner: self.clone(),
            id: id.into(),
            stop,
            credentials: Some(credentials),
            initial,
            installed: false,
            connection_attempt: true,
        })
    }
    pub fn resolve(self: &Arc<Self>, id: &str) -> Result<Lease, String> {
        let mut state = self.state.lock().map_err(|_| "Session lock failed")?;
        if state.closing || state.users >= MAX_USERS {
            return Err("Application closing or session worker limit reached".into());
        }
        let slot = state.slots.get_mut(id).ok_or("Session is disconnected")?;
        if slot.phase != Phase::Connected || slot.stop.load(Ordering::SeqCst) {
            return Err("Session is not connected or is being disconnected".into());
        }
        let credentials = slot
            .credentials
            .as_ref()
            .ok_or("Session credentials unavailable")?
            .clone();
        let stop = slot.stop.clone();
        slot.users += 1;
        state.users += 1;
        Ok(Lease {
            owner: self.clone(),
            id: id.into(),
            stop,
            credentials: Some(credentials),
            initial: false,
            installed: true,
            connection_attempt: false,
        })
    }
    pub fn disconnect(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Session lock failed")?;
        if let Some(slot) = state.slots.get_mut(id) {
            slot.stop.store(true, Ordering::SeqCst);
            if let Some(credentials) = slot.credentials.take() {
                credentials.browse.cancel();
            }
            for stop in slot.linked.iter().filter_map(|stop| stop.upgrade()) {
                stop.store(true, Ordering::SeqCst);
            }
            if slot.users == 0 {
                state.slots.remove(id);
            }
        }
        self.changed.notify_all();
        Ok(())
    }
    pub fn begin_shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        state.closing = true;
        state.slots.retain(|_, slot| {
            slot.stop.store(true, Ordering::SeqCst);
            for stop in slot.linked.iter().filter_map(|stop| stop.upgrade()) {
                stop.store(true, Ordering::SeqCst);
            }
            if let Some(credentials) = slot.credentials.take() {
                credentials.browse.cancel();
            }
            slot.users != 0
        });
        self.changed.notify_all();
    }
    pub fn shutdown(&self) {
        self.begin_shutdown();
        let mut state = self.state.lock().unwrap();
        while state.users != 0 {
            state = self.changed.wait(state).unwrap();
        }
        state.slots.clear();
    }
}
impl Lease {
    /// Keep the originating session generation and its intentional-disconnect
    /// cancellation. Transport failures do not revoke this lease.
    pub fn fork_editor(&self)->Result<Lease,String>{
        let lease=self.owner.resolve(&self.id)?;
        if !Arc::ptr_eq(&lease.stop,&self.stop){return Err("Session generation changed".into());}
        Ok(lease)
    }
    pub fn generation(&self)->usize{Arc::as_ptr(&self.stop) as usize}
    pub fn browse_home(&self) -> Result<(String, Vec<Entry>), String> {
        let credentials = self.credentials.as_ref().expect("Live session lease");
        if self.initial {
            let (mut connection, _) =
                crate::sftp::connect(&credentials.profile, &credentials.secret, &self.stop)?;
            let path = connection.home(&self.stop)?;
            let entries = crate::sftp::list_with_stop(&mut connection, &path, &self.stop)?;
            credentials.browse.install(connection, &self.stop)?;
            return Ok((path, entries));
        }
        credentials.browse.read(
            &self.stop,
            || {
                crate::sftp::connect(&credentials.profile, &credentials.secret, &self.stop)
                    .map(|value| value.0)
            },
            |connection| {
                let path = connection.home(&self.stop)?;
                let entries = crate::sftp::list_with_stop(connection, &path, &self.stop)?;
                Ok((path, entries))
            },
        )
    }
    pub fn list_remote(&self, path: &str) -> Result<Vec<Entry>, String> {
        let path = crate::sftp::normalize(path)?;
        let credentials = self.credentials.as_ref().expect("Live session lease");
        credentials.browse.read(
            &self.stop,
            || {
                crate::sftp::connect(&credentials.profile, &credentials.secret, &self.stop)
                    .map(|value| value.0)
            },
            |connection| crate::sftp::list_with_stop(connection, &path, &self.stop),
        )
    }
    pub fn link_stop(&self, token: &Arc<AtomicBool>) -> Result<(), String> {
        let mut state = self.owner.state.lock().map_err(|_| "Session lock failed")?;
        let slot = state
            .slots
            .get_mut(&self.id)
            .ok_or("Session disconnected")?;
        if self.stop.load(Ordering::SeqCst) || !Arc::ptr_eq(&slot.stop, &self.stop) {
            token.store(true, Ordering::SeqCst);
            return Err("Session disconnected".into());
        }
        slot.linked.retain(|stop| stop.strong_count() != 0);
        if slot.linked.len() >= MAX_USERS {
            return Err("Session cancellation link limit reached".into());
        }
        slot.linked.push(Arc::downgrade(token));
        Ok(())
    }
    pub fn profile(&self) -> &Profile {
        &self
            .credentials
            .as_ref()
            .expect("Live session lease")
            .profile
    }
    pub fn secret(&self) -> &str {
        &self
            .credentials
            .as_ref()
            .expect("Live session lease")
            .secret
    }
    pub fn stop(&self) -> &AtomicBool {
        &self.stop
    }
    pub fn install(&mut self) -> Result<(), String> {
        let mut state = self.owner.state.lock().map_err(|_| "Session lock failed")?;
        if state.closing || self.stop.load(Ordering::SeqCst) {
            return Err("Session disconnected before connection completed".into());
        }
        let slot = state
            .slots
            .get_mut(&self.id)
            .ok_or("Session was disconnected")?;
        if !Arc::ptr_eq(&slot.stop, &self.stop) {
            return Err("Session generation changed".into());
        }
        if self.initial {
            slot.credentials = self.credentials.clone();
            slot.phase = Phase::Connected;
        }
        self.installed = true;
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Drop this user's secret reference before reporting worker completion.
        self.credentials.take();
        if let Ok(mut state) = self.owner.state.lock() {
            if let Some(slot) = state.slots.get_mut(&self.id) {
                if Arc::ptr_eq(&slot.stop, &self.stop) {
                    slot.users -= 1;
                    if self.connection_attempt {
                        slot.connecting -= 1;
                    }
                    if self.initial && !self.installed {
                        slot.stop.store(true, Ordering::SeqCst);
                        if let Some(credentials) = slot.credentials.take() {
                            credentials.browse.cancel();
                        }
                    }
                    if slot.users == 0
                        && (slot.stop.load(Ordering::SeqCst) || self.initial && !self.installed)
                    {
                        state.slots.remove(&self.id);
                    }
                }
            }
            state.users -= 1;
            self.owner.changed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn editor_fork_is_revoked_by_intentional_origin_disconnect(){
        let sessions=Arc::new(Sessions::default());sessions.prepare("origin").unwrap();let mut initial=sessions.connect("origin",profile("fixture"),Zeroizing::new("generated-secret".into())).unwrap();initial.install().unwrap();drop(initial);let source=sessions.resolve("origin").unwrap();let editor=source.fork_editor().unwrap();sessions.disconnect("origin").unwrap();assert!(source.stop().load(Ordering::SeqCst));assert!(editor.stop().load(Ordering::SeqCst));assert_eq!(editor.secret(),"generated-secret");assert_eq!(editor.profile().host,source.profile().host);let stop=Arc::new(AtomicBool::new(false));assert!(editor.link_stop(&stop).is_err());assert!(stop.load(Ordering::SeqCst));assert!(source.fork_editor().is_err());
    }
    #[test]
    fn prepared_and_connecting_tabs_refuse_close_until_cancel_cleanup() {
        let sessions = Arc::new(Sessions::default());
        sessions.prepare("prepared").unwrap();
        let called = AtomicBool::new(false);
        assert!(sessions
            .try_begin_close(|| {
                called.store(true, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert!(!called.load(Ordering::SeqCst));
        assert!(!sessions.state.lock().unwrap().closing);
        sessions.disconnect("prepared").unwrap();
        sessions.prepare("connecting").unwrap();
        let mut lease = sessions
            .connect(
                "connecting",
                profile("fixture"),
                Zeroizing::new(String::new()),
            )
            .unwrap();
        assert!(sessions
            .try_begin_close(|| Ok(()))
            .unwrap_err()
            .contains("キャンセル"));
        assert!(!lease.stop().load(Ordering::SeqCst));
        sessions.disconnect("connecting").unwrap();
        assert!(lease.install().is_err());
        assert!(
            sessions.try_begin_close(|| Ok(())).is_err(),
            "Cancelled connection worker still requires cleanup"
        );
        drop(lease);
        assert!(sessions.try_begin_close(|| Ok(())).is_ok());
        assert!(sessions.prepare("late").is_err());
    }
    #[test]
    fn idle_connected_reads_allow_close_but_explicit_reconnect_waits_for_cleanup() {
        let sessions = Arc::new(Sessions::default());
        sessions.prepare("connected").unwrap();
        let mut initial = sessions
            .connect(
                "connected",
                profile("fixture"),
                Zeroizing::new(String::new()),
            )
            .unwrap();
        initial.install().unwrap();
        assert!(
            sessions.try_begin_close(|| Ok(())).is_err(),
            "Successful install must not lose the still-running connection worker"
        );
        drop(initial);
        let mut reconnect = sessions
            .connect(
                "connected",
                profile("ignored"),
                Zeroizing::new(String::new()),
            )
            .unwrap();
        assert!(sessions.try_begin_close(|| Ok(())).is_err());
        reconnect.install().unwrap();
        assert!(sessions.try_begin_close(|| Ok(())).is_err());
        drop(reconnect);
        let user = sessions.resolve("connected").unwrap();
        assert!(sessions.try_begin_close(|| Ok(())).is_ok());
        assert!(sessions.resolve("connected").is_err());
        sessions.begin_shutdown();
        assert!(user.stop().load(Ordering::SeqCst));
        drop(user);
        sessions.shutdown();
    }
    #[test]
    fn engine_close_refusal_does_not_seal_or_cancel_session_state() {
        let sessions = Sessions::default();
        let engine = crate::engine::Engine::default();
        engine.prepare("busy-sync".into()).unwrap();
        assert!(sessions
            .try_begin_close(|| engine.try_begin_close())
            .is_err());
        assert!(!sessions.state.lock().unwrap().closing);
        assert!(sessions.prepare("another-tab").is_ok());
        sessions.disconnect("another-tab").unwrap();
        engine.stop("busy-sync").unwrap();
        assert!(sessions
            .try_begin_close(|| engine.try_begin_close())
            .is_ok());
    }
    #[test]
    fn session_prepare_and_accepted_close_are_atomic() {
        for _ in 0..30 {
            let sessions = Arc::new(Sessions::default());
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let preparing = sessions.clone();
            let ready = barrier.clone();
            let prepare = std::thread::spawn(move || {
                ready.wait();
                preparing.prepare("race")
            });
            let closing = sessions.clone();
            let ready = barrier.clone();
            let close = std::thread::spawn(move || {
                ready.wait();
                closing.try_begin_close(|| Ok(()))
            });
            barrier.wait();
            assert_ne!(
                prepare.join().unwrap().is_ok(),
                close.join().unwrap().is_ok(),
                "Either session preparation or close commits, never both"
            );
        }
    }
    fn profile(host: &str) -> Profile {
        Profile {
            id: "fixture".into(),
            name: "Generated fixture".into(),
            host: host.into(),
            port: 22,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: "generated.ppk".into(),
            host_key: "generated-only".into(),
        }
    }
    #[test]
    fn prepare_cancel_refuses_late_claim_and_completion_cannot_install() {
        let sessions = Arc::new(Sessions::default());
        sessions.prepare("before-claim").unwrap();
        sessions.disconnect("before-claim").unwrap();
        assert!(sessions
            .connect(
                "before-claim",
                profile("original"),
                Zeroizing::new("fixture".into())
            )
            .is_err());
        sessions.prepare("in-flight").unwrap();
        let mut lease = sessions
            .connect(
                "in-flight",
                profile("original"),
                Zeroizing::new("fixture".into()),
            )
            .unwrap();
        sessions.disconnect("in-flight").unwrap();
        assert!(lease.stop().load(Ordering::SeqCst));
        assert!(lease.install().is_err());
        assert!(sessions.resolve("in-flight").is_err());
        assert!(sessions.prepare("in-flight").is_err());
        drop(lease);
        assert!(sessions.state.lock().unwrap().slots.is_empty());
    }
    #[test]
    fn immutable_snapshot_overrides_reconnect_inputs_and_drops_on_disconnect() {
        let sessions = Arc::new(Sessions::default());
        sessions.prepare("tab").unwrap();
        let mut lease = sessions
            .connect(
                "tab",
                profile("original"),
                Zeroizing::new("original-secret".into()),
            )
            .unwrap();
        let weak = Arc::downgrade(lease.credentials.as_ref().unwrap());
        lease.install().unwrap();
        drop(lease);
        assert!(weak.upgrade().is_some());
        sessions.prepare("tab").unwrap();
        let reconnected = sessions
            .connect(
                "tab",
                profile("edited"),
                Zeroizing::new("different-secret".into()),
            )
            .unwrap();
        assert_eq!(reconnected.profile().host, "original");
        assert_eq!(reconnected.secret(), "original-secret");
        drop(reconnected);
        let user = sessions.resolve("tab").unwrap();
        sessions.disconnect("tab").unwrap();
        assert!(sessions.resolve("tab").is_err());
        assert!(weak.upgrade().is_some());
        drop(user);
        assert!(weak.upgrade().is_none());
    }
    #[test]
    fn slots_and_concurrent_secret_users_are_bounded() {
        let sessions = Arc::new(Sessions::default());
        for n in 0..16 {
            sessions.prepare(&format!("tab-{n}")).unwrap();
        }
        assert!(sessions.prepare("overflow").is_err());
        let mut connect = sessions
            .connect("tab-0", profile("fixture"), Zeroizing::new(String::new()))
            .unwrap();
        connect.install().unwrap();
        drop(connect);
        let users: Vec<_> = (0..16)
            .map(|_| sessions.resolve("tab-0").unwrap())
            .collect();
        assert!(sessions.resolve("tab-0").is_err());
        drop(users);
        sessions.shutdown();
        assert!(sessions.state.lock().unwrap().slots.is_empty());
        assert!(sessions.prepare("closed").is_err());
    }
    #[test]
    fn shutdown_cancels_and_waits_for_live_secret_users() {
        let sessions = Arc::new(Sessions::default());
        sessions.prepare("tab").unwrap();
        let lease = sessions
            .connect(
                "tab",
                profile("fixture"),
                Zeroizing::new("fixture-only".into()),
            )
            .unwrap();
        let stop = lease.stop.clone();
        let weak = Arc::downgrade(lease.credentials.as_ref().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        let shutdown = sessions.clone();
        let worker = std::thread::spawn(move || {
            shutdown.shutdown();
            tx.send(()).unwrap();
        });
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !stop.load(Ordering::SeqCst) && std::time::Instant::now() < until {
            std::thread::yield_now();
        }
        assert!(stop.load(Ordering::SeqCst));
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_err());
        drop(lease);
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert!(weak.upgrade().is_none());
    }
    #[test]
    fn disconnect_cancels_linked_manual_operation_without_retaining_token() {
        let sessions = Arc::new(Sessions::default());
        sessions.prepare("tab").unwrap();
        let mut initial = sessions
            .connect("tab", profile("fixture"), Zeroizing::new(String::new()))
            .unwrap();
        initial.install().unwrap();
        drop(initial);
        let user = sessions.resolve("tab").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        user.link_stop(&stop).unwrap();
        sessions.disconnect("tab").unwrap();
        assert!(stop.load(Ordering::SeqCst));
        drop(user);
        assert!(sessions.state.lock().unwrap().slots.is_empty());
    }
}
