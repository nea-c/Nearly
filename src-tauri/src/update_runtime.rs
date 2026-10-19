//! Bounded native restart-health coordinator. Journal flags are lookup hints;
//! only retained process handles and reauthenticated bytes authorize cleanup.
use serde::Serialize;
use std::{
    ffi::OsStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Startup {
    Ordinary,
    Health(String),
    Invalid,
}
pub(crate) fn parse_args<I, S>(args: I) -> Startup
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<_> = args.into_iter().skip(1).collect();
    let health = args.iter().any(|a| {
        a.as_ref()
            .to_string_lossy()
            .starts_with("--nearly-update-health")
    });
    if !health {
        return Startup::Ordinary;
    }
    if args.len() != 1 {
        return Startup::Invalid;
    }
    let Some(text) = args[0].as_ref().to_str() else {
        return Startup::Invalid;
    };
    let Some(nonce) = text.strip_prefix("--nearly-update-health=") else {
        return Startup::Invalid;
    };
    if nonce.len() != 32
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Startup::Invalid;
    }
    Startup::Health(nonce.into())
}
#[derive(Default)]
struct HealthFlags {
    settings: bool,
    ui: bool,
}
impl HealthFlags {
    fn ready(&self) -> bool {
        self.settings && self.ui
    }
}
fn matching_active(active: Option<&str>, nonce: &str) -> bool {
    active == Some(nonce)
}
type Notice = Arc<dyn Fn(Report) + Send + Sync>;
pub(crate) struct HealthActions {
    pub release:Arc<dyn Fn()->Result<(),String>+Send+Sync>,
    pub seal_exit:Arc<dyn Fn()->Result<crate::HealthExitSeal,String>+Send+Sync>,
    pub attest_idle:Arc<dyn Fn()->Result<crate::HealthIdleProof,String>+Send+Sync>,
    pub exit:Arc<dyn Fn()+Send+Sync>,
}
struct Inner {
    report: Report,
    flags: HealthFlags,
    startup: Startup,
    active: Option<String>,
    sink: Option<Notice>,
    started: bool,
    actions:Option<HealthActions>,
}
struct Shared {
    inner: Mutex<Inner>,
    changed: Condvar,
    cancelled: AtomicBool,
    enabled: bool,
}
#[derive(Clone)]
pub(crate) struct Runtime(Arc<Shared>);
impl Default for Runtime {
    fn default() -> Self {
        Self::new(Startup::Ordinary)
    }
}
impl Runtime {
    pub(crate) fn new(startup: Startup) -> Self {
        Self::create(
            startup,
            crate::startup_update::handoff_validated()
                && crate::update_package::runtime_key().is_some(),
        )
    }
    fn create(startup: Startup, enabled: bool) -> Self {
        let active = if enabled {
            if let Startup::Health(n) = &startup {
                Some(n.clone())
            } else {
                None
            }
        } else {
            None
        };
        Self(Arc::new(Shared {
            inner: Mutex::new(Inner {
                report: Report {
                    phase: if enabled&&matches!(&startup,Startup::Health(_)){"waitingForUi"}else{"idle"},
                    reason: None,
                    revision: 0,
                },
                flags: HealthFlags::default(),
                startup,
                active,
                sink: None,
                started: false,
                actions:None,
            }),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
            enabled,
        }))
    }
    pub(crate) fn status(&self) -> Report {
        self.0
            .inner
            .lock()
            .map(|s| s.report.clone())
            .unwrap_or(Report {
                phase: "recoveryRequired",
                reason: Some("runtimeUnavailable"),
                revision: u64::MAX,
            })
    }
    fn publish(&self, phase: &'static str, reason: Option<&'static str>) {
        #[cfg(all(feature="installer-qa",windows))]
        crate::installer_qa::trace_runtime(phase,reason);
        let notice = if let Ok(mut s) = self.0.inner.lock() {
            if s.report.phase == phase && s.report.reason == reason {
                return;
            }
            // A conflicting launch fences every subsequent authority check.
            if self.0.cancelled.load(Ordering::Acquire) && phase != "recoveryRequired" {
                return;
            }
            s.report = Report {
                phase,
                reason,
                revision: s.report.revision.saturating_add(1),
            };
            Some((s.sink.clone(), s.report.clone()))
        } else {
            None
        };
        self.0.changed.notify_all();
        if let Some((Some(sink), report)) = notice {
            sink(report);
        }
    }
    fn recovery(&self, reason: &'static str) {
        self.0.cancelled.store(true, Ordering::Release);
        self.publish("recoveryRequired", Some(reason));
    }
    pub(crate) fn settings_loaded(&self) {
        if self.0.enabled {
            if let Ok(mut s) = self.0.inner.lock() {
                s.flags.settings = true;
            }
            self.0.changed.notify_all();
        }
    }
    pub(crate) fn ack_ready(&self) {
        if self.0.enabled {
            if let Ok(mut s) = self.0.inner.lock() {
                s.flags.ui = true;
            }
            self.0.changed.notify_all();
        }
    }
    /// Return true when this invocation is a health route, including malformed
    /// input. It must never fall through to ordinary blank-window creation.
    pub(crate) fn route_second(&self, startup: Startup) -> bool {
        match startup {
            Startup::Ordinary => false,
            Startup::Health(nonce) => {
                if self.0.enabled {
                    let matches = self
                        .0
                        .inner
                        .lock()
                        .map(|s| matching_active(s.active.as_deref(), &nonce))
                        .unwrap_or(false);
                    if !matches {
                        self.recovery("unrelatedHealthLaunch");
                    }
                }
                true
            }
            Startup::Invalid => {
                if self.0.enabled {
                    self.recovery("invalidHealthArguments");
                }
                true
            }
        }
    }
    /// Called during native setup, before the main renderer bootstraps. Disabled
    /// production performs no discovery and emits no status notification.
    pub(crate) fn start(&self, sink: Notice, actions:HealthActions) {
        if !self.0.enabled {
            return;
        }
        let startup = {
            let Ok(mut s) = self.0.inner.lock() else {
                return;
            };
            if s.started {
                return;
            }
            s.started = true;
            s.sink = Some(sink);
            s.actions=Some(actions);
            s.startup.clone()
        };
        let runtime = self.clone();
        std::thread::spawn(move || runtime.run(startup));
    }
    fn waiting_ui(&self, timeout: Duration) -> Result<(), &'static str> {
        let deadline = Instant::now() + timeout;
        let mut s = self.0.inner.lock().map_err(|_| "runtimeUnavailable")?;
        loop {
            if self.0.cancelled.load(Ordering::Acquire) {
                return Err("restartInterrupted");
            }
            if s.flags.ready() {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("uiHealthTimeout");
            }
            let (next, _) = self
                .0
                .changed
                .wait_timeout(s, remaining.min(Duration::from_millis(100)))
                .map_err(|_| "runtimeUnavailable")?;
            s = next;
        }
    }
    fn native_health(&self) -> bool {
        !self.0.cancelled.load(Ordering::Acquire)
            && self
                .0
                .inner
                .lock()
                .map(|s| s.flags.ready())
                .unwrap_or(false)
    }
    fn run(&self, startup: Startup) {
        #[cfg(windows)]
        if let Err(reason) = self.run_native(startup) {
            self.recovery(reason);
        }
        #[cfg(not(windows))]
        {
            let _ = startup;
            self.recovery("unsupportedPlatform");
        }
    }
    #[cfg(windows)]
    fn run_supervisor_health(&self,nonce:&str)->Result<(), &'static str>{
        use crate::update_restart::{LiveRecoverySupervisor,SupervisorEvent};
        let snapshot=crate::update_recovery_windows::authenticate_health(nonce).map_err(|_|"supervisorAuthenticationFailed")?;
        let live=LiveRecoverySupervisor::open(snapshot).map_err(|_|"liveSupervisorMissing")?;
        self.publish("waitingForUi",None);
        // Supervisor allows 30s health plus 5s cooperative exit. Keep the
        // authenticated listener alive beyond both bounded intervals.
        let deadline=Instant::now()+Duration::from_secs(45);
        let mut signalled=false;
        let mut idle_attested=false;
        loop {
            if self.0.cancelled.load(Ordering::Acquire){return Err("restartInterrupted");}
            match live.poll_event().map_err(|_|"supervisorEvidenceLost")? {
                Some(SupervisorEvent::Success)=>{
                    let s=self.0.inner.lock().map_err(|_|"runtimeUnavailable")?;
                    (s.actions.as_ref().ok_or("runtimeUnavailable")?.release)().map_err(|_|"probationReleaseFailed")?;
                    drop(s);self.publish("succeeded",None);return Ok(());
                },
                Some(SupervisorEvent::ExitRequest)=>{
                    #[cfg(feature="installer-qa")] crate::installer_qa::trace("exit","requested");
                    let s=self.0.inner.lock().map_err(|_|"runtimeUnavailable")?;
                    let actions=s.actions.as_ref().ok_or("runtimeUnavailable")?;
                    let seal=(actions.seal_exit)().map_err(|_|"healthShutdownBusy")?;
                    #[cfg(feature="installer-qa")] crate::installer_qa::trace("exit","sealed");
                    live.signal_idle(&seal).map_err(|_|"supervisorEvidenceLost")?;
                    #[cfg(feature="installer-qa")] crate::installer_qa::trace("exit","idleSignalled");
                    #[cfg(feature="installer-qa")] crate::installer_qa::trace("exit","issued");
                    (actions.exit)();return Ok(());
                },
                None=>(),
            }
            let settings_ready=self.0.inner.lock().map_err(|_|"runtimeUnavailable")?.flags.settings;
            if !idle_attested&&settings_ready{
                let s=self.0.inner.lock().map_err(|_|"runtimeUnavailable")?;
                // Settings initialization can still be returning while holding
                // its writer lock. Retry boundedly; never assume settlement.
                if let Ok(proof)=(s.actions.as_ref().ok_or("runtimeUnavailable")?.attest_idle)(){
                    live.signal_probation_idle(&proof).map_err(|_|"supervisorEvidenceLost")?;idle_attested=true;
                    #[cfg(feature="installer-qa")] crate::installer_qa::trace("idle","attested");
                }
            }
            if !signalled&&idle_attested&&self.native_health(){live.signal_healthy().map_err(|_|"supervisorEvidenceLost")?;signalled=true;self.publish("awaitingSuccess",None);}
            if Instant::now()>=deadline{return Err("supervisorHealthTimeout");}
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    #[cfg(windows)]
    fn run_native(&self, startup: Startup) -> Result<(), &'static str> {
        // Both real release gates are checked again immediately before the first
        // native filesystem/process effect. No runtime flag can open this gate.
        if !crate::startup_update::handoff_validated() {
            return Ok(());
        }
        let Some(_key) = crate::update_package::runtime_key() else {
            return Ok(());
        };
        if startup == Startup::Invalid {
            return Err("invalidHealthArguments");
        }
        // Protocol3 health is observation-only; never enter the protocol2 writer
        // route, even for a legacy health argument with a matching nonce.
        if let Startup::Health(nonce)=&startup{return self.run_supervisor_health(nonce);}
        crate::update_recovery_windows::ordinary_startup_allowed().map_err(|_|"transactionUnavailable")?;
        self.publish("idle", None);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nonce_only_parser_rejects_duplicates_and_argument_smuggling() {
        let n = "0123456789abcdef0123456789abcdef";
        assert_eq!(parse_args(["Nearly.exe"]), Startup::Ordinary);
        assert_eq!(
            parse_args(["Nearly.exe", &format!("--nearly-update-health={n}")]),
            Startup::Health(n.into())
        );
        for args in [
            vec!["Nearly.exe", "--nearly-update-health"],
            vec!["Nearly.exe", "--nearly-update-health=ABC"],
            vec![
                "Nearly.exe",
                "--nearly-update-health=0123456789abcdef0123456789abcdef",
                "--nearly-update-health=0123456789abcdef0123456789abcdef",
            ],
            vec![
                "Nearly.exe",
                "--nearly-update-health=0123456789abcdef0123456789abcdef",
                "--pid=1",
            ],
            vec![
                "Nearly.exe",
                "--nearly-update-health=0123456789abcdef0123456789abcdef",
                "C:\\fake.exe",
            ],
        ] {
            assert_eq!(parse_args(args), Startup::Invalid);
        }
    }
}

