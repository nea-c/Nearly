use super::*;
use crate::update_cleanup::engine::{Authority, Evidence, Files, Journal};
use std::{fs, os::windows::fs::OpenOptionsExt};

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root = std::env::temp_dir().join(format!(
            "nearly-native-transaction-{}-{}",
            std::process::id(),
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("Nearly.exe"), b"original fixture Nearly image").unwrap();
        fs::write(
            root.join("Nearly_r1.0_x64-setup.exe"),
            b"manual setup sentinel",
        )
        .unwrap();
        fs::write(root.join("sentinel.txt"), b"unrelated sentinel").unwrap();
        for name in crate::split_settings::NAMES {
            for path in [root.join(name),root.join(name).with_extension("backup.json")] {
                fs::write(&path,format!("generated preserved storage sentinel {}",path.file_name().unwrap().to_string_lossy())).unwrap();
            }
        }
        Self { root }
    }
    fn context(&self) -> NativeContext {
        windows_impl::capture(&self.root).unwrap()
    }
    fn record(&self, context: &NativeContext) -> TransactionRecord {
        let nonce = "a".repeat(32);
        let basename = format!("Nearly-update-1.1.0-{nonce}-setup.exe");
        let path = self.root.join(&basename);
        fs::write(&path, b"ordinary generated installer fixture").unwrap();
        let file = File::open(&path).unwrap();
        let metadata = file.metadata().unwrap();
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.unwrap();
        let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
        let binding = codec::Binding {
            nonce,
            root: context.root().clone(),
            release: codec::Release {
                internal_version: "1.1.0".into(),
                public_tag: "r1.1".into(),
                architecture: codec::Architecture::X64,
                download_asset: "Nearly_r1.1_x64-setup.exe".into(),
                signature_proof_digest: sha256(b"c2lnbmVkLWZpeHR1cmU="),
            },
            installer: codec::Installer {
                basename,
                identity: codec::Identity {
                    volume: info.dwVolumeSerialNumber as u64,
                    file_id: format!("{index:032x}"),
                },
                length: metadata.len(),
                sha256: sha256(b"ordinary generated installer fixture"),
            },
        };
        windows_impl::fixture_record(context, binding).unwrap()
    }
    fn sentinels_unchanged(&self) {
        for name in crate::split_settings::NAMES {
            for path in [self.root.join(name),self.root.join(name).with_extension("backup.json")] {
                assert_eq!(fs::read(&path).unwrap(),format!("generated preserved storage sentinel {}",path.file_name().unwrap().to_string_lossy()).as_bytes());
            }
        }
        assert_eq!(
            fs::read(self.root.join("Nearly_r1.0_x64-setup.exe")).unwrap(),
            b"manual setup sentinel"
        );
        assert_eq!(
            fs::read(self.root.join("sentinel.txt")).unwrap(),
            b"unrelated sentinel"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only generated fixture files and one known subdirectory; no recursive walk.
        for parent in [self.root.join(STATE_DIRECTORY), self.root.clone()] {
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
struct IndependentFixtureEvidence {
    binding: codec::Binding,
    healthy: bool,
}
impl Authority for IndependentFixtureEvidence {
    fn verify(&mut self, b: &codec::Binding, _: Evidence) -> std::result::Result<(), String> {
        if b == &self.binding && self.healthy {
            Ok(())
        } else {
            Err("fixture native authority denied".into())
        }
    }
}
fn pending(
    context: &NativeContext,
    record: TransactionRecord,
) -> (
    TransactionStore,
    engine::Lifecycle,
    IndependentFixtureEvidence,
) {
    let mut authority = IndependentFixtureEvidence {
        binding: record.receipt.binding.clone(),
        healthy: true,
    };
    let binding = record.receipt.binding.clone();
    let mut store = windows_impl::fixture_store(context, record).unwrap();
    let mut lifecycle = engine::Lifecycle::prepare(binding, &mut authority, &mut store).unwrap();
    for next in [
        codec::State::HandoffCommitted,
        codec::State::InstallationSucceeded,
        codec::State::RestartHealthy,
        codec::State::CleanupPending,
    ] {
        lifecycle.advance(next, &mut authority, &mut store).unwrap();
    }
    (store, lifecycle, authority)
}

#[test]
fn production_context_is_disabled_without_both_existing_release_gates() {
    assert!(matches!(
        NativeContext::capture_current_install(),
        Err(Error::Disabled)
    ));
}
#[test]
fn real_user_dpapi_roundtrip_tamper_and_root_relocation_fail_closed() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let mut store = windows_impl::fixture_store(&context, record.clone()).unwrap();
    let mut authority = IndependentFixtureEvidence {
        binding: record.receipt.binding.clone(),
        healthy: true,
    };
    engine::Lifecycle::prepare(record.receipt.binding.clone(), &mut authority, &mut store).unwrap();
    let path = fixture.root.join(STATE_DIRECTORY).join("transaction.dpapi");
    let protected = fs::read(&path).unwrap();
    assert!(!protected
        .windows(b"package_signature".len())
        .any(|b| b == b"package_signature"));
    assert_eq!(store.recovery_hint().unwrap(), Some(record));
    drop(store);
    let mut tampered = protected.clone();
    let index = tampered.len() - 1;
    tampered[index] ^= 1;
    fs::write(&path, &tampered).unwrap();
    assert!(TransactionStore::open(&context).is_err());
    fs::write(&path, &protected).unwrap();
    let foreign = Fixture::new();
    let foreign_context = foreign.context();
    let foreign_store = TransactionStore::open(&foreign_context).unwrap();
    drop(foreign_store);
    fs::write(
        foreign.root.join(STATE_DIRECTORY).join("transaction.dpapi"),
        &protected,
    )
    .unwrap();
    assert!(TransactionStore::open(&foreign_context).is_err());
    fixture.sentinels_unchanged();
    foreign.sentinels_unchanged();
}
#[test]
fn exclusive_native_lease_rejects_other_store_and_stale_recovery() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let (mut first, mut life, mut authority) = pending(&context, record);
    let hint = first.recovery_hint().unwrap().unwrap();
    let mut second = TransactionStore::open(&context).unwrap();
    first.begin(Some(&hint.receipt)).unwrap();
    assert!(matches!(
        second.begin(Some(&hint.receipt)),
        Err(engine::CommitError::Busy)
    ));
    first.end();
    let mut files = NativeFiles::new(&context);
    life.cleanup(0, &mut authority, &mut first, &mut files)
        .unwrap();
    assert!(matches!(
        second.begin(Some(&hint.receipt)),
        Err(engine::CommitError::Stale)
    ));
    fixture.sentinels_unchanged();
}
#[test]
fn actual_handle_cleanup_preserves_manual_setup_sentinel_and_original_backup() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let stage = fixture
        .root
        .join(&record.receipt.binding.installer.basename);
    let backup = fixture.root.join(&record.old_image.basename);
    let (mut store, mut life, mut authority) = pending(&context, record);
    let mut files = NativeFiles::new(&context);
    assert_eq!(
        life.cleanup(0, &mut authority, &mut store, &mut files),
        Ok(engine::Outcome::Cleaned)
    );
    assert!(!stage.exists());
    assert_eq!(fs::read(&backup).unwrap(), b"original fixture Nearly image");
    fixture.sentinels_unchanged();
    let recovered = store.recovery_hint().unwrap().unwrap();
    let mut lifecycle =
        engine::Lifecycle::recover(&codec::encode(&recovered.receipt).unwrap()).unwrap();
    assert_eq!(
        lifecycle.cleanup(1, &mut authority, &mut store, &mut files),
        Ok(engine::Outcome::AlreadyCleaned)
    );
}
#[test]
fn real_file_lock_defers_and_tampered_object_is_preserved() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let path = fixture
        .root
        .join(&record.receipt.binding.installer.basename);
    let (mut store, mut life, mut authority) = pending(&context, record);
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let mut files = NativeFiles::new(&context);
    assert_eq!(
        life.cleanup(0, &mut authority, &mut store, &mut files),
        Ok(engine::Outcome::Deferred { until_ms: 100 })
    );
    drop(locked);
    fs::write(&path, b"modified installer bytes").unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        life.cleanup(100, &mut authority, &mut store, &mut files),
        Err(engine::Error::Preserve)
    );
    assert_eq!(fs::read(path).unwrap(), before);
    fixture.sentinels_unchanged();
}
#[test]
fn hardlink_installer_and_unowned_state_directory_are_refused() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let path = fixture
        .root
        .join(&record.receipt.binding.installer.basename);
    fs::hard_link(&path, fixture.root.join("hardlink-sentinel")).unwrap();
    let mut files = NativeFiles::new(&context);
    assert!(matches!(
        files.open_exact(&record.receipt.binding),
        Err(engine::OpenError::Refused)
    ));
    assert!(path.exists());
    fixture.sentinels_unchanged();
    fs::create_dir(fixture.root.join(STATE_DIRECTORY)).unwrap();
    assert!(TransactionStore::open(&context).is_err());
    assert!(!fixture
        .root
        .join(STATE_DIRECTORY)
        .join("owner.dpapi")
        .exists());
}
#[test]
fn authenticated_record_metadata_still_needs_live_native_evidence() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let stage = fixture
        .root
        .join(&record.receipt.binding.installer.basename);
    let (mut store, mut life, _authority) = pending(&context, record);
    let saved = store.recovery_hint().unwrap().unwrap();
    let mut native = DenyNativeEvidence;
    let mut authority = EvidenceAdapter {
        context: &context,
        record: &saved,
        native: &mut native,
    };
    let mut files = NativeFiles::new(&context);
    assert!(life
        .cleanup(0, &mut authority, &mut store, &mut files)
        .is_err());
    assert!(stage.exists());
    fixture.sentinels_unchanged();
}

