//! Protocol-3 native recovery adapter. Persisted records are never capabilities.
use crate::update_cleanup::codec;
use crate::update_transaction::windows_impl as fs;
use crate::update_transaction::{Error, Result};
use std::{
    fs::{File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};
struct RootInner {
    path: PathBuf,
    binding: codec::Root,
    guards: Vec<File>,
}
#[derive(Clone)]
pub(crate) struct PinnedRoot(Arc<RootInner>);
impl PinnedRoot {
    fn capture(path: &Path) -> Result<Self> {
        let path = dunce::simplified(path).to_path_buf();
        let mut paths: Vec<_> = path.ancestors().collect();
        paths.reverse();
        let guards = paths
            .into_iter()
            .map(|p| fs::directory(p, 0x80))
            .collect::<Result<Vec<_>>>()?;
        let binding = codec::Root {
            path: path.to_str().ok_or(Error::Unsafe)?.into(),
            identity: fs::identity(&fs::info(guards.last().ok_or(Error::Unsafe)?)?),
        };
        Ok(Self(Arc::new(RootInner {
            path,
            binding,
            guards,
        })))
    }
    #[cfg(test)]
    fn fixture(path: &Path) -> Result<Self> {
        if !path.starts_with(std::env::temp_dir())
            || !path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with("nearly-"))
        {
            return Err(Error::Unsafe);
        }
        Self::capture(path)
    }
    pub(crate) fn path(&self) -> &Path {
        &self.0.path
    }
    fn verify(&self) -> Result<()> {
        let current = fs::directory(self.path(), 0x80)?;
        if fs::identity(&fs::info(&current)?) != self.0.binding.identity {
            return Err(Error::Unsafe);
        }
        Ok(())
    }
}
pub(crate) fn capture_registered_root() -> Result<PinnedRoot> {
    if !crate::startup_update::handoff_validated()
        || crate::update_package::runtime_key().is_none()
    {
        return Err(Error::Disabled);
    }
    let installation = crate::install_root::RegisteredInstallation::capture_recovery()
        .map_err(|_| Error::Unsafe)?;
    // Admission guards stay alive while PinnedRoot acquires its own pins.
    capture_admitted_root(installation)
}
fn capture_admitted_root(installation:crate::install_root::RegisteredInstallation)->Result<PinnedRoot>{
    let mut root=PinnedRoot::capture(installation.root())?;
    Arc::get_mut(&mut root.0).ok_or(Error::Unsafe)?.guards.extend(installation.into_guards());
    Ok(root)
}

