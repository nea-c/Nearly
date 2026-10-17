use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveError {
    pub code: String,
    pub stage_path: Option<String>,
    pub committed: bool,
}
impl ArchiveError {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            stage_path: None,
            committed: false,
        }
    }
}
impl From<std::io::Error> for ArchiveError {
    fn from(_: std::io::Error) -> Self {
        Self::new("io_error")
    }
}
impl From<zip::result::ZipError> for ArchiveError {
    fn from(_: zip::result::ZipError) -> Self {
        Self::new("unsupported_zip")
    }
}
#[derive(Clone)]
pub struct Limits {
    pub entries: usize,
    pub depth: usize,
    pub archive: u64,
    pub single: u64,
    pub total: u64,
    pub central: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 10_000,
            depth: 40,
            archive: 512 * 1024 * 1024,
            single: 512 * 1024 * 1024,
            total: 2 * 1024 * 1024 * 1024,
            central: 16 * 1024 * 1024,
        }
    }
}
pub struct Budget<'a> {
    pub limits: Limits,
    pub deadline: Instant,
    pub stop: &'a AtomicBool,
    pub limit_hit: std::cell::Cell<bool>,
    io_ops: std::cell::Cell<u64>,
    io_bytes: std::cell::Cell<u64>,
}
impl<'a> Budget<'a> {
    pub fn new(stop: &'a AtomicBool) -> Self {
        Self {
            limits: Limits::default(),
            deadline: Instant::now() + Duration::from_secs(300),
            stop,
            limit_hit: std::cell::Cell::new(false),
            io_ops: std::cell::Cell::new(0),
            io_bytes: std::cell::Cell::new(0),
        }
    }
    pub fn check(&self) -> Result<(), ArchiveError> {
        if self.stop.load(Ordering::SeqCst) {
            Err(ArchiveError::new("cancelled"))
        } else if self.limit_hit.get() || Instant::now() >= self.deadline {
            Err(ArchiveError::new("limit_exceeded"))
        } else {
            Ok(())
        }
    }
    pub fn read_exact<R: Read>(&self, r: &mut R, buf: &mut [u8]) -> Result<(), ArchiveError> {
        self.check()?;
        r.read_exact(buf)
            .map_err(|_| ArchiveError::new("unsupported_zip"))?;
        self.check()
    }
    pub fn seek<R: Seek>(&self, r: &mut R, pos: u64) -> Result<(), ArchiveError> {
        self.check()?;
        r.seek(SeekFrom::Start(pos))?;
        self.check()
    }
    pub fn tick(&self, bytes: usize) -> Result<(), ArchiveError> {
        self.io_ops.set(self.io_ops.get().saturating_add(1));
        self.io_bytes
            .set(self.io_bytes.get().saturating_add(bytes as u64));
        if self.io_ops.get() > 500_000 || self.io_bytes.get() > 4 * 1024 * 1024 * 1024 {
            self.limit_hit.set(true);
        }
        self.check()
    }
}
#[derive(Debug, Clone)]
pub struct PlannedEntry {
    pub name: String,
    pub raw: Vec<u8>,
    pub dir: bool,
    pub size: u64,
    pub compressed: u64,
    pub crc: u32,
    pub method: u16,
    pub flags: u16,
    pub header: u64,
    pub data: u64,
}
#[derive(Debug)]
pub struct ArchivePlan {
    pub entries: Vec<PlannedEntry>,
    pub total: u64,
    pub central: u64,
}
fn u16at(b: &[u8], n: usize) -> u16 {
    u16::from_le_bytes([b[n], b[n + 1]])
}
fn u32at(b: &[u8], n: usize) -> u32 {
    u32::from_le_bytes(b[n..n + 4].try_into().expect("fixed header"))
}
fn bad<T>() -> Result<T, ArchiveError> {
    Err(ArchiveError::new("unsupported_zip"))
}
fn checked(a: u64, b: u64) -> Result<u64, ArchiveError> {
    a.checked_add(b)
        .ok_or_else(|| ArchiveError::new("unsupported_zip"))
}
pub fn validate_entry_name(raw: &[u8], utf8: bool, dir: bool) -> Result<String, ArchiveError> {
    let unsafe_name = || ArchiveError::new("unsafe_entry");
    if raw.len() > 1024 || raw.is_empty() || (!utf8 && !raw.is_ascii()) {
        return Err(unsafe_name());
    }
    let text = std::str::from_utf8(raw).map_err(|_| unsafe_name())?;
    let name = if dir {
        text.strip_suffix('/').ok_or_else(unsafe_name)?
    } else {
        text
    };
    if name.is_empty() {
        return Err(unsafe_name());
    }
    for part in name.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_uppercase();
        let numbered = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"));
        let device = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || numbered.is_some_and(|s| {
            s.chars().count() == 1 && s.chars().all(|c| matches!(c, '0'..='9' | '¹' | '²' | '³'))
        });
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part.encode_utf16().count() > 255
            || device
            || part.chars().any(|c| {
                c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
            })
        {
            return Err(unsafe_name());
        }
    }
    Ok(name.to_owned())
}
// Includes implicit parents. Explicit directory records may occur once only.
pub fn insert_name(
    names: &mut HashMap<String, (bool, bool)>,
    name: &str,
    dir: bool,
    max: usize,
) -> Result<(), ArchiveError> {
    let mut path = String::new();
    let parts: Vec<_> = name.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        if i != 0 {
            path.push('/');
        }
        path.push_str(part);
        let key = path.to_uppercase();
        let final_part = i + 1 == parts.len();
        let needed_dir = !final_part || dir;
        match names.get_mut(&key) {
            Some((existing_dir, explicit)) => {
                if !*existing_dir || !needed_dir || (final_part && *explicit) {
                    return Err(ArchiveError::new("unsafe_entry"));
                }
                if final_part {
                    *explicit = true;
                }
            }
            None => {
                if names.len() >= max {
                    return Err(ArchiveError::new("limit_exceeded"));
                }
                names.insert(key, (needed_dir, final_part));
            }
        }
    }
    Ok(())
}
fn extras(bytes: &[u8]) -> Result<(), ArchiveError> {
    let mut n = 0;
    while n < bytes.len() {
        if bytes.len() - n < 4 {
            return bad();
        }
        let tag = u16at(bytes, n);
        let len = u16at(bytes, n + 2) as usize;
        n += 4;
        if !matches!(tag, 0x5455 | 0x000a) || len > bytes.len() - n {
            return bad();
        }
        n += len;
    }
    Ok(())
}
pub fn preflight<R: Read + Seek>(
    r: &mut R,
    length: u64,
    budget: &Budget,
) -> Result<ArchivePlan, ArchiveError> {
    budget.check()?;
    if length > budget.limits.archive {
        return Err(ArchiveError::new("limit_exceeded"));
    }
    if length < 22 {
        return bad();
    }
    let tail_len = length.min(65_557) as usize;
    let start = length - tail_len as u64;
    let mut tail = vec![0; tail_len];
    budget.seek(r, start)?;
    budget.read_exact(r, &mut tail)?;
    let candidates: Vec<_> = (0..=tail.len() - 22)
        .filter(|&i| {
            tail[i..i + 4] == [0x50, 0x4b, 5, 6]
                && i + 22 + u16at(&tail, i + 20) as usize == tail.len()
        })
        .collect();
    if candidates.len() != 1 {
        return bad();
    }
    let end = start + candidates[0] as u64;
    let e = &tail[candidates[0]..];
    let count = u16at(e, 10) as usize;
    let cd_size = u32at(e, 12) as u64;
    let cd = u32at(e, 16) as u64;
    if u16at(e, 4) != 0
        || u16at(e, 6) != 0
        || u16at(e, 8) as usize != count
        || count == 65535
        || cd_size == u32::MAX as u64
        || cd == u32::MAX as u64
        || checked(cd, cd_size)? != end
    {
        return bad();
    }
    if count > budget.limits.entries || cd_size > budget.limits.central {
        return Err(ArchiveError::new("limit_exceeded"));
    }
    let mut entries = Vec::with_capacity(count);
    let mut names = HashMap::new();
    let mut pos = cd;
    let mut total = 0;
    for _ in 0..count {
        if checked(pos, 46)? > end {
            return bad();
        }
        budget.seek(r, pos)?;
        let mut h = [0; 46];
        budget.read_exact(r, &mut h)?;
        if u32at(&h, 0) != 0x02014b50 {
            return bad();
        }
        let flags = u16at(&h, 8);
        let method = u16at(&h, 10);
        let allowed = if method == 8 { 0x0806 } else { 0x0800 };
        let size = u32at(&h, 24) as u64;
        let compressed = u32at(&h, 20) as u64;
        let header = u32at(&h, 42) as u64;
        let name_len = u16at(&h, 28) as usize;
        let extra_len = u16at(&h, 30) as usize;
        let comment_len = u16at(&h, 32) as usize;
        if name_len > 1024 {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        pos = checked(pos, 46 + (name_len + extra_len + comment_len) as u64)?;
        if pos > end
            || flags & !allowed != 0
            || !matches!(method, 0 | 8)
            || u16at(&h, 6) > 20
            || u16at(&h, 34) != 0
            || [size, compressed, header].contains(&(u32::MAX as u64))
        {
            return bad();
        }
        let mut raw = vec![0; name_len];
        budget.read_exact(r, &mut raw)?;
        let mut extra = vec![0; extra_len];
        budget.read_exact(r, &mut extra)?;
        extras(&extra)?;
        let attrs = u32at(&h, 38);
        let unix = (attrs >> 16) & 0xf000;
        if !matches!(unix, 0 | 0x4000 | 0x8000) || attrs & 0x400 != 0 {
            return Err(ArchiveError::new("unsafe_entry"));
        }
        let dir = raw.last() == Some(&b'/');
        if ((attrs & 0x10 != 0 || unix == 0x4000) && !dir)
            || (unix == 0x8000 && dir)
            || dir && (size != 0 || compressed != 0 || method != 0 || u32at(&h,16)!=0)
        {
            return bad();
        }
        let name = validate_entry_name(&raw, flags & 0x800 != 0, dir)?;
        if name.split('/').count() > budget.limits.depth {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        insert_name(&mut names, &name, dir, budget.limits.entries)?;
        if size > budget.limits.single {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        total = checked(total, size)?;
        if total > budget.limits.total {
            return Err(ArchiveError::new("limit_exceeded"));
        }
        entries.push(PlannedEntry {
            name,
            raw,
            dir,
            size,
            compressed,
            crc: u32at(&h, 16),
            method,
            flags,
            header,
            data: 0,
        });
    }
    if pos != end {
        return bad();
    }
    let mut intervals = Vec::with_capacity(count);
    for entry in &mut entries {
        if checked(entry.header, 30)? > cd {
            return bad();
        }
        budget.seek(r, entry.header)?;
        let mut h = [0; 30];
        budget.read_exact(r, &mut h)?;
        if u32at(&h, 0) != 0x04034b50
            || u16at(&h, 4) > 20
            || u16at(&h, 6) != entry.flags
            || u16at(&h, 8) != entry.method
            || u32at(&h, 14) != entry.crc
            || u32at(&h, 18) as u64 != entry.compressed
            || u32at(&h, 22) as u64 != entry.size
            || u16at(&h, 26) as usize != entry.raw.len()
        {
            return bad();
        }
        entry.data = checked(
            entry.header,
            30 + entry.raw.len() as u64 + u16at(&h, 28) as u64,
        )?;
        let finish = checked(entry.data, entry.compressed)?;
        if finish > cd {
            return bad();
        }
        let mut raw = vec![0; entry.raw.len()];
        budget.read_exact(r, &mut raw)?;
        if raw != entry.raw {
            return bad();
        }
        let mut extra = vec![0; u16at(&h, 28) as usize];
        budget.read_exact(r, &mut extra)?;
        extras(&extra)?;
        if entry.method == 0 && entry.size != entry.compressed {
            return bad();
        }
        intervals.push((entry.header, finish));
    }
    intervals.sort_unstable();
    let mut cursor = 0;
    for (begin, finish) in intervals {
        if begin != cursor {
            return bad();
        }
        cursor = finish;
    }
    if cursor != cd {
        return bad();
    }
    budget.check()?;
    Ok(ArchivePlan {
        entries,
        total,
        central: cd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::sync::atomic::AtomicBool;
    fn fixture() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "a.txt",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap().into_inner()
    }
    fn inspect(bytes: Vec<u8>) -> Result<ArchivePlan, ArchiveError> {
        let stop = AtomicBool::new(false);
        let budget = Budget::new(&stop);
        preflight(&mut Cursor::new(&bytes), bytes.len() as u64, &budget)
    }
    #[test]
    fn stored_fixture_is_planned() {
        let p = inspect(fixture()).unwrap();
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0].name, "a.txt");
    }
    #[test]
    fn traversal_devices_ads_and_invalid_names_are_rejected() {
        for name in [
            "../a",
            "a/../b",
            "/a",
            "C:/a",
            "a\\b",
            "x:y",
            "NUL.txt",
            "COM¹.txt",
            "a.",
            "a ",
            "a//b",
            "a\0b",
        ] {
            assert!(
                validate_entry_name(name.as_bytes(), true, false).is_err(),
                "{name}"
            );
        }
        assert_eq!(
            validate_entry_name("日本語/a".as_bytes(), true, false).unwrap(),
            "日本語/a"
        );
        assert!(validate_entry_name(&[0xff], true, false).is_err());
    }
    #[test]
    fn malformed_ranges_zip64_encryption_and_descriptors_fail() {
        for (offset, value) in [(6, 1u8), (6, 8u8), (8, 99u8)] {
            let mut bytes = fixture();
            bytes[offset] = value;
            assert!(inspect(bytes).is_err());
        }
        let mut bytes = fixture();
        let end = bytes.len() - 22;
        bytes[end + 10] = 0xff;
        bytes[end + 11] = 0xff;
        assert!(inspect(bytes).is_err());
        let mut bytes = fixture();
        bytes.pop();
        assert!(inspect(bytes).is_err());
    }
    #[test]
    fn raw_duplicate_is_rejected_before_library_collapse() {
        let mut bytes = fixture();
        let end = bytes.len() - 22;
        let cd = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
        let record = bytes[cd..end].to_vec();
        bytes.splice(end..end, record.clone());
        let end = bytes.len() - 22;
        bytes[end + 8..end + 12].copy_from_slice(&[2, 0, 2, 0]);
        bytes[end + 12..end + 16].copy_from_slice(&((record.len() * 2) as u32).to_le_bytes());
        assert_eq!(inspect(bytes).unwrap_err().code, "unsafe_entry");
    }
    #[test]
    fn central_record_count_and_actual_limits_are_preallocation_bounds() {
        let bytes = fixture();
        let stop = AtomicBool::new(false);
        let mut budget = Budget::new(&stop);
        budget.limits.entries = 0;
        assert_eq!(
            preflight(&mut Cursor::new(&bytes), bytes.len() as u64, &budget)
                .unwrap_err()
                .code,
            "limit_exceeded"
        );
        budget.limits.entries = 10;
        budget.limits.single = 4;
        assert_eq!(
            preflight(&mut Cursor::new(&bytes), bytes.len() as u64, &budget)
                .unwrap_err()
                .code,
            "limit_exceeded"
        );
    }
    #[test]
    fn cancel_and_deadline_fail_before_read() {
        let stop = AtomicBool::new(true);
        assert_eq!(Budget::new(&stop).check().unwrap_err().code, "cancelled");
        let stop = AtomicBool::new(false);
        let mut budget = Budget::new(&stop);
        budget.deadline = std::time::Instant::now();
        assert_eq!(budget.check().unwrap_err().code, "limit_exceeded");
    }
    #[test]
    fn case_collisions_file_parents_and_implicit_directory_rules() {
        let mut names = HashMap::new();
        insert_name(&mut names, "Folder/a", false, 10).unwrap();
        assert!(insert_name(&mut names, "folder/A", false, 10).is_err());
        insert_name(&mut names, "Folder", true, 10).unwrap();
        assert!(insert_name(&mut names, "Folder", true, 10).is_err());
        let mut names = HashMap::new();
        insert_name(&mut names, "a", false, 10).unwrap();
        assert!(insert_name(&mut names, "a/b", false, 10).is_err());
    }
    #[test]
    fn central_special_attributes_offsets_and_extra_policy_reject_before_decode() {
        let original = fixture();
        let end = original.len() - 22;
        let cd = u32at(&original, end + 16) as usize;
        for (offset, data) in [
            (cd + 8, vec![1, 0]),
            (cd + 8, vec![8, 0]),
            (cd + 10, vec![99, 0]),
            (cd + 38, 0xa0000000u32.to_le_bytes().to_vec()),
            (cd + 42, u32::MAX.to_le_bytes().to_vec()),
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + data.len()].copy_from_slice(&data);
            assert!(inspect(bytes).is_err());
        }
        for tag in [0x0001u16, 0x9901, 0x7075, 0xbeef] {
            let mut extra = tag.to_le_bytes().to_vec();
            extra.extend([0, 0]);
            assert!(extras(&extra).is_err());
        }
        assert!(extras(&[0x55, 0x54, 1, 0, 0]).is_ok());
        assert!(extras(&[0x55, 0x54, 9, 0, 0]).is_err());
    }
    #[test]
    fn aggregate_and_depth_boundaries_are_checked_before_output() {
        let bytes = fixture();
        let stop = AtomicBool::new(false);
        let mut budget = Budget::new(&stop);
        budget.limits.total = 4;
        assert_eq!(
            preflight(&mut Cursor::new(&bytes), bytes.len() as u64, &budget)
                .unwrap_err()
                .code,
            "limit_exceeded"
        );
        budget.limits.total = 5;
        budget.limits.depth = 0;
        assert_eq!(
            preflight(&mut Cursor::new(&bytes), bytes.len() as u64, &budget)
                .unwrap_err()
                .code,
            "limit_exceeded"
        );
        budget.limits.depth = 1;
        assert!(preflight(&mut Cursor::new(&bytes), bytes.len() as u64, &budget).is_ok());
    }
    #[test]
    fn directory_records_must_be_canonical_stored_empty_crc_zero(){
        let mut writer=zip::ZipWriter::new(Cursor::new(Vec::new()));writer.add_directory("folder/",zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();let original=writer.finish().unwrap().into_inner();assert!(inspect(original.clone()).is_ok());
        let end=original.len()-22;let cd=u32at(&original,end+16) as usize;
        for crc in [false,true]{let mut bytes=original.clone();if crc{bytes[14]=1;bytes[cd+16]=1;}else{bytes[8]=8;bytes[cd+10]=8;}assert!(inspect(bytes).is_err());}
    }
}