#[test]
fn delete_pending_reader_does_not_mark_cleaned_until_original_handle_releases() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let path = fixture
        .root
        .join(&record.receipt.binding.installer.basename);
    let (mut store, mut life, mut authority) = pending(&context, record);
    // Permit a deletion request but keep the kernel object alive through a
    // separate read handle. Basic disposition must not be mistaken for absence.
    let reader = fs::OpenOptions::new()
        .read(true)
        .share_mode(5)
        .open(&path)
        .unwrap();
    let mut files = NativeFiles::new(&context);
    let result = life.cleanup(0, &mut authority, &mut store, &mut files);
    assert!(matches!(
        result,
        Err(engine::Error::UncertainDelete) | Ok(engine::Outcome::Deferred { .. })
    ));
    assert_eq!(
        store.recovery_hint().unwrap().unwrap().receipt.state,
        codec::State::CleanupPending
    );
    drop(reader);
    let hint = store.recovery_hint().unwrap().unwrap();
    let mut recovered = engine::Lifecycle::recover(&codec::encode(&hint.receipt).unwrap()).unwrap();
    assert_eq!(
        recovered.cleanup(100, &mut authority, &mut store, &mut files),
        Ok(engine::Outcome::Cleaned)
    );
    fixture.sentinels_unchanged();
}

