use super::{codec::*, engine::*};
use std::collections::BTreeSet;

fn binding() -> Binding {
    Binding {
        nonce: "a".repeat(32),
        root: Root {
            path: "C:\\Fixture\\Nearly".into(),
            identity: Identity {
                volume: 7,
                file_id: "1".repeat(32),
            },
        },
        release: Release {
            internal_version: "1.0.0".into(),
            public_tag: "r1.0".into(),
            architecture: Architecture::X64,
            download_asset: "Nearly_r1.0_x64-setup.exe".into(),
            signature_proof_digest: "b".repeat(64),
        },
        installer: Installer {
            basename: format!("Nearly-update-1.0.0-{}-setup.exe", "a".repeat(32)),
            identity: Identity {
                volume: 7,
                file_id: "2".repeat(32),
            },
            length: 1234,
            sha256: "c".repeat(64),
        },
    }
}
struct Trusted {
    binding: Binding,
    owned: bool,
    handoff: bool,
    installed: bool,
    healthy: bool,
    checks: usize,
}
impl Trusted {
    fn all() -> Self {
        Self {
            binding: binding(),
            owned: true,
            handoff: true,
            installed: true,
            healthy: true,
            checks: 0,
        }
    }
}
impl Authority for Trusted {
    fn verify(&mut self, binding: &Binding, evidence: Evidence) -> Result<(), String> {
        self.checks += 1;
        let allowed = self.binding == *binding
            && self.owned
            && match evidence {
                Evidence::Owned => true,
                Evidence::HandedOff => self.handoff,
                Evidence::Installed => self.handoff && self.installed,
                Evidence::Healthy => self.handoff && self.installed && self.healthy,
            };
        if allowed {
            Ok(())
        } else {
            Err("independent native facts do not authorize this binding".into())
        }
    }
}
#[derive(Default)]
struct MemoryJournal {
    bytes: Vec<u8>,
    fail: Option<CommitError>,
    fail_at: Option<(usize, CommitError)>,
    writes: usize,
    leased: bool,
}
impl Journal for MemoryJournal {
    fn begin(&mut self, expected: Option<&Receipt>) -> Result<(), CommitError> {
        if self.leased {
            return Err(CommitError::Busy);
        }
        let expected = expected.map(|r| encode(r).unwrap()).unwrap_or_default();
        if self.bytes != expected {
            return Err(CommitError::Stale);
        }
        self.leased = true;
        Ok(())
    }
    fn commit(&mut self, receipt: &Receipt) -> Result<(), CommitError> {
        if !self.leased {
            return Err(CommitError::NotCommitted);
        }
        self.writes += 1;
        let fault = if self
            .fail_at
            .as_ref()
            .is_some_and(|(at, _)| *at == self.writes)
        {
            self.fail_at.take().map(|(_, fault)| fault)
        } else {
            self.fail.take()
        };
        if fault == Some(CommitError::NotCommitted) {
            return Err(CommitError::NotCommitted);
        }
        self.bytes = encode(receipt).unwrap();
        if fault == Some(CommitError::Uncertain) {
            return Err(CommitError::Uncertain);
        }
        Ok(())
    }
    fn end(&mut self) {
        self.leased = false;
    }
}
struct FakeFiles {
    observation: Observation,
    present: bool,
    open_lock: bool,
    delete_lock: bool,
    uncertain_delete: bool,
    opens: usize,
    deletes: usize,
    deleted: BTreeSet<String>,
    sentinels: BTreeSet<String>,
    swap_after_open: bool,
    uncertain_keeps_present: bool,
    on_open: Option<Box<dyn FnMut()>>,
}
impl FakeFiles {
    fn new() -> Self {
        let b = binding();
        Self {
            observation: Observation {
                root: b.root,
                root_reparse: false,
                parent_reparse: false,
                basename: b.installer.basename,
                file_identity: b.installer.identity,
                length: b.installer.length,
                sha256: b.installer.sha256,
                regular_file: true,
                links: 1,
            },
            present: true,
            open_lock: false,
            delete_lock: false,
            uncertain_delete: false,
            opens: 0,
            deletes: 0,
            deleted: BTreeSet::new(),
            sentinels: [
                "manual Nearly_r1.0_x64-setup.exe".into(),
                "foreign-sentinel".into(),
            ]
            .into(),
            swap_after_open: false,
            uncertain_keeps_present: false,
            on_open: None,
        }
    }
}
impl Files for FakeFiles {
    type Handle = String;
    fn open_exact(&mut self, _binding: &Binding) -> Result<Opened<String>, OpenError> {
        self.opens += 1;
        if self.open_lock {
            return Err(OpenError::Locked);
        }
        if let Some(hook) = self.on_open.as_mut() {
            hook();
        }
        if !self.present {
            return Err(OpenError::Missing(Absence {
                root: self.observation.root.clone(),
                root_reparse: self.observation.root_reparse,
                parent_reparse: self.observation.parent_reparse,
            }));
        }
        let handle = self.observation.file_identity.file_id.clone();
        let observation = self.observation.clone();
        if self.swap_after_open {
            self.sentinels.insert("replacement-at-same-path".into());
        }
        Ok(Opened {
            handle,
            observation,
        })
    }
    fn delete_exact(&mut self, handle: String) -> Result<(), DeleteError> {
        if self.delete_lock {
            return Err(DeleteError::Locked);
        }
        self.deletes += 1;
        if self.uncertain_delete && self.uncertain_keeps_present {
            return Err(DeleteError::Uncertain);
        }
        self.present = false;
        self.deleted.insert(handle);
        if self.uncertain_delete {
            return Err(DeleteError::Uncertain);
        }
        Ok(())
    }
}
fn pending(authority: &mut Trusted, journal: &mut impl Journal) -> Lifecycle {
    let mut l = Lifecycle::prepare(binding(), authority, journal).unwrap();
    for state in [
        State::HandoffCommitted,
        State::InstallationSucceeded,
        State::RestartHealthy,
        State::CleanupPending,
    ] {
        l.advance(state, authority, journal).unwrap();
    }
    l
}
#[test]
fn healthy_ordered_cleanup_uses_only_verified_handle_and_is_idempotent() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let mut l = pending(&mut a, &mut j);
    assert_eq!(l.cleanup(0, &mut a, &mut j, &mut f), Ok(Outcome::Cleaned));
    assert_eq!(f.deletes, 1);
    assert!(f.deleted.contains(&"2".repeat(32)));
    assert_eq!(f.sentinels.len(), 2);
    let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
    assert_eq!(
        recovered.cleanup(1, &mut a, &mut j, &mut f),
        Ok(Outcome::AlreadyCleaned)
    );
    assert_eq!(f.deletes, 1);
    assert_eq!(recovered.receipt().state, State::Cleaned);
}
#[test]
fn default_authority_and_missing_failed_cancelled_or_ambiguous_evidence_never_delete() {
    let (mut j, mut f) = (MemoryJournal::default(), FakeFiles::new());
    assert!(Lifecycle::prepare(binding(), &mut DenyAll, &mut j).is_err());
    assert_eq!(j.writes, 0);
    let mut a = Trusted::all();
    let l = pending(&mut a, &mut j);
    let bytes = encode(l.receipt()).unwrap();
    for failure in 0..4 {
        let mut a = Trusted::all();
        match failure {
            0 => a.owned = false,
            1 => a.handoff = false,
            2 => a.installed = false,
            _ => a.healthy = false,
        };
        let mut recovered = Lifecycle::recover(&bytes).unwrap();
        assert!(recovered.cleanup(0, &mut a, &mut j, &mut f).is_err());
    }
    let mut recovered = Lifecycle::recover(&bytes).unwrap();
    assert!(recovered.cleanup(0, &mut DenyAll, &mut j, &mut f).is_err());
    assert_eq!(f.opens, 0);
    assert_eq!(f.deletes, 0);
}
#[test]
fn skipped_transitions_and_success_without_restart_health_preserve_every_file() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let mut l = Lifecycle::prepare(binding(), &mut a, &mut j).unwrap();
    assert_eq!(
        l.advance(State::CleanupPending, &mut a, &mut j),
        Err(Error::NotReady)
    );
    l.advance(State::HandoffCommitted, &mut a, &mut j).unwrap();
    l.advance(State::InstallationSucceeded, &mut a, &mut j)
        .unwrap();
    a.healthy = false;
    assert!(l.advance(State::RestartHealthy, &mut a, &mut j).is_err());
    assert_eq!(l.cleanup(0, &mut a, &mut j, &mut f), Err(Error::NotReady));
    assert_eq!(f.deletes, 0);
}
#[test]
fn adversarial_valid_journal_rewrites_cannot_invent_ownership_or_health() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let l = Lifecycle::prepare(binding(), &mut a, &mut j).unwrap();
    let mut forged = l.receipt().clone();
    forged.state = State::CleanupPending;
    forged.sequence = 4;
    j.bytes = encode(&forged).unwrap();
    let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
    a.installed = false;
    a.healthy = false;
    assert!(recovered.cleanup(0, &mut a, &mut j, &mut f).is_err());
    for mutation in 0..6 {
        let mut forged = forged.clone();
        match mutation {
            0 => forged.binding.root.path = "C:\\Foreign\\Nearly".into(),
            1 => forged.binding.root.identity.file_id = "3".repeat(32),
            2 => forged.binding.installer.identity.file_id = "4".repeat(32),
            3 => forged.binding.installer.sha256 = "d".repeat(64),
            4 => forged.binding.release.signature_proof_digest = "e".repeat(64),
            _ => {
                forged.binding.nonce = "f".repeat(32);
                forged.binding.installer.basename =
                    format!("Nearly-update-1.0.0-{}-setup.exe", "f".repeat(32));
            }
        }
        j.bytes = encode(&forged).unwrap();
        let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
        assert!(recovered
            .cleanup(0, &mut Trusted::all(), &mut j, &mut f)
            .is_err());
    }
    assert_eq!(f.opens, 0);
    assert_eq!(f.deletes, 0);
}
#[test]
fn observations_reject_reparse_foreign_identity_hash_length_name_and_hardlinks() {
    let (mut a, mut j) = (Trusted::all(), MemoryJournal::default());
    let l = pending(&mut a, &mut j);
    let bytes = encode(l.receipt()).unwrap();
    for mutation in 0..10 {
        let mut f = FakeFiles::new();
        match mutation {
            0 => f.observation.root_reparse = true,
            1 => f.observation.parent_reparse = true,
            2 => f.observation.root.identity.file_id = "3".repeat(32),
            3 => f.observation.file_identity.volume = 8,
            4 => f.observation.file_identity.file_id = "4".repeat(32),
            5 => f.observation.length = 1235,
            6 => f.observation.sha256 = "d".repeat(64),
            7 => f.observation.basename = "Nearly_r1.0_x64-setup.exe".into(),
            8 => f.observation.links = 2,
            _ => f.observation.regular_file = false,
        }
        let before = j.bytes.clone();
        let mut recovered = Lifecycle::recover(&bytes).unwrap();
        assert_eq!(
            recovered.cleanup(0, &mut a, &mut j, &mut f),
            Err(Error::Preserve)
        );
        assert_eq!(f.deletes, 0);
        assert_eq!(j.bytes, before);
        assert_eq!(f.sentinels.len(), 2);
    }
}
#[test]
fn pathname_replacement_after_open_does_not_change_the_deleted_object() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let mut l = pending(&mut a, &mut j);
    f.swap_after_open = true;
    l.cleanup(0, &mut a, &mut j, &mut f).unwrap();
    assert_eq!(f.deleted, ["2".repeat(32)].into());
    assert!(f.sentinels.contains("replacement-at-same-path"));
}
#[test]
fn locked_open_and_delete_defer_with_bounded_persisted_backoff() {
    for locked_open in [true, false] {
        let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
        let mut l = pending(&mut a, &mut j);
        f.open_lock = locked_open;
        f.delete_lock = !locked_open;
        assert_eq!(
            l.cleanup(0, &mut a, &mut j, &mut f),
            Ok(Outcome::Deferred { until_ms: 100 })
        );
        let opens = f.opens;
        assert_eq!(
            l.cleanup(99, &mut a, &mut j, &mut f),
            Ok(Outcome::Deferred { until_ms: 100 })
        );
        assert_eq!(f.opens, opens);
        let mut l = Lifecycle::recover(&j.bytes).unwrap();
        assert_eq!(
            l.cleanup(100, &mut a, &mut j, &mut f),
            Ok(Outcome::Deferred { until_ms: 300 })
        );
        assert_eq!(
            l.cleanup(300, &mut a, &mut j, &mut f),
            Ok(Outcome::RetryExhausted)
        );
        let opens = f.opens;
        assert_eq!(
            l.cleanup(900, &mut a, &mut j, &mut f),
            Ok(Outcome::RetryExhausted)
        );
        assert_eq!(f.opens, opens);
        assert_eq!(f.deletes, 0);
    }
}
#[test]
fn held_lock_can_clear_on_next_scheduled_retry_without_deleting_sentinels() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let mut l = pending(&mut a, &mut j);
    f.open_lock = true;
    l.cleanup(0, &mut a, &mut j, &mut f).unwrap();
    f.open_lock = false;
    let mut l = Lifecycle::recover(&j.bytes).unwrap();
    assert_eq!(l.cleanup(100, &mut a, &mut j, &mut f), Ok(Outcome::Cleaned));
    assert_eq!(f.deletes, 1);
    assert_eq!(f.sentinels.len(), 2);
}
#[test]
fn every_transition_commit_failure_fences_instance_and_recovery_rechecks_authority() {
    for fault in [CommitError::NotCommitted, CommitError::Uncertain] {
        for target in [
            State::HandoffCommitted,
            State::InstallationSucceeded,
            State::RestartHealthy,
            State::CleanupPending,
        ] {
            let (mut a, mut j, mut f) =
                (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
            let mut l = Lifecycle::prepare(binding(), &mut a, &mut j).unwrap();
            for state in [
                State::HandoffCommitted,
                State::InstallationSucceeded,
                State::RestartHealthy,
                State::CleanupPending,
            ] {
                if state == target {
                    break;
                }
                l.advance(state, &mut a, &mut j).unwrap();
            }
            j.fail = Some(fault.clone());
            assert_eq!(
                l.advance(target, &mut a, &mut j),
                Err(Error::Journal(fault.clone()))
            );
            assert_eq!(l.cleanup(0, &mut a, &mut j, &mut f), Err(Error::Fenced));
            assert_eq!(f.deletes, 0);
            let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
            a.owned = false;
            assert!(recovered.cleanup(0, &mut a, &mut j, &mut f).is_err());
            assert_eq!(f.deletes, 0);
        }
    }
}
#[test]
fn failed_cleaned_commit_and_uncertain_delete_recover_without_second_deletion() {
    for uncertain_delete in [false, true] {
        let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
        let mut l = pending(&mut a, &mut j);
        f.uncertain_delete = uncertain_delete;
        if !uncertain_delete {
            j.fail_at = Some((j.writes + 2, CommitError::NotCommitted));
        }
        assert!(l.cleanup(0, &mut a, &mut j, &mut f).is_err());
        assert_eq!(f.deletes, 1);
        assert_eq!(l.cleanup(1, &mut a, &mut j, &mut f), Err(Error::Fenced));
        let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
        assert_eq!(
            recovered.cleanup(1, &mut a, &mut j, &mut f),
            Ok(Outcome::Cleaned)
        );
        assert_eq!(f.deletes, 1);
    }
}
#[test]
fn forged_cleaned_receipt_or_foreign_missing_root_cannot_authorize_deletion_or_completion() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let l = pending(&mut a, &mut j);
    let mut r = l.receipt().clone();
    r.state = State::Cleaned;
    r.sequence = 5;
    j.bytes = encode(&r).unwrap();
    let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
    assert_eq!(
        recovered.cleanup(0, &mut a, &mut j, &mut f),
        Err(Error::Preserve)
    );
    assert_eq!(f.deletes, 0);
    f.present = false;
    f.observation.root_reparse = true;
    assert_eq!(
        recovered.cleanup(0, &mut a, &mut j, &mut f),
        Err(Error::Preserve)
    );
    f.observation.root_reparse = false;
    a.healthy = false;
    assert!(recovered.cleanup(0, &mut a, &mut j, &mut f).is_err());
}

