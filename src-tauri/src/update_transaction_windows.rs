use super::*;
use crate::update_cleanup::engine::{
    Absence, CommitError, DeleteError, Files, Journal, Observation, OpenError, Opened,
};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
};
use windows::Win32::{
    Foundation::{FILETIME, HANDLE},
    Storage::FileSystem::{
        FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_INFO,
    },
};
const REPARSE: u32 = 0x00200000;
const DIRECTORY: u32 = 0x02000000;
const DELETE: u32 = 0x00010000;
const OWNER: &str = "owner.dpapi";
const RECORD: &str = "transaction.dpapi";
const LEASE: &str = "transaction.lock";
const HEADER: &[u8] = b"NearlyUpdateTransaction1\0";

#[repr(C)]
struct Blob {
    length: u32,
    bytes: *mut u8,
}
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *const std::ffi::c_void,
        prompt: *const std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *const std::ffi::c_void,
        prompt: *const std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn GetProcessTimes(
        handle: *mut std::ffi::c_void,
        created: *mut FILETIME,
        exited: *mut FILETIME,
        kernel: *mut FILETIME,
        user: *mut FILETIME,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        handle: *mut std::ffi::c_void,
        flags: u32,
        path: *mut u16,
        length: *mut u32,
    ) -> i32;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}