#[test]
fn root_junction_and_foreign_root_context_are_not_adopted() {
    let fixture = Fixture::new();
    let foreign = Fixture::new();
    let context = fixture.context();
    let record = fixture.record(&context);
    let foreign_context = foreign.context();
    let mut files = NativeFiles::new(&foreign_context);
    assert!(matches!(
        files.open_exact(&record.receipt.binding),
        Err(engine::OpenError::Refused)
    ));
    let link = fixture.root.join("fixture-junction");
    let result = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&foreign.root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "generated junction creation failed"
    );
    assert!(windows_impl::capture(&link).is_err());
    // Remove only this exact junction itself, never recurse into its target.
    fs::remove_dir(&link).unwrap();
    fixture.sentinels_unchanged();
    foreign.sentinels_unchanged();
}

#[test]
fn signed_reauthentication_twice_coexists_with_the_pinned_native_delete_handle() {
    let fixture = Fixture::new();
    let context = fixture.context();
    let (mut stage, candidate, key) = crate::update_package::fixture_stage(
        &fixture.root,
        "1.1.0",
        context.installed_image_sha256(),
    );
    let snapshot = stage.transaction_snapshot(&candidate, &key).unwrap();
    let bytes = fs::read(snapshot.path()).unwrap();
    let proof = snapshot.package();
    let mut record = fixture.record(&context);
    let path = fixture
        .root
        .join(&record.receipt.binding.installer.basename);
    fs::write(&path, &bytes).unwrap();
    record.receipt.binding.installer.length = bytes.len() as u64;
    record.receipt.binding.installer.sha256 = proof.installer_sha256().into();
    record.package_signature = std::str::from_utf8(proof.signature()).unwrap().into();
    record.receipt.binding.release.signature_proof_digest = sha256(proof.signature());
    record.payload_sha256 = proof.payload_sha256().into();
    drop(snapshot);
    drop(stage); // closes/removes only the separate signed-source fixture
    let (mut store, mut lifecycle, _fixture_authority) = pending(&context, record.clone());
    struct Reauthenticate<'a> {
        context: &'a NativeContext,
        record: &'a TransactionRecord,
        key: &'a crate::update_package::TrustedKey,
        checks: usize,
    }
    impl Authority for Reauthenticate<'_> {
        fn verify(
            &mut self,
            binding: &codec::Binding,
            _: Evidence,
        ) -> std::result::Result<(), String> {
            self.checks += 1;
            if binding != &self.record.receipt.binding {
                return Err("binding mismatch".into());
            }
            let proof = authenticate_record(self.context, self.record, self.key)
                .map_err(|_| "signed fixture authentication failed")?;
            if proof.payload_sha256() != self.context.installed_image_sha256() {
                return Err("signed payload mismatch".into());
            }
            Ok(())
        }
    }
    let mut authority = Reauthenticate {
        context: &context,
        record: &record,
        key: &key,
        checks: 0,
    };
    let mut files = NativeFiles::new(&context);
    assert_eq!(
        lifecycle.cleanup(0, &mut authority, &mut store, &mut files),
        Ok(engine::Outcome::Cleaned)
    );
    assert_eq!(authority.checks, 2);
    assert!(!path.exists());
    fixture.sentinels_unchanged();
}

