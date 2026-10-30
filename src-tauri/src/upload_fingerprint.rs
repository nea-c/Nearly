//! Optional no-op evidence from bytes already sent on this connection.
//! Never a mutation/deletion permit and never populated by scanning remote files.
use super::*;
use std::{collections::HashMap, path::PathBuf};
pub(super) const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_BYTES: usize = 4 * 1024 * 1024;
type Key = (PathBuf, String);
#[derive(Clone)]
pub(super) struct Evidence {
    pub(super) source: crate::source_change::Snapshot,
    pub(super) digest: ring::digest::Digest,
    pub(super) remote: RemoteStamp,
}
#[derive(Default)]
pub(super) struct Cache { entries: HashMap<Key, Evidence>, bytes: usize }
fn charge(key: &Key, evidence: &Evidence) -> usize {
    key.0.as_os_str().len().saturating_mul(2).saturating_add(key.1.len())
        .saturating_add(256).saturating_add(evidence.remote.authority_bytes())
}
impl Cache {
    pub(super) fn remember(&mut self, source: PathBuf, target: String, evidence: Evidence) {
        let key = (source, target);
        self.take(&key);
        let next = self.bytes.saturating_add(charge(&key, &evidence));
        if self.entries.len() >= MAX_ENTRIES || next > MAX_BYTES { return; }
        self.bytes = next;
        self.entries.insert(key, evidence);
    }
    fn take(&mut self, key: &Key) -> Option<Evidence> {
        let entry = self.entries.remove(key)?;
        self.bytes = self.bytes.saturating_sub(charge(key, &entry));
        Some(entry)
    }
}
fn key(root: &Path, relative: &Path, remote: &str) -> Result<Key, String> {
    Ok((root.join(relative), recorded_target(remote, relative)?))
}
impl Connection {
    pub(crate) fn has_upload_fingerprint(&self, root: &Path, relative: &Path, remote: &str) -> bool {
        key(root, relative, remote).ok().is_some_and(|key| self.fingerprints.lock().ok().is_some_and(|cache| cache.entries.contains_key(&key)))
    }
    pub(crate) fn forget_upload_fingerprint(&self, root: &Path, relative: &Path, remote: &str) {
        if let (Ok(key), Ok(mut cache)) = (key(root, relative, remote), self.fingerprints.lock()) { cache.take(&key); }
    }
}
pub(crate) fn unchanged_uploaded_content(s: &mut Connection, root: &Path, relative: &Path, remote: &str, stop: &AtomicBool) -> Result<bool, String> {
    crate::file_ops::check(stop)?;
    let key = key(root, relative, remote)?;
    // Consume first: failure, cancellation, changes and unknown outcomes cannot reuse it.
    let Some(evidence) = s.fingerprints.lock().map_err(|_| "Upload content state unavailable")?.take(&key) else { return Ok(false); };
    s.run(stop, async {
        let mut input = std::fs::File::open(&key.0).map_err(|_| "Local content comparison source unavailable")?;
        let snapshot = crate::source_change::Snapshot::capture(&input)?;
        if snapshot != evidence.source || snapshot.length() > MAX_FILE { return Ok(false); }
        let mut local = ObservedComparison { comparison: FileComparison::Upload { remote_newer: false }, source: key.0.clone(), root: root.to_path_buf(), snapshot };
        local.revalidate()?;
        if matches!(local.comparison, FileComparison::SourceChanged) { return Ok(false); }
        let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
        let mut buffer = [0u8; 32768];
        let mut bytes = 0u64;
        loop {
            crate::file_ops::check(stop)?;
            let n = input.read(&mut buffer).map_err(|_| "Local content comparison read failed")?;
            if n == 0 { break; }
            bytes += n as u64;
            if bytes > MAX_FILE { return Ok(false); }
            digest.update(&buffer[..n]);
        }
        if bytes != local.snapshot.length() || digest.finish().as_ref() != evidence.digest.as_ref() { return Ok(false); }
        local.revalidate()?;
        if matches!(local.comparison, FileComparison::SourceChanged) { return Ok(false); }
        // Still do fresh remote ancestry/type/size/time/parent checks. No cached authorization.
        let comparison = compare_file_observed(s, root, relative, remote,stop).await?;
        if !matches!(comparison.comparison, FileComparison::Unchanged(ref stamp) if stamp == &evidence.remote) { return Ok(false); }
        local.revalidate()?;
        crate::file_ops::check(stop)?;
        if matches!(local.comparison, FileComparison::SourceChanged) { return Ok(false); }
        if let Ok(mut cache) = s.fingerprints.lock() { cache.remember(key.0, key.1, evidence); }
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fingerprint_budget_includes_retained_ancestor_chain_and_replacement_delta() {
        let path=std::env::temp_dir().join(format!("nearly-fingerprint-budget-{}-{}",std::process::id(),getrandom::u64().unwrap()));
        let file=std::fs::File::create(&path).unwrap();
        let snapshot=crate::source_change::Snapshot::capture(&file).unwrap();drop(file);std::fs::remove_file(path).unwrap();
        let evidence=|bytes:usize|Evidence{source:snapshot.clone(),digest:ring::digest::digest(&ring::digest::SHA256,b""),remote:RemoteStamp{size:0,mtime:1,parent:Some(RemoteDirectoryStamp{chain:Arc::new(vec![("x".repeat(bytes),None,None,0o40755)])})}};
        let mut cache=Cache::default();let key:Key=(PathBuf::from("generated"),"/generated".into());
        let deep=evidence(8192);let retained=deep.remote.authority_bytes();cache.remember(key.0.clone(),key.1.clone(),deep);
        assert!(cache.bytes>=retained,"ancestor-chain memory must be included in the4MiB bound");
        let first=cache.bytes;cache.remember(key.0.clone(),key.1.clone(),evidence(16384));assert_eq!(cache.entries.len(),1);assert_eq!(cache.bytes-first,8192);
        cache.remember(key.0.clone(),key.1.clone(),evidence(MAX_BYTES));assert!(cache.entries.is_empty());assert_eq!(cache.bytes,0);
        for index in 0..8192{cache.remember(PathBuf::from(format!("generated/{index}")),format!("/generated/{index}"),evidence(8192));}
        assert!(cache.bytes<=MAX_BYTES);assert!(cache.entries.len()<MAX_ENTRIES);
        let keys:Vec<_>=cache.entries.keys().cloned().collect();for key in keys{cache.take(&key);}assert_eq!(cache.bytes,0);
        for index in 0..8192{cache.remember(PathBuf::from(format!("generated/{index}")),format!("/generated/{index}"),evidence(0));}
        assert_eq!(cache.entries.len(),MAX_ENTRIES);assert!(cache.bytes<=MAX_BYTES);
    }
}