#[cfg(test)]
mod health_tests {
    use super::*;
    #[test]
    fn probation_readiness_does_not_admit_work_or_release_from_renderer_ack(){
        let runtime=Runtime::create(Startup::Health("a".repeat(32)),true);
        let mut registry=crate::window_ownership::Registry::default();
        registry.register_native_window("main").unwrap();registry.enter_health_probation();
        registry.bootstrap("main").unwrap();registry.settings_registered("main").unwrap();
        assert_eq!(runtime.status().phase,"waitingForUi");
        assert!(registry.claim("main","premature").is_err());
        runtime.settings_loaded();runtime.ack_ready();
        assert_eq!(runtime.waiting_ui(Duration::ZERO),Ok(()));
        assert!(registry.claim("main","still-premature").is_err());
        assert!(registry.settings_mutable("main").is_err());
        assert_eq!(runtime.status().phase,"waitingForUi");
    }
    #[test]
    fn native_settings_and_renderer_ack_are_independently_required() {
        let mut f = HealthFlags::default();
        assert!(!f.ready());
        f.settings = true;
        assert!(!f.ready());
        f.settings = false;
        f.ui = true;
        assert!(!f.ready());
        f.settings = true;
        assert!(f.ready());
    }
    #[test]
    fn health_second_launch_only_matches_the_exact_active_transaction() {
        let n = "a".repeat(32);
        assert!(!matching_active(None, &n));
        assert!(!matching_active(Some(&"b".repeat(32)), &n));
        assert!(matching_active(Some(&n), &n));
    }
    #[test]
    fn real_production_gates_are_enabled_with_registered_key() {
        assert!(crate::startup_update::HANDOFF_RELEASE_VALIDATED);
        assert!(crate::update_package::production_key().is_some());
    }
}