#[test]
fn read_only_restart_discovery_does_not_create_a_state_namespace(){let fixture=Fixture::new();let context=fixture.context();assert!(matches!(TransactionStore::open_existing(&context),Err(Error::Missing)));assert!(!fixture.root.join(STATE_DIRECTORY).exists());fixture.sentinels_unchanged();}

#[test]
fn authenticated_later_update_reuses_only_own_cleaned_record_and_retains_backups(){
 let fixture=Fixture::new();let context=fixture.context();let record=fixture.record(&context);let backup=fixture.root.join(&record.old_image.basename);let old=fs::read(&backup).unwrap();
 let(mut store,mut lifecycle,mut authority)=pending(&context,record.clone());let mut files=NativeFiles::new(&context);
 assert_eq!(lifecycle.cleanup(0,&mut authority,&mut store,&mut files),Ok(engine::Outcome::Cleaned));drop(store);
 let(mut stage,candidate,key)=crate::update_package::fixture_stage(&fixture.root,"1.1.0",context.installed_image_sha256());let snapshot=stage.transaction_snapshot(&candidate,&key).unwrap();
 let next=prepare_transaction(&context,&snapshot).expect("own terminal journal must not permanently block later authenticated staging");
 assert_eq!(next.lifecycle.receipt().state,codec::State::Prepared);assert_ne!(next.lifecycle.receipt().binding.nonce,record.receipt.binding.nonce);assert_eq!(fs::read(backup).unwrap(),old);fixture.sentinels_unchanged();
}