#[test]
fn exhausted_receipt_sequence_preserves_file_before_irreversible_action() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let l = pending(&mut a, &mut j);
    let mut r = l.receipt().clone();
    r.sequence = 64;
    let mut recovered = Lifecycle::recover(&encode(&r).unwrap()).unwrap();
    assert_eq!(
        recovered.cleanup(0, &mut a, &mut j, &mut f),
        Err(Error::Preserve)
    );
    assert_eq!(f.opens, 0);
    assert_eq!(f.deletes, 0);
}

#[test]
fn recovered_pending_requires_a_fresh_acknowledged_durable_checkpoint_before_deletion() {
    for fault in [CommitError::NotCommitted, CommitError::Uncertain] {
        let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
        let l = pending(&mut a, &mut j);
        let mut recovered = Lifecycle::recover(&encode(l.receipt()).unwrap()).unwrap();
        j.fail = Some(fault.clone());
        assert_eq!(
            recovered.cleanup(0, &mut a, &mut j, &mut f),
            Err(Error::Journal(fault))
        );
        assert_eq!(f.deletes, 0);
        assert_eq!(
            recovered.cleanup(1, &mut a, &mut j, &mut f),
            Err(Error::Fenced)
        );
    }
}

// This fixture exercises serialized process-crash recovery using actual isolated
// journal files. It is NOT a protected Windows journal or a power-loss simulator.
struct DiskJournal {
    dir: std::path::PathBuf,
    path: std::path::PathBuf,
    fault: Option<(State, CommitError)>,
    leased: bool,
}
impl DiskJournal {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            "updater-cleanup-fixture-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(name);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("receipt.json");
        Self {
            dir,
            path,
            fault: None,
            leased: false,
        }
    }
    fn read(&self) -> Vec<u8> {
        std::fs::read(&self.path).unwrap()
    }
}
impl Journal for DiskJournal {
    fn begin(&mut self, expected: Option<&Receipt>) -> Result<(), CommitError> {
        if self.leased {
            return Err(CommitError::Busy);
        }
        let current = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(_) => return Err(CommitError::Uncertain),
        };
        if current != expected.map(|r| encode(r).unwrap()).unwrap_or_default() {
            return Err(CommitError::Stale);
        }
        self.leased = true;
        Ok(())
    }
    fn commit(&mut self, receipt: &Receipt) -> Result<(), CommitError> {
        use std::io::Write;
        if !self.leased {
            return Err(CommitError::NotCommitted);
        }
        let bytes = encode(receipt).map_err(|_| CommitError::NotCommitted)?;
        let fault = if self
            .fault
            .as_ref()
            .is_some_and(|(state, _)| *state == receipt.state)
        {
            self.fault.take().map(|(_, fault)| fault)
        } else {
            None
        };
        if fault == Some(CommitError::NotCommitted) {
            return Err(CommitError::NotCommitted);
        }
        let staged = self.dir.join("receipt.pending");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|_| CommitError::NotCommitted)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| CommitError::NotCommitted)?;
        drop(file);
        fixture_replace(&staged, &self.path).map_err(|_| CommitError::Uncertain)?;
        if fault == Some(CommitError::Uncertain) {
            return Err(CommitError::Uncertain);
        }
        Ok(())
    }
    fn end(&mut self) {
        self.leased = false;
    }
}
#[cfg(windows)]
fn fixture_replace(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Exact fixture-owned paths; replace atomically, never remove-before-rename.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn fixture_replace(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}
impl Drop for DiskJournal {
    fn drop(&mut self) {
        // Exact fixture-owned files only; never recursively walk or delete.
        let _ = std::fs::remove_file(self.dir.join("receipt.pending"));
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.dir);
    }
}
#[test]
fn disk_journal_process_restart_replays_each_transition_and_failed_publish_safely() {
    let (mut a, mut j, mut f) = (Trusted::all(), DiskJournal::new(), FakeFiles::new());
    let mut l = Lifecycle::prepare(binding(), &mut a, &mut j).unwrap();
    for target in [
        State::HandoffCommitted,
        State::InstallationSucceeded,
        State::RestartHealthy,
        State::CleanupPending,
    ] {
        l = Lifecycle::recover(&j.read()).unwrap();
        l.advance(target, &mut a, &mut j).unwrap();
        assert_eq!(decode(&j.read()).unwrap().state, target);
    }
    j.fault = Some((State::Cleaned, CommitError::Uncertain));
    assert_eq!(
        l.cleanup(0, &mut a, &mut j, &mut f),
        Err(Error::Journal(CommitError::Uncertain))
    );
    assert_eq!(f.deletes, 1);
    let mut recovered = Lifecycle::recover(&j.read()).unwrap();
    assert_eq!(
        recovered.cleanup(1, &mut a, &mut j, &mut f),
        Ok(Outcome::AlreadyCleaned)
    );
    assert_eq!(f.deletes, 1);
}
#[test]
fn disk_journal_tampering_is_rechecked_against_independent_binding_and_not_self_authorized() {
    let (mut a, mut j, mut f) = (Trusted::all(), DiskJournal::new(), FakeFiles::new());
    let l = pending(&mut a, &mut j);
    let mut r = l.receipt().clone();
    r.binding.installer.sha256 = "d".repeat(64);
    std::fs::write(&j.path, encode(&r).unwrap()).unwrap();
    let before = j.read();
    let mut recovered = Lifecycle::recover(&before).unwrap();
    assert!(recovered.cleanup(0, &mut a, &mut j, &mut f).is_err());
    assert_eq!(f.deletes, 0);
    assert_eq!(j.read(), before);
    assert_eq!(f.sentinels.len(), 2);
}

