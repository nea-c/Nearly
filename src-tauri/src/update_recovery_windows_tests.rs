use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::cell::Cell;

fn retained_test_peer() -> LivePeer {
    let path = std::env::current_exe().unwrap();
    let proof = FileProof::open(&path, false).unwrap().1;
    LivePeer::open(&current_process_identity().unwrap(), &path, &proof).unwrap()
}

#[test]
fn retained_exit_race_requires_a_second_exact_signaled_observation() {
    let id = ProcessIdentity { pid: 42, created: 100 };
    let waits = Cell::new(0);
    let identities = Cell::new(0);
    let result = observe_retained_exit(&id, Path::new("owned.exe"), || {
        identities.set(identities.get() + 1); Ok(id.clone())
    }, || {
        waits.set(waits.get() + 1); Ok(waits.get() == 2)
    }, || Err(Error::Unsafe), || Ok(7));
    assert_eq!(result.unwrap(), Some(7));
    assert_eq!(waits.get(), 2);
    assert_eq!(identities.get(), 2);
}

#[test]
fn retained_exit_race_never_rescues_live_changed_or_uncertain_processes() {
    let id = ProcessIdentity { pid: 42, created: 100 };
    for case in 0..6 {
        let identities = Cell::new(0);
        let waits = Cell::new(0);
        let result = observe_retained_exit(&id, Path::new("owned.exe"), || {
            identities.set(identities.get() + 1);
            if identities.get() == 2 {
                if case == 1 { return Ok(ProcessIdentity { pid: 42, created: 101 }); }
                if case == 2 { return Err(Error::Unsafe); }
            }
            Ok(id.clone())
        }, || {
            waits.set(waits.get() + 1);
            if waits.get() == 1 || case == 0 { return Ok(false); }
            if case == 3 { return Err(Error::Uncertain); }
            Ok(true)
        }, || Err(Error::Unsafe), || {
            if case == 4 { Err(Error::Uncertain) } else { Ok(259) }
        });
        assert!(result.is_err(), "case {case} must refuse");
    }
}

#[test]
fn retained_exit_race_never_rescues_a_successfully_mismatching_path() {
    let id = ProcessIdentity { pid: 42, created: 100 };
    let waits = Cell::new(0);
    assert!(observe_retained_exit(&id, Path::new("owned.exe"), || Ok(id.clone()), || {
        waits.set(waits.get() + 1); Ok(false)
    }, || Ok(PathBuf::from("foreign.exe")), || panic!("not authorized")).is_err());
    assert_eq!(waits.get(), 1);
}

#[test]
fn retained_exit_normal_live_and_already_signaled_paths_are_preserved() {
    let id = ProcessIdentity { pid: 42, created: 100 };
    assert_eq!(observe_retained_exit(&id, Path::new("owned.exe"), || Ok(id.clone()),
        || Ok(false), || Ok(PathBuf::from("owned.exe")), || panic!("still live")).unwrap(), None);
    assert_eq!(observe_retained_exit(&id, Path::new("owned.exe"), || Ok(id.clone()),
        || Ok(true), || panic!("exited path is not required"), || Ok(0)).unwrap(), Some(0));
}

#[test]
fn live_retained_child_waits_for_an_observed_clean_foreign_set() {
    let fixture = Fixture::new();
    let root = PinnedRoot::fixture(&fixture.0).unwrap();
    let peer = retained_test_peer();
    let calls = Cell::new(0);
    let pauses = Cell::new(0);
    let result = settled_no_file_users_with(&root, Some(&peer), |root, peer| {
        root.verify()?;
        assert_eq!(peer.unwrap().exited()?, None);
        calls.set(calls.get() + 1);
        Ok(calls.get() == 3)
    }, || Duration::from_millis(pauses.get() * 25), || pauses.set(pauses.get() + 1));
    assert!(result.unwrap());
    assert_eq!(calls.get(), 3);
    assert_eq!(pauses.get(), 2);
}

#[test]
fn persistent_foreign_users_exhaust_one_fixed_deadline_and_refuse() {
    let fixture = Fixture::new();
    let root = PinnedRoot::fixture(&fixture.0).unwrap();
    let peer = retained_test_peer();
    let now = Cell::new(0);
    let calls = Cell::new(0);
    let result = settled_no_file_users_with(&root, Some(&peer), |_, _| {
        calls.set(calls.get() + 1); Ok(false)
    }, || Duration::from_millis(now.get()), || now.set(now.get() + 25));
    assert!(!result.unwrap());
    assert_eq!(now.get(), 2000);
    assert_eq!(calls.get(), 81);
    assert_eq!(std::fs::read(fixture.0.join("Nearly.exe")).unwrap(), b"old image");
}

