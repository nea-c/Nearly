use crate::PublicRecord;
use std::{
    io::Write,
    path::{Path, PathBuf},
};
pub struct FilePublicRecord {
    path: PathBuf,
    forbidden: Vec<PathBuf>,
}
impl FilePublicRecord {
    pub fn new(path: PathBuf, forbidden: Vec<PathBuf>) -> Self {
        Self { path, forbidden }
    }
}
impl PublicRecord for FilePublicRecord {
    fn assert_absent(&mut self) -> Result<(), &'static str> {
        for path in std::iter::once(&self.path).chain(&self.forbidden) {
            if !path.is_absolute() {
                return Err("absolute public/key-check paths required");
            }
            let parent = path.parent().ok_or("public parent missing")?;
            check_parents(parent)?;
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err("key/public-record path exists or cannot be checked"),
            }
        }
        Ok(())
    }
    fn save_new(&mut self, public_key: &str) -> Result<(), &'static str> {
        if public_key.len() > 16384
            || minisign::PublicKeyBox::from_string(public_key)
                .and_then(|b| b.into_public_key())
                .is_err()
        {
            return Err("invalid public record");
        }
        self.assert_absent()?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)
            .map_err(|_| "public record create-new failed")?;
        file.write_all(public_key.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "public record persistence failed")
    }
}
fn check_parents(parent: &Path) -> Result<(), &'static str> {
    for path in parent.ancestors() {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "public parent cannot be checked")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("public parent rejected");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("public reparse parent rejected");
            }
        }
    }
    Ok(())
}
