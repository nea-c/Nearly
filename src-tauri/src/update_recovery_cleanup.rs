//! Protocol-3 post-success artifact reclamation. Never used for rollback.
use super::*;

const COUNT: u8 = 7;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Progress {
    next: u8,
    intent: bool,
    issue: Option<Issue>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) enum Issue { LockedOrIo, ChangedOrUnsafe, EvidenceUnavailable }
impl Progress {
    pub(super) fn finished(&self) -> bool { self.next == COUNT && !self.intent }
    pub(super) fn validate(&self, r: &RecoveryTransaction) -> Result<()> {
        if r.engine.phase != RecoveryPhase::Succeeded || r.abandoned
            || self.next > COUNT || self.intent && self.next == COUNT {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

/// This observation proves only that the original process is no longer live.
/// It NEVER fabricates zero-exit evidence or grants rollback/recovery authority.
/// With a durable Succeeded record, fresh signed running-image/UI health and
/// exact-owned deletion it permits a later startup to retry reclamation only.
fn no_longer_live(expected: &ProcessIdentity) -> Result<()> {
    let raw = unsafe { OpenProcess(0x00101000, 0, expected.pid) };
    if raw.is_null() {
        return if unsafe { GetLastError() } == 87 { Ok(()) } else { Err(Error::Uncertain) };
    }
    let handle = Handle(raw);
    if process_identity(handle.0, expected.pid)? != *expected { return Ok(()); }
    match unsafe { WaitForSingleObject(handle.0, 0) } {
        0 => {
            let mut code = 259;
            if unsafe { GetExitCodeProcess(handle.0, &mut code) } == 0 || code != 0 {
                return Err(Error::Uncertain);
            }
            Ok(())
        },
        258 => Err(Error::Busy),
        _ => Err(Error::Uncertain),
    }
}

fn remember_issue(store: &mut RecoveryStore, nonce: &str, issue: Issue) -> Result<()> {
    let mut r = store.read()?.ok_or(Error::Missing)?;
    if r.nonce != nonce || r.engine.phase != RecoveryPhase::Succeeded || r.abandoned { return Err(Error::Unsafe); }
    let p = r.cleanup.get_or_insert(Progress { next: 0, intent: false, issue: None });
    if !p.finished() && p.issue != Some(issue) { p.issue = Some(issue); store.publish(&mut r)?; }
    Ok(())
}

/// Preserve the exact previous proof/progress before the sole current slot is
/// reused. This immutable receipt is NOT discovered, replayed or used as cleanup
/// authority. The newer signed running payload cannot attest older restart health.
pub(super) fn archive_before_replace(store: &RecoveryStore) -> Result<()> {
    let Some(record) = store.read()? else { return Ok(()); };
    if record.abandoned || !matches!(record.engine.phase, RecoveryPhase::Succeeded | RecoveryPhase::Restored)
        || record.cleanup.as_ref().is_some_and(Progress::finished) { return Ok(()); }
    let directory = store.directory.join(&record.nonce);
    let _pin = fs::directory(&directory, 0x80)?;
    let archive = directory.join(format!("retained-v3-{}.dpapi", record.publication));
    let expected = record.encode()?;
    let verify = || -> Result<()> {
        let bytes = fs::read_bounded(&archive, 64 * 1024)?.ok_or(Error::Missing)?;
        let plain = fs::crypt_root(&record.root, "retained-v3", &bytes, false)?;
        if RecoveryTransaction::decode(&plain)? != record { return Err(Error::Unsafe); }
        Ok(())
    };
    if archive.exists() { return verify(); }
    let pending = directory.join(format!("retained-{}.pending", random_nonce()?));
    let cipher = fs::crypt_root(&record.root, "retained-v3", &expected, true)?;
    drop(fs::new_file(&pending, &cipher)?);
    let (_source, _) = FileProof::open(&pending, true)?;
    // WRITE_THROUGH, no REPLACE_EXISTING: never overwrite an unknown receipt.
    let _status = unsafe { MoveFileExW(fs::wide(&pending).as_ptr(), fs::wide(&archive).as_ptr(), 8) };
    // The DELETE-access rename pin must close before read_bounded's share-read
    // reopen. Ancestor pins remain; decrypted exact readback detects replacement.
    drop(_source);
    // The native return may be uncertain. Only durable decrypted readback grants
    // permission to reuse the current slot; a partial pending file grants none.
    verify()
}

fn finalize_missing_setup(store: &mut RecoveryStore, record: &mut RecoveryTransaction) -> Result<bool> {
    if record.cleanup.as_ref().is_some_and(|p| p.next == COUNT - 1 && p.intent)
        && matches!(FileProof::open(&store.root.path().join(&record.installer_name), false), Err(Error::Missing)) {
        record.cleanup = Some(Progress { next: COUNT, intent: false, issue: None });
        store.publish(record)?;
        return Ok(true);
    }
    Ok(false)
}

// Parameters are native capabilities supplied by current(), never renderer data.
// Separating acquisition from verification lets generated fixtures exercise the
// EXACT signature/payload/registry checks without inspecting a user installation.
fn admit(root: &PinnedRoot, record: &RecoveryTransaction, key: &crate::update_package::TrustedKey,
    current: &Path, version: &str, registry: &RegistryKey) -> Result<(File, File)> {
    record.validate()?;
    root.verify()?;
    if record.root != root.0.binding || record.engine.phase != RecoveryPhase::Succeeded || record.abandoned {
        return Err(Error::Unsafe);
    }
    no_longer_live(&record.parent)?;
    no_longer_live(record.helper.as_ref().ok_or(Error::Unsafe)?)?;
    no_longer_live(record.worker.as_ref().ok_or(Error::Unsafe)?)?;
    if record.target_version != version { return Err(Error::Unsafe); }
    let (mut installer, captured) = FileProof::open(&root.path().join(&record.installer_name), false)?;
    if captured != record.installer { return Err(Error::Unsafe); }
    let package = crate::update_package::authenticate_snapshot(&mut installer, record.package_signature.as_bytes(),
        &record.target_version, crate::update_package::Architecture::X64, key).map_err(|_| Error::Unsafe)?;
    if package.updater_protocol() != 3 || package.target_version() != record.target_version
        || package.payload_sha256() != record.payload_sha256 { return Err(Error::Unsafe); }
    if dunce::canonicalize(current).map_err(|_| Error::Io)? != dunce::canonicalize(root.path().join(LIVE_NAMES[0])).map_err(|_| Error::Io)? {
        return Err(Error::Unsafe);
    }
    let (running_pin, running) = FileProof::open(current, false)?;
    let (uninstaller_pin, uninstaller) = FileProof::open(&root.path().join(LIVE_NAMES[1]), false)?;
    if running.sha256 != package.payload_sha256() || record.files[0].candidate.as_ref() != Some(&running)
        || record.files[1].candidate.as_ref() != Some(&uninstaller) { return Err(Error::Unsafe); }
    validate_static_registration_for_version(root, registry, version)?;
    if registry.snapshot()? != record.new_values { return Err(Error::Unsafe); }
    // setup read pin closes here. Live pins remain through the file/journal run.
    Ok((running_pin, uninstaller_pin))
}

fn admitted_run(store: &mut RecoveryStore, mut record: RecoveryTransaction,
    key: &crate::update_package::TrustedKey, current: &Path, version: &str, registry: &RegistryKey) -> Result<()> {
    if record.engine.phase != RecoveryPhase::Succeeded || record.abandoned { return Err(Error::Unsafe); }
    if record.cleanup.as_ref().is_some_and(Progress::finished) || finalize_missing_setup(store, &mut record)? { return Ok(()); }
    let result = (|| {
        let _live_pins = admit(&store.root, &record, key, current, version, registry)?;
        run_files(store, record.clone(), usize::MAX)
    })();
    if let Err(ref error) = result {
        let issue = match error {
            Error::Io | Error::Busy => Issue::LockedOrIo,
            Error::Invalid | Error::Unsafe => Issue::ChangedOrUnsafe,
            _ => Issue::EvidenceUnavailable,
        };
        // If journal access itself is uncertain, keep the original error and do
        // not guess at its contents. Runtime still records the safe reason code.
        let _ = remember_issue(store, &record.nonce, issue);
    }
    result
}

/// Caller is the native coordinator AFTER fresh settings and renderer readiness.
/// Records alone never authorize deletion: reauthenticate the signed package,
/// currently running payload, registration and updater process absence each run.
pub(super) fn current() -> std::result::Result<bool, &'static str> {
    (|| -> Result<bool> {
        let installation = match crate::install_root::RegisteredInstallation::capture_current_startup().map_err(|_| Error::Unsafe)? {
            Some(value) if value.is_current().map_err(|_| Error::Unsafe)? => value,
            _ => return Ok(false),
        };
        let root = capture_admitted_root(installation)?;
        if !root.path().join(crate::update_transaction::STATE_DIRECTORY).exists() { return Ok(false); }
        let mut store = RecoveryStore::open(&root, "Global\\NearlyInstallMutation-local.syncfiles.native-v3")?;
        let record = store.read()?.ok_or(Error::Missing)?;
        if record.engine.phase != RecoveryPhase::Succeeded || record.abandoned { return Ok(false); }
        let nonce = record.nonce.clone();
        let result = (|| {
            let key = crate::update_package::runtime_key().ok_or(Error::Disabled)?;
            let current = std::env::current_exe().map_err(|_| Error::Io)?;
            let registry = RegistryKey::open("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\local.syncfiles.native")?;
            admitted_run(&mut store, record, &key, &current, env!("CARGO_PKG_VERSION"), &registry)
        })();
        if let Err(ref error) = result {
            let issue = match error {
                Error::Busy | Error::Io => Issue::LockedOrIo,
                Error::Unsafe | Error::Invalid => Issue::ChangedOrUnsafe,
                _ => Issue::EvidenceUnavailable,
            };
            let _ = remember_issue(&mut store, &nonce, issue);
        }
        result?;
        Ok(true)
    })().map_err(|error| match error {
        Error::Busy | Error::Io => "cleanupLockedOrIo",
        Error::Unsafe | Error::Invalid => "cleanupChangedOrUnsafe",
        _ => "cleanupEvidenceUnavailable",
    })
}
// Fixed targets derived from the original transaction. No stored path, prefix
// search, directory traversal, or deletion of live installation files.
fn target(root: &PinnedRoot, r: &RecoveryTransaction, index: u8) -> Result<(PathBuf, FileProof, bool)> {
    let directory = root.path().join(crate::update_transaction::STATE_DIRECTORY).join(&r.nonce);
    let (path, proof, optional) = match index {
        0 | 1 => (directory.join(BACKUP_NAMES[index as usize]), r.files[index as usize].backup.clone(), false),
        2 | 3 => {
            let i = (index - 2) as usize;
            (directory.join(format!("displaced-old-{}", LIVE_NAMES[i])), r.files[i].old.clone(), true)
        },
        4 | 5 => {
            let i = (index - 4) as usize;
            (directory.join("candidate").join(LIVE_NAMES[i]), r.files[i].candidate.clone().ok_or(Error::Unsafe)?, true)
        },
        6 => (root.path().join(&r.installer_name), r.installer.clone(), false),
        _ => return Err(Error::Invalid),
    };
    Ok((path, proof, optional))
}

fn open_delete(path: &Path, expected: &FileProof) -> Result<File> {
    // Deny both write and delete sharing from hash observation through deletion.
    let mut file = OpenOptions::new().read(true).access_mode(0x80000000 | 0x10000)
        .share_mode(1).custom_flags(REPARSE).open(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { Error::Missing } else { Error::Io }
        })?;
    let info = fs::regular(&file)?;
    require_default_stream(path)?;
    let (length, digest) = fs::hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)?;
    if fs::identity(&info) != expected.identity || length != expected.length || digest != expected.sha256 {
        return Err(Error::Unsafe);
    }
    Ok(file)
}
fn delete_handle(file: File, path: &Path) -> Result<()> {
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{SetFileInformationByHandle,FileDispositionInfo,FILE_DISPOSITION_INFO}};
    let info = FILE_DISPOSITION_INFO { DeleteFile: true.into() };
    unsafe { SetFileInformationByHandle(HANDLE(file.as_raw_handle()), FileDispositionInfo,
        &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) }.map_err(|_| Error::Io)?;
    drop(file);
    // Delete-pending is not completion. Reopened foreign objects are preserved.
    match FileProof::open(path, false) {
        Err(Error::Missing) => Ok(()),
        _ => Err(Error::Uncertain),
    }
}