struct ProtectedOutput(Blob);
impl Drop for ProtectedOutput {
    fn drop(&mut self) {
        if !self.0.bytes.is_null() {
            unsafe {
                LocalFree(self.0.bytes.cast());
            }
        }
    }
}
pub(crate) fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn entropy(root: &codec::Root, purpose: &str) -> Vec<u8> {
    format!(
        "Nearly/updater/v1/{purpose}/{}/{}/{}",
        root.path, root.identity.volume, root.identity.file_id
    )
    .into_bytes()
}
fn crypt(context: &NativeContext, purpose: &str, input: &[u8], protect: bool) -> Result<Vec<u8>> {
    crypt_root(context.root(),purpose,input,protect)
}
pub(crate) fn crypt_root(root: &codec::Root, purpose: &str, input: &[u8], protect: bool) -> Result<Vec<u8>> {
    if input.is_empty() || input.len() > MAX_SEALED_RECORD {
        return Err(Error::Invalid);
    }
    let entropy = entropy(root, purpose);
    let source = Blob {
        length: input.len() as u32,
        bytes: input.as_ptr().cast_mut(),
    };
    let extra = Blob {
        length: entropy.len() as u32,
        bytes: entropy.as_ptr().cast_mut(),
    };
    let mut output = ProtectedOutput(Blob {
        length: 0,
        bytes: std::ptr::null_mut(),
    });
    // UI_FORBIDDEN, current-user scope. Never LOCAL_MACHINE; no stored secret.
    let success = unsafe {
        if protect {
            CryptProtectData(
                &source,
                std::ptr::null(),
                &extra,
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut output.0,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                &extra,
                std::ptr::null(),
                std::ptr::null(),
                1,
                &mut output.0,
            )
        }
    };
    if success == 0
        || output.0.bytes.is_null()
        || output.0.length == 0
        || output.0.length as usize > MAX_SEALED_RECORD
    {
        return Err(Error::Protection);
    }
    Ok(unsafe { std::slice::from_raw_parts(output.0.bytes, output.0.length as usize) }.to_vec())
}
pub(crate) fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut value = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut value) }
        .map_err(|_| Error::Io)?;
    if value.dwFileAttributes & 0x400 != 0 {
        return Err(Error::Unsafe);
    }
    Ok(value)
}
pub(crate) fn identity(value: &BY_HANDLE_FILE_INFORMATION) -> codec::Identity {
    let index = ((value.nFileIndexHigh as u64) << 32) | value.nFileIndexLow as u64;
    codec::Identity {
        volume: value.dwVolumeSerialNumber as u64,
        file_id: format!("{index:032x}"),
    }
}
pub(crate) fn regular(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let value = info(file)?;
    if value.dwFileAttributes & 0x10 != 0 || value.nNumberOfLinks != 1 {
        return Err(Error::Unsafe);
    }
    Ok(value)
}
pub(crate) fn file_length(value: &BY_HANDLE_FILE_INFORMATION) -> u64 {
    ((value.nFileSizeHigh as u64) << 32) | value.nFileSizeLow as u64
}
pub(crate) fn hash_file(file: &mut File, limit: u64) -> Result<(u64, String)> {
    file.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| Error::Io)?;
        if count == 0 {
            break;
        }
        total = total.checked_add(count as u64).ok_or(Error::Invalid)?;
        if total > limit {
            return Err(Error::Invalid);
        }
        hash.update(&buffer[..count]);
    }
    Ok((
        total,
        hash.finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}
pub(crate) fn directory(path: &Path, access: u32) -> Result<File> {
    let file = OpenOptions::new()
        // Metadata-only handles do not reliably participate in Windows
        // delete sharing. FILE_LIST_DIRECTORY makes these namespace pins
        // effective against rename/delete until the owning context drops.
        .access_mode(access | 1)
        .share_mode(3)
        .custom_flags(DIRECTORY | REPARSE)
        .open(path)
        .map_err(|_| Error::Io)?;
    if info(&file)?.dwFileAttributes & 0x10 == 0 {
        return Err(Error::Unsafe);
    }
    Ok(file)
}
pub(super) fn capture(root: &Path) -> Result<NativeContext> {
    let root = dunce::simplified(root).to_path_buf();
    let mut paths: Vec<_> = root.ancestors().collect();
    paths.reverse();
    let mut guards = Vec::new();
    for path in paths {
        guards.push(directory(path, 0x80)?);
    }
    let root_info = info(guards.last().ok_or(Error::Unsafe)?)?;
    let mut image = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(REPARSE)
        .open(root.join("Nearly.exe"))
        .map_err(|_| Error::Io)?;
    let image_info = regular(&image)?;
    let (length, digest) = hash_file(&mut image, crate::update_package::MAX_PACKAGE as u64)?;
    if length == 0 || length != file_length(&image_info) {
        return Err(Error::Unsafe);
    }
    let root_value = codec::Root {
        path: root.to_str().ok_or(Error::Unsafe)?.to_owned(),
        identity: identity(&root_info),
    };
    Ok(NativeContext(Arc::new(ContextInner {
        root_path: root,
        root: root_value,
        image,
        image_identity: identity(&image_info),
        image_length: length,
        image_sha256: digest,
        _directories: guards,
    })))
}
fn state_directory(context: &NativeContext) -> Result<(File, bool)> {
    use windows::{
        core::PWSTR,
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                NtCreateFile, NTCREATEFILE_CREATE_DISPOSITION, NTCREATEFILE_CREATE_OPTIONS,
            },
        },
        Win32::{
            Foundation::{OBJECT_ATTRIBUTE_FLAGS, UNICODE_STRING},
            Storage::FileSystem::{FILE_ACCESS_RIGHTS, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE},
            System::IO::IO_STATUS_BLOCK,
        },
    };
    // Relative native create/open prevents the create-directory/open race.
    let parent = directory(context.root_path(), 0x84)?;
    if identity(&info(&parent)?) != context.0.root.identity {
        return Err(Error::Unsafe);
    }
    let mut name: Vec<u16> = STATE_DIRECTORY.encode_utf16().collect();
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
    if info(&file)?.dwFileAttributes & 0x10 == 0 {
        return Err(Error::Unsafe);
    }
    if !matches!(status.Information, 1 | 2) {
        return Err(Error::Unsafe);
    }
    Ok((file, status.Information == 2))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u8,
    root: codec::Root,
}
pub(crate) fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>> {
    let file = match OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(REPARSE)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::Io),
    };
    if file_length(&regular(&file)?) > limit as u64 {
        return Err(Error::Invalid);
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Io)?;
    if bytes.len() > limit {
        return Err(Error::Invalid);
    }
    Ok(Some(bytes))
}
pub(crate) fn new_file(path: &Path, bytes: &[u8]) -> Result<File> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(1)
        .custom_flags(REPARSE)
        .create_new(true)
        .open(path)
        .map_err(|_| Error::Io)?;
    regular(&file)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| Error::Io)?;
    Ok(file)
}
pub(crate) struct TransactionStore {
    context: NativeContext,
    directory: PathBuf,
    _state_guard: File,
    _owner_guard: File,
    lease: Option<File>,
    record: Option<TransactionRecord>,
    initial: Option<TransactionRecord>,
}
impl TransactionStore {
    pub(crate) fn claim_current_restart(&mut self,expected:&codec::Receipt)->Result<TransactionRecord>{
        let identity=crate::update_restart::current_identity().map_err(|_|Error::Unsafe)?;
        self.begin(Some(expected)).map_err(|_|Error::Busy)?;
        let claimed=(||{
            let mut record=self.record.as_ref().ok_or(Error::Missing)?.clone();
            if record.receipt.state!=codec::State::HandoffCommitted{return Err(Error::Unsafe);}
            if let Some(previous)=&record.restart_process{
                return if previous==&identity{Ok(record)}else{Err(Error::Unsafe)};
            }
            record.restart_process=Some(identity);
            record.receipt.sequence=record.receipt.sequence.checked_add(1).filter(|s|*s<=64).ok_or(Error::Invalid)?;
            self.publish(&record)?;self.record=Some(record.clone());Ok(record)
        })();
        self.end();claimed
    }
    /// Discovery never creates a directory, owner, lease or record.
    pub(crate) fn open_existing(context:&NativeContext)->Result<Self>{Self::open_mode(context,false)}
    fn commit_handoff(&mut self, identity: &ProcessIdentity) -> Result<codec::Receipt> {
        if identity.pid == 0 || identity.created == 0 {
            return Err(Error::Invalid);
        }
        let expected = self.read_current()?.ok_or(Error::Missing)?.receipt;
        self.begin(Some(&expected)).map_err(|_| Error::Busy)?;
        let result = (|| {
            let mut record = self.record.as_ref().ok_or(Error::Missing)?.clone();
            if record.receipt.state != codec::State::Prepared
                || record
                    .installer_process
                    .as_ref()
                    .is_some_and(|old| old != identity)
            {
                return Err(Error::Unsafe);
            }
            record.installer_process = Some(identity.clone());
            record.receipt.state = codec::State::HandoffCommitted;
            record.receipt.sequence = record
                .receipt
                .sequence
                .checked_add(1)
                .filter(|s| *s <= 64)
                .ok_or(Error::Invalid)?;
            self.publish(&record)?;
            let acknowledged = record.receipt.clone();
            self.record = Some(record);
            Ok(acknowledged)
        })();
        self.end();
        result
    }
    pub(crate) fn open(context: &NativeContext) -> Result<Self> {Self::open_mode(context,true)}
    fn open_mode(context:&NativeContext,create:bool)->Result<Self>{
        let (state_guard, created) = if create { state_directory(context)? } else {
            let file=OpenOptions::new().access_mode(0x80).share_mode(3)
                .custom_flags(DIRECTORY|REPARSE).open(context.root_path().join(STATE_DIRECTORY))
                .map_err(|e|if e.kind()==std::io::ErrorKind::NotFound{Error::Missing}else{Error::Io})?;
            if info(&file)?.dwFileAttributes & 0x10==0{return Err(Error::Unsafe);}
            (file,false)
        };
        let directory = context.root_path().join(STATE_DIRECTORY);
        let owner = directory.join(OWNER);
        if created {
            let value = Owner {
                version: 1,
                root: context.0.root.clone(),
            };
            let plain = serde_json::to_vec(&value).map_err(|_| Error::Invalid)?;
            let sealed = crypt(context, "owner", &plain, true)?;
            drop(new_file(&owner, &sealed)?);
        }
        let bytes = read_bounded(&owner, MAX_SEALED_RECORD)?.ok_or(Error::Unsafe)?;
        let plain = crypt(context, "owner", &bytes, false)?;
        if plain.len() > 4096 {
            return Err(Error::Invalid);
        }
        let decoded: Owner = serde_json::from_slice(&plain).map_err(|_| Error::Invalid)?;
        if decoded.version != 1 || decoded.root != context.0.root {
            return Err(Error::Unsafe);
        }
        let owner_guard = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(REPARSE)
            .open(&owner)
            .map_err(|_| Error::Io)?;
        regular(&owner_guard)?;
        let mut store = Self {
            context: context.clone(),
            directory,
            _state_guard: state_guard,
            _owner_guard: owner_guard,
            lease: None,
            record: None,
            initial: None,
        };
        store.record = store.read_current()?;
        Ok(store)
    }
    fn read_current(&self) -> Result<Option<TransactionRecord>> {
        let Some(bytes) = read_bounded(&self.directory.join(RECORD), MAX_SEALED_RECORD)? else {
            return Ok(None);
        };
        let cipher = bytes.strip_prefix(HEADER).ok_or(Error::Invalid)?;
        let plain = crypt(&self.context, "record", cipher, false)?;
        let record = TransactionRecord::decode(&plain)?;
        if record.receipt.binding.root != self.context.0.root {
            return Err(Error::Unsafe);
        }
        Ok(Some(record))
    }
    /// Untrusted recovery hint only. Journal::begin reacquires the native lease,
    /// reloads and compares this exact receipt before authority/files/commits.
    pub(crate) fn recovery_hint(&self) -> Result<Option<TransactionRecord>> {
        self.read_current()
    }
    pub(crate) fn record(&self) -> Option<&TransactionRecord> {
        self.record.as_ref().or(self.initial.as_ref())
    }
    fn publish(&self, record: &TransactionRecord) -> Result<()> {
        let plain = record.encode()?;
        let cipher = crypt(&self.context, "record", &plain, true)?;
        let mut bytes = HEADER.to_vec();
        bytes.extend_from_slice(&cipher);
        if bytes.len() > MAX_SEALED_RECORD {
            return Err(Error::Invalid);
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| Error::Io)?;
        let name = format!(
            "transaction-{}.pending",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let staged = self.directory.join(name);
        let file = new_file(&staged, &bytes)?;
        let owned = identity(&regular(&file)?);
        drop(file);
        let guard = OpenOptions::new()
            .read(true)
            .share_mode(5)
            .custom_flags(REPARSE)
            .open(&staged)
            .map_err(|_| Error::Uncertain)?;
        if identity(&regular(&guard)?) != owned {
            return Err(Error::Uncertain);
        }
        let target = self.directory.join(RECORD);
        let from = wide(&staged);
        let to = wide(&target);
        // Source is owned/unpredictable and held without write sharing. Directory
        // identities are pinned. DPAPI is not a same-user malicious-code boundary.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
            return Err(Error::Uncertain);
        }
        drop(guard);
        Ok(())
    }
}
impl Journal for TransactionStore {
    fn begin(&mut self, expected: Option<&codec::Receipt>) -> std::result::Result<(), CommitError> {
        if self.lease.is_some() {
            return Err(CommitError::Busy);
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .custom_flags(REPARSE)
            .open(self.directory.join(LEASE))
            .map_err(|e| {
                if matches!(e.raw_os_error(), Some(32 | 33)) {
                    CommitError::Busy
                } else {
                    CommitError::Uncertain
                }
            })?;
        if regular(&lock).is_err() {
            return Err(CommitError::Uncertain);
        }
        let current = self.read_current().map_err(|_| CommitError::Uncertain)?;
        if current.as_ref().map(|r| &r.receipt) != expected {
            return Err(CommitError::Stale);
        }
        self.record = current;
        self.lease = Some(lock);
        Ok(())
    }
    fn commit(&mut self, receipt: &codec::Receipt) -> std::result::Result<(), CommitError> {
        if self.lease.is_none() {
            return Err(CommitError::NotCommitted);
        }
        let mut record = self
            .record
            .as_ref()
            .or(self.initial.as_ref())
            .ok_or(CommitError::NotCommitted)?
            .clone();
        record.receipt = receipt.clone();
        self.publish(&record).map_err(|_| CommitError::Uncertain)?;
        self.record = Some(record);
        Ok(())
    }
    fn end(&mut self) {
        self.lease.take();
    }
}

pub(crate) struct VerifiedInstaller {
    file: File,
    path: PathBuf,
    owned: codec::Identity,
    _context: NativeContext,
}
pub(crate) struct NativeFiles {
    context: NativeContext,
}
impl NativeFiles {
    pub(crate) fn new(context: &NativeContext) -> Self {
        Self {
            context: context.clone(),
        }
    }
}
impl Files for NativeFiles {
    type Handle = VerifiedInstaller;
    fn open_exact(
        &mut self,
        b: &codec::Binding,
    ) -> std::result::Result<Opened<Self::Handle>, OpenError> {
        if codec::validate_binding(b).is_err() || b.root != self.context.0.root {
            return Err(OpenError::Refused);
        }
        let path = self.context.root_path().join(&b.installer.basename);
        let mut file = match OpenOptions::new()
            .read(true)
            .access_mode(0x80000000 | DELETE)
            .share_mode(1)
            .custom_flags(REPARSE)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return OkMissing::missing(&self.context)
            }
            Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => return Err(OpenError::Locked),
            Err(_) => return Err(OpenError::Refused),
        };
        let value = regular(&file).map_err(|_| OpenError::Refused)?;
        let (length, sha256) = hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)
            .map_err(|_| OpenError::Refused)?;
        let owned = identity(&value);
        if owned != b.installer.identity
            || length != b.installer.length
            || sha256 != b.installer.sha256
        {
            return Err(OpenError::Refused);
        }
        let observation = Observation {
            root: self.context.0.root.clone(),
            root_reparse: false,
            parent_reparse: false,
            basename: b.installer.basename.clone(),
            file_identity: owned.clone(),
            length,
            sha256,
            regular_file: true,
            links: value.nNumberOfLinks,
        };
        Ok(Opened {
            handle: VerifiedInstaller {
                file,
                path,
                owned,
                _context: self.context.clone(),
            },
            observation,
        })
    }
    fn delete_exact(&mut self, handle: Self::Handle) -> std::result::Result<(), DeleteError> {
        let VerifiedInstaller {
            file,
            path,
            owned,
            _context,
        } = handle;
        if identity(&regular(&file).map_err(|_| DeleteError::Refused)?) != owned {
            return Err(DeleteError::Refused);
        }
        let disposition = FILE_DISPOSITION_INFO {
            DeleteFile: true.into(),
        };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                &disposition as *const _ as *const _,
                std::mem::size_of_val(&disposition) as u32,
            )
        }
        .map_err(|e| {
            if matches!(e.code().0 as u32 & 0xffff, 32 | 33) {
                DeleteError::Locked
            } else {
                DeleteError::Uncertain
            }
        })?;
        drop(file);
        // Basic disposition may only mark delete-pending while another reader is
        // alive. Confirm absence after closing, never mark Cleaned prematurely.
        match OpenOptions::new()
            .access_mode(0x80)
            .share_mode(7)
            .custom_flags(REPARSE)
            .open(&path)
        {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => Err(DeleteError::Locked),
            _ => Err(DeleteError::Uncertain),
        }
    }
}
struct OkMissing;
impl OkMissing {
    fn missing<H>(context: &NativeContext) -> std::result::Result<Opened<H>, OpenError> {
        Err(OpenError::Missing(Absence {
            root: context.0.root.clone(),
            root_reparse: false,
            parent_reparse: false,
        }))
    }
}