use crate::update_recovery::{
    self as model, Direction, InstallObject, ObservedObject, ObservedTuple, RecoveryPhase,
    RecoveryRecord, StepStatus,
};
use crate::update_transaction::{sha256, ProcessIdentity};
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    process::{Child, Command},
    time::{Duration, Instant},
};
const REPARSE: u32 = 0x00200000;
const MAX_NATIVE_RECORD: usize = 48 * 1024;
const NATIVE_HEADER: &[u8] = b"NearlyUpdateTransaction2\0";
const VALUE_NAMES: [&str; 3] = ["DisplayVersion", "NearlyInternalVersion", "EstimatedSize"];
const LIVE_NAMES: [&str; 2] = ["Nearly.exe", "uninstall.exe"];
const BACKUP_NAMES: [&str; 2] = ["previous-image.exe", "previous-uninstaller.exe"];
type RawHandle = *mut c_void;
#[link(name = "kernel32")]
unsafe extern "system" {
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    fn CreateMutexW(attributes: *const c_void, initial: i32, name: *const u16) -> RawHandle;
    fn ReleaseMutex(handle: RawHandle) -> i32;
    fn CloseHandle(handle: RawHandle) -> i32;
    fn GetLastError() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn GetProcessTimes(
        handle: RawHandle,
        created: *mut windows::Win32::Foundation::FILETIME,
        exited: *mut windows::Win32::Foundation::FILETIME,
        kernel: *mut windows::Win32::Foundation::FILETIME,
        user: *mut windows::Win32::Foundation::FILETIME,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        handle: RawHandle,
        flags: u32,
        path: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: RawHandle, code: *mut u32) -> i32;
    fn CreateEventW(
        attributes: *const c_void,
        manual: i32,
        initial: i32,
        name: *const u16,
    ) -> RawHandle;
    fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> RawHandle;
    fn SetEvent(handle: RawHandle) -> i32;
    fn FindFirstStreamW(
        path: *const u16,
        level: u32,
        data: *mut StreamData,
        flags: u32,
    ) -> RawHandle;
    fn FindNextStreamW(handle: RawHandle, data: *mut StreamData) -> i32;
    fn FindClose(handle: RawHandle) -> i32;
}
#[repr(C)]
struct StreamData {
    size: i64,
    name: [u16; 296],
}
fn require_default_stream(path: &Path) -> Result<()> {
    let mut data = StreamData {
        size: 0,
        name: [0; 296],
    };
    let raw = unsafe { FindFirstStreamW(fs::wide(path).as_ptr(), 0, &mut data, 0) };
    if raw as isize == -1 {
        return Err(Error::Unsafe);
    }
    struct Stream(RawHandle);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                FindClose(self.0);
            }
        }
    }
    let stream = Stream(raw);
    let length = data
        .name
        .iter()
        .position(|c| *c == 0)
        .ok_or(Error::Unsafe)?;
    if String::from_utf16(&data.name[..length]).map_err(|_| Error::Unsafe)? != "::$DATA" {
        return Err(Error::Unsafe);
    }
    if unsafe { FindNextStreamW(stream.0, &mut data) } != 0 {
        return Err(Error::Unsafe);
    }
    if unsafe { GetLastError() } != 38 {
        return Err(Error::Uncertain);
    }
    Ok(())
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSetInformationFile(
        file: RawHandle,
        status: *mut windows::Win32::System::IO::IO_STATUS_BLOCK,
        info: *const c_void,
        bytes: u32,
        class: u32,
    ) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(
        key: RawHandle,
        sub: *const u16,
        options: u32,
        access: u32,
        out: *mut RawHandle,
    ) -> i32;
    fn RegQueryValueExW(
        key: RawHandle,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        length: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        key: RawHandle,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        length: u32,
    ) -> i32;
    fn RegDeleteValueW(key: RawHandle, name: *const u16) -> i32;
    fn RegFlushKey(key: RawHandle) -> i32;
    fn RegCloseKey(key: RawHandle) -> i32;
    #[cfg(test)]
    fn RegCreateKeyExW(
        key: RawHandle,
        sub: *const u16,
        reserved: u32,
        class: *mut u16,
        options: u32,
        access: u32,
        security: *const c_void,
        out: *mut RawHandle,
        disposition: *mut u32,
    ) -> i32;
    #[cfg(test)]
    fn RegDeleteTreeW(key: RawHandle, sub: *const u16) -> i32;
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn random_nonce() -> Result<String> {
    let mut b = [0; 16];
    getrandom::fill(&mut b).map_err(|_| Error::Io)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
struct Handle(RawHandle);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct MutationMutex(Handle);
impl MutationMutex {
    fn acquire(name: &str) -> Result<Self> {
        let raw = unsafe { CreateMutexW(std::ptr::null(), 1, wide(name).as_ptr()) };
        let error = unsafe { GetLastError() };
        if raw.is_null() {
            return Err(Error::Io);
        }
        let handle = Handle(raw);
        if error == 183 {
            return Err(Error::Busy);
        }
        Ok(Self(handle))
    }
}
impl Drop for MutationMutex {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawValue {
    present: bool,
    kind: u32,
    bytes: Vec<u8>,
}
impl RawValue {
    fn absent() -> Self {
        Self {
            present: false,
            kind: 0,
            bytes: Vec::new(),
        }
    }
    fn string(value: &str) -> Self {
        Self {
            present: true,
            kind: 1,
            bytes: value
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        }
    }
    fn dword(value: u32) -> Self {
        Self {
            present: true,
            kind: 4,
            bytes: value.to_le_bytes().to_vec(),
        }
    }
    fn validate(&self) -> Result<()> {
        if self.bytes.len() > 1024 || (!self.present && (self.kind != 0 || !self.bytes.is_empty()))
        {
            Err(Error::Invalid)
        } else {
            Ok(())
        }
    }
}
struct RegistryKey {
    handle: RawHandle,
    sub: String,
}
impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.handle);
        }
    }
}
impl RegistryKey {
    fn open(sub: &str) -> Result<Self> {
        let mut handle = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                0x80000001usize as RawHandle,
                wide(sub).as_ptr(),
                0,
                0x0001 | 0x0002 | 0x0100,
                &mut handle,
            )
        };
        if status != 0 {
            return Err(Error::Unsafe);
        }
        Ok(Self {
            handle,
            sub: sub.into(),
        })
    }
    fn read_named(&self, name: &str) -> Result<RawValue> {
        let name = wide(name);
        let mut kind = 0;
        let mut length = 0;
        let status = unsafe {
            RegQueryValueExW(
                self.handle,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut length,
            )
        };
        if status == 2 {
            return Ok(RawValue::absent());
        }
        if status != 0 || length > 1024 {
            return Err(Error::Unsafe);
        }
        let mut bytes = vec![0; length as usize];
        if unsafe {
            RegQueryValueExW(
                self.handle,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                bytes.as_mut_ptr(),
                &mut length,
            )
        } != 0
            || length as usize > bytes.len()
        {
            return Err(Error::Uncertain);
        }
        bytes.truncate(length as usize);
        Ok(RawValue {
            present: true,
            kind,
            bytes,
        })
    }
    fn read(&self, index: usize) -> Result<RawValue> {
        self.read_named(VALUE_NAMES.get(index).ok_or(Error::Invalid)?)
    }
    fn write(&self, index: usize, expected: &RawValue, value: &RawValue) -> Result<()> {
        value.validate()?;
        if &self.read(index)? != expected {
            return Err(Error::Unsafe);
        }
        let name = wide(VALUE_NAMES.get(index).ok_or(Error::Invalid)?);
        let status = unsafe {
            if value.present {
                RegSetValueExW(
                    self.handle,
                    name.as_ptr(),
                    0,
                    value.kind,
                    value.bytes.as_ptr(),
                    value.bytes.len() as u32,
                )
            } else {
                RegDeleteValueW(self.handle, name.as_ptr())
            }
        };
        // A failed API can still have changed the value. Read it before returning.
        let observed = self.read(index)?;
        if observed != *value {
            return Err(if observed == *expected && status != 0 {
                Error::Io
            } else {
                Error::Uncertain
            });
        }
        if unsafe { RegFlushKey(self.handle) } != 0 {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
    fn snapshot(&self) -> Result<[RawValue; 3]> {
        Ok([self.read(0)?, self.read(1)?, self.read(2)?])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileProof {
    identity: codec::Identity,
    length: u64,
    sha256: String,
}
impl FileProof {
    fn pin_shared(path: &Path, expected: &Self) -> Result<File> {
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(5)
            .custom_flags(REPARSE)
            .open(path)
            .map_err(|_| Error::Io)?;
        let information = fs::regular(&file)?;
        require_default_stream(path)?;
        let (length, digest) = fs::hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)?;
        if fs::identity(&information) != expected.identity
            || length != expected.length
            || digest != expected.sha256
        {
            return Err(Error::Unsafe);
        }
        Ok(file)
    }
    fn validate(&self) -> Result<()> {
        if !hex(&self.identity.file_id, 32)
            || !hex(&self.sha256, 64)
            || self.length == 0
            || self.length > crate::update_package::MAX_PACKAGE as u64
        {
            Err(Error::Invalid)
        } else {
            Ok(())
        }
    }
    fn open(path: &Path, rename: bool) -> Result<(File, Self)> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .share_mode(if rename { 5 } else { 1 })
            .custom_flags(REPARSE);
        if rename {
            options.access_mode(0x80000000 | 0x00010000);
        }
        let mut file = options.open(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Missing
            } else {
                Error::Io
            }
        })?;
        let information = fs::regular(&file)?;
        require_default_stream(path)?;
        let (length, digest) = fs::hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)?;
        let proof = Self {
            identity: fs::identity(&information),
            length,
            sha256: digest,
        };
        proof.validate()?;
        if proof.length != fs::file_length(&information) {
            return Err(Error::Unsafe);
        }
        Ok((file, proof))
    }
    fn matches(&self, path: &Path) -> bool {
        Self::open(path, false).is_ok_and(|(_, p)| p == *self)
    }
    fn copy_to(&self, source: &Path, destination: &Path) -> Result<Self> {
        let (mut input, current) = Self::open(source, false)?;
        if current != *self {
            return Err(Error::Unsafe);
        }
        input.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
        let mut output = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(1)
            .custom_flags(REPARSE)
            .open(destination)
            .map_err(|_| Error::Io)?;
        std::io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|_| Error::Io)?;
        drop(output);
        let (_, copy) = Self::open(destination, false)?;
        if copy.length != self.length || copy.sha256 != self.sha256 {
            return Err(Error::Unsafe);
        }
        Ok(copy)
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum FileOperation {
    DisplaceOld,
    PromoteNew,
    CreateRestoreCandidate,
    DisplaceNew,
    PromoteOld,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileMutationStep {
    object: InstallObject,
    operation: FileOperation,
    status: StepStatus,
    source: FileProof,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FileState {
    old: FileProof,
    backup: FileProof,
    candidate: Option<FileProof>,
    restore: Option<FileProof>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecoveryTransaction {
    schema_version: u8,
    publication: u32,
    root: codec::Root,
    nonce: String,
    source_version: String,
    target_version: String,
    public_label: String,
    package_signature: String,
    payload_sha256: String,
    installer_name: String,
    installer: FileProof,
    files: [FileState; 2],
    old_values: [RawValue; 3],
    new_values: [RawValue; 3],
    settings_sha256: Option<String>,
    engine: RecoveryRecord,
    file_step: Option<FileMutationStep>,
    parent: ProcessIdentity,
    helper: Option<ProcessIdentity>,
    worker: Option<ProcessIdentity>,
    child: Option<ProcessIdentity>,
    old_restart_attempted: bool,
    abandoned: bool,
}
impl RecoveryTransaction {
    fn validate(&self) -> Result<()> {
        if self.schema_version != 2
            || self.publication > 512
            || !hex(&self.nonce, 32)
            || self.root.path.len() > 512
            || !hex(&self.root.identity.file_id, 32)
            || self.package_signature.len() > 16 * 1024
            || self.package_signature.is_empty()
            || !hex(&self.payload_sha256, 64)
            || self.installer_name != format!("Nearly_{}_x64-setup.exe", self.public_label)
            || crate::version::release_version(&self.public_label)
                .map(|v| v.to_string())
                .as_deref()
                != Some(&self.target_version)
            || self.source_version.len() > 32
            || crate::version::release_version(&format!(
                "r{}",
                self.source_version
                    .strip_suffix(".0")
                    .ok_or(Error::Invalid)?
            ))
            .map(|v| v.to_string())
            .as_deref()
                != Some(&self.source_version)
            || self.settings_sha256.as_ref().is_some_and(|s| !hex(s, 64))
            || [
                Some(&self.parent),
                self.helper.as_ref(),
                self.worker.as_ref(),
                self.child.as_ref(),
            ]
            .into_iter()
            .flatten()
            .any(|p| p.pid == 0 || p.created == 0)
        {
            return Err(Error::Invalid);
        }
        model::validate(&self.engine).map_err(|_| Error::Invalid)?;
        self.installer.validate()?;
        for f in &self.files {
            f.old.validate()?;
            f.backup.validate()?;
            for p in [&f.candidate, &f.restore].into_iter().flatten() {
                p.validate()?;
            }
        }
        for value in self.old_values.iter().chain(self.new_values.iter()) {
            value.validate()?;
        }
        if let Some(step) = &self.file_step {
            if !matches!(
                step.object,
                InstallObject::Image | InstallObject::Uninstaller
            ) || !matches!(
                self.engine.phase,
                RecoveryPhase::Applying | RecoveryPhase::Restoring | RecoveryPhase::ManualRepair
            ) {
                return Err(Error::Invalid);
            }
            step.source.validate()?;
        }
        Ok(())
    }
    fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let b = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if b.len() > MAX_NATIVE_RECORD {
            return Err(Error::Invalid);
        }
        Ok(b)
    }
    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_NATIVE_RECORD {
            return Err(Error::Invalid);
        }
        let record: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        record.validate()?;
        Ok(record)
    }
}
fn child_directory(parent: &Path, name: &str) -> Result<(File, bool)> {
    if name.is_empty() || name.contains(['\\', '/', ':']) || matches!(name, "." | "..") {
        return Err(Error::Unsafe);
    }
    // Parent is held without delete sharing. Relative NT create avoids a leaf
    // directory swap between create and open; the returned guard pins the leaf.
    use windows::{
        core::PWSTR,
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                NtCreateFile, NTCREATEFILE_CREATE_DISPOSITION, NTCREATEFILE_CREATE_OPTIONS,
            },
        },
        Win32::{
            Foundation::{HANDLE, OBJECT_ATTRIBUTE_FLAGS, UNICODE_STRING},
            Storage::FileSystem::{FILE_ACCESS_RIGHTS, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE},
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let parent = fs::directory(parent, 0x84)?;
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let unicode = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: PWSTR(name.as_mut_ptr()),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: HANDLE(parent.as_raw_handle()),
        ObjectName: &unicode,
        Attributes: OBJECT_ATTRIBUTE_FLAGS(0x40),
        ..Default::default()
    };
    let mut handle = HANDLE::default();
    let mut status = IO_STATUS_BLOCK::default();
    unsafe {
        NtCreateFile(
            &mut handle,
            FILE_ACCESS_RIGHTS(0x00100083),
            &attributes,
            &mut status,
            None,
            FILE_FLAGS_AND_ATTRIBUTES(0x10),
            FILE_SHARE_MODE(3),
            NTCREATEFILE_CREATE_DISPOSITION(3),
            NTCREATEFILE_CREATE_OPTIONS(0x00200021),
            None,
            0,
        )
    }
    .ok()
    .map_err(|_| Error::Io)?;
    let file = unsafe { File::from_raw_handle(handle.0) };
    if fs::info(&file)?.dwFileAttributes & 0x10 == 0 || !matches!(status.Information, 1 | 2) {
        return Err(Error::Unsafe);
    }
    Ok((file, status.Information == 2))
}
struct RecoveryStore {
    root: PinnedRoot,
    directory: PathBuf,
    _state: File,
    _owner: File,
    _lease: File,
    _mutex: MutationMutex,
}
impl RecoveryStore {
    fn open(root: &PinnedRoot, mutex_name: &str) -> Result<Self> {
        root.verify()?;
        let mutex = MutationMutex::acquire(mutex_name)?;
        let (state, created) =
            child_directory(root.path(), crate::update_transaction::STATE_DIRECTORY)?;
        let directory = root.path().join(crate::update_transaction::STATE_DIRECTORY);
        let owner_path = directory.join("owner-v3.dpapi");
        if created || !owner_path.exists() {
            // A schema1 state directory is retained and fenced, never migrated.
            if directory.join("transaction.dpapi").exists() {
                return Err(Error::Unsafe);
            }
            let plain = serde_json::to_vec(&root.0.binding).map_err(|_| Error::Invalid)?;
            let sealed = fs::crypt_root(&root.0.binding, "owner-v3", &plain, true)?;
            drop(fs::new_file(&owner_path, &sealed)?);
        }
        let owner = FileProof::open(&owner_path, false)
            .or_else(|_| {
                // DPAPI blobs may be shorter than an application; normal regular
                // file verification remains mandatory and does not parse as PE.
                Err(Error::Unsafe)
            })?
            .0;
        let bytes = fs::read_bounded(&owner_path, 64 * 1024)?.ok_or(Error::Unsafe)?;
        let plain = fs::crypt_root(&root.0.binding, "owner-v3", &bytes, false)?;
        let binding: codec::Root = serde_json::from_slice(&plain).map_err(|_| Error::Invalid)?;
        if binding != root.0.binding {
            return Err(Error::Unsafe);
        }
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .custom_flags(REPARSE)
            .open(directory.join("transaction.lock"))
            .map_err(|_| Error::Busy)?;
        fs::regular(&lease)?;
        Ok(Self {
            root: root.clone(),
            directory,
            _state: state,
            _owner: owner,
            _lease: lease,
            _mutex: mutex,
        })
    }
    fn read(&self) -> Result<Option<RecoveryTransaction>> {
        self.root.verify()?;
        let Some(bytes) = fs::read_bounded(&self.directory.join("recovery-v3.dpapi"), 64 * 1024)?
        else {
            return Ok(None);
        };
        let cipher = bytes.strip_prefix(NATIVE_HEADER).ok_or(Error::Invalid)?;
        let plain = fs::crypt_root(&self.root.0.binding, "record-v3", cipher, false)?;
        let r = RecoveryTransaction::decode(&plain)?;
        if r.root != self.root.0.binding {
            return Err(Error::Unsafe);
        }
        Ok(Some(r))
    }
    fn publish(&self, record: &mut RecoveryTransaction) -> Result<()> {
        self.root.verify()?;
        let current = self.read()?;
        if current.as_ref().is_some_and(|c| {
            if c.nonce == record.nonce {
                c.publication != record.publication
            } else {
                record.publication != 0
                    || record.engine.phase != RecoveryPhase::Prepared
                    || (!c.abandoned
                        && !matches!(
                            c.engine.phase,
                            RecoveryPhase::Succeeded | RecoveryPhase::Restored
                        ))
            }
        }) {
            return Err(Error::Uncertain);
        }
        record.publication = record
            .publication
            .checked_add(1)
            .filter(|n| *n <= 512)
            .ok_or(Error::Invalid)?;
        let plain = record.encode()?;
        let cipher = fs::crypt_root(&self.root.0.binding, "record-v3", &plain, true)?;
        let mut bytes = NATIVE_HEADER.to_vec();
        bytes.extend(cipher);
        let pending = self
            .directory
            .join(format!("recovery-{}.pending", random_nonce()?));
        drop(fs::new_file(&pending, &bytes)?);
        let (guard, identity) = FileProof::open(&pending, true)?;
        if unsafe {
            MoveFileExW(
                fs::wide(&pending).as_ptr(),
                fs::wide(&self.directory.join("recovery-v3.dpapi")).as_ptr(),
                1 | 8,
            )
        } == 0
        {
            // Publication may have taken effect even if native status failed.
            drop(guard);
            return if self.read()?.as_ref() == Some(record) {
                Ok(())
            } else {
                Err(Error::Uncertain)
            };
        }
        drop(guard);
        let _ = identity;
        if self.read()?.as_ref() != Some(record) {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
}

/// Each native API effect is surrounded by durable intent and fresh observation.
/// An interruption returns to the supervisor; no API error means "no effect".
struct Boundary {
    at: usize,
    count: usize,
}
impl Boundary {
    fn hit(&mut self) -> Result<()> {
        let n = self.count;
        self.count += 1;
        if n == self.at {
            Err(Error::Uncertain)
        } else {
            Ok(())
        }
    }
}
pub(crate) struct RecoverySession {
    store: RecoveryStore,
    record: RecoveryTransaction,
    registry: RegistryKey,
    _transaction: File,
    _candidate: File,
    _backups: [File; 2],
    candidate_pins: [Option<File>; 2],
    restore_pins: [Option<File>; 2],
}
impl RecoverySession {
    fn prepare(
        root: &PinnedRoot,
        registry: RegistryKey,
        material: PackageMaterial,
        settings: Option<String>,
        mutex_name: &str,
    ) -> Result<Self> {
        // Admission is all-or-nothing before any backup/state creation.
        root.verify()?;
        let (old_image_guard, old_image) =
            FileProof::open(&root.path().join(LIVE_NAMES[0]), false)?;
        let (old_uninstaller_guard, old_uninstaller) =
            FileProof::open(&root.path().join(LIVE_NAMES[1]), false)?;
        let old_values = registry.snapshot()?;
        let store = RecoveryStore::open(root, mutex_name)?;
        if store.read()?.is_some_and(|r| {
            !r.abandoned
                && !matches!(
                    r.engine.phase,
                    RecoveryPhase::Succeeded | RecoveryPhase::Restored
                )
        }) {
            return Err(Error::Unsafe);
        }
        let nonce = random_nonce()?;
        let (transaction, created) = child_directory(&store.directory, &nonce)?;
        if !created {
            return Err(Error::Unsafe);
        }
        let directory = store.directory.join(&nonce);
        let (candidate, created) = child_directory(&directory, "candidate")?;
        if !created {
            return Err(Error::Unsafe);
        }
        let image_backup = old_image.copy_to(
            &root.path().join(LIVE_NAMES[0]),
            &directory.join(BACKUP_NAMES[0]),
        )?;
        let uninstall_backup = old_uninstaller.copy_to(
            &root.path().join(LIVE_NAMES[1]),
            &directory.join(BACKUP_NAMES[1]),
        )?;
        let (image_backup_guard, _) = FileProof::open(&directory.join(BACKUP_NAMES[0]), false)?;
        let (uninstall_backup_guard, _) = FileProof::open(&directory.join(BACKUP_NAMES[1]), false)?;
        let parent = current_process_identity()?;
        let record = RecoveryTransaction {
            schema_version: 2,
            publication: 0,
            root: root.0.binding.clone(),
            nonce,
            source_version: material.source_version,
            target_version: material.target_version,
            public_label: material.public_label,
            package_signature: material.signature,
            payload_sha256: material.payload_sha256,
            installer_name: material.installer_name,
            installer: material.installer,
            files: [
                FileState {
                    old: old_image,
                    backup: image_backup,
                    candidate: None,
                    restore: None,
                },
                FileState {
                    old: old_uninstaller,
                    backup: uninstall_backup,
                    candidate: None,
                    restore: None,
                },
            ],
            old_values,
            new_values: [RawValue::absent(), RawValue::absent(), RawValue::absent()],
            settings_sha256: settings,
            engine: RecoveryRecord {
                sequence: 0,
                phase: RecoveryPhase::Prepared,
                step: None,
            },
            file_step: None,
            parent,
            helper: None,
            worker: None,
            child: None,
            old_restart_attempted: false,
            abandoned: false,
        };
        drop(old_image_guard);
        drop(old_uninstaller_guard);
        let mut session = Self {
            store,
            record,
            registry,
            _transaction: transaction,
            _candidate: candidate,
            _backups: [image_backup_guard, uninstall_backup_guard],
            candidate_pins: [None, None],
            restore_pins: [None, None],
        };
        session.publish()?;
        Ok(session)
    }
    fn directory(&self) -> PathBuf {
        self.store.directory.join(&self.record.nonce)
    }
    fn backup_path(&self, index: usize) -> PathBuf {
        self.directory().join(BACKUP_NAMES[index])
    }
    fn live_path(&self, index: usize) -> PathBuf {
        self.store.root.path().join(LIVE_NAMES[index])
    }
    fn candidate_path(&self, index: usize) -> PathBuf {
        self.directory().join("candidate").join(LIVE_NAMES[index])
    }
    fn displaced_path(&self, index: usize, new: bool) -> PathBuf {
        self.directory().join(format!(
            "displaced-{}-{}",
            if new { "new" } else { "old" },
            LIVE_NAMES[index]
        ))
    }
    fn restore_path(&self, index: usize) -> PathBuf {
        self.directory()
            .join(format!("restore-{}", LIVE_NAMES[index]))
    }
    fn publish(&mut self) -> Result<()> {
        self.store.publish(&mut self.record)
    }
    fn index(object: InstallObject) -> Result<usize> {
        match object {
            InstallObject::Image => Ok(0),
            InstallObject::Uninstaller => Ok(1),
            _ => Err(Error::Invalid),
        }
    }
    fn validate_backups(&self) -> Result<()> {
        self.store.root.verify()?;
        for i in 0..2 {
            if !self.record.files[i].backup.matches(&self.backup_path(i)) {
                return Err(Error::Unsafe);
            }
        }
        Ok(())
    }
    fn observe_file(&self, index: usize) -> Result<ObservedObject> {
        let state = &self.record.files[index];
        let live = self.live_path(index);
        match FileProof::open(&live, false) {
            Ok((_, p)) if p == state.old || state.restore.as_ref() == Some(&p) => {
                return Ok(ObservedObject::Old)
            }
            Ok((_, p)) if state.candidate.as_ref() == Some(&p) => return Ok(ObservedObject::New),
            Ok(_) => return Ok(ObservedObject::Foreign),
            Err(Error::Missing) => (),
            Err(_) => return Ok(ObservedObject::Uncertain),
        }
        self.validate_backups()?;
        // Missing live is recoverable only from exact owned displacement plus
        // a persisted rename intent/observation identifying this file.
        if !self
            .record
            .file_step
            .as_ref()
            .is_some_and(|s| Self::index(s.object).ok() == Some(index))
        {
            return Ok(ObservedObject::Uncertain);
        }
        let old_displaced = state.old.matches(&self.displaced_path(index, false));
        let new_displaced = state
            .candidate
            .as_ref()
            .is_some_and(|p| p.matches(&self.displaced_path(index, true)));
        if old_displaced || new_displaced {
            Ok(ObservedObject::RecoverablePartial)
        } else {
            Ok(ObservedObject::Uncertain)
        }
    }
    pub(crate) fn inspect_tuple(&self) -> Result<ObservedTuple> {
        let current = RegistryKey::open(&self.registry.sub)?;
        let mut objects = [ObservedObject::Uncertain; 5];
        objects[0] = self.observe_file(0)?;
        objects[1] = self.observe_file(1)?;
        for i in 0..3 {
            let v = current.read(i)?;
            objects[i + 2] = match (
                v == self.record.old_values[i],
                v == self.record.new_values[i],
            ) {
                (true, true) => ObservedObject::Unchanged,
                (true, false) => ObservedObject::Old,
                (false, true) => ObservedObject::New,
                _ => ObservedObject::Foreign,
            };
        }
        Ok(ObservedTuple { objects })
    }
    fn rename(&self, source: &Path, destination: &Path, expected: &FileProof) -> Result<()> {
        self.store.root.verify()?;
        let (handle, p) = FileProof::open(source, true)?;
        if &p != expected {
            return Err(Error::Unsafe);
        }
        if destination.exists() {
            return Err(Error::Unsafe);
        }
        let parent = destination.parent().ok_or(Error::Unsafe)?;
        let parent_guard = fs::directory(parent, 0x82)?;
        let name: Vec<u16> = destination
            .file_name()
            .ok_or(Error::Unsafe)?
            .encode_wide()
            .collect();
        #[repr(C)]
        struct Rename {
            replace: u8,
            root: RawHandle,
            length: u32,
            name: [u16; 1],
        }
        let offset = std::mem::offset_of!(Rename, name);
        let mut data = vec![0u64; (offset + name.len() * 2 + 7) / 8];
        let ptr = data.as_mut_ptr().cast::<u8>();
        unsafe {
            let h = ptr.cast::<Rename>();
            (*h).replace = 0;
            (*h).root = parent_guard.as_raw_handle();
            (*h).length = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr().cast::<u8>(),
                ptr.add(offset),
                name.len() * 2,
            );
        }
        let mut io = windows::Win32::System::IO::IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtSetInformationFile(
                handle.as_raw_handle(),
                &mut io,
                ptr.cast(),
                (offset + name.len() * 2) as u32,
                10,
            )
        };
        #[cfg(test)]
        if status < 0 {
            eprintln!(
                "native fixture rename {} -> {} NTSTATUS {status:x}",
                source.display(),
                destination.display()
            );
        }
        // Retained source handle permits identity verification through rename.
        let endpoint = FileProof::open(destination, true);
        let source_absent = matches!(FileProof::open(source, false), Err(Error::Missing));
        if !source_absent || !endpoint.is_ok_and(|(_, p)| p == *expected) {
            return Err(if status < 0 {
                Error::Io
            } else {
                Error::Uncertain
            });
        }
        Ok(())
    }
    fn file_operation(
        &mut self,
        index: usize,
        operation: FileOperation,
        fault: &mut Boundary,
    ) -> Result<()> {
        self.revalidate_registration()?;
        self.validate_backups()?;
        let object = model::APPLY_ORDER[index];
        let (source, destination, proof) = match operation {
            FileOperation::DisplaceOld => (
                self.live_path(index),
                self.displaced_path(index, false),
                self.record.files[index].old.clone(),
            ),
            FileOperation::PromoteNew => (
                self.candidate_path(index),
                self.live_path(index),
                self.record.files[index]
                    .candidate
                    .clone()
                    .ok_or(Error::Invalid)?,
            ),
            FileOperation::CreateRestoreCandidate => (
                self.backup_path(index),
                self.restore_path(index),
                self.record.files[index].backup.clone(),
            ),
            FileOperation::DisplaceNew => (
                self.live_path(index),
                self.displaced_path(index, true),
                self.record.files[index]
                    .candidate
                    .clone()
                    .ok_or(Error::Invalid)?,
            ),
            FileOperation::PromoteOld => (
                self.restore_path(index),
                self.live_path(index),
                self.record.files[index]
                    .restore
                    .clone()
                    .ok_or(Error::Invalid)?,
            ),
        };
        fault.hit()?;
        self.record.file_step = Some(FileMutationStep {
            object,
            operation,
            status: StepStatus::Intent,
            source: proof.clone(),
        });
        self.publish()?;
        fault.hit()?;
        self.revalidate_registration()?;
        if operation == FileOperation::CreateRestoreCandidate {
            if destination.exists() {
                // A process crash before the copy's identity was published is
                // uncertain. Content equality alone does not grant ownership.
                return Err(Error::Uncertain);
            }
            let restored = proof.copy_to(&source, &destination)?;
            self.restore_pins[index] = Some(FileProof::pin_shared(&destination, &restored)?);
            self.record.files[index].restore = Some(restored);
        } else {
            self.rename(&source, &destination, &proof)?;
        }
        fault.hit()?;
        self.record.file_step.as_mut().ok_or(Error::Invalid)?.status = StepStatus::Observed;
        self.publish()?;
        fault.hit()?;
        Ok(())
    }
    fn mutate(
        &mut self,
        object: InstallObject,
        direction: Direction,
        fault: &mut Boundary,
    ) -> Result<()> {
        self.revalidate_registration()?;
        self.validate_backups()?;
        let step = self.record.engine.step.ok_or(Error::Unsafe)?;
        if step.object != object || step.direction != direction || step.status != StepStatus::Intent
        {
            return Err(Error::Unsafe);
        }
        if let Ok(index) = Self::index(object) {
            let observed = self.observe_file(index)?;
            if matches!(
                (direction, observed),
                (Direction::Apply, ObservedObject::New) | (Direction::Restore, ObservedObject::Old)
            ) {
                return Ok(());
            }
            if matches!(
                observed,
                ObservedObject::Foreign | ObservedObject::Uncertain
            ) {
                return Err(Error::Unsafe);
            }
            match direction {
                Direction::Apply => {
                    if observed == ObservedObject::Old {
                        self.file_operation(index, FileOperation::DisplaceOld, fault)?;
                    }
                    self.file_operation(index, FileOperation::PromoteNew, fault)?;
                }
                Direction::Restore => {
                    if self.record.files[index].restore.is_none() {
                        self.file_operation(index, FileOperation::CreateRestoreCandidate, fault)?;
                    }
                    if observed == ObservedObject::New {
                        self.file_operation(index, FileOperation::DisplaceNew, fault)?;
                    }
                    self.file_operation(index, FileOperation::PromoteOld, fault)?;
                }
            }
        } else {
            let index = model::APPLY_ORDER
                .iter()
                .position(|v| *v == object)
                .ok_or(Error::Invalid)?
                - 2;
            let (expected, value) = match direction {
                Direction::Apply => (
                    &self.record.old_values[index],
                    &self.record.new_values[index],
                ),
                Direction::Restore => (
                    &self.record.new_values[index],
                    &self.record.old_values[index],
                ),
            };
            let observed = self.registry.read(index)?;
            if observed == *value {
                return Ok(());
            }
            if observed != *expected {
                return Err(Error::Unsafe);
            }
            fault.hit()?;
            self.publish()?;
            fault.hit()?;
            self.revalidate_registration()?;
            let (expected, value) = match direction {
                Direction::Apply => (
                    &self.record.old_values[index],
                    &self.record.new_values[index],
                ),
                Direction::Restore => (
                    &self.record.new_values[index],
                    &self.record.old_values[index],
                ),
            };
            self.registry.write(index, expected, value)?;
            fault.hit()?;
        }
        Ok(())
    }
    pub(crate) fn apply_one(&mut self, object: InstallObject) -> Result<()> {
        self.mutate(
            object,
            Direction::Apply,
            &mut Boundary {
                at: usize::MAX,
                count: 0,
            },
        )
    }
    pub(crate) fn restore_one(&mut self, object: InstallObject) -> Result<()> {
        self.mutate(
            object,
            Direction::Restore,
            &mut Boundary {
                at: usize::MAX,
                count: 0,
            },
        )
    }
}
struct PackageMaterial {
    source_version: String,
    target_version: String,
    public_label: String,
    signature: String,
    payload_sha256: String,
    installer_name: String,
    installer: FileProof,
}
fn process_identity(handle: RawHandle, pid: u32) -> Result<ProcessIdentity> {
    let (mut created, mut exited, mut kernel, mut user) = (
        windows::Win32::Foundation::FILETIME::default(),
        windows::Win32::Foundation::FILETIME::default(),
        windows::Win32::Foundation::FILETIME::default(),
        windows::Win32::Foundation::FILETIME::default(),
    );
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0
        || pid == 0
    {
        return Err(Error::Unsafe);
    }
    let created = (created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64;
    if created == 0 {
        return Err(Error::Unsafe);
    }
    Ok(ProcessIdentity { pid, created })
}
fn current_process_identity() -> Result<ProcessIdentity> {
    let h = unsafe { OpenProcess(0x1000, 0, std::process::id()) };
    if h.is_null() {
        return Err(Error::Unsafe);
    }
    let h = Handle(h);
    process_identity(h.0, std::process::id())
}

pub(crate) struct RecoveryHealthSnapshot {
    root: PinnedRoot,
    record: RecoveryTransaction,
    helper_path: PathBuf,
    _helper: File,
    _installer: File,
    _running: File,
}
impl RecoveryHealthSnapshot {
    pub(crate) fn helper_identity(&self) -> &ProcessIdentity {
        self.record.helper.as_ref().expect("authenticated helper")
    }
    pub(crate) fn helper_path(&self) -> &Path {
        &self.helper_path
    }
    pub(crate) fn helper_file_identity(&self) -> &codec::Identity {
        &self.record.files[0].backup.identity
    }
    pub(crate) fn helper_sha256(&self) -> &str {
        &self.record.files[0].backup.sha256
    }
    pub(crate) fn nonce(&self) -> &str {
        &self.record.nonce
    }
    pub(crate) fn verify_helper_image(&self) -> std::result::Result<(), String> {
        (|| -> Result<()> {
            self.root.verify()?;
            let mut file = self._helper.try_clone().map_err(|_| Error::Io)?;
            let identity = fs::identity(&fs::regular(&file)?);
            let (length, digest) =
                fs::hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)?;
            let expected = &self.record.files[0].backup;
            if identity != expected.identity
                || length != expected.length
                || digest != expected.sha256
                || !expected.matches(&self.helper_path)
            {
                return Err(Error::Unsafe);
            }
            Ok(())
        })()
        .map_err(|_| "Recovery helper image proof was lost".into())
    }
    pub(crate) fn confirm_succeeded(&self) -> std::result::Result<(), String> {
        (|| -> Result<()> {
            self.verify_helper_image().map_err(|_| Error::Unsafe)?;
            let observed = observe_record(&self.root)?.ok_or(Error::Missing)?;
            if observed.nonce != self.record.nonce
                || observed.root != self.record.root
                || observed.helper != self.record.helper
                || observed.child != self.record.child
                || observed.payload_sha256 != self.record.payload_sha256
                || observed.engine.phase != RecoveryPhase::Succeeded
            {
                return Err(Error::Uncertain);
            }
            Ok(())
        })()
        .map_err(|_| "Durable supervisor success was not confirmed".into())
    }
}
fn observe_record(root: &PinnedRoot) -> Result<Option<RecoveryTransaction>> {
    root.verify()?;
    let directory = root.path().join(crate::update_transaction::STATE_DIRECTORY);
    let _state = fs::directory(&directory, 0x80)?;
    let owner =
        fs::read_bounded(&directory.join("owner-v3.dpapi"), 64 * 1024)?.ok_or(Error::Unsafe)?;
    let owner = fs::crypt_root(&root.0.binding, "owner-v3", &owner, false)?;
    if serde_json::from_slice::<codec::Root>(&owner).map_err(|_| Error::Invalid)? != root.0.binding
    {
        return Err(Error::Unsafe);
    }
    let Some(bytes) = fs::read_bounded(&directory.join("recovery-v3.dpapi"), 64 * 1024)? else {
        return Ok(None);
    };
    let cipher = bytes.strip_prefix(NATIVE_HEADER).ok_or(Error::Invalid)?;
    let plain = fs::crypt_root(&root.0.binding, "record-v3", cipher, false)?;
    let record = RecoveryTransaction::decode(&plain)?;
    if record.root != root.0.binding {
        return Err(Error::Unsafe);
    }
    Ok(Some(record))
}
pub(crate) fn authenticate_health(nonce: &str) -> Result<RecoveryHealthSnapshot> {
    if !hex(nonce, 32) {
        return Err(Error::Invalid);
    }
    let root = capture_registered_root()?;
    validate_settings_override(&root)?;
    let record = observe_record(&root)?.ok_or(Error::Missing)?;
    if record.nonce != nonce
        || !matches!(
            record.engine.phase,
            RecoveryPhase::AwaitingHealth | RecoveryPhase::Succeeded
        )
        || record.child.as_ref() != Some(&current_process_identity()?)
        || record.helper.is_none()
    {
        return Err(Error::Unsafe);
    }
    let (_installer, proof) = authenticate_installer(&root, &record)?;
    if proof.updater_protocol() != 3
        || proof.payload_sha256() != record.payload_sha256
        || proof.target_version() != env!("CARGO_PKG_VERSION")
    {
        return Err(Error::Unsafe);
    }
    let current = std::env::current_exe().map_err(|_| Error::Io)?;
    if dunce::canonicalize(&current).map_err(|_| Error::Io)?
        != dunce::canonicalize(root.path().join("Nearly.exe")).map_err(|_| Error::Io)?
    {
        return Err(Error::Unsafe);
    }
    let (_running, running) = FileProof::open(&current, false)?;
    if running.sha256 != proof.payload_sha256()
        || record.files[0].candidate.as_ref() != Some(&running)
    {
        return Err(Error::Unsafe);
    }
    let helper_path = root
        .path()
        .join(crate::update_transaction::STATE_DIRECTORY)
        .join(nonce)
        .join(BACKUP_NAMES[0]);
    let (_helper, helper) = FileProof::open(&helper_path, false)?;
    if helper != record.files[0].backup {
        return Err(Error::Unsafe);
    }
    Ok(RecoveryHealthSnapshot {
        root,
        record,
        helper_path,
        _helper,
        _installer,
        _running,
    })
}
fn authenticate_installer(
    root: &PinnedRoot,
    record: &RecoveryTransaction,
) -> Result<(File, crate::update_package::PackageProof)> {
    let (mut file, captured) = FileProof::open(&root.path().join(&record.installer_name), false)?;
    if captured != record.installer {
        return Err(Error::Unsafe);
    }
    let key = crate::update_package::runtime_key().ok_or(Error::Disabled)?;
    let proof = crate::update_package::authenticate_snapshot(
        &mut file,
        record.package_signature.as_bytes(),
        &record.target_version,
        crate::update_package::Architecture::X64,
        &key,
    )
    .map_err(|_| Error::Unsafe)?;
    if proof.updater_protocol() != 3 || proof.payload_sha256() != record.payload_sha256 {
        return Err(Error::Unsafe);
    }
    Ok((file, proof))
}
pub(crate) fn ordinary_startup_allowed() -> std::result::Result<(), String> {
    (|| -> Result<()> {
        let installation = match crate::install_root::RegisteredInstallation::capture_current_startup()
            .map_err(|_| Error::Unsafe)? {
            Some(installation) => installation,
            None => return Ok(()),
        };
        if !installation.is_current().map_err(|_| Error::Unsafe)? {
            return Ok(());
        }
        let root = capture_admitted_root(installation)?;
        observed_startup_admission(&root)
    })()
    .map_err(|_| "An incomplete native update requires recovery before Nearly can open".into())
}
fn observed_startup_admission(root: &PinnedRoot) -> Result<()> {
    let state = root.path().join(crate::update_transaction::STATE_DIRECTORY);
    if !state.exists() {
        return Ok(());
    }
    if !state.join("owner-v3.dpapi").exists() {
        return Err(Error::Unsafe);
    }
    let record = observe_record(root)?.ok_or(Error::Uncertain)?;
    if !record.abandoned
        && !matches!(
            record.engine.phase,
            RecoveryPhase::Succeeded | RecoveryPhase::Restored
        )
    {
        return Err(Error::Busy);
    }
    Ok(())
}
#[cfg(feature="installer-qa")]
pub(crate) fn qa_restored()->bool{
    (||->Result<bool>{
        let root=capture_registered_root()?;
        observed_startup_admission(&root)?;
        Ok(observe_record(&root)?.is_some_and(|r|!r.abandoned&&r.engine.phase==RecoveryPhase::Restored))
    })().unwrap_or(false)
}