#[cfg(test)]
mod coordinator_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn production_constructor_selects_enabled_runtime_without_starting_discovery() {
        let rt=Runtime::new(Startup::Ordinary);assert_eq!(rt.0.enabled,crate::startup_update::handoff_validated());
        assert!(!rt.0.inner.lock().unwrap().started);
    }
    #[test]
    fn disabled_startup_and_health_routes_have_no_notifications_or_native_discovery() {
        let count = Arc::new(AtomicUsize::new(0));
        for startup in [
            Startup::Ordinary,
            Startup::Invalid,
            Startup::Health("a".repeat(32)),
        ] {
            let rt = Runtime::create(startup, false);
            let notices = count.clone();
            rt.start(Arc::new(move |_| {
                notices.fetch_add(1, Ordering::SeqCst);
            }),HealthActions{release:Arc::new(||Ok(())),seal_exit:Arc::new(||Err("test has no native authority".into())),attest_idle:Arc::new(||Err("test has no native authority".into())),exit:Arc::new(||panic!("unexpected native exit"))});
            rt.settings_loaded();
            rt.ack_ready();
            assert!(!rt.route_second(Startup::Ordinary));
            assert!(rt.route_second(Startup::Invalid));
            assert!(rt.route_second(Startup::Health("b".repeat(32))));
            assert_eq!(
                rt.status(),
                Report {
                    phase: "idle",
                    reason: None,
                    revision: 0
                }
            );
        }
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn second_instance_health_is_idempotent_only_for_the_active_nonce() {
        let nonce = "a".repeat(32);
        let rt = Runtime::create(Startup::Health(nonce.clone()), true);
        assert!(rt.route_second(Startup::Health(nonce)));
        assert!(!rt.0.cancelled.load(Ordering::Acquire));
        assert!(rt.route_second(Startup::Health("b".repeat(32))));
        assert!(rt.0.cancelled.load(Ordering::Acquire));
        assert_eq!(rt.status().reason, Some("unrelatedHealthLaunch"));
        rt.publish("cleaned", None);
        assert_eq!(rt.status().phase, "recoveryRequired");
        let ordinary = Runtime::create(Startup::Ordinary, true);
        assert!(ordinary.route_second(Startup::Health("b".repeat(32))));
        assert_eq!(ordinary.status().phase, "recoveryRequired");
    }
    #[test]
    fn missing_either_native_settings_or_ui_ack_times_out() {
        for (settings, ui) in [(false, false), (true, false), (false, true)] {
            let rt = Runtime::create(Startup::Health("a".repeat(32)), true);
            if settings {
                rt.settings_loaded();
            }
            if ui {
                rt.ack_ready();
            }
            assert_eq!(
                rt.waiting_ui(Duration::from_millis(2)),
                Err("uiHealthTimeout")
            );
            assert!(!rt.native_health());
        }
    }
    #[test]
    fn fresh_ephemeral_flags_wake_native_health_wait_and_are_not_replayed() {
        let rt = Runtime::create(Startup::Health("a".repeat(32)), true);
        rt.settings_loaded();
        let renderer = rt.clone();
        let worker = std::thread::spawn(move || renderer.ack_ready());
        assert_eq!(rt.waiting_ui(Duration::from_secs(1)), Ok(()));
        worker.join().unwrap();
        assert!(rt.native_health());
        let restart = Runtime::create(Startup::Health("a".repeat(32)), true);
        assert!(!restart.native_health());
    }
    #[test]
    fn report_revisions_are_monotonic_and_owned_codes_exclude_native_details() {
        let rt = Runtime::create(Startup::Ordinary, true);
        rt.publish("checking", None);
        assert_eq!(rt.status().revision, 1);
        rt.publish("checking", None);
        assert_eq!(rt.status().revision, 1);
        rt.recovery("liveRestartEvidenceMissing");
        assert_eq!(rt.status().revision, 2);
        assert_eq!(
            serde_json::to_value(rt.status()).unwrap(),
            serde_json::json!({"phase":"recoveryRequired","reason":"liveRestartEvidenceMissing","revision":2})
        );
    }
}