#[test]
fn real_native_lock_exhaustion_retains_exact_installer_backup_and_settings(){
 let fixture=Fixture::new();let context=fixture.context();let record=fixture.record(&context);let path=fixture.root.join(&record.receipt.binding.installer.basename);let backup=fixture.root.join(&record.old_image.basename);let settings=fixture.root.join("settings.json");let settings_before=fs::read(&settings).unwrap();
 let(mut store,mut life,mut authority)=pending(&context,record);let locked=fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();let mut files=NativeFiles::new(&context);
 assert_eq!(life.cleanup(0,&mut authority,&mut store,&mut files),Ok(engine::Outcome::Deferred{until_ms:100}));
 assert_eq!(life.cleanup(100,&mut authority,&mut store,&mut files),Ok(engine::Outcome::Deferred{until_ms:300}));
 assert_eq!(life.cleanup(300,&mut authority,&mut store,&mut files),Ok(engine::Outcome::RetryExhausted));
 assert_eq!(life.receipt().attempts,3);assert!(path.exists());assert_eq!(fs::read(backup).unwrap(),b"original fixture Nearly image");assert_eq!(fs::read(settings).unwrap(),settings_before);drop(locked);fixture.sentinels_unchanged();
}
#[test]
fn authenticated_signature_never_substitutes_for_the_running_image(){
 let fixture=Fixture::new();let context=fixture.context();let(mut stage,candidate,key)=crate::update_package::fixture_stage(&fixture.root,env!("CARGO_PKG_VERSION"),context.installed_image_sha256());let snapshot=stage.transaction_snapshot(&candidate,&key).unwrap();let transaction=prepare_transaction(&context,&snapshot).unwrap();let record=transaction.store.recovery_hint().unwrap().unwrap();let proof=authenticate_record(&context,&record,&key).unwrap();
 assert!(verify_running_payload(&context,&proof).is_err(),"fixture bytes/path are not this native running process");
 let mut forged=record.clone();forged.package_signature="c2lnbmVkLWZpeHR1cmU=".into();forged.receipt.binding.release.signature_proof_digest=sha256(forged.package_signature.as_bytes());assert!(authenticate_record(&context,&forged,&key).is_err());fixture.sentinels_unchanged();
}
#[test]
fn fresh_signed_update_does_not_replace_an_active_or_uncertain_journal(){
 let fixture=Fixture::new();let context=fixture.context();let(mut stage,candidate,key)=crate::update_package::fixture_stage(&fixture.root,"1.1.0",context.installed_image_sha256());let snapshot=stage.transaction_snapshot(&candidate,&key).unwrap();let transaction=prepare_transaction(&context,&snapshot).unwrap();let before=transaction.store.recovery_hint().unwrap().unwrap();
 let backups=||fs::read_dir(&fixture.root).unwrap().flatten().filter(|e|e.file_name().to_string_lossy().ends_with("-previous.exe")).count();
 assert_eq!(backups(),1);
 let(mut next_stage,next_candidate,next_key)=crate::update_package::fixture_stage(&fixture.root,"1.1.0",context.installed_image_sha256());let next=next_stage.transaction_snapshot(&next_candidate,&next_key).unwrap();assert!(prepare_transaction(&context,&next).is_err());assert_eq!(transaction.store.recovery_hint().unwrap().unwrap(),before);assert!(fixture.root.join(&before.old_image.basename).exists());
 assert_eq!(backups(),1,"reject an incomplete journal before creating another backup");fixture.sentinels_unchanged();
}

#[test]
fn exact_native_restart_claim_is_idempotent_and_detects_a_prior_crashed_process(){
 let fixture=Fixture::new();let context=fixture.context();let record=fixture.record(&context);let mut authority=IndependentFixtureEvidence{binding:record.receipt.binding.clone(),healthy:true};let mut store=windows_impl::fixture_store(&context,record.clone()).unwrap();let mut life=engine::Lifecycle::prepare(record.receipt.binding.clone(),&mut authority,&mut store).unwrap();life.advance(codec::State::HandoffCommitted,&mut authority,&mut store).unwrap();
 let claimed=store.claim_current_restart(life.receipt()).unwrap();assert_eq!(claimed.restart_process.as_ref().unwrap().pid,std::process::id());assert!(claimed.restart_process.as_ref().unwrap().created>0);let again=store.claim_current_restart(&claimed.receipt).unwrap();assert_eq!(again,claimed);drop(store);
 let foreign=Fixture::new();let foreign_context=foreign.context();let mut stale=foreign.record(&foreign_context);stale.restart_process=Some(ProcessIdentity{pid:1,created:1});let mut authority=IndependentFixtureEvidence{binding:stale.receipt.binding.clone(),healthy:true};let mut store=windows_impl::fixture_store(&foreign_context,stale.clone()).unwrap();let mut life=engine::Lifecycle::prepare(stale.receipt.binding.clone(),&mut authority,&mut store).unwrap();life.advance(codec::State::HandoffCommitted,&mut authority,&mut store).unwrap();let before=store.recovery_hint().unwrap().unwrap();assert!(store.claim_current_restart(life.receipt()).is_err());assert_eq!(store.recovery_hint().unwrap().unwrap(),before);foreign.sentinels_unchanged();fixture.sentinels_unchanged();
}