#[test]
fn uncertain_file_users_refuse_without_waiting_or_authorizing_effects() {
    let fixture = Fixture::new();
    let root = PinnedRoot::fixture(&fixture.0).unwrap();
    let peer = retained_test_peer();
    let result = settled_no_file_users_with(&root, Some(&peer), |_, _| Err(Error::Uncertain),
        || Duration::ZERO, || panic!("uncertainty must not be retried"));
    assert!(matches!(result, Err(Error::Uncertain)));
    assert_eq!(std::fs::read(fixture.0.join("Nearly.exe")).unwrap(), b"old image");
}

#[test]
fn no_retained_child_does_not_grant_an_observation_wait() {
    let fixture = Fixture::new();
    let root = PinnedRoot::fixture(&fixture.0).unwrap();
    assert!(!settled_no_file_users_with(&root, None, |_, _| Ok(false),
        || Duration::ZERO, || panic!("no retained child")).unwrap());
}

#[test]
fn file_user_hints_are_fixed_and_cannot_exclude_foreign_identities() {
    let own = ProcessIdentity { pid: 1, created: 100 };
    let child = ProcessIdentity { pid: 2, created: 200 };
    let mut entry: RmInfo = unsafe { std::mem::zeroed() };
    entry.process.pid = child.pid;
    entry.process.created.dwLowDateTime = child.created as u32;
    assert!(rm_identity_allowed(&entry, &own, Some(&child)));
    entry.process.created.dwLowDateTime += 1;
    assert!(!rm_identity_allowed(&entry, &own, Some(&child)));
    assert_eq!(file_user_hint(&entry, Some(&child)), "childIdentityMismatch");
    entry.process.pid = 3;
    let fill = |entry: &mut RmInfo, name: &str| {
        entry.application.fill(0);
        for (a, b) in entry.application.iter_mut().zip(name.encode_utf16()) { *a = b; }
    };
    fill(&mut entry, "MsMpEng.exe");
    assert_eq!(file_user_hint(&entry, Some(&child)), "scannerHint");
    assert!(!rm_identity_allowed(&entry, &own, Some(&child)));
    fill(&mut entry, "msedgewebview2.exe");
    assert_eq!(file_user_hint(&entry, Some(&child)), "webviewHint");
    assert!(!rm_identity_allowed(&entry, &own, Some(&child)));
    fill(&mut entry, "C:\\private\\unknown-token.exe");
    assert_eq!(file_user_hint(&entry, Some(&child)), "unknown");
    assert!(!rm_identity_allowed(&entry, &own, Some(&child)));
}