#[cfg(all(test, windows))]
mod native_fixture_tests {
    use super::*;
    use std::{fs, path::PathBuf, process::Command};
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            for parent in [
                self.0.join(crate::update_transaction::STATE_DIRECTORY),
                self.0.clone(),
            ] {
                if let Ok(entries) = fs::read_dir(&parent) {
                    for entry in entries.flatten() {
                        if entry.file_type().is_ok_and(|t| t.is_file()) {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
                let _ = fs::remove_dir(parent);
            }
        }
    }
    #[test]
    fn signed_actual_running_payload_is_authenticated_in_a_harmless_copied_test_process() {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!(
            "nearly-runtime-running-{}-{}",
            std::process::id(),
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let image = fixture.0.join("Nearly.exe");
        fs::copy(std::env::current_exe().unwrap(), &image).unwrap();
        let mut child = Command::new(&image)
            .args([
                "update_runtime::native_fixture_tests::running_payload_helper",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .spawn()
            .unwrap();
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(15),
                "harmless helper failed its bounded completion deadline"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            fs::read(fixture.0.join("settings.json")).unwrap(),
            b"settings sentinel"
        );
        assert_eq!(
            fs::read(fixture.0.join("Nearly_r1.0_x64-setup.exe")).unwrap(),
            b"manual setup sentinel"
        );
    }
    #[test]
    #[ignore]
    fn running_payload_helper() {
        use crate::update_transaction::{
            authenticate_record, prepare_transaction, verify_running_payload, NativeContext,
        };
        let image = std::env::current_exe().unwrap();
        let root = image.parent().unwrap();
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("nearly-runtime-running-"));
        fs::write(root.join("settings.json"), b"settings sentinel").unwrap();
        fs::write(
            root.join("Nearly_r1.0_x64-setup.exe"),
            b"manual setup sentinel",
        )
        .unwrap();
        let context = NativeContext::fixture_context(root).unwrap();
        let (mut stage, candidate, key) = crate::update_package::fixture_stage(
            root,
            env!("CARGO_PKG_VERSION"),
            context.installed_image_sha256(),
        );
        let snapshot = stage.transaction_snapshot(&candidate, &key).unwrap();
        let transaction = prepare_transaction(&context, &snapshot).unwrap();
        let record = transaction.store.recovery_hint().unwrap().unwrap();
        let proof = authenticate_record(&context, &record, &key).unwrap();
        verify_running_payload(&context, &proof).expect(
            "authenticated actual running test payload/version/architecture/path must match",
        );
        assert_eq!(proof.payload_sha256(), context.installed_image_sha256());
        assert_eq!(
            fs::read(root.join(&record.old_image.basename)).unwrap(),
            fs::read(&image).unwrap()
        );
        let rt = Runtime::create(Startup::Health(record.receipt.binding.nonce.clone()), true);
        assert_eq!(rt.waiting_ui(Duration::ZERO), Err("uiHealthTimeout"));
        rt.settings_loaded();
        assert!(!rt.native_health());
        rt.ack_ready();
        assert_eq!(rt.waiting_ui(Duration::ZERO), Ok(()));
        assert!(rt.native_health());
    }
}