#[derive(Clone, Default)]
struct SharedJournal(std::rc::Rc<std::cell::RefCell<MemoryJournal>>);
impl Journal for SharedJournal {
    fn begin(&mut self, r: Option<&Receipt>) -> Result<(), CommitError> {
        self.0.borrow_mut().begin(r)
    }
    fn commit(&mut self, r: &Receipt) -> Result<(), CommitError> {
        self.0.borrow_mut().commit(r)
    }
    fn end(&mut self) {
        self.0.borrow_mut().end();
    }
}
#[test]
fn competing_cleanup_cannot_enter_during_verified_handle_transaction() {
    use std::{cell::RefCell, rc::Rc};
    let (mut a, mut j, mut f) = (Trusted::all(), SharedJournal::default(), FakeFiles::new());
    let mut owner = pending(&mut a, &mut j);
    let bytes = j.0.borrow().bytes.clone();
    let mut contender = Lifecycle::recover(&bytes).unwrap();
    let mut other_journal = j.clone();
    let result = Rc::new(RefCell::new(None));
    let report = result.clone();
    f.on_open = Some(Box::new(move || {
        let mut other_files = FakeFiles::new();
        let outcome =
            contender.cleanup(0, &mut Trusted::all(), &mut other_journal, &mut other_files);
        let fenced =
            contender.cleanup(1, &mut Trusted::all(), &mut other_journal, &mut other_files);
        *report.borrow_mut() = Some((outcome, fenced, other_files.opens, other_files.deletes));
    }));
    assert_eq!(
        owner.cleanup(0, &mut a, &mut j, &mut f),
        Ok(Outcome::Cleaned)
    );
    assert_eq!(
        *result.borrow(),
        Some((
            Err(Error::Journal(CommitError::Busy)),
            Err(Error::Fenced),
            0,
            0
        ))
    );
    assert_eq!(f.deletes, 1);
    assert!(!j.0.borrow().leased);
}
#[test]
fn stale_recovered_instance_cannot_overwrite_newer_retry_count_or_phase() {
    let (mut a, mut j, mut f) = (Trusted::all(), SharedJournal::default(), FakeFiles::new());
    let mut owner = pending(&mut a, &mut j);
    let mut stale = Lifecycle::recover(&j.0.borrow().bytes).unwrap();
    f.open_lock = true;
    owner.cleanup(0, &mut a, &mut j, &mut f).unwrap();
    let committed = j.0.borrow().bytes.clone();
    let mut other_journal = j.clone();
    let mut other_files = FakeFiles::new();
    assert_eq!(
        stale.cleanup(100, &mut a, &mut other_journal, &mut other_files),
        Err(Error::Journal(CommitError::Stale))
    );
    assert_eq!(other_files.opens, 0);
    assert_eq!(other_files.deletes, 0);
    assert_eq!(j.0.borrow().bytes, committed);
    let mut stale_phase = Lifecycle::recover(&committed).unwrap();
    f.open_lock = false;
    owner.cleanup(100, &mut a, &mut j, &mut f).unwrap();
    assert_eq!(
        stale_phase.cleanup(100, &mut a, &mut other_journal, &mut other_files),
        Err(Error::Journal(CommitError::Stale))
    );
    assert_eq!(decode(&j.0.borrow().bytes).unwrap().state, State::Cleaned);
    assert_eq!(f.deletes, 1);
}
#[test]
fn uncertain_deletion_with_object_still_present_needs_new_health_before_a_retry() {
    let (mut a, mut j, mut f) = (Trusted::all(), MemoryJournal::default(), FakeFiles::new());
    let mut l = pending(&mut a, &mut j);
    f.uncertain_delete = true;
    f.uncertain_keeps_present = true;
    assert_eq!(
        l.cleanup(0, &mut a, &mut j, &mut f),
        Err(Error::UncertainDelete)
    );
    assert!(f.present);
    assert_eq!(decode(&j.bytes).unwrap().state, State::CleanupPending);
    assert_eq!(l.cleanup(1, &mut a, &mut j, &mut f), Err(Error::Fenced));
    let mut recovered = Lifecycle::recover(&j.bytes).unwrap();
    let opens = f.opens;
    assert!(recovered.cleanup(1, &mut DenyAll, &mut j, &mut f).is_err());
    assert_eq!(f.opens, opens);
    f.uncertain_delete = false;
    assert_eq!(
        recovered.cleanup(1, &mut a, &mut j, &mut f),
        Ok(Outcome::Cleaned)
    );
    assert_eq!(f.deletes, 2);
    assert_eq!(f.deleted.len(), 1);
    assert_eq!(f.sentinels.len(), 2);
}