static NEXT: AtomicUsize = AtomicUsize::new(1);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "nearly-recovery-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        std::fs::write(p.join("Nearly.exe"), b"old image").unwrap();
        std::fs::write(p.join("uninstall.exe"), b"old uninstaller").unwrap();
        std::fs::write(p.join("settings.json"), b"settings sentinel").unwrap();
        Self(p)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("NEARLY_RECOVERY_RM_TRACE").is_some() {
            eprintln!(
                "retained generated RM diagnostic fixture: {}",
                self.0.display()
            );
            return;
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn root_only_capture_survives_absent_live_executable() {
    let f = Fixture::new();
    std::fs::remove_file(f.0.join("Nearly.exe")).unwrap();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    assert_eq!(root.path(), f.0);
}

#[test]
fn every_native_rename_boundary_has_exact_recoverable_tuple() {
    let mut succeeded = 0;
    for fail in 0..48 {
        let f = Fixture::new();
        let root = PinnedRoot::fixture(&f.0).unwrap();
        let mut tx = FixtureTransaction::prepare(&root).unwrap();
        let result = tx.apply_with_fault(fail);
        if result.is_err() {
            tx.session.record = tx.session.store.read().unwrap().unwrap();
            tx.restore_with_fault(usize::MAX).unwrap();
        }
        let image = std::fs::read(f.0.join("Nearly.exe")).unwrap();
        let uninstaller = std::fs::read(f.0.join("uninstall.exe")).unwrap();
        if result.is_ok() {
            succeeded += 1;
            assert_eq!(image, b"new image");
            assert_eq!(uninstaller, b"new uninstaller");
        } else {
            assert_eq!(image, b"old image");
            assert_eq!(uninstaller, b"old uninstaller");
        }
        assert_eq!(
            std::fs::read(f.0.join("settings.json")).unwrap(),
            b"settings sentinel"
        );
        assert_eq!(std::fs::read(tx.backup_path(0)).unwrap(), b"old image");
        assert_eq!(
            std::fs::read(tx.backup_path(1)).unwrap(),
            b"old uninstaller"
        );
    }
    assert!(
        succeeded > 0,
        "fault range must include an uninterrupted successful apply"
    );
}

#[test]
fn raw_registry_absence_and_foreign_type_survive_exact_inverse() {
    let f = Fixture::new();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    let mut tx = FixtureTransaction::prepare(&root).unwrap();
    tx.apply_with_fault(usize::MAX).unwrap();
    tx.restore_with_fault(usize::MAX).unwrap();
    assert_eq!(tx.registry_values().unwrap(), tx.old_values());
    assert_eq!(tx.unrelated_value().unwrap(), b"unrelated sentinel");
}

#[test]
fn hardlinked_image_and_missing_uninstaller_fail_before_backup() {
    for missing in [false, true] {
        let f = Fixture::new();
        if missing {
            std::fs::remove_file(f.0.join("uninstall.exe")).unwrap();
        } else {
            std::fs::hard_link(f.0.join("Nearly.exe"), f.0.join("foreign-link.exe")).unwrap();
        }
        let root = PinnedRoot::fixture(&f.0).unwrap();
        assert!(FixtureTransaction::prepare(&root).is_err());
        assert!(!f.0.join(".Nearly-update-state").exists());
    }
}
#[test]
fn named_stream_is_not_an_owned_single_stream_candidate() {
    let f = Fixture::new();
    let path = f.0.join("Nearly.exe");
    std::fs::write(format!("{}:foreign", path.display()), b"foreign stream").unwrap();
    assert!(FileProof::open(&path, false).is_err());
}
#[test]
fn global_fixture_mutex_excludes_then_releases_without_abandonment() {
    let name = format!(
        "Global\\NearlyRecoveryFixture-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let first = MutationMutex::acquire(&name).unwrap();
    assert!(MutationMutex::acquire(&name).is_err());
    drop(first);
    let second = MutationMutex::acquire(&name).unwrap();
    drop(second);
}
#[test]
fn settings_anchor_binds_actual_all_five_files_and_refuses_an_external_override() {
    let f = Fixture::new();
    let outside = Fixture::new();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    assert!(validate_settings_anchor(&root, &f.0.join("settings.json")).is_ok());
    assert!(validate_settings_anchor(&root, &outside.0.join("settings.json")).is_err());
    assert!(validate_settings_anchor(&root, &f.0.join("other.json")).is_err());
    let before = settings_fingerprint(&root).unwrap();
    std::fs::write(f.0.join("history.json"), b"changed history").unwrap();
    assert_ne!(settings_fingerprint(&root).unwrap(), before);
}

struct FixtureTransaction {
    session: RecoverySession,
    key: String,
}
impl FixtureTransaction {
    fn prepare(root: &PinnedRoot) -> Result<Self> {
        let key = format!(
            "Software\\NearlyRecoveryFixture\\{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut handle = std::ptr::null_mut();
        let mut disposition = 0;
        if unsafe {
            RegCreateKeyExW(
                0x80000001usize as RawHandle,
                wide(&key).as_ptr(),
                0,
                std::ptr::null_mut(),
                0,
                0xf003f | 0x100,
                std::ptr::null(),
                &mut handle,
                &mut disposition,
            )
        } != 0
        {
            return Err(Error::Io);
        }
        let registry = RegistryKey {
            handle,
            sub: key.clone(),
        };
        for (name, value) in [
            ("DisplayVersion", RawValue::string("0.2.0")),
            (
                "EstimatedSize",
                RawValue {
                    present: true,
                    kind: 3,
                    bytes: vec![7, 8, 0],
                },
            ),
            (
                "Unrelated",
                RawValue {
                    present: true,
                    kind: 3,
                    bytes: b"unrelated sentinel".to_vec(),
                },
            ),
        ] {
            if unsafe {
                RegSetValueExW(
                    handle,
                    wide(name).as_ptr(),
                    0,
                    value.kind,
                    value.bytes.as_ptr(),
                    value.bytes.len() as u32,
                )
            } != 0
            {
                return Err(Error::Io);
            }
        }
        let exe = root.path().join("Nearly.exe");
        let uninstall = root.path().join("uninstall.exe");
        for (name, value) in [
            ("NearlyOwner", RawValue::string("local.syncfiles.native")),
            ("DisplayName", RawValue::string("Nearly")),
            ("Publisher", RawValue::string("Nearly")),
            (
                "InstallLocation",
                RawValue::string(root.path().to_str().unwrap()),
            ),
            (
                "DisplayIcon",
                RawValue::string(&format!("\"{}\",0", exe.display())),
            ),
            (
                "UninstallString",
                RawValue::string(&format!("\"{}\"", uninstall.display())),
            ),
            (
                "QuietUninstallString",
                RawValue::string(&format!("\"{}\" /S", uninstall.display())),
            ),
            ("NoModify", RawValue::dword(1)),
            ("NoRepair", RawValue::dword(1)),
        ] {
            if unsafe {
                RegSetValueExW(
                    handle,
                    wide(name).as_ptr(),
                    0,
                    value.kind,
                    value.bytes.as_ptr(),
                    value.bytes.len() as u32,
                )
            } != 0
            {
                return Err(Error::Io);
            }
        }
        let (_, installer) = FileProof::open(&root.path().join("Nearly.exe"), false)?;
        let material = PackageMaterial {
            source_version: "0.2.0".into(),
            target_version: "2.0.0".into(),
            public_label: "r2.0".into(),
            signature: "generated-fixture".into(),
            payload_sha256: sha256(b"new image"),
            installer_name: "Nearly_r2.0_x64-setup.exe".into(),
            installer,
        };
        let mut session = RecoverySession::prepare(
            root,
            registry,
            material,
            Some(settings_fingerprint(root)?),
            &format!(
                "Local\\NearlyRecoveryFixtureMutex-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ),
        )?;
        for (index, bytes) in [
            (0, b"new image".as_slice()),
            (1, b"new uninstaller".as_slice()),
        ] {
            std::fs::write(session.candidate_path(index), bytes).map_err(|_| Error::Io)?;
            let proof = FileProof::open(&session.candidate_path(index), false)?.1;
            session.candidate_pins[index] = Some(FileProof::pin_shared(
                &session.candidate_path(index),
                &proof,
            )?);
            session.record.files[index].candidate = Some(proof);
        }
        session.record.new_values = [
            RawValue::string("r2.0"),
            RawValue::string("2.0.0"),
            RawValue::dword(1),
        ];
        session.record.engine = RecoveryRecord {
            sequence: 1,
            phase: RecoveryPhase::CandidatesVerified,
            step: None,
        };
        session.publish()?;
        Ok(Self { session, key })
    }
    fn walk(&mut self, direction: Direction, at: usize) -> Result<()> {
        let mut boundary = Boundary { at, count: 0 };
        let mut order = model::APPLY_ORDER;
        if direction == Direction::Restore {
            order.reverse();
        }
        for object in order {
            boundary.hit()?;
            self.session.record.engine.phase = if direction == Direction::Apply {
                RecoveryPhase::Applying
            } else {
                RecoveryPhase::Restoring
            };
            self.session.record.engine.sequence += 1;
            self.session.record.engine.step = Some(model::MutationStep {
                object,
                direction,
                status: StepStatus::Intent,
            });
            self.session.publish()?;
            boundary.hit()?;
            self.session
                .mutate(object, direction, &mut boundary)
                .map_err(|e| {
                    eprintln!("fixture {direction:?} {object:?} failed: {e:?}");
                    e
                })?;
            self.session.record.engine.step.as_mut().unwrap().status = StepStatus::Observed;
            self.session.publish()?;
            boundary.hit()?;
        }
        Ok(())
    }
    fn apply_with_fault(&mut self, at: usize) -> Result<()> {
        self.walk(Direction::Apply, at)
    }
    fn restore_with_fault(&mut self, at: usize) -> Result<()> {
        self.walk(Direction::Restore, at)
    }
    fn backup_path(&self, index: usize) -> PathBuf {
        self.session.backup_path(index)
    }
    fn registry_values(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&self.session.registry.snapshot()?).unwrap())
    }
    fn old_values(&self) -> Vec<u8> {
        serde_json::to_vec(&self.session.record.old_values).unwrap()
    }
    fn unrelated_value(&self) -> Result<Vec<u8>> {
        Ok(self.session.registry.read_named("Unrelated")?.bytes)
    }
}
impl Drop for FixtureTransaction {
    fn drop(&mut self) {
        unsafe {
            RegDeleteTreeW(0x80000001usize as RawHandle, wide(&self.key).as_ptr());
        }
    }
}

#[test]
#[ignore]
fn bounded_peer_fixture() {
    std::thread::sleep(Duration::from_millis(
        std::env::var("NEARLY_RECOVERY_PEER_DELAY")
            .unwrap()
            .parse()
            .unwrap(),
    ));
    std::process::exit(
        std::env::var("NEARLY_RECOVERY_PEER_EXIT")
            .unwrap()
            .parse()
            .unwrap(),
    );
}
fn peer_fixture(delay: u64, code: i32) -> (Child, ProcessIdentity, PathBuf, FileProof) {
    let path = std::env::current_exe().unwrap();
    let child = Command::new(&path)
        .args([
            "update_recovery_windows::tests::bounded_peer_fixture",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env("NEARLY_RECOVERY_PEER_DELAY", delay.to_string())
        .env("NEARLY_RECOVERY_PEER_EXIT", code.to_string())
        .spawn()
        .unwrap();
    let identity = process_identity(child.as_raw_handle(), child.id()).unwrap();
    let (_, proof) = FileProof::open(&path, false).unwrap();
    (child, identity, path, proof)
}
#[test]
fn exact_retained_peer_requires_pid_creation_image_and_natural_exit() {
    let (mut child, id, path, proof) = peer_fixture(500, 7);
    let peer = LivePeer::open(&id, &path, &proof).unwrap();
    assert_eq!(peer.exited().unwrap(), None);
    assert!(LivePeer::open(
        &ProcessIdentity {
            pid: id.pid,
            created: id.created + 1
        },
        &path,
        &proof
    )
    .is_err());
    let mut wrong = proof.clone();
    wrong.sha256 = sha256(b"foreign image");
    assert!(LivePeer::open(&id, &path, &wrong).is_err());
    assert!(child.try_wait().unwrap().is_none());
    assert_eq!(child.wait().unwrap().code(), Some(7));
    assert_eq!(peer.exited().unwrap(), Some(7));
}
#[test]
fn reserved_helper_switches_never_fall_through_to_tauri() {
    let nonce = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        parse_helper(["Nearly.exe", "ordinary.txt"]),
        HelperParse::Ordinary
    );
    for args in [
        vec!["Nearly.exe".into(), "--nearly-recovery".into()],
        vec![
            "Nearly.exe".into(),
            format!("--nearly-recovery={nonce}"),
            "--nearly-parent=1:2".into(),
            "extra".into(),
        ],
        vec![
            "Nearly.exe".into(),
            format!("--nearly-recovery={nonce}"),
            "--nearly-parent=01:2".into(),
        ],
        vec!["Nearly.exe".into(), "--nearly-recovery-only=BAD".into()],
    ] {
        assert_eq!(parse_helper(args), HelperParse::Invalid);
    }
    assert_eq!(
        parse_helper([
            "Nearly.exe",
            &format!("--nearly-recovery={nonce}"),
            "--nearly-parent=12:34"
        ]),
        HelperParse::Helper(HelperArgs {
            nonce: nonce.into(),
            parent: Some(ProcessIdentity {
                pid: 12,
                created: 34
            }),
            recovery_only: false
        })
    );
    assert_eq!(
        parse_helper(["Nearly.exe", &format!("--nearly-recovery-only={nonce}")]),
        HelperParse::Helper(HelperArgs {
            nonce: nonce.into(),
            parent: None,
            recovery_only: true
        })
    );
}
#[test]
fn exact_parent_exit_without_commit_never_authorizes_recovery() {
    for committed in [false, true] {
        let (mut child, id, path, proof) = peer_fixture(250, 0);
        let peer = LivePeer::open(&id, &path, &proof).unwrap();
        let events = RecoveryEvents::fresh(&random_nonce().unwrap()).unwrap();
        if committed {
            events.commit.set().unwrap();
        }
        let start = Instant::now();
        let result = await_parent_exit(&peer, &events, Duration::from_secs(3));
        assert_eq!(result.is_ok(), committed);
        assert!(child.wait().unwrap().success());
        if committed {
            assert!(start.elapsed() >= Duration::from_millis(100));
        }
    }
}
#[test]
fn stale_events_and_abort_refuse_before_any_mutation() {
    let nonce = random_nonce().unwrap();
    let events = RecoveryEvents::fresh(&nonce).unwrap();
    assert!(RecoveryEvents::fresh(&nonce).is_err());
    events.commit.set().unwrap();
    assert!(RecoveryEvents::open(&nonce).is_err());
    let (mut child, id, path, proof) = peer_fixture(200, 0);
    let peer = LivePeer::open(&id, &path, &proof).unwrap();
    events.abort.set().unwrap();
    assert!(await_parent_exit(&peer, &events, Duration::from_secs(3)).is_err());
    assert!(child.try_wait().unwrap().is_none());
    assert!(child.wait().unwrap().success());
}
#[test]
fn competing_ordinary_startup_is_fenced_by_incomplete_or_missing_record() {
    let f = Fixture::new();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    assert!(observed_startup_admission(&root).is_ok());
    let mut tx = FixtureTransaction::prepare(&root).unwrap();
    assert!(observed_startup_admission(&root).is_err());
    tx.session.record.engine = RecoveryRecord {
        sequence: 2,
        phase: RecoveryPhase::Succeeded,
        step: None,
    };
    tx.session.publish().unwrap();
    assert!(observed_startup_admission(&root).is_ok());
    std::fs::remove_file(tx.session.store.directory.join("recovery-v3.dpapi")).unwrap();
    assert!(observed_startup_admission(&root).is_err());
}
struct FixtureSupervisor {
    healthy: bool,
    stage_exit: i32,
    bad_candidate: bool,
}
impl SupervisorIo for FixtureSupervisor {
    fn stage(&mut self, s: &mut RecoverySession) -> Result<Option<WorkerExit>> {
        let path = std::env::current_exe().unwrap();
        let proof = FileProof::open(&path, false)?.1;
        let child = Command::new(&path)
            .args([
                "update_recovery_windows::tests::generated_stage_fixture",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("NEARLY_RECOVERY_FIXTURE_ROOT", s.store.root.path())
            .env("NEARLY_RECOVERY_FIXTURE_NONCE", &s.record.nonce)
            .env(
                "NEARLY_RECOVERY_FIXTURE_STAGE_EXIT",
                self.stage_exit.to_string(),
            )
            .env(
                "NEARLY_RECOVERY_FIXTURE_STAGE_BAD",
                if self.bad_candidate { "yes" } else { "no" },
            )
            .spawn()
            .map_err(|_| Error::Io)?;
        let identity = process_identity(child.as_raw_handle(), child.id())?;
        let peer = LivePeer::open(&identity, &path, &proof)?;
        let suffix = format!("{}-{}-{}", s.record.nonce, identity.pid, identity.created);
        let authorize = Event::fresh_name(&format!("Local\\NearlyStageAuthorize-{suffix}"))?;
        let ready = Event::fresh_name(&format!("Local\\NearlyStageReady-{suffix}"))?;
        s.record.worker = Some(identity);
        s.publish()?;
        authorize.set()?;
        let start = Instant::now();
        let mut seen = false;
        loop {
            let exited = peer.exited()?;
            if !seen {
                if exited.is_some() {
                    return Err(Error::Uncertain);
                }
                seen = ready.is_set()?;
            } else if let Some(_code) = exited {
                return Ok(Some(WorkerExit {
                    peer,
                    nonce: s.record.nonce.clone(),
                    _child: child,
                    _authorize: authorize,
                    _ready: ready,
                }));
            }
            if start.elapsed() > Duration::from_secs(5) {
                return Err(Error::Busy);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn inspect(
        &mut self,
        s: &mut RecoverySession,
        w: &WorkerExit,
        p: &crate::update_package::PackageProof,
    ) -> Result<()> {
        if w.peer.exited()? != Some(0)
            || s.record.worker.as_ref() != Some(&w.peer.identity)
            || w.nonce != s.record.nonce
        {
            return Err(Error::Unsafe);
        }
        inspect_candidate_files(s, p)
    }
    fn launch(&mut self, s: &mut RecoverySession) -> Result<(Child, LivePeer)> {
        let mut command = Command::new(s.live_path(0));
        command
            .args([
                "update_recovery_windows::tests::generated_health_fixture",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("NEARLY_RECOVERY_FIXTURE_ROOT", s.store.root.path())
            .env("NEARLY_RECOVERY_FIXTURE_NONCE", &s.record.nonce)
            .env(
                "NEARLY_RECOVERY_FIXTURE_HEALTH",
                if self.healthy { "success" } else { "fail" },
            );
        launch_health_command(s, &mut command)
    }
    fn health_timeout(&self) -> Duration {
        Duration::from_millis(300)
    }
}
#[test]
#[ignore]
fn generated_stage_fixture() {
    let root = PinnedRoot::fixture(Path::new(
        &std::env::var("NEARLY_RECOVERY_FIXTURE_ROOT").unwrap(),
    ))
    .unwrap();
    let nonce = std::env::var("NEARLY_RECOVERY_FIXTURE_NONCE").unwrap();
    let id = current_process_identity().unwrap();
    let suffix = format!("{nonce}-{}-{}", id.pid, id.created);
    let start = Instant::now();
    let authorize = loop {
        if let Ok(event) = Event::open_name(&format!("Local\\NearlyStageAuthorize-{suffix}")) {
            if event.is_set().unwrap() {
                break event;
            }
        }
        assert!(start.elapsed() < Duration::from_secs(4));
        std::thread::sleep(Duration::from_millis(10));
    };
    let _authorize = authorize;
    let ready = Event::open_name(&format!("Local\\NearlyStageReady-{suffix}")).unwrap();
    ready.set().unwrap();
    let candidate = root
        .path()
        .join(crate::update_transaction::STATE_DIRECTORY)
        .join(&nonce)
        .join("candidate");
    std::fs::copy(
        std::env::current_exe().unwrap(),
        candidate.join("Nearly.exe"),
    )
    .unwrap();
    let mut pe = vec![0u8; 128];
    pe[..2].copy_from_slice(b"MZ");
    pe[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());
    pe[64..68].copy_from_slice(b"PE\0\0");
    pe[68..70].copy_from_slice(&0x14cu16.to_le_bytes());
    pe[88..90].copy_from_slice(&0x10bu16.to_le_bytes());
    std::fs::write(
        candidate.join("uninstall.exe"),
        if std::env::var("NEARLY_RECOVERY_FIXTURE_STAGE_BAD").unwrap() == "yes" {
            b"malformed".as_slice()
        } else {
            pe.as_slice()
        },
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let code = std::env::var("NEARLY_RECOVERY_FIXTURE_STAGE_EXIT")
        .unwrap()
        .parse::<i32>()
        .unwrap();
    if code != 0 {
        std::process::exit(code);
    }
}
#[test]
#[ignore]
fn generated_health_fixture() {
    let root = PinnedRoot::fixture(Path::new(
        &std::env::var("NEARLY_RECOVERY_FIXTURE_ROOT").unwrap(),
    ))
    .unwrap();
    let nonce = std::env::var("NEARLY_RECOVERY_FIXTURE_NONCE").unwrap();
    let start = Instant::now();
    let identity = current_process_identity().unwrap();
    let record = loop {
        if let Ok(Some(record)) = observe_record(&root) {
            if record.child.as_ref() == Some(&identity) {
                break record;
            }
        }
        assert!(start.elapsed() < Duration::from_secs(4));
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(record.nonce, nonce);
    let (_, image) = FileProof::open(&std::env::current_exe().unwrap(), false).unwrap();
    assert_eq!(image.sha256, record.payload_sha256);
    Event::open("Idle", &nonce).unwrap().set().unwrap();
    if std::env::var("NEARLY_RECOVERY_FIXTURE_HEALTH").unwrap() == "success" {
        Event::open("Healthy", &nonce).unwrap().set().unwrap();
    }
    let success = Event::open("Success", &nonce).unwrap();
    let request = Event::open("ExitRequest", &nonce).unwrap();
    loop {
        if success.is_set().unwrap() {
            assert_eq!(
                observe_record(&root).unwrap().unwrap().engine.phase,
                RecoveryPhase::Succeeded
            );
            Event::open("SuccessAck", &nonce).unwrap().set().unwrap();
            break;
        }
        if request.is_set().unwrap() {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn generated_supervisor_case(healthy: bool, stage_exit: i32, bad_candidate: bool) {
    let f = Fixture::new();
    std::fs::write(f.0.join("owned-shortcut.lnk"), b"shortcut sentinel").unwrap();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    let mut tx = FixtureTransaction::prepare(&root).unwrap();
    for i in 0..2 {
        tx.session.candidate_pins[i] = None;
        std::fs::remove_file(tx.session.candidate_path(i)).unwrap();
    }
    let payload = std::fs::read(std::env::current_exe().unwrap()).unwrap();
    let (mut stage, candidate, key) =
        crate::update_package::fixture_stage(&f.0, "2.0.0", &sha256(&payload));
    let snapshot = stage.transaction_snapshot(&candidate, &key).unwrap();
    let package = snapshot.package().clone();
    tx.session.record.installer = FileProof::open(snapshot.path(), false).unwrap().1;
    tx.session.record.package_signature = String::from_utf8(package.signature().to_vec()).unwrap();
    tx.session.record.payload_sha256 = sha256(&payload);
    tx.session.record.files[0].candidate = None;
    tx.session.record.files[1].candidate = None;
    tx.session.record.engine = RecoveryRecord {
        sequence: 1,
        phase: RecoveryPhase::Armed,
        step: None,
    };
    tx.session.publish().unwrap();
    let (mut parent, id, path, proof) = peer_fixture(100, 0);
    let parent_peer = LivePeer::open(&id, &path, &proof).unwrap();
    parent.wait().unwrap();
    let events = RecoveryEvents::fresh(&tx.session.record.nonce).unwrap();
    events.commit.set().unwrap();
    let result = supervise_with(
        &mut tx.session,
        &events,
        &parent_peer,
        &package,
        &mut FixtureSupervisor {
            healthy,
            stage_exit,
            bad_candidate,
        },
    );
    if healthy {
        assert!(
            result.is_ok(),
            "healthy supervisor result={result:?} phase={:?}",
            tx.session.record.engine.phase
        );
        assert_eq!(tx.session.record.engine.phase, RecoveryPhase::Succeeded);
        assert_eq!(
            sha256(&std::fs::read(f.0.join("Nearly.exe")).unwrap()),
            sha256(&payload)
        );
        assert_eq!(
            tx.session.registry.snapshot().unwrap(),
            tx.session.record.new_values
        );
    } else {
        assert_eq!(
            sha256(&std::fs::read(f.0.join("Nearly.exe")).unwrap()),
            sha256(b"old image"),
            "failed-health supervisor result={result:?} phase={:?}",
            tx.session.record.engine.phase
        );
        assert_eq!(
            std::fs::read(f.0.join("uninstall.exe")).unwrap(),
            b"old uninstaller"
        );
        assert_eq!(
            tx.session.registry.snapshot().unwrap(),
            tx.session.record.old_values
        );
        assert!(!tx.session.record.old_restart_attempted);
    }
    assert_eq!(
        std::fs::read(f.0.join("settings.json")).unwrap(),
        b"settings sentinel"
    );
    assert_eq!(
        std::fs::read(f.0.join("owned-shortcut.lnk")).unwrap(),
        b"shortcut sentinel"
    );
    assert_eq!(tx.unrelated_value().unwrap(), b"unrelated sentinel");
    assert!(tx.backup_path(0).exists() && tx.backup_path(1).exists());
}
#[test]
fn generated_supervisor_exact_nonzero_stage_restores_real_tuple() {
    generated_supervisor_case(false, 9, false);
}
#[test]
fn generated_supervisor_bad_candidate_restores_real_tuple() {
    generated_supervisor_case(false, 0, true);
}
#[test]
#[ignore = "Manual generated-process qualification; requires exclusive fixture-file access"]
fn generated_supervisor_success_real_tuple() {
    generated_supervisor_case(true, 0, false);
}
#[test]
#[ignore = "Manual generated-process qualification; requires exclusive fixture-file access"]
fn generated_supervisor_failed_health_restore_real_tuple() {
    generated_supervisor_case(false, 0, false);
}
#[test]
#[ignore]
fn fast_ready_exit_fixture() {
    let nonce = std::env::var("NEARLY_RECOVERY_FIXTURE_NONCE").unwrap();
    let id = current_process_identity().unwrap();
    let name = format!("Local\\NearlyStageReady-{nonce}-{}-{}", id.pid, id.created);
    let start = Instant::now();
    loop {
        if let Ok(event) = Event::open_name(&name) {
            event.set().unwrap();
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn ready_and_zero_exit_before_first_observation_is_valid_exact_worker_proof() {
    let nonce = random_nonce().unwrap();
    let path = std::env::current_exe().unwrap();
    let proof = FileProof::open(&path, false).unwrap().1;
    let mut child = Command::new(&path)
        .args([
            "update_recovery_windows::tests::fast_ready_exit_fixture",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env("NEARLY_RECOVERY_FIXTURE_NONCE", &nonce)
        .spawn()
        .unwrap();
    let id = process_identity(child.as_raw_handle(), child.id()).unwrap();
    let peer = LivePeer::open(&id, &path, &proof).unwrap();
    let suffix = format!("{nonce}-{}-{}", id.pid, id.created);
    let authorize = Event::fresh_name(&format!("Local\\NearlyStageAuthorize-{suffix}")).unwrap();
    let ready = Event::fresh_name(&format!("Local\\NearlyStageReady-{suffix}")).unwrap();
    authorize.set().unwrap();
    assert!(child.wait().unwrap().success());
    let exited = wait_stage_worker(peer, child, authorize, ready, &nonce, Duration::ZERO).unwrap();
    assert_eq!(exited.peer.exited().unwrap(), Some(0));
}
#[test]
fn changed_static_registration_refuses_apply_and_retains_original_live_tuple() {
    let f = Fixture::new();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    let mut tx = FixtureTransaction::prepare(&root).unwrap();
    let value = RawValue::string("foreign owner");
    assert_eq!(
        unsafe {
            RegSetValueExW(
                tx.session.registry.handle,
                wide("NearlyOwner").as_ptr(),
                0,
                value.kind,
                value.bytes.as_ptr(),
                value.bytes.len() as u32,
            )
        },
        0
    );
    assert!(tx.apply_with_fault(usize::MAX).is_err());
    assert_eq!(std::fs::read(f.0.join("Nearly.exe")).unwrap(), b"old image");
    assert_eq!(
        std::fs::read(f.0.join("uninstall.exe")).unwrap(),
        b"old uninstaller"
    );
    assert_eq!(tx.registry_values().unwrap(), tx.old_values());
    assert_eq!(
        tx.session.registry.read_named("NearlyOwner").unwrap(),
        value
    );
}
#[test]
fn candidate_and_restored_uninstaller_guards_deny_writers_across_owned_renames() {
    let f = Fixture::new();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    let mut tx = FixtureTransaction::prepare(&root).unwrap();
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .open(tx.session.candidate_path(1))
        .is_err());
    tx.apply_with_fault(usize::MAX).unwrap();
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .open(f.0.join("uninstall.exe"))
        .is_err());
    tx.restore_with_fault(usize::MAX).unwrap();
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .open(f.0.join("uninstall.exe"))
        .is_err());
}
#[test]
fn old_restart_attempt_is_durable_before_failed_spawn_and_cannot_repeat() {
    let f = Fixture::new();
    let path = f.0.join("settings.json");
    std::fs::remove_file(&path).unwrap();
    crate::unified_settings::save(
        &path,
        &crate::Settings {
            version: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let root = PinnedRoot::fixture(&f.0).unwrap();
    let mut tx = FixtureTransaction::prepare(&root).unwrap();
    tx.apply_with_fault(usize::MAX).unwrap();
    tx.restore_with_fault(usize::MAX).unwrap();
    tx.session.record.engine.phase = RecoveryPhase::Restored;
    tx.session.record.engine.step = None;
    tx.session.record.file_step = None;
    tx.session.publish().unwrap();
    let proof = tx.session.verify_restored_tuple(None).unwrap();
    // The old fixture is plain text, so this can never launch an ordinary app.
    assert!(tx.session.restart_previous(proof).is_err());
    assert!(
        tx.session
            .store
            .read()
            .unwrap()
            .unwrap()
            .old_restart_attempted
    );
    assert!(tx.session.verify_restored_tuple(None).is_err());
}