fn run_files(store: &mut RecoveryStore, mut record: RecoveryTransaction, at: usize) -> Result<()> {
    record.validate()?;
    if record.engine.phase != RecoveryPhase::Succeeded || record.abandoned
        || store.read()?.as_ref() != Some(&record) { return Err(Error::Unsafe); }
    let directory = store.directory.join(&record.nonce);
    // These pins prevent namespace redirection; old empty directories are kept
    // because legacy records have no independently recorded directory IDs.
    let _transaction = fs::directory(&directory, 0x80)?;
    let _candidate = fs::directory(&directory.join("candidate"), 0x80)?;
    if record.cleanup.is_none() {
        record.cleanup = Some(Progress { next: 0, intent: false, issue: None });
        store.publish(&mut record)?;
    }
    let mut boundary = Boundary { at, count: 0 };
    while record.cleanup.as_ref().ok_or(Error::Invalid)?.next < COUNT {
        store.root.verify()?;
        let progress = record.cleanup.as_ref().ok_or(Error::Invalid)?.clone();
        let (path, expected, optional) = target(&store.root, &record, progress.next)?;
        let opened = open_delete(&path, &expected);
        match opened {
            Err(Error::Missing) if optional || progress.intent => (),
            Ok(file) => {
                record.cleanup.as_mut().ok_or(Error::Invalid)?.intent = true;
                record.cleanup.as_mut().ok_or(Error::Invalid)?.issue = None;
                store.publish(&mut record)?;
                boundary.hit()?;
                if let Err(error) = delete_handle(file, &path) {
                    record.cleanup.as_mut().ok_or(Error::Invalid)?.issue = Some(match error {
                        Error::Io | Error::Busy => Issue::LockedOrIo,
                        _ => Issue::EvidenceUnavailable,
                    });
                    store.publish(&mut record)?;
                    return Err(error);
                }
                boundary.hit()?;
            },
            Err(error) => {
                record.cleanup.as_mut().ok_or(Error::Invalid)?.issue = Some(match error {
                    Error::Io | Error::Busy => Issue::LockedOrIo,
                    _ => Issue::ChangedOrUnsafe,
                });
                // Diagnostics never change Succeeded or grant new deletion rights.
                store.publish(&mut record)?;
                return Err(error);
            },
        }
        let p = record.cleanup.as_mut().ok_or(Error::Invalid)?;
        p.next += 1; p.intent = false; p.issue = None;
        store.publish(&mut record)?;
        boundary.hit()?;
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn fixture_run(store: &mut RecoveryStore, r: RecoveryTransaction, at: usize) -> Result<()> {
    run_files(store, r, at)
}

#[cfg(test)]
pub(super) fn fixture_admit(root: &PinnedRoot, r: &RecoveryTransaction, key: &crate::update_package::TrustedKey,
    current: &Path, version: &str, registry: &RegistryKey) -> Result<()> {
    admit(root, r, key, current, version, registry).map(|_| ())
}
#[cfg(test)]
pub(super) fn fixture_admitted_run(store: &mut RecoveryStore, r: RecoveryTransaction, key: &crate::update_package::TrustedKey,
    current: &Path, version: &str, registry: &RegistryKey) -> Result<()> {
    admitted_run(store, r, key, current, version, registry)
}
#[cfg(test)]
pub(super) fn fixture_peer(expected: &ProcessIdentity) -> Result<()> { no_longer_live(expected) }
#[cfg(test)]
pub(super) fn fixture_archive(store: &RecoveryStore) -> Result<()> { archive_before_replace(store) }
