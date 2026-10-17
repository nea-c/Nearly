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
struct Inner {
    report: Report,
    flags: HealthFlags,
    startup: Startup,
    active: Option<String>,
    sink: Option<Notice>,
    started: bool,
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
            crate::startup_update::HANDOFF_RELEASE_VALIDATED
                && crate::update_package::production_key().is_some(),
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
                    phase: "idle",
                    reason: None,
                    revision: 0,
                },
                flags: HealthFlags::default(),
                startup,
                active,
                sink: None,
                started: false,
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
    pub(crate) fn start(&self, sink: Notice) {
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
    fn run_native(&self, startup: Startup) -> Result<(), &'static str> {
        use crate::update_transaction::{Error, NativeContext, TransactionStore};
        // Both real release gates are checked again immediately before the first
        // native filesystem/process effect. No runtime flag can open this gate.
        if !crate::startup_update::HANDOFF_RELEASE_VALIDATED {
            return Ok(());
        }
        let Some(key) = crate::update_package::production_key() else {
            return Ok(());
        };
        if startup == Startup::Invalid {
            return Err("invalidHealthArguments");
        }
        self.publish("checking", None);
        let context =
            NativeContext::capture_current_install().map_err(|_| "installedContextUnavailable")?;
        let store = match TransactionStore::open_existing(&context) {
            Ok(store) => store,
            Err(Error::Missing) if startup == Startup::Ordinary => {
                self.publish("idle", None);
                return Ok(());
            }
            Err(_) => return Err("transactionUnavailable"),
        };
        let record = store.recovery_hint().map_err(|_| "journalUncertain")?;
        let Some(record) = record else {
            if startup == Startup::Ordinary {
                self.publish("idle", None);
                return Ok(());
            }
            return Err("transactionMissing");
        };
        // A persisted Cleaned state is terminal metadata, never cleanup authority.
        if startup == Startup::Ordinary {
            if record.receipt.state == crate::update_cleanup::codec::State::Cleaned {
                self.publish("idle", None);
                return Ok(());
            }
            return Err("liveRestartEvidenceMissing");
        }
        let Startup::Health(nonce) = startup else {
            return Err("invalidHealthArguments");
        };
        if nonce != record.receipt.binding.nonce {
            return Err("transactionMismatch");
        }
        if record.receipt.state != crate::update_cleanup::codec::State::HandoffCommitted {
            return Err("liveRestartEvidenceMissing");
        }
        let mut session = NativeSession::open(context, store, record, key, self.clone())?;
        self.publish("waitingForUi", None);
        self.waiting_ui(Duration::from_secs(20))?;
        session.complete(self, Duration::from_secs(30))
    }
}
#[cfg(windows)]
struct NativeSession {
    context: crate::update_transaction::NativeContext,
    store: crate::update_transaction::TransactionStore,
    lifecycle: crate::update_cleanup::engine::Lifecycle,
    evidence: RestartEvidence,
}
#[cfg(windows)]
struct RestartEvidence {
    record: crate::update_transaction::TransactionRecord,
    key: crate::update_package::TrustedKey,
    live: crate::update_restart::LiveInstaller,
    exit: Option<crate::update_restart::ExitProof>,
    runtime: Runtime,
}
#[cfg(windows)]
impl crate::update_transaction::NativeEvidence for RestartEvidence {
    fn verify(
        &mut self,
        context: &crate::update_transaction::NativeContext,
        record: &crate::update_transaction::TransactionRecord,
        evidence: crate::update_cleanup::engine::Evidence,
    ) -> Result<(), String> {
        use crate::update_cleanup::engine::Evidence;
        if self.runtime.0.cancelled.load(Ordering::Acquire)
            || record.receipt.binding != self.record.receipt.binding
        {
            return Err("Restart fenced".into());
        }
        let proof = crate::update_transaction::authenticate_record(context, record, &self.key)
            .map_err(|_| "Package authentication failed")?;
        crate::update_transaction::verify_running_payload(context, &proof)
            .map_err(|_| "Running image authentication failed")?;
        if record.restart_process.as_ref() != Some(&crate::update_restart::current_identity()?) {
            return Err("Restart process identity mismatch".into());
        }
        let expected = record
            .installer_process
            .as_ref()
            .ok_or("Installer identity unavailable")?;
        if self.live.process_identity() != expected
            || self.live.nonce() != record.receipt.binding.nonce
            || self.live.image_path()
                != context
                    .root_path()
                    .join(&record.receipt.binding.installer.basename)
        {
            return Err("Installer binding mismatch".into());
        }
        if let Some(exit) = &self.exit {
            if exit.process_identity() != expected
                || exit.nonce() != record.receipt.binding.nonce
                || exit.image_path() != self.live.image_path()
            {
                return Err("Installer exit proof mismatch".into());
            }
        } else {
            self.live.verify_installed()?;
        }
        if evidence == Evidence::Healthy && !self.runtime.native_health() {
            return Err("Native application health unavailable".into());
        }
        Ok(())
    }
}
#[cfg(windows)]
impl NativeSession {
    fn open(
        context: crate::update_transaction::NativeContext,
        mut store: crate::update_transaction::TransactionStore,
        record: crate::update_transaction::TransactionRecord,
        key: crate::update_package::TrustedKey,
        runtime: Runtime,
    ) -> Result<Self, &'static str> {
        let proof = crate::update_transaction::authenticate_record(&context, &record, &key)
            .map_err(|_| "packageAuthenticationFailed")?;
        crate::update_transaction::verify_running_payload(&context, &proof)
            .map_err(|_| "runningImageMismatch")?;
        let id = record
            .installer_process
            .as_ref()
            .ok_or("liveInstallerMissing")?;
        let live = crate::update_restart::LiveInstaller::open(
            &record.receipt.binding.nonce,
            id,
            &context
                .root_path()
                .join(&record.receipt.binding.installer.basename),
        )
        .map_err(|_| "liveInstallerMissing")?;
        // Persist the first authenticated native restart identity. A subsequent
        // process after a crash cannot reattach to this transaction by nonce.
        let record = store
            .claim_current_restart(&record.receipt)
            .map_err(|_| "restartAlreadyClaimed")?;
        let lifecycle = crate::update_cleanup::engine::Lifecycle::recover(
            &crate::update_cleanup::codec::encode(&record.receipt)
                .map_err(|_| "journalUncertain")?,
        )
        .map_err(|_| "journalUncertain")?;
        Ok(Self {
            context,
            store,
            lifecycle,
            evidence: RestartEvidence {
                record,
                key,
                live,
                exit: None,
                runtime,
            },
        })
    }
    fn advance(&mut self, target: crate::update_cleanup::codec::State) -> Result<(), &'static str> {
        if target == crate::update_cleanup::codec::State::CleanupPending
            && self.evidence.exit.is_none()
        {
            return Err("installerExitEvidenceMissing");
        }
        let record = self.evidence.record.clone();
        let mut authority = crate::update_transaction::EvidenceAdapter {
            context: &self.context,
            record: &record,
            native: &mut self.evidence,
        };
        self.lifecycle
            .advance(target, &mut authority, &mut self.store)
            .map_err(|_| "transitionEvidenceLost")
    }
    fn complete(&mut self, runtime: &Runtime, timeout: Duration) -> Result<(), &'static str> {
        use crate::update_cleanup::{codec::State, engine::Outcome};
        use crate::update_transaction::NativeEvidence;
        self.advance(State::InstallationSucceeded)?;
        self.advance(State::RestartHealthy)?;
        // A fresh reauthentication immediately before the external health event.
        let record = self.evidence.record.clone();
        self.evidence
            .verify(
                &self.context,
                &record,
                crate::update_cleanup::engine::Evidence::Healthy,
            )
            .map_err(|_| "restartEvidenceLost")?;
        self.evidence
            .live
            .signal_healthy()
            .map_err(|_| "healthSignalFailed")?;
        runtime.publish("waitingForInstaller", None);
        self.evidence.exit = Some(
            self.evidence
                .live
                .wait_exit_zero(timeout)
                .map_err(|_| "installerExitNotConfirmed")?,
        );
        self.advance(State::CleanupPending)?;
        let start = Instant::now();
        let mut files = crate::update_transaction::NativeFiles::new(&self.context);
        loop {
            let now = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let record = self.evidence.record.clone();
            let mut authority = crate::update_transaction::EvidenceAdapter {
                context: &self.context,
                record: &record,
                native: &mut self.evidence,
            };
            match self
                .lifecycle
                .cleanup(now, &mut authority, &mut self.store, &mut files)
                .map_err(|_| "cleanupEvidenceLost")?
            {
                Outcome::Cleaned | Outcome::AlreadyCleaned => {
                    runtime.publish("cleaned", None);
                    return Ok(());
                }
                Outcome::RetryExhausted => return Err("cleanupLocked"),
                Outcome::Deferred { until_ms } => {
                    let delay = until_ms.saturating_sub(start.elapsed().as_millis() as u64);
                    std::thread::sleep(Duration::from_millis(delay.min(200)));
                }
            }
        }
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
    fn real_production_gates_remain_disabled() {
        assert!(!crate::startup_update::HANDOFF_RELEASE_VALIDATED);
        assert!(crate::update_package::production_key().is_none());
    }
}

#[cfg(test)]
mod coordinator_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]
    fn disabled_startup_and_health_routes_have_no_notifications_or_native_discovery() {
        let count = Arc::new(AtomicUsize::new(0));
        for startup in [
            Startup::Ordinary,
            Startup::Invalid,
            Startup::Health("a".repeat(32)),
        ] {
            let rt = Runtime::new(startup);
            let notices = count.clone();
            rt.start(Arc::new(move |_| {
                notices.fetch_add(1, Ordering::SeqCst);
            }));
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
