use crate::{
    local_publish::{self, OwnedStage},
    zip_preflight::{self, ArchiveError, Budget},
};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ZipAction {
    Compress,
    Extract,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveRequest {
    pub id: String,
    pub action: ZipAction,
    pub source: String,
    pub destination: String,
    pub side: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveOutcome {
    pub final_path: String,
    pub action: ZipAction,
    pub entries: usize,
    pub bytes: u64,
}
impl ArchiveRequest {
    pub fn validate(&self) -> Result<(), ArchiveError> {
        if self.side != "local" {
            return Err(ArchiveError::new(if self.side == "remote" {
                "remote_unsupported"
            } else {
                "invalid_request"
            }));
        }
        if self.source.len() > 4096 || self.destination.len() > 4096 {
            return Err(ArchiveError::new("invalid_request"));
        }
        Ok(())
    }
}
fn budget_io(budget: &Budget) -> std::io::Result<()> {
    budget
        .check()
        .map_err(|_| std::io::Error::other("archive_budget"))
}
struct Reader<'a, 'b> {
    inner: File,
    budget: &'a Budget<'b>,
}
impl Read for Reader<'_, '_> {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.budget
            .tick(b.len())
            .map_err(|_| std::io::Error::other("archive_budget"))?;
        let n = self.inner.read(b)?;
        budget_io(self.budget)?;
        Ok(n)
    }
}
impl Seek for Reader<'_, '_> {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        self.budget
            .tick(0)
            .map_err(|_| std::io::Error::other("archive_budget"))?;
        let n = self.inner.seek(p)?;
        budget_io(self.budget)?;
        Ok(n)
    }
}
struct Writer<'a, 'b> {
    inner: File,
    budget: &'a Budget<'b>,
    position: u64,
    extent: u64,
}
impl Write for Writer<'_, '_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        budget_io(self.budget)?;
        let end = self
            .position
            .checked_add(buf.len() as u64)
            .ok_or_else(|| std::io::Error::other("archive_limit"))?;
        if end > self.budget.limits.archive {
            self.budget.limit_hit.set(true);
            return Err(std::io::Error::other("archive_limit"));
        }
        let n = self.inner.write(buf)?;
        self.position += n as u64;
        self.extent = self.extent.max(self.position);
        budget_io(self.budget)?;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        budget_io(self.budget)?;
        self.inner.flush()?;
        budget_io(self.budget)
    }
}
impl Seek for Writer<'_, '_> {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        budget_io(self.budget)?;
        let position = match p {
            SeekFrom::Start(n) => n,
            SeekFrom::Current(n) => self
                .position
                .checked_add_signed(n)
                .ok_or_else(|| std::io::Error::other("archive_limit"))?,
            SeekFrom::End(n) => self
                .extent
                .checked_add_signed(n)
                .ok_or_else(|| std::io::Error::other("archive_limit"))?,
        };
        if position > self.budget.limits.archive {
            return Err(std::io::Error::other("archive_limit"));
        }
        self.position = self.inner.seek(SeekFrom::Start(position))?;
        budget_io(self.budget)?;
        Ok(self.position)
    }
}
fn lib_error(budget: &Budget) -> ArchiveError {
    budget
        .check()
        .err()
        .unwrap_or_else(|| ArchiveError::new("integrity_error"))
}
pub fn local_drive(path: &Path) -> Result<(), ArchiveError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
        let text = path
            .to_str()
            .ok_or_else(|| ArchiveError::new("invalid_request"))?;
        if text.len() < 3 || !text.as_bytes()[0].is_ascii_alphabetic() || &text[1..3] != ":\\" {
            return Err(ArchiveError::new("invalid_request"));
        }
        let drive: Vec<u16> = std::ffi::OsStr::new(&text[..3])
            .encode_wide()
            .chain(Some(0))
            .collect();
        if !matches!(unsafe { GetDriveTypeW(PCWSTR(drive.as_ptr())) }, 2 | 3) {
            return Err(ArchiveError::new("invalid_request"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(ArchiveError::new("unsupported_platform"))
    }
}
fn path_limit(path: &Path) -> Result<(), ArchiveError> {
    if path.as_os_str().to_string_lossy().encode_utf16().count() > 240 {
        Err(ArchiveError::new("limit_exceeded"))
    } else {
        Ok(())
    }
}
fn ancestors(path: &Path) -> Result<Vec<File>, ArchiveError> {
    let mut out = Vec::new();
    for parent in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        out.push(local_publish::lock_dir(parent)?);
    }
    Ok(out)
}
#[derive(Debug, PartialEq)]
struct Item {
    path: PathBuf,
    name: String,
    dir: bool,
    size: u64,
    modified: std::time::SystemTime,
}
fn inventory(source: &Path, budget: &Budget) -> Result<(Vec<Item>, Vec<File>), ArchiveError> {
    let parent = source
        .parent()
        .ok_or_else(|| ArchiveError::new("invalid_request"))?;
    let mut pending = vec![source.to_owned()];
    let mut items = Vec::new();
    let mut guards = Vec::new();
    let mut names = HashMap::new();
    let mut total = 0u64;
    while let Some(path) = pending.pop() {
        budget.check()?;
        if items.len() >= budget.limits.entries {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        let meta = fs::symlink_metadata(&path)?;
        if !local_publish::ordinary(&meta) {
            return Err(ArchiveError::new("unsafe_entry"));
        }
        let relative = path
            .strip_prefix(parent)
            .map_err(|_| ArchiveError::new("unsafe_entry"))?;
        let raw = relative
            .to_str()
            .ok_or_else(|| ArchiveError::new("unsafe_entry"))?
            .replace('\\', "/");
        let encoded = if meta.is_dir() {
            format!("{raw}/")
        } else {
            raw
        };
        let name = zip_preflight::validate_entry_name(encoded.as_bytes(), true, meta.is_dir())?;
        if name.split('/').count() > budget.limits.depth {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        zip_preflight::insert_name(&mut names, &name, meta.is_dir(), budget.limits.entries)?;
        if meta.is_file() {
            if meta.len() > budget.limits.single {
                return Err(ArchiveError::new("limit_exceeded"));
            }
            total = total
                .checked_add(meta.len())
                .ok_or_else(|| ArchiveError::new("limit_exceeded"))?;
            if total > budget.limits.total {
                return Err(ArchiveError::new("limit_exceeded"));
            }
        } else {
            guards.push(local_publish::lock_dir(&path)?);
            for child in fs::read_dir(&path)? {
                budget.check()?;
                if pending.len() + items.len() >= budget.limits.entries {
                    return Err(ArchiveError::new("limit_exceeded"));
                }
                pending.push(child?.path());
            }
        }
        items.push(Item {
            path,
            name,
            dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
            modified: meta.modified()?,
        });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((items, guards))
}
// Inputs are canonical, validated ordinary local paths from the native command.
pub fn execute(
    action: ZipAction,
    source: &Path,
    target: &Path,
    budget: &Budget,
) -> Result<ArchiveOutcome, ArchiveError> {
    budget.check()?;
    local_drive(source)?;
    local_drive(target)?;
    path_limit(source)?;
    path_limit(target)?;
    let parent = target
        .parent()
        .ok_or_else(|| ArchiveError::new("invalid_request"))?;
    let _source_parents = ancestors(
        source
            .parent()
            .ok_or_else(|| ArchiveError::new("invalid_request"))?,
    )?;
    let _target_parents = ancestors(parent)?;
    match fs::symlink_metadata(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => return Err(ArchiveError::new("collision")),
        Err(_) => return Err(ArchiveError::new("io_error")),
    }
    let meta = fs::symlink_metadata(source)?;
    if !local_publish::ordinary(&meta) {
        return Err(ArchiveError::new("unsafe_entry"));
    }
    let suffix = |p: &Path| {
        p.extension()
            .and_then(|x| x.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
    };
    if action == ZipAction::Extract && (!meta.is_file() || !suffix(source))
        || action == ZipAction::Compress && !suffix(target)
    {
        return Err(ArchiveError::new("invalid_request"));
    }
    match action {
        ZipAction::Compress => compress(source, target, budget),
        ZipAction::Extract => extract(source, target, budget),
    }
}
fn compress(source: &Path, target: &Path, budget: &Budget) -> Result<ArchiveOutcome, ArchiveError> {
    let (items, _guards) = inventory(source, budget)?;
    let mut stage = OwnedStage::create(target.parent().unwrap(), false, budget)?;
    let result = (|| {
        let output = stage.handle.try_clone()?;
        let writer = Writer {
            inner: output,
            budget,
            position: 0,
            extent: 0,
        };
        let mut zip = zip::ZipWriter::new(writer);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6))
            .large_file(false);
        let mut total = 0u64;
        let mut buf = [0u8; 65536];
        for item in &items {
            budget.check()?;
            if item.dir {
                zip.add_directory(format!("{}/", item.name), options.compression_method(zip::CompressionMethod::Stored))
                    .map_err(|_| lib_error(budget))?;
                continue;
            }
            let mut input = local_publish::source_file(&item.path)?;
            let before = input.metadata()?;
            if before.len() != item.size || before.modified()? != item.modified {
                return Err(ArchiveError::new("source_changed"));
            }
            zip.start_file(&item.name, options)
                .map_err(|_| lib_error(budget))?;
            let mut size = 0u64;
            loop {
                budget.check()?;
                let n = input.read(&mut buf)?;
                budget.check()?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                total += n as u64;
                if size > budget.limits.single || total > budget.limits.total {
                    return Err(ArchiveError::new("limit_exceeded"));
                }
                zip.write_all(&buf[..n]).map_err(|_| lib_error(budget))?;
            }
            if size != item.size || input.metadata()?.modified()? != item.modified {
                return Err(ArchiveError::new("source_changed"));
            }
        }
        let mut output = zip.finish().map_err(|_| lib_error(budget))?;
        output.flush()?;
        output.inner.sync_all()?;
        budget.check()?;
        if inventory(source, budget)?.0 != items {
            return Err(ArchiveError::new("source_changed"));
        }
        let bytes = stage.handle.metadata()?.len();
        if bytes > budget.limits.archive {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        let outcome = ArchiveOutcome {
            final_path: target.to_string_lossy().into_owned(),
            action: ZipAction::Compress,
            entries: items.len(),
            bytes: total,
        };
        stage.publish(target, budget)?;
        Ok(outcome)
    })();
    result.map_err(|e| stage.error(e))
}
fn extract(source: &Path, target: &Path, budget: &Budget) -> Result<ArchiveOutcome, ArchiveError> {
    let input = local_publish::source_file(source)?;
    let length = input.metadata()?.len();
    let mut reader = Reader {
        inner: input,
        budget,
    };
    let plan = zip_preflight::preflight(&mut reader, length, budget)?;
    let mut zip = zip::ZipArchive::with_config(
        zip::read::Config {
            archive_offset: zip::read::ArchiveOffset::Known(0),
        },
        reader,
    )
    .map_err(|_| lib_error(budget))?;
    if zip.len() != plan.entries.len() || zip.central_directory_start() != plan.central {
        return Err(ArchiveError::new("unsupported_zip"));
    }
    for (index, planned) in plan.entries.iter().enumerate() {
        let actual = zip.by_index_data(index).map_err(|_| lib_error(budget))?;
        if actual.name_raw() != planned.raw
            || actual.size() != planned.size
            || actual.compressed_size() != planned.compressed
            || actual.crc32() != planned.crc
            || actual.header_start() != planned.header
            || actual.is_dir() != planned.dir
            || actual.is_symlink()
            || actual.encrypted()
        {
            return Err(ArchiveError::new("unsupported_zip"));
        }
        path_limit(&target.join(&planned.name))?;
    }
    let mut stage = OwnedStage::create(target.parent().unwrap(), true, budget)?;
    let result = (|| {
        let mut dirs = HashMap::new();
        for item in &plan.entries {
            let path = Path::new(&item.name);
            for p in path
                .ancestors()
                .filter(|p| !p.as_os_str().is_empty())
                .skip(if item.dir { 0 } else { 1 })
            {
                dirs.insert(p.to_path_buf(), ());
            }
        }
        let mut dirs: Vec<_> = dirs.into_keys().collect();
        dirs.sort_by_key(|p| p.components().count());
        let mut guards = Vec::new();
        for dir in dirs {
            budget.check()?;
            let target = stage.path.join(dir);
            path_limit(&target)?;
            fs::create_dir(&target)?;
            guards.push(local_publish::lock_dir(&target)?);
        }
        let mut buf = [0u8; 65536];
        let mut total = 0u64;
        let mut written = HashMap::new();
        for (index, item) in plan.entries.iter().enumerate() {
            budget.check()?;
            if item.dir {
                continue;
            }
            let outpath = stage.path.join(&item.name);
            path_limit(&outpath)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(windows)]
            options.share_mode(1).custom_flags(0x00200000);
            let mut output = options.open(&outpath)?;
            if !local_publish::ordinary(&output.metadata()?) {
                return Err(ArchiveError::new("unsafe_entry"));
            }
            let output_id = local_publish::identity(&output)?;
            let mut entry = zip.by_index(index).map_err(|_| lib_error(budget))?;
            let mut size = 0u64;
            loop {
                budget.check()?;
                let n = entry.read(&mut buf).map_err(|_| lib_error(budget))?;
                budget.check()?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                total += n as u64;
                if size > budget.limits.single || size > item.size || total > budget.limits.total {
                    return Err(ArchiveError::new("limit_exceeded"));
                }
                output.write_all(&buf[..n])?;
                budget.check()?;
            }
            if size != item.size {
                return Err(ArchiveError::new("integrity_error"));
            }
            output.flush()?;
            output.sync_all()?;
            budget.check()?;
            written.insert(outpath, (size, output_id));
        }
        if total != plan.total {
            return Err(ArchiveError::new("integrity_error"));
        }
        // Validate the complete owned inventory before releasing descendants.
        let mut pending = vec![stage.path.clone()];
        let mut seen_files = 0;
        let mut seen_dirs = 0;
        let mut final_file_guards = Vec::new();
        while let Some(dir) = pending.pop() {
            budget.check()?;
            for child in fs::read_dir(dir)? {
                budget.check()?;
                let child = child?.path();
                let meta = fs::symlink_metadata(&child)?;
                if !local_publish::ordinary(&meta) {
                    return Err(ArchiveError::new("unsafe_entry"));
                }
                if meta.is_dir() {
                    seen_dirs += 1;
                    if seen_dirs > guards.len() {
                        return Err(ArchiveError::new("source_changed"));
                    }
                    pending.push(child);
                } else {
                    let expected = written
                        .get(&child)
                        .ok_or_else(|| ArchiveError::new("source_changed"))?;
                    let file = local_publish::source_file(&child)?;
                    if file.metadata()?.len() != expected.0
                        || local_publish::identity(&file)? != expected.1
                    {
                        return Err(ArchiveError::new("source_changed"));
                    }
                    seen_files += 1;
                    final_file_guards.push(file);
                }
            }
        }
        if seen_files != written.len() || seen_dirs != guards.len() {
            return Err(ArchiveError::new("source_changed"));
        }
        let outcome = ArchiveOutcome {
            final_path: target.to_string_lossy().into_owned(),
            action: ZipAction::Extract,
            entries: plan.entries.len(),
            bytes: total,
        };
        // Windows refuses directory rename while descendants deny delete sharing.
        // All path-based writes are finished. Keep the root DELETE handle and
        // destination-parent guards pinned; release descendants only, then publish.
        drop(final_file_guards);
        drop(guards);
        stage.publish(target, budget)?;
        Ok(outcome)
    })();
    result.map_err(|e| stage.error(e))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn temp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "nearly-zip-codec-{}-{}",
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
    fn roundtrip_file_unicode_empty_nested_directory_without_overwrite() {
        let parent = temp();
        let source = parent.join("source");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("empty")).unwrap();
        fs::create_dir(source.join("nested")).unwrap();
        fs::write(source.join("nested/日本語.txt"), b"payload").unwrap();
        fs::write(source.join("zero"), b"").unwrap();
        let stop = AtomicBool::new(false);
        let budget = Budget::new(&stop);
        let zip = parent.join("output.zip");
        let out = execute(ZipAction::Compress, &source, &zip, &budget).unwrap();
        assert_eq!(out.entries, 5);
        let target = parent.join("extracted");
        execute(ZipAction::Extract, &zip, &target, &budget).unwrap();
        assert_eq!(
            fs::read(target.join("source/nested/日本語.txt")).unwrap(),
            b"payload"
        );
        assert!(target.join("source/empty").is_dir());
        assert_eq!(
            execute(ZipAction::Extract, &zip, &target, &budget)
                .unwrap_err()
                .code,
            "collision"
        );
        assert_eq!(
            fs::read(source.join("nested/日本語.txt")).unwrap(),
            b"payload"
        );
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn crc_failure_retains_stage_without_final_and_cancellation_never_publishes() {
        let parent = temp();
        let source = parent.join("a");
        fs::write(&source, b"payload").unwrap();
        let zip = parent.join("a.zip");
        let stop = AtomicBool::new(false);
        let budget = Budget::new(&stop);
        execute(ZipAction::Compress, &source, &zip, &budget).unwrap();
        let mut bytes = fs::read(&zip).unwrap();
        let offset = 30 + 1;
        bytes[offset] ^= 0x7f;
        fs::write(&zip, bytes).unwrap();
        let target = parent.join("extract");
        let error = execute(ZipAction::Extract, &zip, &target, &budget).unwrap_err();
        assert!(!target.exists());
        assert!(!error.committed);
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            execute(
                ZipAction::Compress,
                &source,
                &parent.join("cancel.zip"),
                &budget
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(!parent.join("cancel.zip").exists());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn output_limit_and_remote_request_are_fail_closed() {
        let request = ArchiveRequest {
            id: "x".into(),
            source: "unreadable".into(),
            destination: "unreadable".into(),
            side: "remote".into(),
            action: ZipAction::Extract,
        };
        assert_eq!(request.validate().unwrap_err().code, "remote_unsupported");
        let parent = temp();
        let source = parent.join("a");
        fs::write(&source, b"payload").unwrap();
        let stop = AtomicBool::new(false);
        let mut budget = Budget::new(&stop);
        budget.limits.archive = 80;
        let target = parent.join("limited.zip");
        let error = execute(ZipAction::Compress, &source, &target, &budget).unwrap_err();
        assert_eq!(error.code, "limit_exceeded");
        assert!(!target.exists());
        assert!(error.stage_path.is_some());
        fs::remove_dir_all(parent).unwrap();
    }
    #[test]
    fn empty_uppercase_zip_and_unsupported_bytes_are_authoritatively_checked(){
        let parent=temp();let source=parent.join("empty.ZIP");
        let bytes=zip::ZipWriter::new(std::io::Cursor::new(Vec::new())).finish().unwrap().into_inner();fs::write(&source,bytes).unwrap();
        let stop=AtomicBool::new(false);let budget=Budget::new(&stop);let target=parent.join("empty-result");
        let result=execute(ZipAction::Extract,&source,&target,&budget).unwrap();assert_eq!(result.entries,0);assert_eq!(result.bytes,0);assert_eq!(fs::read_dir(&target).unwrap().count(),0);
        fs::write(&source,b"this is not ZIP bytes").unwrap();assert!(execute(ZipAction::Extract,&source,&parent.join("bad"),&budget).is_err());assert!(!parent.join("bad").exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
