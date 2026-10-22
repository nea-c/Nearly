//! Local source consistency observations. I/O errors are never normal changes.
use std::{fs::File, time::SystemTime};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Change { Content, Replaced }

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    length: u64,
    modified: SystemTime,
    identity: (u64, u64),
}
impl Snapshot {
    pub(crate) fn length(&self) -> u64 { self.length }
    pub(crate) fn modified(&self) -> SystemTime { self.modified }
    pub(crate) fn capture(file: &File) -> Result<Self, String> {
        let metadata = file.metadata().map_err(|_| "Local source metadata unavailable")?;
        if !metadata.is_file() { return Err("Local source is not a regular file".into()); }
        #[cfg(windows)]
        let identity = {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION}};
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.map_err(|_| "Local source identity unavailable")?;
            if info.dwFileAttributes & (0x10 | 0x400) != 0 { return Err("Local source is a directory or reparse point".into()); }
            (info.dwVolumeSerialNumber as u64, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64)
        };
        #[cfg(unix)]
        let identity = { use std::os::unix::fs::MetadataExt; (metadata.dev(), metadata.ino()) };
        Ok(Self { length: metadata.len(), modified: metadata.modified().map_err(|_| "Local source timestamp unavailable")?, identity })
    }
    pub(crate) fn changed(&self, opened: &File, current: &File, bytes: u64) -> Result<Option<Change>, String> {
        let after = Self::capture(opened)?;
        let path_now = Self::capture(current)?;
        if self.identity != after.identity || self.identity != path_now.identity { return Ok(Some(Change::Replaced)); }
        if self.length != after.length || self.modified != after.modified || self.length != bytes
            || path_now.length != after.length || path_now.modified != after.modified { return Ok(Some(Change::Content)); }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::{self, OpenOptions, FileTimes}, io::Write, path::PathBuf, sync::atomic::{AtomicUsize, Ordering}, time::Duration};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture { fn new() -> Self { let p=std::env::temp_dir().join(format!("nearly-source-change-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));fs::create_dir(&p).unwrap();fs::write(p.join("source.txt"),b"original").unwrap();Self(p) } fn path(&self)->PathBuf{self.0.join("source.txt")} }
    impl Drop for Fixture {fn drop(&mut self){assert!(self.0.starts_with(std::env::temp_dir()));let _=fs::remove_dir_all(&self.0);}}
    #[test] fn stable_opened_source_is_unchanged(){let f=Fixture::new();let a=File::open(f.path()).unwrap();let before=Snapshot::capture(&a).unwrap();let current=File::open(f.path()).unwrap();assert_eq!(before.changed(&a,&current,8).unwrap(),None);}
    #[test] fn in_place_save_and_length_change_are_normal_content_changes(){for append in [false,true]{let f=Fixture::new();let a=File::open(f.path()).unwrap();let before=Snapshot::capture(&a).unwrap();let mut writer=OpenOptions::new().write(true).open(f.path()).unwrap();writer.write_all(if append{b"longer generated version"}else{b"changed!"}).unwrap();writer.set_times(FileTimes::new().set_modified(SystemTime::now()+Duration::from_secs(5))).unwrap();drop(writer);let current=File::open(f.path()).unwrap();assert_eq!(before.changed(&a,&current,8).unwrap(),Some(Change::Content));}}
    #[test] fn atomic_replace_is_detected_even_with_the_same_size_and_timestamp(){let f=Fixture::new();let a=File::open(f.path()).unwrap();let before=Snapshot::capture(&a).unwrap();let next=f.0.join("new.txt");fs::write(&next,b"changed!").unwrap();File::options().write(true).open(&next).unwrap().set_times(FileTimes::new().set_modified(before.modified)).unwrap();fs::rename(&next,f.path()).unwrap();let current=File::open(f.path()).unwrap();assert_eq!(before.changed(&a,&current,8).unwrap(),Some(Change::Replaced));}
    #[cfg(windows)]
    #[test] fn atomic_replace_with_an_open_read_handle_and_async_clone(){
        let f=Fixture::new();let a=File::open(f.path()).unwrap();let before=Snapshot::capture(&a).unwrap();
        let _reader=tokio::fs::File::from_std(a.try_clone().unwrap());
        let output=std::process::Command::new("node").args(["-e","const fs=require('fs');fs.writeFileSync(process.argv[2],'changed!');fs.renameSync(process.argv[2],process.argv[1]);"])
            .arg(f.path()).arg(f.0.join("new.txt")).output().unwrap();
        // Node/libuv MoveFileEx can reject this supported replacement while
        // Rust's rename succeeds. Keep the real open handles in both cases.
        if !output.status.success() { fs::rename(f.0.join("new.txt"),f.path()).unwrap(); }
        let current=File::open(f.path()).unwrap();assert_eq!(before.changed(&a,&current,8).unwrap(),Some(Change::Replaced));
    }
    #[cfg(windows)]
    #[test] fn sharing_violation_is_not_misclassified_as_a_successful_change(){use std::os::windows::fs::OpenOptionsExt;let f=Fixture::new();let held=OpenOptions::new().read(true).write(true).share_mode(0).open(f.path()).unwrap();let error=File::open(f.path()).unwrap_err();assert_eq!(error.raw_os_error(),Some(32));drop(held);}
}