struct LivePeer {
    process: Handle,
    identity: ProcessIdentity,
    path: PathBuf,
    image: FileProof,
    _image: File,
}
impl LivePeer {
    fn open(expected: &ProcessIdentity, path: &Path, image: &FileProof) -> Result<Self> {
        if expected.pid == 0 || expected.created == 0 {
            return Err(Error::Invalid);
        }
        let raw = unsafe { OpenProcess(0x00101000, 0, expected.pid) };
        if raw.is_null() {
            return Err(Error::Uncertain);
        }
        let process = Handle(raw);
        if process_identity(process.0, expected.pid)? != *expected
            || unsafe { WaitForSingleObject(process.0, 0) } != 258
        {
            return Err(Error::Unsafe);
        }
        let observed = process_path(process.0)?;
        let canonical = dunce::canonicalize(path).map_err(|_| Error::Io)?;
        if observed != canonical {
            return Err(Error::Unsafe);
        }
        // Read-only peer pin allows DELETE sharing after exact process exit.
        // A read pin without delete sharing would deadlock our later rename.
        let mut guard = OpenOptions::new()
            .read(true)
            .share_mode(5)
            .custom_flags(REPARSE)
            .open(path)
            .map_err(|_| Error::Io)?;
        let identity = fs::identity(&fs::regular(&guard)?);
        let (length, sha256) =
            fs::hash_file(&mut guard, crate::update_package::MAX_PACKAGE as u64)?;
        let proof = FileProof {
            identity,
            length,
            sha256,
        };
        if proof != *image {
            return Err(Error::Unsafe);
        }
        Ok(Self {
            process,
            identity: expected.clone(),
            path: canonical,
            image: proof,
            _image: guard,
        })
    }
    fn exited(&self) -> Result<Option<u32>> {
        observe_retained_exit(&self.identity, &self.path,
            || process_identity(self.process.0, self.identity.pid),
            |milliseconds| match unsafe { WaitForSingleObject(self.process.0, milliseconds) } {
                0 => Ok(true), 258 => Ok(false), _ => Err(Error::Uncertain),
            },
            || process_path(self.process.0),
            || {
                let mut code = 259;
                if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0 {
                    Err(Error::Uncertain)
                } else {
                    Ok(code)
                }
            })
    }
}
fn observe_retained_exit(
    expected: &ProcessIdentity,
    expected_path: &Path,
    mut identity: impl FnMut() -> Result<ProcessIdentity>,
    mut signaled: impl FnMut(u32) -> Result<bool>,
    path: impl FnOnce() -> Result<PathBuf>,
    mut exit_code: impl FnMut() -> Result<u32>,
) -> Result<Option<u32>> {
    let verify_identity = |observed: Result<ProcessIdentity>| -> Result<()> {
        let observed = observed.map_err(|error| {
            #[cfg(feature="installer-qa")]
            crate::installer_qa::trace("peerObservation", "identityQueryFailed");
            error
        })?;
        if observed != *expected { return Err(Error::Uncertain); }
        Ok(())
    };
    verify_identity(identity())?;
    let mut exited_after_path_failure = false;
    if !signaled(0)? {
        match path() {
            Ok(observed) => {
                if observed != expected_path { return Err(Error::Uncertain); }
                return Ok(None);
            }
            Err(error) => {
                #[cfg(feature="installer-qa")]
                crate::installer_qa::trace("peerObservation", "pathQueryFailed");
                // Image queries can fail while the retained object is still
                // tearing down. Wait once on that same handle, then revalidate
                // its identity. A timeout/error never authorizes a live peer.
                if !signaled(1000)? {
                    #[cfg(feature="installer-qa")]
                    crate::installer_qa::trace("peerObservation", "pathFailureStillLive");
                    return Err(error);
                }
                verify_identity(identity())?;
                exited_after_path_failure = true;
            }
        }
    }
    let code = exit_code()?;
    if code == 259 { return Err(Error::Uncertain); }
    #[cfg(feature="installer-qa")]
    if exited_after_path_failure {
        crate::installer_qa::trace("peerObservation", "exitAfterPathFailure");
    }
    let _ = exited_after_path_failure;
    Ok(Some(code))
}
fn process_path(handle: RawHandle) -> Result<PathBuf> {
    let mut bytes = vec![0u16; 32768];
    let mut length = bytes.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, bytes.as_mut_ptr(), &mut length) } == 0
        || length == 0
        || length as usize >= bytes.len()
    {
        return Err(Error::Unsafe);
    }
    let path = String::from_utf16(&bytes[..length as usize]).map_err(|_| Error::Unsafe)?;
    dunce::canonicalize(path).map_err(|_| Error::Unsafe)
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct HelperArgs {
    nonce: String,
    parent: Option<ProcessIdentity>,
    recovery_only: bool,
}
#[derive(Debug, PartialEq, Eq)]
enum HelperParse {
    Ordinary,
    Invalid,
    Helper(HelperArgs),
}
fn parse_helper<I, S>(args: I) -> HelperParse
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let args: Vec<_> = args
        .into_iter()
        .skip(1)
        .map(|s| s.as_ref().to_os_string())
        .collect();
    if !args.iter().any(|s| {
        s.to_string_lossy().starts_with("--nearly-recovery")
            || s.to_string_lossy().starts_with("--nearly-parent")
    }) {
        return HelperParse::Ordinary;
    }
    let strings: Option<Vec<_>> = args.iter().map(|s| s.to_str()).collect();
    let Some(args) = strings else {
        return HelperParse::Invalid;
    };
    if args.len() == 1 {
        if let Some(nonce) = args[0].strip_prefix("--nearly-recovery-only=") {
            if hex(nonce, 32) {
                return HelperParse::Helper(HelperArgs {
                    nonce: nonce.into(),
                    parent: None,
                    recovery_only: true,
                });
            }
        }
        return HelperParse::Invalid;
    }
    if args.len() != 2 {
        return HelperParse::Invalid;
    }
    let Some(nonce) = args[0].strip_prefix("--nearly-recovery=") else {
        return HelperParse::Invalid;
    };
    let Some(parent) = args[1].strip_prefix("--nearly-parent=") else {
        return HelperParse::Invalid;
    };
    let Some((pid, created)) = parent.split_once(':') else {
        return HelperParse::Invalid;
    };
    let canonical =
        |s: &str| !s.is_empty() && !s.starts_with('0') && s.bytes().all(|c| c.is_ascii_digit());
    if !hex(nonce, 32) || !canonical(pid) || !canonical(created) {
        return HelperParse::Invalid;
    }
    let (Ok(pid), Ok(created)) = (pid.parse::<u32>(), created.parse::<u64>()) else {
        return HelperParse::Invalid;
    };
    HelperParse::Helper(HelperArgs {
        nonce: nonce.into(),
        parent: Some(ProcessIdentity { pid, created }),
        recovery_only: false,
    })
}
struct Event(Handle);
impl Event {
    fn name(kind: &str, nonce: &str) -> String {
        format!("Local\\NearlyRecovery{kind}-{nonce}")
    }
    fn fresh_name(name: &str) -> Result<Self> {
        let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide(name).as_ptr()) };
        let code = unsafe { GetLastError() };
        if raw.is_null() {
            return Err(Error::Io);
        }
        let event = Self(Handle(raw));
        if code == 183 {
            return Err(Error::Unsafe);
        }
        Ok(event)
    }
    fn fresh(kind: &str, nonce: &str) -> Result<Self> {
        Self::fresh_name(&Self::name(kind, nonce))
    }
    fn open_name(name: &str) -> Result<Self> {
        let raw = unsafe { OpenEventW(0x00100002, 0, wide(name).as_ptr()) };
        if raw.is_null() {
            return Err(Error::Unsafe);
        }
        Ok(Self(Handle(raw)))
    }
    fn open(kind: &str, nonce: &str) -> Result<Self> {
        Self::open_name(&Self::name(kind, nonce))
    }
    fn set(&self) -> Result<()> {
        if unsafe { SetEvent(self.0 .0) } == 0 {
            Err(Error::Io)
        } else {
            Ok(())
        }
    }
    fn is_set(&self) -> Result<bool> {
        match unsafe { WaitForSingleObject(self.0 .0, 0) } {
            0 => Ok(true),
            258 => Ok(false),
            _ => Err(Error::Uncertain),
        }
    }
}
struct RecoveryEvents {
    ready: Event,
    abort: Event,
    commit: Event,
    healthy: Event,
    success: Event,
    success_ack: Event,
    exit_request: Event,
    idle: Event,
}
impl RecoveryEvents {
    fn fresh(nonce: &str) -> Result<Self> {
        Ok(Self {
            ready: Event::fresh("Ready", nonce)?,
            abort: Event::fresh("Abort", nonce)?,
            commit: Event::fresh("Commit", nonce)?,
            healthy: Event::fresh("Healthy", nonce)?,
            success: Event::fresh("Success", nonce)?,
            success_ack: Event::fresh("SuccessAck", nonce)?,
            exit_request: Event::fresh("ExitRequest", nonce)?,
            idle: Event::fresh("Idle", nonce)?,
        })
    }
    fn open(nonce: &str) -> Result<Self> {
        let events = Self {
            ready: Event::open("Ready", nonce)?,
            abort: Event::open("Abort", nonce)?,
            commit: Event::open("Commit", nonce)?,
            healthy: Event::open("Healthy", nonce)?,
            success: Event::open("Success", nonce)?,
            success_ack: Event::open("SuccessAck", nonce)?,
            exit_request: Event::open("ExitRequest", nonce)?,
            idle: Event::open("Idle", nonce)?,
        };
        if events.ready.is_set()?
            || events.abort.is_set()?
            || events.commit.is_set()?
            || events.healthy.is_set()?
            || events.success.is_set()?
            || events.success_ack.is_set()?
            || events.exit_request.is_set()?
            || events.idle.is_set()?
        {
            return Err(Error::Unsafe);
        }
        Ok(events)
    }
}
fn settings_fingerprint(root: &PinnedRoot) -> Result<String> {
    root.verify()?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut total = 0usize;
    for name in crate::split_settings::NAMES {
        hash.update(name.as_bytes());
        match fs::read_bounded(&root.path().join(name), 16_000_000)? {
            None => hash.update(&[0]),
            Some(bytes) => {
                total = total.checked_add(bytes.len()).ok_or(Error::Invalid)?;
                if total > 16_000_000 {
                    return Err(Error::Invalid);
                }
                hash.update(&[1]);
                hash.update(&(bytes.len() as u64).to_le_bytes());
                hash.update(&bytes);
            }
        }
    }
    Ok(hash
        .finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn validate_settings_anchor(root: &PinnedRoot, anchor: &Path) -> Result<()> {
    if anchor.file_name().and_then(|s| s.to_str()) != Some("settings.json")
        || dunce::canonicalize(anchor.parent().ok_or(Error::Unsafe)?).map_err(|_| Error::Unsafe)?
            != dunce::canonicalize(root.path()).map_err(|_| Error::Unsafe)?
    {
        return Err(Error::Unsafe);
    }
    Ok(())
}
fn validate_settings_override(root: &PinnedRoot) -> Result<()> {
    if let Some(path) = std::env::var_os("SYNCFILES_CONFIG_DIR") {
        if path.is_empty() {
            return Err(Error::Unsafe);
        }
        validate_settings_anchor(root, &PathBuf::from(path).join("settings.json"))?;
    }
    Ok(())
}
fn validate_registration_invariants(root: &PinnedRoot, key: &RegistryKey) -> Result<()> {
    let exe = root.path().join("Nearly.exe");
    let uninstaller = root.path().join("uninstall.exe");
    let exe = exe.to_str().ok_or(Error::Unsafe)?;
    let uninstaller = uninstaller.to_str().ok_or(Error::Unsafe)?;
    for (name, expected) in [
        ("NearlyOwner", "local.syncfiles.native".to_owned()),
        ("DisplayName", "Nearly".into()),
        ("Publisher", "Nearly".into()),
        (
            "InstallLocation",
            root.path().to_str().ok_or(Error::Unsafe)?.into(),
        ),
        ("UninstallString", format!("\"{uninstaller}\"")),
        ("QuietUninstallString", format!("\"{uninstaller}\" /S")),
        ("DisplayIcon", format!("\"{exe}\",0")),
    ] {
        if key.read_named(name)? != RawValue::string(&expected) {
            return Err(Error::Unsafe);
        }
    }
    for name in ["NoModify", "NoRepair"] {
        if key.read_named(name)? != RawValue::dword(1) {
            return Err(Error::Unsafe);
        }
    }
    Ok(())
}
fn validate_static_registration(root: &PinnedRoot, key: &RegistryKey) -> Result<()> {
    validate_registration_invariants(root, key)?;
    let source = env!("CARGO_PKG_VERSION");
    let internal = key.read(1)?;
    if internal.present && internal != RawValue::string(source) {
        return Err(Error::Unsafe);
    }
    let display = key.read(0)?;
    let public =
        crate::version::display_label(&semver::Version::parse(source).map_err(|_| Error::Unsafe)?);
    if display != RawValue::string(source) && display != RawValue::string(&public) {
        return Err(Error::Unsafe);
    }
    Ok(())
}
pub(crate) struct PreparedRecovery {
    root: PinnedRoot,
    record: RecoveryTransaction,
    _guards: Vec<File>,
}
impl PreparedRecovery {
    pub(crate) fn abandon_never_spawned(
        &mut self,
        failure: &crate::update_handoff::LaunchFailure,
    ) -> Result<()> {
        if !failure.never_spawned_for(&self.record.nonce)
            || self.record.engine.phase != RecoveryPhase::Prepared
            || self.record.helper.is_some()
            || self.record.worker.is_some()
            || self.record.child.is_some()
        {
            return Err(Error::Unsafe);
        }
        let store = RecoveryStore::open(
            &self.root,
            "Global\\NearlyInstallMutation-local.syncfiles.native-v3",
        )?;
        if store.read()?.as_ref() != Some(&self.record) {
            return Err(Error::Uncertain);
        }
        self.record.abandoned = true;
        store.publish(&mut self.record)
    }
}
pub(crate) fn prepare_recovery(
    snapshot: &crate::update_package::StageSnapshot,
    settings_anchor: &Path,
) -> Result<PreparedRecovery> {
    let root = capture_registered_root()?;
    let proof = snapshot.package();
    if proof.updater_protocol() != 3 {
        return Err(Error::Unsafe);
    }
    validate_settings_anchor(&root, settings_anchor)?;
    validate_settings_override(&root)?;
    if dunce::canonicalize(std::env::current_exe().map_err(|_| Error::Io)?)
        .map_err(|_| Error::Io)?
        != dunce::canonicalize(root.path().join("Nearly.exe")).map_err(|_| Error::Io)?
    {
        return Err(Error::Unsafe);
    }
    if snapshot.path() != root.path().join(proof.asset_name()) {
        return Err(Error::Unsafe);
    }
    let (_, installer) = FileProof::open(snapshot.path(), false)?;
    if installer.sha256 != proof.installer_sha256() {
        return Err(Error::Unsafe);
    }
    let registry = RegistryKey::open(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\local.syncfiles.native",
    )?;
    validate_static_registration(&root, &registry)?;
    let material = PackageMaterial {
        source_version: env!("CARGO_PKG_VERSION").into(),
        target_version: proof.target_version().into(),
        public_label: proof.public_label().into(),
        signature: String::from_utf8(proof.signature().to_vec()).map_err(|_| Error::Invalid)?,
        payload_sha256: proof.payload_sha256().into(),
        installer_name: proof.asset_name().into(),
        installer,
    };
    let session = RecoverySession::prepare(
        &root,
        registry,
        material,
        Some(settings_fingerprint(&root)?),
        "Global\\NearlyInstallMutation-local.syncfiles.native-v3",
    )?;
    let record = session.record.clone();
    drop(session);
    let directory = root
        .path()
        .join(crate::update_transaction::STATE_DIRECTORY)
        .join(&record.nonce);
    let mut guards = vec![
        fs::directory(
            &root.path().join(crate::update_transaction::STATE_DIRECTORY),
            0x80,
        )?,
        fs::directory(&directory, 0x80)?,
        fs::directory(&directory.join("candidate"), 0x80)?,
    ];
    for i in 0..2 {
        let (guard, p) = FileProof::open(&directory.join(BACKUP_NAMES[i]), false)?;
        if p != record.files[i].backup {
            return Err(Error::Unsafe);
        }
        guards.push(guard);
    }
    Ok(PreparedRecovery {
        root,
        record,
        _guards: guards,
    })
}
pub(crate) struct LaunchedRecovery {
    child: Option<Child>,
    peer: LivePeer,
    events: RecoveryEvents,
    committed: bool,
}
impl Drop for LaunchedRecovery {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.events.abort.set();
        }
    }
}
impl LaunchedRecovery {
    pub(crate) fn commit(mut self) -> Result<Child> {
        if self.peer.exited()?.is_some() {
            return Err(Error::Unsafe);
        }
        self.events.commit.set()?;
        self.committed = true;
        self.child.take().ok_or(Error::Unsafe)
    }
}
pub(crate) fn launch_verified_recovery(
    prepared: &PreparedRecovery,
) -> std::result::Result<LaunchedRecovery, crate::update_handoff::LaunchFailure> {
    let nonce = &prepared.record.nonce;
    let (path, events) = (|| -> Result<_> {
        prepared.root.verify()?;
        if observe_record(&prepared.root)?.as_ref() != Some(&prepared.record) {
            return Err(Error::Uncertain);
        }
        let path = prepared
            .root
            .path()
            .join(crate::update_transaction::STATE_DIRECTORY)
            .join(nonce)
            .join(BACKUP_NAMES[0]);
        if !prepared.record.files[0].backup.matches(&path) {
            return Err(Error::Unsafe);
        }
        Ok((path, RecoveryEvents::fresh(nonce)?))
    })()
    .map_err(|e| {
        crate::update_handoff::LaunchFailure::before_spawn(
            nonce,
            format!("Recovery preparation failed: {e:?}"),
        )
    })?;
    let parent = &prepared.record.parent;
    let child = Command::new(&path)
        .args([
            format!("--nearly-recovery={nonce}"),
            format!("--nearly-parent={}:{}", parent.pid, parent.created),
        ])
        .spawn()
        .map_err(|e| crate::update_handoff::LaunchFailure::before_spawn(nonce, e.to_string()))?;
    let launched = (|| -> Result<_> {
        let identity = process_identity(child.as_raw_handle(), child.id())?;
        let peer = LivePeer::open(&identity, &path, &prepared.record.files[0].backup)?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if peer.exited()?.is_some() {
                return Err(Error::Unsafe);
            }
            if events.ready.is_set()? {
                return Ok(peer);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(Error::Busy)
    })();
    match launched {
        Ok(peer) => Ok(LaunchedRecovery {
            child: Some(child),
            peer,
            events,
            committed: false,
        }),
        Err(error) => {
            let _ = events.abort.set();
            Err(crate::update_handoff::LaunchFailure::after_spawn(format!(
                "Recovery helper did not become ready: {error:?}"
            )))
        }
    }
}
pub(crate) fn bind_recovery(
    prepared: &mut PreparedRecovery,
    launched: &LaunchedRecovery,
) -> Result<()> {
    if launched.peer.exited()?.is_some() {
        return Err(Error::Unsafe);
    }
    let store = RecoveryStore::open(
        &prepared.root,
        "Global\\NearlyInstallMutation-local.syncfiles.native-v3",
    )?;
    if store.read()?.as_ref() != Some(&prepared.record)
        || prepared.record.engine.phase != RecoveryPhase::Prepared
    {
        return Err(Error::Uncertain);
    }
    prepared.record.helper = Some(launched.peer.identity.clone());
    prepared.record.engine = RecoveryRecord {
        sequence: 1,
        phase: RecoveryPhase::Armed,
        step: None,
    };
    store.publish(&mut prepared.record)
}
pub(crate) enum HelperDispatch {
    NotHelper,
    Terminal(i32),
}
pub(crate) fn dispatch_helper<I, S>(args: I) -> HelperDispatch
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    match parse_helper(args) {
        HelperParse::Ordinary => HelperDispatch::NotHelper,
        HelperParse::Invalid => HelperDispatch::Terminal(2),
        HelperParse::Helper(args) => HelperDispatch::Terminal(match run_helper(args) {
            Ok(_) => {#[cfg(feature="installer-qa")] crate::installer_qa::trace("helper","succeeded");0},
            Err(error) => {#[cfg(feature="installer-qa")] {crate::installer_qa::trace("helper","failed");crate::installer_qa::trace_error(&error);}let _=error;8},
        }),
    }
}
fn await_parent_exit(parent: &LivePeer, events: &RecoveryEvents, timeout: Duration) -> Result<()> {
    let start = Instant::now();
    loop {
        if events.abort.is_set()? {
            return Err(Error::Unsafe);
        }
        if supervisor_observation(parent.exited(), "parent")?.is_some() {
            return if events.commit.is_set()? {
                Ok(())
            } else {
                Err(Error::Unsafe)
            };
        }
        if start.elapsed() >= timeout {
            return Err(Error::Busy);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RmUnique {
    pid: u32,
    created: windows::Win32::Foundation::FILETIME,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct RmInfo {
    process: RmUnique,
    application: [u16; 256],
    service: [u16; 64],
    application_type: u32,
    status: u32,
    session: u32,
    restartable: i32,
}
fn rm_identity_allowed(entry: &RmInfo, supervisor: &ProcessIdentity, child: Option<&ProcessIdentity>) -> bool {
    [Some(supervisor), child].into_iter().flatten().any(|identity| {
        identity.pid == entry.process.pid
            && identity.created == ((entry.process.created.dwHighDateTime as u64) << 32
                | entry.process.created.dwLowDateTime as u64)
    })
}
// Diagnostic hints only: never consulted by authorization or file effects.
#[cfg(any(test, feature="installer-qa"))]
fn file_user_hint(entry: &RmInfo, child: Option<&ProcessIdentity>) -> &'static str {
    if child.is_some_and(|identity| identity.pid == entry.process.pid
        && identity.created != ((entry.process.created.dwHighDateTime as u64) << 32
            | entry.process.created.dwLowDateTime as u64)) {
        return "childIdentityMismatch";
    }
    let text = |s: &[u16]| String::from_utf16_lossy(&s[..s.iter().position(|c| *c == 0).unwrap_or(s.len())]).to_ascii_lowercase();
    let application = text(&entry.application);
    let service = text(&entry.service);
    if matches!(application.as_str(), "msmpeng.exe" | "antimalware service executable" | "microsoft defender antivirus service") || service == "windefend" {
        "scannerHint"
    } else if matches!(application.as_str(), "msedgewebview2.exe" | "msedgewebview2" | "microsoft edge webview2") {
        "webviewHint"
    } else {
        "unknown"
    }
}
#[cfg(feature="installer-qa")]
fn trace_foreign_file_user(entry: &RmInfo, child: Option<&ProcessIdentity>) {
    use std::sync::atomic::{AtomicU8, Ordering};
    static REPORTED: AtomicU8 = AtomicU8::new(0);
    let hint = file_user_hint(entry, child);
    let bit = match hint { "scannerHint" => 1, "webviewHint" => 2, "childIdentityMismatch" => 4, _ => 8 };
    if REPORTED.fetch_or(bit, Ordering::Relaxed) & bit == 0 {
        crate::installer_qa::trace("fileUserHint", hint);
    }
}
#[link(name = "rstrtmgr")]
unsafe extern "system" {
    fn RmStartSession(session: *mut u32, flags: u32, key: *mut u16) -> u32;
    fn RmRegisterResources(
        session: u32,
        files: u32,
        names: *const *const u16,
        apps: u32,
        processes: *const RmUnique,
        services: u32,
        service_names: *const *const u16,
    ) -> u32;
    fn RmGetList(
        session: u32,
        needed: *mut u32,
        count: *mut u32,
        info: *mut RmInfo,
        reasons: *mut u32,
    ) -> u32;
    fn RmEndSession(session: u32) -> u32;
}
fn no_file_users(root: &PinnedRoot, allowed: Option<&LivePeer>) -> Result<bool> {
    if let Some(peer) = allowed {
        peer.exited()?;
    }
    root.verify()?;
    let mut id = 0;
    let mut key = [0u16; 33];
    let start_status = unsafe { RmStartSession(&mut id, 0, key.as_mut_ptr()) };
    #[cfg(test)]
    if std::env::var_os("NEARLY_RECOVERY_RM_TRACE").is_some() {
        eprintln!("RM start={} root={}", start_status, root.path().display());
    }
    if start_status != 0 {
        return Err(Error::Uncertain);
    }
    struct Rm(u32);
    impl Drop for Rm {
        fn drop(&mut self) {
            unsafe {
                RmEndSession(self.0);
            }
        }
    }
    let session = Rm(id);
    let names: Vec<_> = LIVE_NAMES
        .iter()
        .map(|n| fs::wide(&root.path().join(n)))
        .collect();
    let pointers: Vec<_> = names.iter().map(|s| s.as_ptr()).collect();
    let register_status = unsafe {
        RmRegisterResources(
            session.0,
            2,
            pointers.as_ptr(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
        )
    };
    #[cfg(test)]
    if std::env::var_os("NEARLY_RECOVERY_RM_TRACE").is_some() {
        eprintln!("RM register={} files={:?}", register_status, LIVE_NAMES);
    }
    if register_status != 0 {
        return Err(Error::Uncertain);
    }
    let (mut needed, mut count, mut reasons) = (0, 0, 0);
    let status = unsafe {
        RmGetList(
            session.0,
            &mut needed,
            &mut count,
            std::ptr::null_mut(),
            &mut reasons,
        )
    };
    #[cfg(test)]
    if std::env::var_os("NEARLY_RECOVERY_RM_TRACE").is_some() {
        eprintln!(
            "RM first={} needed={} count={} reasons={}",
            status, needed, count, reasons
        );
    }
    if status == 0 {
        return Ok(needed == 0 && count == 0);
    }
    if status != 234 || needed == 0 || needed > 32 {
        return Err(Error::Uncertain);
    }
    let mut information = vec![unsafe { std::mem::zeroed::<RmInfo>() }; needed as usize];
    count = needed;
    let list_status = unsafe {
        RmGetList(
            session.0,
            &mut needed,
            &mut count,
            information.as_mut_ptr(),
            &mut reasons,
        )
    };
    #[cfg(test)]
    if std::env::var_os("NEARLY_RECOVERY_RM_TRACE").is_some() {
        eprintln!(
            "RM list={} needed={} count={} reasons={}",
            list_status, needed, count, reasons
        );
        for p in information
            .iter()
            .take((count as usize).min(information.len()))
        {
            let text = |s: &[u16]| {
                String::from_utf16_lossy(&s[..s.iter().position(|c| *c == 0).unwrap_or(s.len())])
            };
            eprintln!("RM user pid={} created={} app={:?} service={:?} type={} status={} session={} restartable={}",p.process.pid,((p.process.created.dwHighDateTime as u64)<<32)|p.process.created.dwLowDateTime as u64,text(&p.application),text(&p.service),p.application_type,p.status,p.session,p.restartable);
        }
    }
    if list_status != 0 || count as usize > information.len() {
        return Err(Error::Uncertain);
    }
    // Our own immutable proof pins are legitimate resource users. The helper
    // enters before Tauri/normal operations, so only this exact native process
    // and (during probation) its exact retained child may be excluded.
    let supervisor = current_process_identity()?;
    let mut clean = true;
    for entry in &information[..count as usize] {
        if !rm_identity_allowed(entry, &supervisor, allowed.map(|p| &p.identity)) {
            clean = false;
            #[cfg(feature="installer-qa")]
            trace_foreign_file_user(entry, allowed.map(|p| &p.identity));
        }
    }
    Ok(clean)
}
// Restart Manager may briefly retain an exited process or report a scanner,
// including while the exact retained child is still starting.
// Only observation is retried; every effect still requires an empty foreign set.
fn settled_no_file_users(root: &PinnedRoot, allowed: Option<&LivePeer>) -> Result<bool> {
    let start = Instant::now();
    settled_no_file_users_with(root, allowed, no_file_users, || start.elapsed(), || {
        std::thread::sleep(Duration::from_millis(25));
    })
}
fn settled_no_file_users_with(
    root: &PinnedRoot,
    allowed: Option<&LivePeer>,
    mut observe: impl FnMut(&PinnedRoot, Option<&LivePeer>) -> Result<bool>,
    mut elapsed: impl FnMut() -> Duration,
    mut pause: impl FnMut(),
) -> Result<bool> {
    if let Some(peer) = allowed { peer.exited()?; }
    let may_wait = allowed.is_some();
    loop {
        if observe(root, allowed)? {
            return Ok(true);
        }
        if !may_wait || elapsed() >= Duration::from_secs(2) {
            return Ok(false);
        }
        pause();
    }
}
impl RecoverySession {
    fn revalidate_registration(&mut self) -> Result<()> {
        self.store.root.verify()?;
        let current = RegistryKey::open(&self.registry.sub)?;
        validate_registration_invariants(&self.store.root, &current)?;
        self.registry = current;
        Ok(())
    }
    fn resume(
        root: &PinnedRoot,
        expected: &RecoveryTransaction,
        registry: RegistryKey,
        mutex: &str,
    ) -> Result<Self> {
        let store = RecoveryStore::open(root, mutex)?;
        let record = store.read()?.ok_or(Error::Missing)?;
        if &record != expected {
            return Err(Error::Uncertain);
        }
        let directory = store.directory.join(&record.nonce);
        let transaction = fs::directory(&directory, 0x80)?;
        let candidate = fs::directory(&directory.join("candidate"), 0x80)?;
        let (image, proof) = FileProof::open(&directory.join(BACKUP_NAMES[0]), false)?;
        if proof != record.files[0].backup {
            return Err(Error::Unsafe);
        }
        let (uninstaller, proof) = FileProof::open(&directory.join(BACKUP_NAMES[1]), false)?;
        if proof != record.files[1].backup {
            return Err(Error::Unsafe);
        }
        Ok(Self {
            store,
            record,
            registry,
            _transaction: transaction,
            _candidate: candidate,
            _backups: [image, uninstaller],
            candidate_pins: [None, None],
            restore_pins: [None, None],
        })
    }
    fn settings_compatible(&self) -> bool {
        validate_settings_override(&self.store.root).is_ok()
            && self
                .record
                .settings_sha256
                .as_ref()
                .is_some_and(|h| settings_fingerprint(&self.store.root).as_ref().ok() == Some(h))
            && crate::unified_settings::Document::read(
                &self.store.root.path().join("settings.json"),
            )
            .is_ok()
    }
    fn mark_manual_repair(&mut self) -> Result<()> {
        if self.record.engine.phase == RecoveryPhase::Succeeded {
            return Err(Error::Unsafe);
        }
        self.record.engine.sequence = self
            .record
            .engine
            .sequence
            .checked_add(1)
            .ok_or(Error::Invalid)?;
        self.record.engine.phase = RecoveryPhase::ManualRepair;
        self.record.engine.step = None;
        self.publish()
    }
    fn verify_restored_tuple<'a>(&self, child: Option<&'a LivePeer>) -> Result<RestoredProof<'a>> {
        let current = RegistryKey::open(&self.registry.sub)?;
        validate_registration_invariants(&self.store.root, &current)?;
        if current.snapshot()? != self.record.old_values {
            return Err(Error::Unsafe);
        }
        if child.is_some_and(|p| p.exited().map_or(true, |v| v.is_none())) {
            return Err(Error::Unsafe);
        }
        self.validate_backups()?;
        if self.record.engine.phase != RecoveryPhase::Restored
            || self.record.old_restart_attempted
            || !self.settings_compatible()
            || !no_file_users(&self.store.root, child)?
        {
            return Err(Error::Unsafe);
        }
        if !self
            .inspect_tuple()?
            .objects
            .iter()
            .all(|o| matches!(o, ObservedObject::Old | ObservedObject::Unchanged))
        {
            return Err(Error::Unsafe);
        }
        let (image, proof) = FileProof::open(&self.live_path(0), false)?;
        if proof.sha256 != self.record.files[0].old.sha256
            || proof.length != self.record.files[0].old.length
        {
            return Err(Error::Unsafe);
        }
        Ok(RestoredProof {
            root: self.store.root.0.binding.clone(),
            nonce: self.record.nonce.clone(),
            publication: self.record.publication,
            verified: Instant::now(),
            proof,
            _image: image,
            child,
        })
    }
    fn restart_previous(&mut self, proof: RestoredProof) -> Result<Child> {
        self.revalidate_registration()?;
        if proof
            .child
            .is_some_and(|p| p.exited().map_or(true, |v| v.is_none()))
            || proof.root != self.store.root.0.binding
            || proof.nonce != self.record.nonce
            || proof.publication != self.record.publication
            || proof.verified.elapsed() > Duration::from_secs(1)
            || self.record.old_restart_attempted
            || !self.settings_compatible()
            || !no_file_users(&self.store.root, proof.child)?
        {
            return Err(Error::Unsafe);
        }
        if !self
            .inspect_tuple()?
            .objects
            .iter()
            .all(|o| matches!(o, ObservedObject::Old | ObservedObject::Unchanged))
        {
            return Err(Error::Unsafe);
        }
        if !proof.proof.matches(&self.live_path(0)) {
            return Err(Error::Unsafe);
        }
        self.record.old_restart_attempted = true;
        self.publish()?;
        let child = Command::new(self.live_path(0))
            .spawn()
            .map_err(|_| Error::Io)?;
        let identity = process_identity(child.as_raw_handle(), child.id())?;
        let _peer = LivePeer::open(&identity, &self.live_path(0), &proof.proof)?;
        Ok(child)
    }
}
pub(crate) struct RestoredProof<'a> {
    root: codec::Root,
    nonce: String,
    publication: u32,
    verified: Instant,
    proof: FileProof,
    _image: File,
    child: Option<&'a LivePeer>,
}

fn run_helper(args: HelperArgs) -> Result<()> {
    let root = capture_registered_root()?;
    let record = observe_record(&root)?.ok_or(Error::Missing)?;
    if record.nonce != args.nonce || record.source_version != env!("CARGO_PKG_VERSION") {
        return Err(Error::Unsafe);
    }
    let self_path = root
        .path()
        .join(crate::update_transaction::STATE_DIRECTORY)
        .join(&args.nonce)
        .join(BACKUP_NAMES[0]);
    if dunce::canonicalize(std::env::current_exe().map_err(|_| Error::Io)?)
        .map_err(|_| Error::Io)?
        != dunce::canonicalize(&self_path).map_err(|_| Error::Io)?
    {
        return Err(Error::Unsafe);
    }
    let (_self_image, self_proof) = FileProof::open(&self_path, false)?;
    if self_proof != record.files[0].backup || self_proof.sha256 != record.files[0].old.sha256 {
        return Err(Error::Unsafe);
    }
    let (_installer, package) = authenticate_installer(&root, &record)?;
    if args.recovery_only {
        // Offline lookup hints cannot prove a disappeared worker/helper exited.
        // Refuse rather than infer authority or restart from persisted state.
        return Err(Error::Uncertain);
    }
    if record.engine.phase != RecoveryPhase::Prepared
        || args.parent.as_ref() != Some(&record.parent)
    {
        return Err(Error::Unsafe);
    }
    let parent = LivePeer::open(
        &record.parent,
        &root.path().join("Nearly.exe"),
        &record.files[0].old,
    )?;
    let _source_uninstaller =
        FileProof::pin_shared(&root.path().join("uninstall.exe"), &record.files[1].old)?;
    validate_static_registration(
        &root,
        &RegistryKey::open(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\local.syncfiles.native",
        )?,
    )?;
    let events = RecoveryEvents::open(&record.nonce)?;
    // No mutation lease is held while Ready is signaled or the parent binds us.
    events.ready.set()?;
    await_parent_exit(&parent, &events, Duration::from_secs(60))?;
    let armed = observe_record(&root)?.ok_or(Error::Missing)?;
    let mut expected = record.clone();
    expected.helper = Some(current_process_identity()?);
    expected.engine = RecoveryRecord {
        sequence: 1,
        phase: RecoveryPhase::Armed,
        step: None,
    };
    expected.publication += 1;
    if armed != expected {
        return Err(Error::Unsafe);
    }
    let registry = RegistryKey::open(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\local.syncfiles.native",
    )?;
    let mut session = RecoverySession::resume(
        &root,
        &armed,
        registry,
        "Global\\NearlyInstallMutation-local.syncfiles.native-v3",
    )?;
    // Retain exact parent wait, immutable self/package handles and all events
    // throughout the sole-writer apply/health/recovery loop.
    supervise(&mut session, &events, &parent, &package)
}

struct WorkerExit {
    peer: LivePeer,
    nonce: String,
    _child: Child,
    _authorize: Event,
    _ready: Event,
}
fn stage_worker(session: &mut RecoverySession) -> Result<Option<WorkerExit>> {
    session.revalidate_registration()?;
    if session.record.engine.phase != RecoveryPhase::Staging
        || session.record.worker.is_some()
        || !no_file_users(&session.store.root, None)?
    {
        return Err(Error::Unsafe);
    }
    let path = session
        .store
        .root
        .path()
        .join(&session.record.installer_name);
    if !session.record.installer.matches(&path) {
        return Err(Error::Unsafe);
    }
    let helper = current_process_identity()?;
    let child = match Command::new(&path)
        .args([
            "/NEARLYSTAGE".to_owned(),
            "/NEARLYPROTOCOL=3".into(),
            format!("/NEARLYHELPER={}", helper.pid),
            format!("/NEARLYCREATED={}", helper.created),
            format!("/NEARLYNONCE={}", session.record.nonce),
        ])
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Ok(None),
    };
    let identity = process_identity(child.as_raw_handle(), child.id())?;
    let peer = LivePeer::open(&identity, &path, &session.record.installer)?;
    let suffix = format!(
        "{}-{}-{}",
        session.record.nonce, identity.pid, identity.created
    );
    let authorize = Event::fresh_name(&format!("Local\\NearlyStageAuthorize-{suffix}"))?;
    let ready = Event::fresh_name(&format!("Local\\NearlyStageReady-{suffix}"))?;
    session.record.worker = Some(identity);
    session.publish()?;
    authorize.set()?;
    wait_stage_worker(
        peer,
        child,
        authorize,
        ready,
        &session.record.nonce,
        Duration::from_secs(60),
    )
    .map(Some)
}
fn wait_stage_worker(
    peer: LivePeer,
    child: Child,
    authorize: Event,
    ready: Event,
    nonce: &str,
    timeout: Duration,
) -> Result<WorkerExit> {
    let start = Instant::now();
    let mut ready_seen = false;
    loop {
        ready_seen |= ready.is_set()?;
        let exited = peer.exited()?;
        if exited.is_some() {
            // Persistent Ready is tied to this exact PID+creation by the
            // worker's own native self-identity. Fast completion is valid;
            // bootstrap exit without this worker-specific Ready is uncertain.
            if !ready_seen {
                return Err(Error::Uncertain);
            }
            return Ok(WorkerExit {
                peer,
                nonce: nonce.into(),
                _child: child,
                _authorize: authorize,
                _ready: ready,
            });
        }
        if start.elapsed() > timeout {
            return Err(Error::Busy);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn inspect_candidates(
    session: &mut RecoverySession,
    worker: &WorkerExit,
    package: &crate::update_package::PackageProof,
) -> Result<()> {
    if worker.nonce != session.record.nonce
        || session.record.worker.as_ref() != Some(&worker.peer.identity)
        || worker.peer.image != session.record.installer
        || worker.peer.exited()? != Some(0)
    {
        return Err(Error::Unsafe);
    }
    inspect_candidate_files(session, package)
}
fn inspect_candidate_files(
    session: &mut RecoverySession,
    package: &crate::update_package::PackageProof,
) -> Result<()> {
    session.revalidate_registration()?;
    let candidate = session.directory().join("candidate");
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&candidate).map_err(|_| Error::Io)? {
        let entry = entry.map_err(|_| Error::Io)?;
        names.push(entry.file_name().into_string().map_err(|_| Error::Unsafe)?);
    }
    names.sort();
    let mut expected: Vec<_> = LIVE_NAMES.iter().map(|n| n.to_string()).collect();
    expected.sort();
    if names != expected {
        return Err(Error::Unsafe);
    }
    let (mut image, image_proof) = FileProof::open(&session.candidate_path(0), false)?;
    if image_proof.sha256 != package.payload_sha256() {
        return Err(Error::Unsafe);
    }
    image.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
    let mut bytes = Vec::new();
    image.read_to_end(&mut bytes).map_err(|_| Error::Io)?;
    verify_application_pe(&bytes)?;
    verify_version_resource(&session.candidate_path(0), package.target_version())?;
    let (mut uninstaller, uninstall_proof) = FileProof::open(&session.candidate_path(1), false)?;
    uninstaller
        .seek(SeekFrom::Start(0))
        .map_err(|_| Error::Io)?;
    let mut bytes = Vec::new();
    uninstaller.read_to_end(&mut bytes).map_err(|_| Error::Io)?;
    verify_uninstaller_pe(&bytes)?;
    let size = image_proof
        .length
        .checked_add(uninstall_proof.length)
        .and_then(|n| n.checked_add(1023))
        .map(|n| n / 1024)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Error::Invalid)?;
    drop(image);
    drop(uninstaller);
    let _image = flush_candidate_bytes(&session.candidate_path(0), &image_proof)?;
    let _uninstaller = flush_candidate_bytes(&session.candidate_path(1), &uninstall_proof)?;
    drop(_image);
    drop(_uninstaller);
    session.candidate_pins[0] = Some(FileProof::pin_shared(
        &session.candidate_path(0),
        &image_proof,
    )?);
    session.candidate_pins[1] = Some(FileProof::pin_shared(
        &session.candidate_path(1),
        &uninstall_proof,
    )?);
    session.record.files[0].candidate = Some(image_proof);
    session.record.files[1].candidate = Some(uninstall_proof);
    session.record.new_values = [
        RawValue::string(package.public_label()),
        RawValue::string(package.target_version()),
        RawValue::dword(size),
    ];
    session.publish()
}
fn flush_candidate_bytes(path: &Path, expected: &FileProof) -> Result<File> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(1)
        .custom_flags(REPARSE)
        .open(path)
        .map_err(|_| Error::Io)?;
    let identity = fs::identity(&fs::regular(&file)?);
    let (length, sha256) = fs::hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)?;
    if identity != expected.identity || length != expected.length || sha256 != expected.sha256 {
        return Err(Error::Unsafe);
    }
    file.sync_all().map_err(|_| Error::Uncertain)?;
    drop(file);
    let (file, observed) = FileProof::open(path, false)?;
    if observed != *expected {
        return Err(Error::Unsafe);
    }
    Ok(file)
}
fn pe_header(bytes: &[u8]) -> Result<&[u8]> {
    if bytes.get(..2) != Some(b"MZ") {
        return Err(Error::Unsafe);
    }
    let offset = u32::from_le_bytes(
        bytes
            .get(0x3c..0x40)
            .ok_or(Error::Unsafe)?
            .try_into()
            .map_err(|_| Error::Unsafe)?,
    ) as usize;
    let header = bytes
        .get(offset..offset.checked_add(26).ok_or(Error::Unsafe)?)
        .ok_or(Error::Unsafe)?;
    if header.get(..4) != Some(b"PE\0\0") {
        return Err(Error::Unsafe);
    }
    Ok(header)
}
fn verify_application_pe(bytes: &[u8]) -> Result<()> {
    let h = pe_header(bytes)?;
    if u16::from_le_bytes([h[4], h[5]]) != 0x8664 || u16::from_le_bytes([h[24], h[25]]) != 0x20b {
        return Err(Error::Unsafe);
    }
    Ok(())
}
fn verify_uninstaller_pe(bytes: &[u8]) -> Result<()> {
    let h = pe_header(bytes)?;
    if u16::from_le_bytes([h[4], h[5]]) != 0x14c || u16::from_le_bytes([h[24], h[25]]) != 0x10b {
        return Err(Error::Unsafe);
    }
    Ok(())
}
#[link(name = "version")]
unsafe extern "system" {
    fn GetFileVersionInfoSizeW(path: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(path: *const u16, handle: u32, length: u32, data: *mut c_void) -> i32;
    fn VerQueryValueW(
        data: *const c_void,
        sub: *const u16,
        out: *mut *mut c_void,
        length: *mut u32,
    ) -> i32;
}
fn verify_version_resource(path: &Path, expected: &str) -> Result<()> {
    let version = semver::Version::parse(expected).map_err(|_| Error::Invalid)?;
    let path = fs::wide(path);
    let mut ignored = 0;
    let length = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if length == 0 || length > 1024 * 1024 {
        return Err(Error::Unsafe);
    }
    let mut data = vec![0u8; length as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, length, data.as_mut_ptr().cast()) } == 0 {
        return Err(Error::Unsafe);
    }
    let mut pointer = std::ptr::null_mut();
    let mut size = 0;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            wide("\\").as_ptr(),
            &mut pointer,
            &mut size,
        )
    } == 0
        || pointer.is_null()
        || size < 52
    {
        return Err(Error::Unsafe);
    }
    let fields = unsafe { std::slice::from_raw_parts(pointer.cast::<u32>(), 13) };
    if fields[0] != 0xFEEF04BD
        || fields[2] >> 16 != version.major as u32
        || fields[2] & 0xffff != version.minor as u32
        || fields[3] >> 16 != version.patch as u32
        || fields[3] & 0xffff != 0
    {
        return Err(Error::Unsafe);
    }
    Ok(())
}
trait SupervisorIo {
    fn stage(&mut self, session: &mut RecoverySession) -> Result<Option<WorkerExit>>;
    fn inspect(
        &mut self,
        session: &mut RecoverySession,
        worker: &WorkerExit,
        package: &crate::update_package::PackageProof,
    ) -> Result<()>;
    fn launch(&mut self, session: &mut RecoverySession) -> Result<(Child, LivePeer)>;
    fn health_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
}
struct NativeSupervisorIo;
impl SupervisorIo for NativeSupervisorIo {
    fn stage(&mut self, session: &mut RecoverySession) -> Result<Option<WorkerExit>> {
        stage_worker(session)
    }
    fn inspect(
        &mut self,
        session: &mut RecoverySession,
        worker: &WorkerExit,
        package: &crate::update_package::PackageProof,
    ) -> Result<()> {
        inspect_candidates(session, worker, package)
    }
    fn launch(&mut self, session: &mut RecoverySession) -> Result<(Child, LivePeer)> {
        let path = session.live_path(0);
        launch_health_command(
            session,
            Command::new(path).arg(format!("--nearly-update-health={}", session.record.nonce)),
        )
    }
}
fn launch_health_command(
    session: &mut RecoverySession,
    command: &mut Command,
) -> Result<(Child, LivePeer)> {
    session.revalidate_registration()?;
    if !no_file_users(&session.store.root, None)? {
        return Err(Error::Busy);
    }
    let expected = session.record.files[0]
        .candidate
        .clone()
        .ok_or(Error::Unsafe)?;
    let path = session.live_path(0);
    if !expected.matches(&path) {
        return Err(Error::Unsafe);
    }
    let process = command.spawn().map_err(|_| Error::Io)?;
    let identity = process_identity(process.as_raw_handle(), process.id())?;
    let peer = LivePeer::open(&identity, &path, &expected)?;
    session.record.child = Some(identity);
    session.publish()?;
    Ok((process, peer))
}
fn supervise(
    session: &mut RecoverySession,
    events: &RecoveryEvents,
    parent: &LivePeer,
    package: &crate::update_package::PackageProof,
) -> Result<()> {
    supervise_with(session, events, parent, package, &mut NativeSupervisorIo)
}
fn supervisor_observation<T>(result: Result<T>, site: &'static str) -> Result<T> {
    #[cfg(feature="installer-qa")]
    if result.is_err() { crate::installer_qa::trace("supervisorError", site); }
    let _ = site;
    result
}
fn supervise_with<I: SupervisorIo>(
    session: &mut RecoverySession,
    events: &RecoveryEvents,
    parent: &LivePeer,
    package: &crate::update_package::PackageProof,
    io: &mut I,
) -> Result<()> {
    use model::{ChildState, LiveFacts, ParentState, RecoveryAction as A, WorkerState};
    let mut worker: Option<WorkerExit> = None;
    let mut child: Option<(Child, LivePeer)> = None;
    let (mut failed, mut candidates, mut restored) = (false, false, false);
    let (mut health_started, mut close_requested) = (None, None);
    #[cfg(feature="installer-qa")]
    let mut previous_child=None;
    #[cfg(feature="installer-qa")]
    crate::installer_qa::trace("helper","started");
    loop {
        if supervisor_observation(parent.exited(), "parent")?.is_none() {
            #[cfg(feature="installer-qa")]
            crate::installer_qa::trace("supervisorError", "parent");
            return Err(Error::Unsafe);
        }
        if !supervisor_observation(events.commit.is_set(), "commit")? {
            #[cfg(feature="installer-qa")]
            crate::installer_qa::trace("supervisorError", "commit");
            return Err(Error::Unsafe);
        }
        let child_state = match &child {
            None => ChildState::NotStarted,
            Some((_, peer)) => match supervisor_observation(peer.exited(), "child")? {
                Some(_) => ChildState::Exited,
                None => {
                    if supervisor_observation(events.healthy.is_set(), "child")? {
                        ChildState::LiveHealthy
                    } else {
                        ChildState::LiveUnhealthy
                    }
                }
            },
        };
        #[cfg(feature="installer-qa")]
        if previous_child!=Some(child_state){
            crate::installer_qa::trace("supervisorChild",match child_state{ChildState::NotStarted=>"NotStarted",ChildState::LiveUnhealthy=>"LiveUnhealthy",ChildState::LiveHealthy=>"LiveHealthy",ChildState::Exited=>"Exited",ChildState::Uncertain=>"Uncertain"});previous_child=Some(child_state);
        }
        if child_state == ChildState::LiveUnhealthy
            && health_started.is_some_and(|t: Instant| t.elapsed() > io.health_timeout())
            && !matches!(
                session.record.engine.phase,
                RecoveryPhase::Succeeded | RecoveryPhase::Restored
            )
        {
            failed = true;
        }
        // Restart Manager may briefly report an exited process. Only the exact
        // retained child capability can exclude that stale identity, not its
        // persisted PID or a name-based filter.
        let allowed = child.as_ref().map(|(_, peer)| peer);
        let facts = LiveFacts {
            parent: ParentState::AuthorizedExited,
            worker: match &worker {
                Some(w) => {
                    if supervisor_observation(w.peer.exited(), "worker")? == Some(0) {
                        WorkerState::ExitedZero
                    } else {
                        WorkerState::ExitedNonzero
                    }
                }
                None => WorkerState::NotStarted,
            },
            child: child_state,
            root_and_lease_verified: session.store.root.verify().is_ok(),
            snapshots_verified: session.validate_backups().is_ok(),
            candidates_verified: candidates,
            no_other_users: supervisor_observation(settled_no_file_users(&session.store.root, allowed), "fileUsers")?,
            failure_requested: failed,
            settings_compatible: session.settings_compatible(),
            child_idle_and_settings_settled: supervisor_observation(events.idle.is_set(), "idle")?,
            cooperative_exit_requested: close_requested.is_some(),
            child_exit_timed_out: close_requested
                .is_some_and(|t: Instant| t.elapsed() > Duration::from_secs(5)),
            recovery_only: false,
            restored_this_session: restored,
            old_restart_attempted: session.record.old_restart_attempted,
        };
        let observed = supervisor_observation(session.inspect_tuple(), "tuple")?;
        let action=model::next_action(&session.record.engine, &observed, &facts);
        #[cfg(feature="installer-qa")]
        {
            use model::InstallObject as O;
            let code=match &action{
                A::Wait|A::Publish(_)=>None,A::StartStaging=>Some("StartStaging"),A::VerifyCandidates=>Some("VerifyCandidates"),
                A::Mutate{object,direction}=>Some(match(direction,object){(Direction::Apply,O::Image)=>"ApplyImage",(Direction::Apply,O::Uninstaller)=>"ApplyUninstaller",(Direction::Apply,_)=>"ApplyRegistration",(Direction::Restore,O::Image)=>"RestoreImage",(Direction::Restore,O::Uninstaller)=>"RestoreUninstaller",(Direction::Restore,_)=>"RestoreRegistration"}),
                A::LaunchNew=>Some("LaunchNew"),A::RequestChildExit=>Some("RequestChildExit"),A::RestartOld=>Some("RestartOld"),A::Complete=>Some("Complete"),A::ManualRepair=>Some("ManualRepair")};
            if let Some(code)=code{crate::installer_qa::trace("supervisorAction",code)}
            if matches!(action,A::ManualRepair){
                for (failed,code) in [(!facts.root_and_lease_verified,"rootLeaseInvalid"),(!facts.snapshots_verified,"snapshotsChanged"),(!facts.no_other_users,"otherFileUsers"),(!facts.child_idle_and_settings_settled,"childNotIdle"),(facts.child_exit_timed_out,"childExitTimedOut"),(!facts.settings_compatible,"settingsChanged")]{if failed{crate::installer_qa::trace("supervisorBlock",code)}}
            }
        }
        match action {
            A::Wait => std::thread::sleep(Duration::from_millis(25)),
            A::Publish(record) => {
                let succeeded = record.phase == RecoveryPhase::Succeeded;
                let is_restored = record.phase == RecoveryPhase::Restored;
                session.record.engine = record;
                if !matches!(
                    session.record.engine.phase,
                    RecoveryPhase::Applying | RecoveryPhase::Restoring
                ) {
                    session.record.file_step = None;
                }
                // Failed/uncertain journal publication is terminal uncertainty;
                // never guess that Succeeded failed and roll back afterwards.
                session.publish()?;
                #[cfg(feature="installer-qa")]
                crate::installer_qa::trace("supervisorPhase",match session.record.engine.phase{RecoveryPhase::Prepared=>"Prepared",RecoveryPhase::Armed=>"Armed",RecoveryPhase::Staging=>"Staging",RecoveryPhase::CandidatesVerified=>"CandidatesVerified",RecoveryPhase::Applying=>"Applying",RecoveryPhase::AwaitingHealth=>"AwaitingHealth",RecoveryPhase::Succeeded=>"Succeeded",RecoveryPhase::Restoring=>"Restoring",RecoveryPhase::Restored=>"Restored",RecoveryPhase::ManualRepair=>"ManualRepair"});
                if is_restored {
                    restored = true;
                }
                if succeeded {
                    events.success.set()?;
                    let start = Instant::now();
                    while !events.success_ack.is_set()? && start.elapsed() < Duration::from_secs(5)
                    {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    return Ok(());
                }
            }
            A::StartStaging => match io.stage(session) {
                Ok(Some(proof)) => {
                    failed |= proof.peer.exited()? != Some(0);
                    worker = Some(proof);
                }
                Ok(None) => failed = true,
                Err(error) => {
                    let _ = session.mark_manual_repair();
                    return Err(error);
                }
            },
            A::VerifyCandidates => {
                let Some(proof) = &worker else {
                    return Err(Error::Unsafe);
                };
                if let Err(error) = io.inspect(session, proof, package) {
                    #[cfg(test)]
                    eprintln!("fixture candidate verification failed: {error:?}");
                    let old = session
                        .inspect_tuple()?
                        .objects
                        .iter()
                        .all(|o| matches!(o, ObservedObject::Old | ObservedObject::Unchanged));
                    if proof.peer.exited()? == Some(0)
                        && old
                        && session.validate_backups().is_ok()
                        && no_file_users(&session.store.root, None)?
                    {
                        failed = true;
                    } else {
                        let _ = session.mark_manual_repair();
                        return Err(error);
                    }
                } else {
                    candidates = true;
                }
            }
            A::Mutate { object, direction } => {
                if let Some(peer) = allowed {
                    if peer.exited()?.is_none() {
                        let _ = session.mark_manual_repair();
                        return Err(Error::Busy);
                    }
                }
                if !settled_no_file_users(&session.store.root, allowed)? {
                    let _ = session.mark_manual_repair();
                    return Err(Error::Busy);
                }
                let result = match direction {
                    Direction::Apply => session.apply_one(object),
                    Direction::Restore => session.restore_one(object),
                };
                if let Err(error) = result {
                    // Reinspect real endpoints after an API failure. A forward
                    // known partial tuple can enter reverse restoration; failed
                    // restoration or any foreign/uncertain object stops here.
                    let actual = session.store.read()?.ok_or(Error::Uncertain)?;
                    if actual.nonce != session.record.nonce
                        || actual.root != session.record.root
                        || actual.package_signature != session.record.package_signature
                    {
                        return Err(Error::Uncertain);
                    }
                    session.record = actual;
                    if direction == Direction::Restore
                        || session.inspect_tuple()?.objects.iter().any(|o| {
                            matches!(o, ObservedObject::Foreign | ObservedObject::Uncertain)
                        })
                    {
                        let _ = session.mark_manual_repair();
                        return Err(error);
                    }
                    failed = true;
                }
            }
            A::LaunchNew => {
                if child.is_some() {
                    return Err(Error::Unsafe);
                }
                match io.launch(session) {
                    Err(_) => failed = true,
                    Ok(process) => {
                        child = Some(process);
                        health_started = Some(Instant::now());
                    }
                }
            }
            A::RequestChildExit => {
                supervisor_observation(events.exit_request.set(), "exitRequest")?;
                close_requested = Some(Instant::now());
            }
            A::RestartOld => {
                let proof = session.verify_restored_tuple(allowed)?;
                #[cfg(feature="installer-qa")] crate::installer_qa::trace("restoration","verified");
                let _child = session.restart_previous(proof)?;
                #[cfg(feature="installer-qa")] crate::installer_qa::trace("restoration","restartIssued");
                return Ok(());
            }
            A::Complete => return Ok(()),
            A::ManualRepair => {
                #[cfg(test)]
                eprintln!(
                    "fixture supervisor repair phase={:?} observed={observed:?} facts={facts:?}",
                    session.record.engine.phase
                );
                let _ = session.mark_manual_repair();
                return Err(Error::Unsafe);
            }
        }
    }
}
#[cfg(test)]
#[path = "update_recovery_windows_tests.rs"]
mod tests;