fn backup_current(context: &NativeContext, binding: &codec::Binding) -> Result<ImageBackup> {
    let basename = format!(
        "Nearly-update-{}-{}-previous.exe",
        binding.release.internal_version, binding.nonce
    );
    let path = context.root_path().join(&basename);
    let mut source = context.0.image.try_clone().map_err(|_| Error::Io)?;
    source.seek(SeekFrom::Start(0)).map_err(|_| Error::Io)?;
    if identity(&regular(&source)?) != context.0.image_identity {
        return Err(Error::Unsafe);
    }
    let mut backup = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(1)
        .custom_flags(REPARSE)
        .open(path)
        .map_err(|_| Error::Io)?;
    let count = std::io::copy(&mut source.take(context.0.image_length + 1), &mut backup)
        .map_err(|_| Error::Io)?;
    backup.sync_all().map_err(|_| Error::Io)?;
    let (value_hash_length, digest) =
        hash_file(&mut backup, crate::update_package::MAX_PACKAGE as u64)?;
    if count != context.0.image_length
        || value_hash_length != count
        || digest != context.0.image_sha256
    {
        return Err(Error::Unsafe);
    }
    Ok(ImageBackup {
        basename,
        identity: identity(&regular(&backup)?),
        source_identity: context.0.image_identity.clone(),
        length: count,
        sha256: digest,
        source_version: env!("CARGO_PKG_VERSION").into(),
    })
}
pub(crate) struct PreparedTransaction {
    pub(crate) store: TransactionStore,
    pub(crate) lifecycle: engine::Lifecycle,
    fenced: bool,
}
impl PreparedTransaction {
    /// The opaque failure comes only from the native launch path before spawn.
    /// Persisted Prepared alone is insufficient, including after a process crash.
    pub(crate) fn abandon_never_spawned(&mut self,failure:&crate::update_handoff::LaunchFailure)->Result<()> {
        let expected=self.lifecycle.receipt().clone();
        if self.fenced || expected.state!=codec::State::Prepared
            || !failure.never_spawned_for(&expected.binding.nonce) {return Err(Error::Unsafe);}
        if self.store.begin(Some(&expected)).is_err(){self.fenced=true;return Err(Error::Uncertain);}
        let result=(||{
            let mut record=self.store.record.as_ref().ok_or(Error::Missing)?.clone();
            if record.installer_process.is_some() || record.restart_process.is_some(){return Err(Error::Unsafe);}
            record.receipt.state=codec::State::Abandoned;
            record.receipt.sequence=record.receipt.sequence.checked_add(1).filter(|s|*s<=64).ok_or(Error::Invalid)?;
            self.store.publish(&record)?;
            self.lifecycle=engine::Lifecycle::recover(&codec::encode(&record.receipt).map_err(|_|Error::Invalid)?).map_err(|_|Error::Invalid)?;
            self.store.record=Some(record);Ok(())
        })();
        self.store.end();
        if result.is_err(){self.fenced=true;}
        result
    }
    pub(crate) fn bind_installer(
        &mut self,
        launched: &crate::update_handoff::LaunchedInstaller,
    ) -> Result<()> {
        let key = crate::update_package::production_key().ok_or(Error::Disabled)?;
        self.bind_native(launched, &key)
    }
    fn bind_native(
        &mut self,
        launched: &crate::update_handoff::LaunchedInstaller,
        key: &crate::update_package::TrustedKey,
    ) -> Result<()> {
        if self.fenced {
            return Err(Error::Uncertain);
        }
        let record = self.store.record().ok_or(Error::Missing)?.clone();
        // The opaque native launch object can only be created after Ready.
        // Retain an independently reopened exact process through publication.
        let _process = launched_process(launched, &self.store.context, &record)?;
        authenticate_record(&self.store.context, &record, key)?;
        match self.store.commit_handoff(&launched.process_identity()) {
            Ok(receipt) => {
                self.lifecycle = engine::Lifecycle::recover(
                    &codec::encode(&receipt).map_err(|_| Error::Invalid)?,
                )
                .map_err(|_| Error::Invalid)?;
                Ok(())
            }
            Err(error) => {
                self.fenced = true;
                Err(error)
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn bind_installer_fixture(
        &mut self,
        launched: &crate::update_handoff::LaunchedInstaller,
        key: &crate::update_package::TrustedKey,
    ) -> Result<()> {
        self.bind_native(launched, key)
    }
}
struct ProcessGuard(*mut std::ffi::c_void);
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn launched_process(
    launched: &crate::update_handoff::LaunchedInstaller,
    context: &NativeContext,
    record: &TransactionRecord,
) -> Result<ProcessGuard> {
    let identity = launched.process_identity();
    let process = ProcessGuard(unsafe { OpenProcess(0x00101000, 0, identity.pid) });
    if process.0.is_null() {
        return Err(Error::Unsafe);
    }
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    if unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
        || ((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64)
            != identity.created
        || unsafe { WaitForSingleObject(process.0, 0) } != 258
    {
        return Err(Error::Unsafe);
    }
    let mut path = [0u16; 32768];
    let mut length = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length) } == 0 {
        return Err(Error::Unsafe);
    }
    let actual =
        PathBuf::from(String::from_utf16(&path[..length as usize]).map_err(|_| Error::Unsafe)?);
    if dunce::canonicalize(actual).map_err(|_| Error::Io)?
        != dunce::canonicalize(
            context
                .root_path()
                .join(&record.receipt.binding.installer.basename),
        )
        .map_err(|_| Error::Io)?
    {
        return Err(Error::Unsafe);
    }
    Ok(process)
}
pub(crate) fn prepare_transaction(
    context: &NativeContext,
    snapshot: &crate::update_package::StageSnapshot,
) -> Result<PreparedTransaction> {
    let package = snapshot.package();
    if package.arch() != crate::update_package::Architecture::X64 {
        return Err(Error::Invalid);
    }
    if snapshot.path().parent() != Some(context.root_path()) {
        return Err(Error::Unsafe);
    }
    let basename = snapshot
        .path()
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(Error::Invalid)?
        .to_owned();
    let suffix = basename
        .strip_prefix(&format!("Nearly-update-{}-", package.target_version()))
        .and_then(|s| s.strip_suffix("-setup.exe"))
        .ok_or(Error::Invalid)?;
    let staged_info = regular(snapshot.file())?;
    let mut file = snapshot.file().try_clone().map_err(|_| Error::Io)?;
    let (length, digest) = hash_file(&mut file, crate::update_package::MAX_PACKAGE as u64)?;
    if digest != package.installer_sha256() {
        return Err(Error::Unsafe);
    }
    let binding = codec::Binding {
        nonce: suffix.to_owned(),
        root: context.0.root.clone(),
        release: codec::Release {
            internal_version: package.target_version().into(),
            public_tag: package.public_label().into(),
            architecture: codec::Architecture::X64,
            download_asset: package.asset_name().into(),
            signature_proof_digest: sha256(package.signature()),
        },
        installer: codec::Installer {
            basename,
            identity: identity(&staged_info),
            length,
            sha256: digest,
        },
    };
    codec::validate_binding(&binding).map_err(|_| Error::Invalid)?;
    // Admit the exact prior terminal receipt under the native lease before
    // creating a backup. Rejected/stale/uncertain attempts leave no new copy.
    let mut store = TransactionStore::open(context)?;
    let existing=store.recovery_hint()?;
    if let Some(previous)=&existing {
        if !matches!(previous.receipt.state,codec::State::Cleaned|codec::State::Abandoned)
            || previous.receipt.binding.nonce==binding.nonce {return Err(Error::Unsafe);}
    }
    store.begin(existing.as_ref().map(|r|&r.receipt)).map_err(|_|Error::Busy)?;
    let old_image = backup_current(context, &binding)?;
    let receipt = codec::Receipt {
        version: 1,
        binding: binding.clone(),
        state: codec::State::Prepared,
        sequence: 0,
        attempts: 0,
        next_retry_ms: None,
    };
    let initial = TransactionRecord {
        schema_version: 1,
        receipt,
        package_signature: std::str::from_utf8(package.signature())
            .map_err(|_| Error::Invalid)?
            .to_owned(),
        payload_sha256: package.payload_sha256().into(),
        old_image,
        installer_process: None,
        restart_process: None,
    };
    initial.validate()?;
    // Immutable signed StageSnapshot and pinned native context establish this
    // initial ownership. No previous recovery artifact is a deletion target.
    store.publish(&initial)?;
    let lifecycle=engine::Lifecycle::recover(&codec::encode(&initial.receipt).map_err(|_|Error::Invalid)?).map_err(|_|Error::Invalid)?;
    store.record=Some(initial);
    store.end();
    Ok(PreparedTransaction {
        store,
        lifecycle,
        fenced: false,
    })
}
pub(crate) fn authenticate_record(
    context: &NativeContext,
    record: &TransactionRecord,
    key: &crate::update_package::TrustedKey,
) -> Result<crate::update_package::PackageProof> {
    record.validate()?;
    if record.receipt.binding.root != context.0.root {
        return Err(Error::Unsafe);
    }
    let binding = &record.receipt.binding;
    let mut file = OpenOptions::new()
        .read(true)
        // Reverification may run while the policy pins a READ|DELETE handle.
        // Permit that existing DELETE access, never request write/delete here.
        // The pinned deletion handle itself still refuses other writes/deletes.
        .share_mode(5)
        .custom_flags(REPARSE)
        .open(context.root_path().join(&binding.installer.basename))
        .map_err(|_| Error::Io)?;
    let value = regular(&file)?;
    if identity(&value) != binding.installer.identity
        || file_length(&value) != binding.installer.length
    {
        return Err(Error::Unsafe);
    }
    let proof = crate::update_package::authenticate_snapshot(
        &mut file,
        record.package_signature.as_bytes(),
        &binding.release.internal_version,
        crate::update_package::Architecture::X64,
        key,
    )
    .map_err(|_| Error::Unsafe)?;
    if proof.installer_sha256() != binding.installer.sha256
        || proof.payload_sha256() != record.payload_sha256
        || proof.asset_name() != binding.release.download_asset
    {
        return Err(Error::Unsafe);
    }
    Ok(proof)
}

#[cfg(test)]
pub(super) fn fixture_record(
    context: &NativeContext,
    binding: codec::Binding,
) -> Result<TransactionRecord> {
    let old_image = backup_current(context, &binding)?;
    Ok(TransactionRecord {
        schema_version: 1,
        receipt: codec::Receipt {
            version: 1,
            binding,
            state: codec::State::Prepared,
            sequence: 0,
            attempts: 0,
            next_retry_ms: None,
        },
        package_signature: "c2lnbmVkLWZpeHR1cmU=".into(),
        payload_sha256: sha256(b"fixture new Nearly.exe"),
        old_image,
        installer_process: None,
        restart_process: None,
    })
}
#[cfg(test)]
pub(super) fn fixture_store(
    context: &NativeContext,
    record: TransactionRecord,
) -> Result<TransactionStore> {
    let mut store = TransactionStore::open(context)?;
    store.initial = Some(record);
    Ok(store)
}

/// Recheck the pinned current executable against authenticated release facts.
/// The native context holds the binary and every ancestor without write/delete
/// sharing; persisted journal flags cannot satisfy this check.
pub(crate) fn verify_running_payload(context:&NativeContext,proof:&crate::update_package::PackageProof)->Result<()> {
    if proof.target_version()!=env!("CARGO_PKG_VERSION")
        || crate::update_package::Architecture::current().map_err(|_|Error::Unsafe)?!=proof.arch()
        || proof.payload_sha256()!=context.installed_image_sha256() {
        return Err(Error::Unsafe);
    }
    let current=std::env::current_exe().map_err(|_|Error::Io)?;
    if dunce::canonicalize(current).map_err(|_|Error::Io)?
        !=dunce::canonicalize(context.root_path().join("Nearly.exe")).map_err(|_|Error::Io)? {return Err(Error::Unsafe);}
    let mut file=context.0.image.try_clone().map_err(|_|Error::Io)?;
    let value=regular(&file)?;
    if identity(&value)!=context.0.image_identity{return Err(Error::Unsafe);}
    let (length,hash)=hash_file(&mut file,crate::update_package::MAX_PACKAGE as u64)?;
    if length!=context.0.image_length || hash!=proof.payload_sha256(){return Err(Error::Unsafe);}
    let mut header=[0u8;64];file.seek(SeekFrom::Start(0)).map_err(|_|Error::Io)?;
    file.read_exact(&mut header).map_err(|_|Error::Unsafe)?;
    if &header[..2]!=b"MZ"{return Err(Error::Unsafe);}
    let offset=u32::from_le_bytes(header[60..64].try_into().map_err(|_|Error::Unsafe)?);
    file.seek(SeekFrom::Start(offset as u64)).map_err(|_|Error::Io)?;
    let mut pe=[0u8;26];file.read_exact(&mut pe).map_err(|_|Error::Unsafe)?;
    let machine=match proof.arch(){crate::update_package::Architecture::X64=>0x8664u16,crate::update_package::Architecture::Arm64=>0xaa64};
    if &pe[..4]!=b"PE\0\0" || u16::from_le_bytes([pe[4],pe[5]])!=machine || u16::from_le_bytes([pe[24],pe[25]])!=0x20b{return Err(Error::Unsafe);}
    Ok(())
}