#[test]
fn never_spawned_failure_allows_durable_abandonment_and_a_fresh_signed_retry() {
    let fixture=Fixture::new();let context=fixture.context();
    let(mut stage,candidate,key)=crate::update_package::fixture_stage(&fixture.root,"1.1.0",context.installed_image_sha256());
    let snapshot=stage.transaction_snapshot(&candidate,&key).unwrap();
    let mut prepared=prepare_transaction(&context,&snapshot).unwrap();
    let before=prepared.store.recovery_hint().unwrap().unwrap();
    let backup=fixture.root.join(&before.old_image.basename);
    let failure=crate::update_handoff::fixture_spawn_failure(&fixture.root,&before.receipt.binding.nonce);
    prepared.abandon_never_spawned(&failure).unwrap();
    let abandoned=prepared.store.recovery_hint().unwrap().unwrap();
    assert_eq!(abandoned.receipt.state,codec::State::Abandoned);
    assert_eq!(abandoned.receipt.sequence,1);
    assert_eq!(abandoned.old_image,before.old_image);
    assert_eq!(abandoned.installer_process,None);
    assert!(stage.verified_path().exists(),"abandonment does not delete artifacts");
    assert_eq!(fs::read(&backup).unwrap(),b"original fixture Nearly image");
    let mut life=engine::Lifecycle::recover(&codec::encode(&abandoned.receipt).unwrap()).unwrap();
    let mut deny=DenyNativeEvidence;
    let mut authority=EvidenceAdapter{context:&context,record:&abandoned,native:&mut deny};
    let mut files=NativeFiles::new(&context);
    assert_eq!(life.cleanup(0,&mut authority,&mut prepared.store,&mut files),Err(engine::Error::NotReady));
    assert!(prepared.abandon_never_spawned(&failure).is_err());
    drop(prepared);drop(snapshot);drop(stage);
    let(mut next_stage,next_candidate,next_key)=crate::update_package::fixture_stage(&fixture.root,"1.1.0",context.installed_image_sha256());
    let next=next_stage.transaction_snapshot(&next_candidate,&next_key).unwrap();
    let retry=prepare_transaction(&context,&next).unwrap();
    assert_eq!(retry.lifecycle.receipt().state,codec::State::Prepared);
    assert_ne!(retry.lifecycle.receipt().binding.nonce,abandoned.receipt.binding.nonce);
    assert_eq!(fs::read(backup).unwrap(),b"original fixture Nearly image");fixture.sentinels_unchanged();
}

#[test]
fn never_spawned_proof_cannot_abandon_another_nonce_or_a_committed_or_stale_record() {
    let fixture=Fixture::new();let context=fixture.context();
    let(mut stage,candidate,key)=crate::update_package::fixture_stage(&fixture.root,"1.1.0",context.installed_image_sha256());
    let snapshot=stage.transaction_snapshot(&candidate,&key).unwrap();
    let mut prepared=prepare_transaction(&context,&snapshot).unwrap();
    let before=prepared.store.recovery_hint().unwrap().unwrap();
    let foreign=crate::update_handoff::fixture_spawn_failure(&fixture.root,&"f".repeat(32));
    assert!(prepared.abandon_never_spawned(&foreign).is_err());
    assert_eq!(prepared.store.recovery_hint().unwrap().unwrap(),before);
    // Another lease holder advances the journal. The stale in-memory Prepared
    // capability must not overwrite even a well-formed committed receipt.
    let mut committed=before.receipt.clone();committed.state=codec::State::HandoffCommitted;committed.sequence=1;
    prepared.store.begin(Some(&before.receipt)).unwrap();
    prepared.store.commit(&committed).unwrap();prepared.store.end();
    let durable=prepared.store.recovery_hint().unwrap().unwrap();
    let failure=crate::update_handoff::fixture_spawn_failure(&fixture.root,&before.receipt.binding.nonce);
    assert!(prepared.abandon_never_spawned(&failure).is_err());
    assert_eq!(prepared.store.recovery_hint().unwrap().unwrap(),durable);
    assert!(prepare_transaction(&context,&snapshot).is_err());fixture.sentinels_unchanged();
}
