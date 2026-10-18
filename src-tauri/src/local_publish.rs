use crate::zip_preflight::{ArchiveError, Budget};
#[cfg(windows)]
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
    io::AsRawHandle,
};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub fn ordinary(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    if meta.file_attributes() & 0x400 != 0 {
        return false;
    }
    !meta.file_type().is_symlink() && (meta.is_file() || meta.is_dir())
}
pub fn identity(file: &File) -> Result<(u32, u64), ArchiveError> {
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
            .map_err(|_| ArchiveError::new("io_error"))?;
        if info.dwFileAttributes & 0x400 != 0 {
            return Err(ArchiveError::new("unsafe_entry"));
        }
        Ok((
            info.dwVolumeSerialNumber,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Err(ArchiveError::new("unsupported_platform"))
    }
}
pub fn lock_dir(path: &Path) -> Result<File, ArchiveError> {
    let mut options = OpenOptions::new();
    #[cfg(windows)]
    options
        .access_mode(0x80)
        .share_mode(1)
        .custom_flags(0x02200000);
    #[cfg(not(windows))]
    options.read(true);
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !ordinary(&meta) || !meta.is_dir() {
        return Err(ArchiveError::new("unsafe_entry"));
    }
    identity(&file)?;
    Ok(file)
}
pub fn source_file(path: &Path) -> Result<File, ArchiveError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.share_mode(1).custom_flags(0x00200000);
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !ordinary(&meta) || !meta.is_file() {
        return Err(ArchiveError::new("unsafe_entry"));
    }
    identity(&file)?;
    Ok(file)
}
// One kernel FILE_CREATE returns the owned DELETE handle. There is no
// CreateDirectory->Open window in which a replacement can be adopted.
fn create_directory_handle(parent:&Path,name:&str)->Result<File,ArchiveError>{
    #[cfg(windows)]{
        use std::os::windows::io::FromRawHandle;
        use windows::{core::PWSTR,Wdk::{Foundation::OBJECT_ATTRIBUTES,Storage::FileSystem::{NtCreateFile,FILE_CREATE,FILE_DIRECTORY_FILE,FILE_SYNCHRONOUS_IO_NONALERT}},Win32::{Foundation::{HANDLE,UNICODE_STRING},Storage::FileSystem::{FILE_ACCESS_RIGHTS,FILE_FLAGS_AND_ATTRIBUTES,FILE_SHARE_MODE},System::IO::IO_STATUS_BLOCK}};
        let mut options=OpenOptions::new();options.access_mode(0xa0).share_mode(1).custom_flags(0x02200000);
        let parent_handle=options.open(parent)?;
        if !ordinary(&parent_handle.metadata()?)||!parent_handle.metadata()?.is_dir(){return Err(ArchiveError::new("unsafe_entry"));}
        let mut wide:Vec<u16>=std::ffi::OsStr::new(name).encode_wide().collect();
        let length=u16::try_from(wide.len()*2).map_err(|_|ArchiveError::new("invalid_request"))?;
        let unicode=UNICODE_STRING{Length:length,MaximumLength:length,Buffer:PWSTR(wide.as_mut_ptr())};
        let attrs=OBJECT_ATTRIBUTES{Length:std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,RootDirectory:HANDLE(parent_handle.as_raw_handle()),ObjectName:&unicode,Attributes:windows::Win32::Foundation::OBJECT_ATTRIBUTE_FLAGS(0x40),..Default::default()};
        let mut handle=HANDLE::default();let mut status=IO_STATUS_BLOCK::default();
        let result=unsafe{NtCreateFile(&mut handle,FILE_ACCESS_RIGHTS(0x110080),&attrs,&mut status,None,FILE_FLAGS_AND_ATTRIBUTES(0x10),FILE_SHARE_MODE(1),FILE_CREATE,FILE_DIRECTORY_FILE|FILE_SYNCHRONOUS_IO_NONALERT,None,0)};
        if result.is_err(){return Err(ArchiveError::new("io_error"));}
        let file=unsafe{File::from_raw_handle(handle.0)};
        (|| {let meta=file.metadata()?;if status.Information!=2||!ordinary(&meta)||!meta.is_dir(){return Err(ArchiveError::new("unsafe_entry"));}Ok(())})().map_err(|mut error:ArchiveError|{error.stage_path=Some(parent.join(name).to_string_lossy().into_owned());error})?;
        Ok(file)
    }
    #[cfg(not(windows))]{let _=(parent,name);Err(ArchiveError::new("unsupported_platform"))}
}
pub struct OwnedStage {
    pub path: PathBuf,
    pub handle: File,
    original: (u32, u64),
    committed: bool,
}
impl OwnedStage {
    pub fn create(parent: &Path, dir: bool, budget: &Budget) -> Result<Self, ArchiveError> {
        Self::create_checked(parent, dir, budget, |_| Ok(()))
    }
    fn create_checked(parent: &Path, dir: bool, budget: &Budget, check: impl FnOnce(&File) -> Result<(), ArchiveError>) -> Result<Self, ArchiveError> {
        budget.check()?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| ArchiveError::new("io_error"))?;
        let name = format!(
            ".nearly-archive-{}.partial",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let path = parent.join(name);
        let mut options = OpenOptions::new();
        if path.as_os_str().to_string_lossy().encode_utf16().count() > 240 {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        let handle = if dir {
            create_directory_handle(parent,path.file_name().and_then(|s|s.to_str()).ok_or_else(||ArchiveError::new("invalid_request"))?)?
        } else {
            options.read(true).write(true).create_new(true);
            #[cfg(windows)]
            options
                .access_mode(0xc0010000)
                .share_mode(1)
                .custom_flags(0x00200000);
            options.open(&path)?
        };
        let original = (|| {
            check(&handle)?;
            let meta=handle.metadata()?;
            if !ordinary(&meta) || meta.is_dir()!=dir { return Err(ArchiveError::new("unsafe_entry")); }
            identity(&handle)
        })().map_err(|mut error: ArchiveError| { error.stage_path=Some(path.to_string_lossy().into_owned()); error })?;
        Ok(Self {
            path,
            handle,
            original,
            committed: false,
        })
    }
    pub fn publish(&mut self, target: &Path, budget: &Budget) -> Result<(), ArchiveError> {
        self.publish_inner(target, budget, false)
    }
    /// Only regular files may be replaced; caller owns explicit consent and target revalidation.
    pub fn publish_replacing(&mut self, target: &Path, budget: &Budget) -> Result<(), ArchiveError> {
        self.publish_replacing_checked(target, budget, |source, original| {
            if file_security(source)? != file_security(original)? || (source.metadata()?.file_attributes() ^ original.metadata()?.file_attributes()) & 0x4000 != 0 {
                return Err(ArchiveError::new("security_mismatch"));
            }
            Ok(())
        })
    }
    fn publish_replacing_checked(&mut self, target: &Path, budget: &Budget, check: impl FnOnce(&File, &File) -> Result<(), ArchiveError>) -> Result<(), ArchiveError> {
        if !self.handle.metadata()?.is_file() || !ordinary(&fs::symlink_metadata(target)?) || !fs::symlink_metadata(target)?.is_file() {
            return Err(ArchiveError::new("unsafe_entry"));
        }
        let original = OpenOptions::new().access_mode(0x20080).share_mode(5).custom_flags(0x02200000).open(target)?;
        if !ordinary(&original.metadata()?) || !original.metadata()?.is_file() { return Err(ArchiveError::new("unsafe_entry")); }
        check(&self.handle, &original)?;
        self.publish_inner(target, budget, true)
    }
    fn publish_inner(&mut self, target: &Path, budget: &Budget, replace: bool) -> Result<(), ArchiveError> {
        budget.check()?;
        if self.committed || identity(&self.handle)? != self.original {
            return Err(ArchiveError::new("unsafe_entry"));
        }
        #[cfg(windows)]
        {
            use windows::Win32::{
                Foundation::HANDLE,
                Storage::FileSystem::{
                    FileRenameInfo, FileRenameInfoEx, SetFileInformationByHandle, FILE_RENAME_INFO,
                },
            };
            let wide: Vec<u16> = target.as_os_str().encode_wide().collect();
            let length = wide
                .len()
                .checked_mul(2)
                .ok_or_else(|| ArchiveError::new("invalid_request"))?;
            let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
            let size = offset
                .checked_add(length + 2)
                .ok_or_else(|| ArchiveError::new("invalid_request"))?;
            // Vec<usize> provides the structure's native alignment, unlike Vec<u8>.
            let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let ptr = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            unsafe {
                // REPLACE_IF_EXISTS | POSIX_SEMANTICS permits retaining a delete-shared
                // metadata handle to the original. Do not ignore read-only attributes.
                if replace { (*ptr).Anonymous.Flags = 0x3; }
                else { (*ptr).Anonymous.ReplaceIfExists = false; }
                (*ptr).RootDirectory = HANDLE::default();
                (*ptr).FileNameLength = length as u32;
                std::ptr::copy_nonoverlapping(
                    wide.as_ptr(),
                    (*ptr).FileName.as_mut_ptr(),
                    wide.len(),
                );
                SetFileInformationByHandle(
                    HANDLE(self.handle.as_raw_handle()),
                    if replace { FileRenameInfoEx } else { FileRenameInfo },
                    ptr.cast(),
                    size as u32,
                )
            }
            .map_err(|error| {
                #[cfg(test)]
                eprintln!(
                    "publish error: {error:?}, dir={}",
                    self.handle.metadata().map(|m| m.is_dir()).unwrap_or(false)
                );
                ArchiveError::new("publish_refused")
            })?;
            self.committed = true;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = target;
            Err(ArchiveError::new("unsupported_platform"))
        }
    }
    pub fn error(&self, mut error: ArchiveError) -> ArchiveError {
        error.stage_path = Some(self.path.to_string_lossy().into_owned());
        error.committed = self.committed;
        error
    }
    /// Delete only the still-owned uncommitted regular-file handle, never a reopened pathname.
    pub fn discard_file(&mut self) -> Result<(), ArchiveError> {
        if self.committed || identity(&self.handle)? != self.original || !self.handle.metadata()?.is_file() { return Err(ArchiveError::new("unsafe_entry")); }
        #[cfg(windows)] {
            use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{SetFileInformationByHandle,FileDispositionInfo,FILE_DISPOSITION_INFO}};
            let info=FILE_DISPOSITION_INFO{DeleteFile:true.into()};
            unsafe {SetFileInformationByHandle(HANDLE(self.handle.as_raw_handle()),FileDispositionInfo,(&info as *const FILE_DISPOSITION_INFO).cast(),std::mem::size_of_val(&info) as u32)}.map_err(|_|ArchiveError::new("io_error"))?;
            Ok(())
        }
        #[cfg(not(windows))] {Err(ArchiveError::new("unsupported_platform"))}
    }
}
/// Read-only comparison: replacement never changes ACLs or encryption to make publication work.
fn file_security(file:&File)->Result<Vec<u8>,ArchiveError>{
    use windows::Win32::{Foundation::HANDLE,Security::{GetKernelObjectSecurity,PSECURITY_DESCRIPTOR,OWNER_SECURITY_INFORMATION,GROUP_SECURITY_INFORMATION,DACL_SECURITY_INFORMATION}};
    let information=(OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION).0;
    let mut needed=0;let _=unsafe{GetKernelObjectSecurity(HANDLE(file.as_raw_handle()),information,None,0,&mut needed)};
    if needed==0||needed>65536{return Err(ArchiveError::new("security_unavailable"));}
    let mut storage=vec![0usize;(needed as usize).div_ceil(std::mem::size_of::<usize>())];
    unsafe{GetKernelObjectSecurity(HANDLE(file.as_raw_handle()),information,Some(PSECURITY_DESCRIPTOR(storage.as_mut_ptr().cast())),needed,&mut needed)}.map_err(|_|ArchiveError::new("security_unavailable"))?;
    Ok(unsafe{std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(),needed as usize)}.to_vec())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "nearly-zip-publish-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn handle_publish_no_replace_and_cancel_keep_original() {
        let parent = temp();
        let stop = AtomicBool::new(false);
        let budget = Budget::new(&stop);
        let guard = lock_dir(&parent).unwrap();
        let mut stage = OwnedStage::create(&parent, false, &budget).unwrap();
        // A collision appears after staging, immediately before commit.
        let target = parent.join("result.zip");
        fs::write(&target, b"existing").unwrap();
        assert!(stage.publish(&target, &budget).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"existing");
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            stage
                .publish(&parent.join("cancel.zip"), &budget)
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert!(!parent.join("cancel.zip").exists());
        drop(stage);
        drop(guard);
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn replacement_publishes_complete_stage_without_predeleting_existing_file() {
        use std::io::Write;
        let parent=temp();let stop=AtomicBool::new(false);let budget=Budget::new(&stop);let target=parent.join("target");fs::write(&target,b"old intact").unwrap();
        let mut stage=OwnedStage::create(&parent,false,&budget).unwrap();stage.handle.write_all(b"new complete").unwrap();stage.handle.sync_all().unwrap();
        assert_eq!(fs::read(&target).unwrap(),b"old intact");stage.publish_replacing(&target,&budget).unwrap();assert_eq!(fs::read(&target).unwrap(),b"new complete");drop(stage);fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn security_validation_failure_keeps_both_original_and_complete_stage() {
        use std::io::Write;
        let parent=temp();let stop=AtomicBool::new(false);let budget=Budget::new(&stop);let target=parent.join("target");fs::write(&target,b"old intact").unwrap();let mut stage=OwnedStage::create(&parent,false,&budget).unwrap();stage.handle.write_all(b"new complete").unwrap();
        assert!(stage.publish_replacing_checked(&target,&budget,|_,_|Err(ArchiveError::new("security_mismatch"))).is_err());assert_eq!(fs::read(&target).unwrap(),b"old intact");assert_eq!(stage.handle.metadata().unwrap().len(),12);stage.discard_file().unwrap();drop(stage);fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn replacement_preserves_open_delete_shared_target_handle_until_atomic_publish() {
        use std::io::Write;
        let parent=temp();let stop=AtomicBool::new(false);let budget=Budget::new(&stop);let target=parent.join("target");fs::write(&target,b"old intact").unwrap();
        let retained=OpenOptions::new().access_mode(0x80).share_mode(5).custom_flags(0x02200000).open(&target).unwrap();
        let mut stage=OwnedStage::create(&parent,false,&budget).unwrap();stage.handle.write_all(b"new complete").unwrap();stage.handle.sync_all().unwrap();
        stage.publish_replacing(&target,&budget).unwrap();assert_eq!(fs::read(&target).unwrap(),b"new complete");assert_eq!(retained.metadata().unwrap().len(),10);drop(retained);drop(stage);fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn same_delete_handle_publishes_file_and_directory_without_reopen() {
        let parent = temp();
        let stop = AtomicBool::new(false);
        let budget = Budget::new(&stop);
        for dir in [false, true] {
            let mut stage = OwnedStage::create(&parent, dir, &budget).unwrap();
            if dir {
                let child=stage.path.join("child");fs::create_dir(&child).unwrap();
                let descendant=lock_dir(&child).unwrap();
                drop(descendant); // No writes after descendant release.
                assert!(fs::rename(&stage.path,parent.join("substituted")).is_err());
            }
            let target = parent.join(if dir { "folder" } else { "file.zip" });
            let old = stage.path.clone();
            stage.publish(&target, &budget).unwrap();
            assert!(target.exists());
            assert!(!old.exists());
            assert_eq!(identity(&stage.handle).unwrap(), stage.original);
        }
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn owned_root_handle_blocks_rename_substitution() {
        let parent = temp();
        let stop = AtomicBool::new(false);
        let budget = Budget::new(&stop);
        let stage = OwnedStage::create(&parent, true, &budget).unwrap();
        assert!(fs::rename(&stage.path, parent.join("stolen")).is_err());
        drop(stage);
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn directory_acquisition_is_atomic_create_not_open_existing(){
        let parent=temp();let name="already-owned-by-other";fs::create_dir(parent.join(name)).unwrap();fs::write(parent.join(name).join("marker"),b"other").unwrap();
        assert!(create_directory_handle(&parent,name).is_err());assert_eq!(fs::read(parent.join(name).join("marker")).unwrap(),b"other");
        let handle=create_directory_handle(&parent,"atomic").unwrap();assert!(fs::rename(parent.join("atomic"),parent.join("replace")).is_err());assert!(handle.metadata().unwrap().is_dir());drop(handle);fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn post_create_validation_failure_reports_retained_file_and_directory() {
        let parent=temp();let stop=AtomicBool::new(false);let budget=Budget::new(&stop);
        for dir in [false,true] {
            let error=OwnedStage::create_checked(&parent,dir,&budget,|_|Err(ArchiveError::new("io_error"))).err().expect("injected check fails");
            let retained=PathBuf::from(error.stage_path.expect("every post-create error identifies retained stage"));
            assert_eq!(retained.parent(),Some(parent.as_path()));assert!(retained.exists());assert_eq!(retained.is_dir(),dir);assert!(!error.committed);
        }
        fs::remove_dir_all(parent).unwrap();
    }

}
