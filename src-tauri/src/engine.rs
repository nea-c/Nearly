use crate::sftp::{self, Profile};
use crate::listing_hint::{DeletionBasis,ListingHint,Candidate};
impl DeletionBasis<sftp::RemoteStamp> { fn authority_bytes(&self)->usize {self.storage_bytes(sftp::RemoteStamp::authority_bytes)} }
impl DeletionBasis<sftp::RemoteDirectoryStamp> { fn authority_bytes(&self)->usize {self.storage_bytes(sftp::RemoteDirectoryStamp::authority_bytes)} }
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
#[path="engine_parallel.rs"] mod engine_parallel;
#[path="sync_decisions.rs"] pub(crate) mod sync_decisions;
use sync_decisions::{Diagnostics,Metadata as DecisionMetadata,Reason as DecisionReason};
#[cfg(test)]
mod decision_report_contract {
    #[test]
    fn new_job_exposes_bounded_anonymous_decision_report() {
        let status=serde_json::to_value(super::Status::new()).unwrap();
        assert_eq!(status["syncDecisions"]["precision"], "UTC Unix seconds (SFTP v3), exact equality");
        assert_eq!(status["syncDecisions"]["examples"].as_array().unwrap().len(),0);
    }
}
#[derive(Clone)]
pub struct SyncOptions {
    pub exclusion_rules: String,
    pub delete_removed: bool,
    pub recursive: bool,
}
impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            exclusion_rules: String::new(),
            delete_removed: false,
            recursive: true,
        }
    }
}
#[derive(Debug, PartialEq)]
enum LocalAction {
    Upload,
    Delete,
    Skip,
}

#[cfg(windows)]
fn local_root_identity(root: &Path) -> Result<(u64, u64), String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };
    // Query the directory itself, without following reparse points. Sharing
    // delete access preserves normal user renames/unplug behavior.
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(7)
        .custom_flags(0x02000000 | 0x00200000)
        .open(root)
        .map_err(|_| "Local root unavailable; refusing to infer file deletion")?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|_| "Cannot verify local root identity; deletion refused")?;
    if info.dwFileAttributes & 0x10 == 0 || info.dwFileAttributes & 0x400 != 0 {
        return Err("Local root is not a regular directory; deletion refused".into());
    }
    Ok((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}
#[cfg(unix)]
fn local_root_identity(root: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(root).map_err(|_| "Local root unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Invalid local root".into());
    }
    Ok((meta.dev(), meta.ino()))
}
fn reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
fn local_transfer_action(
    root: &Path,
    relative: &Path,
    expected_root: &(u64, u64),
    known_uploaded: bool,
    stop: &AtomicBool,
) -> Result<LocalAction, String> {
    if stop.load(Ordering::Relaxed) {
        return Err("Operation stopped".into());
    }
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Invalid local transfer path".into());
    }
    if &local_root_identity(root)? != expected_root {
        return Err("Local root identity changed; stop and start a new sync".into());
    }
    let mut existing = root.to_path_buf();
    let mut candidate = root.to_path_buf();
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            candidate.push(component.as_os_str());
            match std::fs::symlink_metadata(&candidate) {
                Ok(meta) if meta.is_dir() && !reparse(&meta) => existing = candidate.clone(),
                Ok(_) => {
                    return Err(
                        "Local parent changed type or is a reparse point; deletion refused".into(),
                    )
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => return Err("Local parent inaccessible; deletion refused".into()),
            }
        }
    }
    match std::fs::symlink_metadata(root.join(relative)) {
        Ok(meta) if reparse(&meta) => Err("Local path is a reparse point; transfer refused".into()),
        Ok(meta) if meta.is_file() => Ok(LocalAction::Upload),
        Ok(_) => Ok(LocalAction::Skip),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !known_uploaded {
                return Ok(LocalAction::Skip);
            }
            // A missing child is meaningful only while its nearest existing
            // parent can still be opened and read. Access failures aren't removals.
            let parent_identity = local_root_identity(&existing)?;
            for entry in std::fs::read_dir(&existing)
                .map_err(|_| "Local directory inaccessible; deletion refused")?
            {
                entry.map_err(|_| "Local directory read failed; deletion refused")?;
            }
            if local_root_identity(&existing)? != parent_identity
                || &local_root_identity(root)? != expected_root
            {
                return Err(
                    "Local root or ancestor changed during absence check; deletion refused".into(),
                );
            }
            if stop.load(Ordering::Relaxed) {
                return Err("Operation stopped".into());
            }
            // Recheck immediately before returning a deletion action, including
            // after reconnect and time spent validating the directory.
            match std::fs::symlink_metadata(root.join(relative)) {
                Ok(meta) if meta.is_file() && !reparse(&meta) => Ok(LocalAction::Upload),
                Ok(_) => Ok(LocalAction::Skip),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(LocalAction::Delete)
                }
                Err(_) => Err("Local file state uncertain; deletion refused".into()),
            }
        }
        Err(_) => Err("Local file inaccessible; deletion refused".into()),
    }
}
// Directory tracking is opt-in and per job/session.
fn queue_directories(
    path: &Path,
    root: &Path,
    queue: &mut HashMap<PathBuf, Pending>,
    directories: &mut HashMap<PathBuf, Option<DeletionBasis<sftp::RemoteDirectoryStamp>>>,
    stop: &AtomicBool,
    rules: &crate::exclusion::Rules,
    detected: Instant,
) -> Result<(), String> {
    crate::file_ops::check(stop)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Directory outside local root")?;
    if !relative.as_os_str().is_empty() {
        if rules.excludes(relative, true)? {
            return Ok(());
        }
        if relative.components().count() > 64 {
            return Err("Local directory depth exceeds 64".into());
        }
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| "Local directory metadata unavailable")?;
        if !meta.is_dir() || reparse(&meta) {
            return Err("Local directory changed type or is a reparse point".into());
        }
        if directories.len() >= 10000 && !directories.contains_key(relative) {
            return Err("Directory tracking limit reached; stop and restart".into());
        }
        directories.entry(relative.to_path_buf()).or_insert(None);
        enqueue_at(queue, relative.to_path_buf(), detected)?;
    }
    for entry in std::fs::read_dir(path).map_err(|_| "Local directory read failed")? {
        let entry = entry.map_err(|_| "Local directory entry read failed")?;
        let meta = std::fs::symlink_metadata(entry.path())
            .map_err(|_| "Local directory entry metadata failed")?;
        if meta.is_dir() && !reparse(&meta) {
            queue_directories(
                &entry.path(),
                root,
                queue,
                directories,
                stop,
                rules,
                detected,
            )?;
        }
    }
    Ok(())
}
fn directory_action(
    root: &Path,
    relative: &Path,
    identity: &(u64, u64),
    stop: &AtomicBool,
) -> Result<LocalAction, String> {
    let action = local_transfer_action(root, relative, identity, true, stop)?;
    match std::fs::symlink_metadata(root.join(relative)) {
        Ok(meta) if meta.is_dir() && !reparse(&meta) => {
            // Read every entry: a partially readable directory cannot authorize deletion.
            for entry in std::fs::read_dir(root.join(relative))
                .map_err(|_| "Local directory inaccessible")?
            {
                entry.map_err(|_| "Local directory read failed")?;
            }
            Ok(LocalAction::Skip) // Existing source means ensure/authorize, never delete.
        }
        Ok(_) => Err("Tracked local directory changed type; deletion refused".into()),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && action == LocalAction::Delete =>
        {
            Ok(LocalAction::Delete)
        }
        Err(_) => Err("Local directory state uncertain; deletion refused".into()),
    }
}
// Windows denies delete/rename of the original root and each existing parent
// for the short final remote operation. Reparse points are opened as themselves.
fn deletion_parent_guard(root: &Path, relative: &Path) -> Result<Vec<std::fs::File>, String> {
    let mut held = Vec::new();
    let mut current = root.to_path_buf();
    let mut paths = vec![current.clone()];
    if let Some(parent) = relative.parent() {
        for part in parent.components() {
            current.push(part.as_os_str());
            paths.push(current.clone());
        }
    }
    for path in paths {
        let mut options = std::fs::OpenOptions::new();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options
                .access_mode(0)
                .share_mode(3)
                .custom_flags(0x02000000 | 0x00200000);
        }
        #[cfg(not(windows))]
        {
            options.read(true);
        }
        match options.open(&path) {
            Ok(file) => {
                let metadata = file
                    .metadata()
                    .map_err(|_| "Local parent handle metadata unavailable")?;
                if !metadata.is_dir() || reparse(&metadata) {
                    return Err("Local parent changed type or is a reparse point".into());
                }
                held.push(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && path != root => break,
            Err(_) => {
                return Err(
                    "Cannot hold original local root/parents during removal; deletion refused"
                        .into(),
                )
            }
        }
    }
    Ok(held)
}
fn suspend_directories(directories: &mut HashMap<PathBuf, Option<DeletionBasis<sftp::RemoteDirectoryStamp>>>) {
    for stamp in directories.values_mut() {
        if let Some(basis)=stamp {basis.suspend();}
    }
}
fn remember_directory(directories: &mut HashMap<PathBuf,Option<DeletionBasis<sftp::RemoteDirectoryStamp>>>, path: PathBuf, stamp: sftp::RemoteDirectoryStamp, bytes: &mut usize) -> Result<(),String> {
    let old=directories.get(&path).and_then(Option::as_ref).map_or(0,DeletionBasis::<sftp::RemoteDirectoryStamp>::authority_bytes);
    let next=bytes.saturating_sub(old).saturating_add(stamp.authority_bytes());
    if next>16*1024*1024 { return Err("Directory authority memory limit reached; stop and start a shallower sync".into()); }
    directories.insert(path,Some(DeletionBasis::Verified(stamp))); *bytes=next; Ok(())
}

const REMOTE_CHANGE_LIMIT: usize = 64;
// JSON numbers are consumed by JavaScript cursors; never silently lose precision.
const MAX_REMOTE_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Clone, Serialize)]
pub struct RemoteChange {
    pub revision: u64,
    pub path: String,
    #[serde(rename = "removedDirectory", skip_serializing_if = "Option::is_none")]
    pub removed_directory: Option<String>,
}
#[derive(Clone, Default, Serialize)]
pub struct RemoteChanges {
    pub revision: u64,
    pub records: Vec<RemoteChange>,
    pub truncated: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopSummary {
    pub known_unreflected: bool,
}
impl Default for StopSummary {
    fn default() -> Self { Self { known_unreflected: false } }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailure {
    pub relative_path: Option<String>,
    pub operation: String,
    pub reason: String,
    pub commit_state: String,
    pub pending: usize,
    pub requires_rescan: bool,
}
#[derive(Clone, Serialize)]
pub struct Status {
    #[serde(rename="syncDecisions")]
    decisions: Diagnostics,
    #[serde(rename="syncPhase",serialize_with="serialize_sync_phase")]
    activity: crate::taskbar_status::Activity,
    #[serde(skip)]
    stop_summary: StopSummary,
    pub status: String,
    pub pending: usize,
    pub sent: u64,
    pub speed: u64,
    pub latency: u64,
    #[serde(rename = "errorCount")]
    pub error_count: u64,
    #[serde(rename = "remoteChanges")]
    pub remote_changes: RemoteChanges,
    pub logs: Vec<String>,
    pub failure: Option<SyncFailure>,
    #[serde(rename = "stopComplete")]
    pub stop_complete: bool,
    #[serde(rename = "deletionRescanRequired")]
    pub deletion_rescan_required: bool,
}
fn serialize_sync_phase<S:serde::Serializer>(activity:&crate::taskbar_status::Activity,serializer:S)->Result<S::Ok,S::Error>{
    use crate::taskbar_status::NativeSyncState::*;
    serializer.serialize_str(match activity.phase(){Scanning=>"scanning",Working=>"working",CaughtUp=>"caught_up",DeletionRescanRequired=>"deletion_rescan_required",Error=>"error",Stopping=>"stopping",Stopped=>"stopped"})
}
impl Status {
    fn new() -> Self {
        Self {
            decisions: Diagnostics::default(),
            activity: crate::taskbar_status::Activity::new(),
            stop_summary: StopSummary::default(),
            status: "running".into(),
            pending: 0,
            sent: 0,
            speed: 0,
            latency: 0,
            error_count: 0,
            remote_changes: RemoteChanges::default(),
            logs: vec!["Initial scan started".into()],
            failure: None,
            stop_complete: false,
            deletion_rescan_required: false,
        }
    }
    fn log(&mut self, s: &str) {
        self.logs.push(s.to_string());
        if self.logs.len() > 100 {
            self.logs.remove(0);
        }
    }
    fn failure(&mut self, message: &str, cancelled: bool) {
        if !cancelled {
            self.activity.failure(true);
            self.error_count = self.error_count.saturating_add(1);
            self.status = "failed".into();
            self.speed = 0;
            // The first failure survives informational log eviction and stop.
            if self.failure.is_none() {
                self.failure = Some(SyncFailure {
                    relative_path: None, operation: "sync".into(),
                    reason: message.chars().take(2048).collect(),
                    commit_state: "unknown".into(), pending: self.pending,
                    requires_rescan: true,
                });
            }
        }
        self.log(message);
    }
    fn failure_context(&mut self, message: &str, relative: Option<&Path>, operation: &str, commit_state: &str, pending: usize, cancelled: bool) {
        self.pending = pending;
        let first = self.failure.is_none();
        self.failure(message, cancelled);
        if first && !cancelled {
            if let Some(failure) = self.failure.as_mut() {
                failure.relative_path = relative.filter(|p| !p.as_os_str().is_empty() && p.components().all(|c| matches!(c, std::path::Component::Normal(_))))
                    .map(|p| p.to_string_lossy().chars().take(4096).collect());
                failure.operation = operation.into();
                failure.commit_state = commit_state.into();
                failure.pending = pending;
            }
        }
    }
    fn record_stopped_queue(&mut self, remaining: usize) {
        self.stop_summary.known_unreflected = remaining > 0 || self.failure.is_some();
        self.pending = if self.failure.is_some() { remaining } else { 0 };
        if let Some(failure) = self.failure.as_mut() { failure.pending = remaining; }
    }
    // Call only after a successful final SFTP result, never after staging writes.
    fn committed_remote_change(&mut self, remote: &str, relative: &Path) {
        self.activity.applied_change();
        let parent = relative.parent().and_then(Path::to_str).unwrap_or("").replace('\\', "/");
        let path = if parent.is_empty() { remote.to_owned() }
            else { format!("{}/{parent}", remote.trim_end_matches('/')) };
        let journal = &mut self.remote_changes;
        if journal.revision >= MAX_REMOTE_REVISION {
            // An exhausted cursor must not wrap and appear caught up again.
            journal.truncated = true;
            journal.records.clear();
            journal.records.push(RemoteChange { revision: MAX_REMOTE_REVISION, path: remote.to_owned(), removed_directory: None });
            self.failure_context("Remote refresh journal exhausted; stop and restart sync",Some(relative),"record","committed",self.pending,false);
            return;
        }
        journal.revision += 1;
        if journal.records.len() == REMOTE_CHANGE_LIMIT {
            journal.records.remove(0);
            journal.truncated = true;
        }
        journal.records.push(RemoteChange { revision: journal.revision, path, removed_directory: None });
    }
    fn committed_remote_directory_removal(&mut self, remote: &str, relative: &Path) {
        self.committed_remote_change(remote, relative);
        if let Some(record) = self.remote_changes.records.last_mut() {
            record.removed_directory = Some(format!("{}/{}", remote.trim_end_matches('/'), relative.to_string_lossy().replace('\\', "/")));
        }
    }
}
struct Job {
    local: PathBuf,
    identity: String,
    endpoints: Vec<std::net::SocketAddr>,
    remote: String,
    status: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
    retry: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}
#[derive(Default)]
pub struct Engine {
    start_failed: AtomicBool,
    failed_starts: Mutex<std::collections::HashSet<String>>,
    // The epoch outlives individual reservations: a completed mutation must
    // still invalidate roots validated by an in-flight start.
    mutation_gate: Arc<Mutex<u64>>,
    operations: Arc<Mutex<HashMap<String, Operation>>>,
    jobs: Mutex<HashMap<String, Job>>,
    starts: Mutex<HashMap<String, (Arc<AtomicBool>, bool)>>,
    closing: AtomicBool,
}
#[derive(Clone)]
struct Operation {
    editor: bool,
    editor_local: Vec<PathBuf>,
    document: Option<String>,
    persistent: bool,
    progress: Arc<crate::operation_progress::Progress>,
    stop: Arc<AtomicBool>,
    claimed: bool,
    archive: bool,
    local: Vec<PathBuf>,
    remote: Vec<String>,
    identity: String,
    endpoints: Vec<std::net::SocketAddr>,
}
#[derive(Clone)]
struct Pending {
    first: Instant,
    last: Instant,
    attempt: u8,
    force_upload: bool,
    batch_checked: bool,
}
pub struct EditorReservation{key:String,operations:Arc<Mutex<HashMap<String,Operation>>>,gate:Arc<Mutex<u64>>}
impl Drop for EditorReservation{fn drop(&mut self){if let Ok(mut epoch)=self.gate.lock(){if let Ok(mut ops)=self.operations.lock(){if ops.remove(&self.key).is_some(){*epoch=epoch.saturating_add(1);}}}}}
fn ready_after_completed_work(completed:bool,queue:&HashMap<PathBuf,Pending>,watcher_pending:bool)->bool {
    completed&&(watcher_pending||queue.values().any(|item|item.last.elapsed()>=Duration::from_millis(500)))
}
#[cfg(test)] #[path="new_file_wait_tests.rs"] mod new_file_wait_tests;
#[cfg(test)] #[path="sync_performance_tests.rs"] mod sync_performance_tests;
#[cfg(test)] #[path="sync_notice_test_hooks.rs"] pub(crate) mod sync_notice_test_hooks;
#[cfg(test)]
mod source_reschedule_tests {
    use super::*;
    #[test]
    fn completed_transfer_rechecks_unconsumed_watcher_events_without_idle_throttle() {
        let q=HashMap::new();
        assert!(ready_after_completed_work(true,&q,true));
        assert!(!ready_after_completed_work(false,&q,true));
        assert!(!ready_after_completed_work(true,&q,false));
    }
    #[test]
    fn ready_work_skips_throttle_but_idle_and_debounce_do_not() {
        let mut q=HashMap::new();let now=Instant::now();enqueue_at(&mut q,PathBuf::from("ready"),now-Duration::from_secs(1)).unwrap();
        assert!(!ready_after_completed_work(false,&q,false));assert!(ready_after_completed_work(true,&q,false));
        q.get_mut(Path::new("ready")).unwrap().last=now+Duration::from_secs(1);
        assert!(!ready_after_completed_work(true,&q,false));q.clear();assert!(!ready_after_completed_work(true,&q,false));
    }
    #[test]
    fn old_watcher_events_cannot_rewind_a_source_change_debounce() {
        let mut q=HashMap::new();let path=PathBuf::from("source.txt");let now=Instant::now();
        enqueue_at(&mut q,path.clone(),now).unwrap();
        enqueue_at(&mut q,path.clone(),now-Duration::from_secs(2)).unwrap();
        assert_eq!(q[&path].last,now);
    }
}
#[cfg(test)]
fn enqueue(q: &mut HashMap<PathBuf, Pending>, p: PathBuf) -> Result<(), String> {
    enqueue_at(q, p, Instant::now())
}
fn enqueue_at(q: &mut HashMap<PathBuf, Pending>, p: PathBuf, now: Instant) -> Result<(), String> {
    if q.len() >= 10000 && !q.contains_key(&p) {
        return Err("Queue limit reached. Stop and restart to rescan.".into());
    }
    q.entry(p)
        .and_modify(|e| {
            e.last = e.last.max(now);
            e.attempt = 0;
        })
        .or_insert(Pending {
            first: now,
            last: now,
            attempt: 0,
            force_upload: false,
            batch_checked: false,
        });
    Ok(())
}
fn scan(
    path: &Path,
    root: &Path,
    q: &mut HashMap<PathBuf, Pending>,
    stop: &AtomicBool,
    rules: &crate::exclusion::Rules,
    recursive: bool,
) -> Result<(), String> {
    for entry in std::fs::read_dir(path).map_err(|_| "Local directory read failed")? {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let entry = entry.map_err(|_| "Local entry failed")?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|_| "Local metadata failed")?;
        let ty = metadata.file_type();
        if reparse(&metadata) {
            continue;
        }
        if ty.is_file() {
            let relative=entry.path().strip_prefix(root).map_err(|_|"Local scan path outside root")?.to_path_buf();
            if (recursive || relative.components().count()==1) && !rules.excludes(&relative,false)? {
                std::fs::File::open(entry.path()).map_err(|_|"Local source entry unreadable; initial scan incomplete, mirror deletion refused")?;
            }
        }
        if ty.is_dir() || ty.is_file() {
            queue_candidate(
                &entry.path(),
                root,
                ty.is_dir(),
                q,
                stop,
                rules,
                Instant::now(),
                recursive,
            )?;
        }
    }
    Ok(())
}
fn queue_candidate(
    path: &Path,
    root: &Path,
    is_dir: bool,
    q: &mut HashMap<PathBuf, Pending>,
    stop: &AtomicBool,
    rules: &crate::exclusion::Rules,
    detected: Instant,
    recursive: bool,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Watcher path outside root")?;
    if rules.excludes(relative, is_dir)? {
        return Ok(());
    }
    if !recursive && (is_dir || relative.components().count() != 1) {
        return Ok(());
    }
    if is_dir {
        if relative.components().count() > 64 {
            return Err("Local directory depth exceeds 64; stop and restart with a shallower root or exclude the deep directory".into());
        }
        scan(path, root, q, stop, rules, recursive)
    } else {
        enqueue_at(q, relative.to_path_buf(), detected)
    }
}
fn queue_removed<T>(
    path: &Path,
    root: &Path,
    inventory: &HashMap<PathBuf, T>,
    q: &mut HashMap<PathBuf, Pending>,
    rules: &crate::exclusion::Rules,
    recursive: bool,
    detected: Instant,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Watcher path outside root")?;
    for known in inventory.keys() {
        if known.starts_with(relative)
            && (recursive || known.components().count() == 1)
            && !rules.excludes(known, false)?
        {
            enqueue_at(q, known.clone(), detected)?;
        }
    }
    Ok(())
}
fn remember_upload<T>(
    inventory: &mut HashMap<PathBuf, T>,
    path: PathBuf,
    stamp: T,
) -> Result<(), String> {
    if inventory.len() >= 10000 && !inventory.contains_key(&path) {
        return Err("Deletion disabled: uploaded-file tracking limit reached. Stop and start a new sync; no further remote deletions will be attempted by this job".into());
    }
    inventory.insert(path, stamp);
    Ok(())
}
fn remember_file(
    inventory: &mut HashMap<PathBuf,DeletionBasis<sftp::RemoteStamp>>, path: PathBuf, stamp: sftp::RemoteStamp,
    authority_bytes: &mut usize,
) -> Result<(),String> {
    let previous=inventory.get(&path).map_or(0,|old|old.authority_bytes()+path.as_os_str().len()*2);
    let next=authority_bytes.saturating_sub(previous).saturating_add(stamp.authority_bytes()+path.as_os_str().len()*2);
    if next > 16*1024*1024 { return Err("Deletion disabled: file authority memory limit reached; stop and start a shallower sync".into()); }
    remember_upload(inventory,path,DeletionBasis::Verified(stamp))?;
    *authority_bytes=next;
    Ok(())
}
impl Engine {
    pub fn starts_pending(&self,ids:&[String])->Result<bool,String>{let starts=self.starts.lock().map_err(|_|"Start lock failed")?;Ok(ids.iter().any(|id|starts.get(id).is_some_and(|(stop,claimed)|*claimed||!stop.load(Ordering::SeqCst))))}
    pub fn window_busy(&self, ids: &[String], operations: &[String]) -> Result<bool, String> {
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        let starts = self.starts.lock().map_err(|_| "Start lock failed")?;
        let ops = self.operations.lock().map_err(|_| "Operation lock failed")?;
        Ok(ids.iter().any(|id| jobs.contains_key(id) || starts.get(id).is_some_and(|(stop, claimed)| *claimed || !stop.load(Ordering::SeqCst))) || operations.iter().any(|id| ops.contains_key(id)))
    }
    pub fn taskbar_state_for(&self, ids: &[String]) -> Result<crate::taskbar_status::TaskbarState, String> {
        use crate::taskbar_status::{aggregate, NativeSyncState as N};
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        let starts = self.starts.lock().map_err(|_| "Start lock failed")?;
        let mut states = Vec::new();
        if self.failed_starts.lock().map_err(|_|"Failure lock failed")?.iter().any(|id|ids.contains(id)){states.push(N::Error);}
        for id in ids { if let Some(job)=jobs.get(id) {
            let s=job.status.lock().map_err(|_| "Status lock failed")?;
            states.push(match s.status.as_str(){"stopping"=>N::Stopping,"stopped"=>N::Stopped,"failed"=>N::Error,_=>if job.handle.as_ref().is_some_and(|h|h.is_finished()){N::Error}else{s.activity.phase()}});
        }}
        Ok(aggregate(states, ids.iter().any(|id|starts.get(id).is_some_and(|(stop,_)|!stop.load(Ordering::SeqCst)))))
    }
    /// Consume native completion epochs only for the invoking window's jobs.
    /// No renderer snapshot/settings can restore these acknowledgements.
    pub fn take_sync_completion(&self, ids: &[String]) -> Result<bool,String> {
        use crate::taskbar_status::{aggregate,NativeSyncState as N,TaskbarState as T};
        let jobs=self.jobs.lock().map_err(|_|"Job lock failed")?;
        let starts=self.starts.lock().map_err(|_|"Start lock failed")?;
        let failed=self.failed_starts.lock().map_err(|_|"Failure lock failed")?.iter().any(|id|ids.contains(id));
        let mut statuses=Vec::new();let mut phases=Vec::new();let mut cancelled=false;
        if failed{phases.push(N::Error);}
        // Hold the job snapshot until acknowledgement: workers cannot change a
        // completed status into an error/stop halfway through this decision.
        for id in ids {if let Some(job)=jobs.get(id) {
            let s=job.status.lock().map_err(|_|"Status lock failed")?;
            cancelled|=job.stop.load(Ordering::SeqCst)||matches!(s.status.as_str(),"stopping"|"stopped");
            phases.push(if job.stop.load(Ordering::SeqCst){N::Stopping}else{match s.status.as_str(){"stopping"=>N::Stopping,"stopped"=>N::Stopped,"failed"=>N::Error,_=>if job.handle.as_ref().is_some_and(|h|h.is_finished()){N::Error}else{s.activity.phase()}}});
            statuses.push(s);
        }}
        cancelled|=ids.iter().any(|id|starts.get(id).is_some_and(|(stop,_)|stop.load(Ordering::SeqCst)));
        let pending=ids.iter().any(|id|starts.get(id).is_some_and(|(stop,claimed)|*claimed||!stop.load(Ordering::SeqCst)));
        if cancelled {
            for mut status in statuses{status.activity.take_completion();}
            return Ok(false);
        }
        let state=aggregate(phases,pending);
        if state==T::Working{return Ok(false);}
        let mut completed=false;
        for mut status in statuses {completed|=status.activity.take_completion()>0;}
        // Failed/stopped windows discard stale successes; a later committed
        // change will create a fresh epoch rather than replaying old success.
        Ok(state==T::CaughtUp&&completed)
    }
    /// Read-only strict idle attestation; ownership probation seals admissions.
    pub(crate) fn probation_idle(&self)->Result<bool,String>{
        let _gate=self.mutation_gate.lock().map_err(|_|"Engine gate failed")?;
        let jobs=self.jobs.lock().map_err(|_|"Job lock failed")?;
        let starts=self.starts.lock().map_err(|_|"Start lock failed")?;
        let operations=self.operations.lock().map_err(|_|"Operation lock failed")?;
        Ok(!self.closing.load(Ordering::SeqCst)&&jobs.is_empty()&&starts.is_empty()&&operations.is_empty())
    }
    pub fn try_begin_close(&self) -> Result<(), String> {
        let _gate = self
            .mutation_gate
            .lock()
            .map_err(|_| "同期状態を確認できないため終了できません。".to_string())?;
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| "同期状態を確認できないため終了できません。".to_string())?;
        let starts = self
            .starts
            .lock()
            .map_err(|_| "接続状態を確認できないため終了できません。".to_string())?;
        if !jobs.is_empty()
            || starts
                .values()
                .any(|(stop, claimed)| *claimed || !stop.load(Ordering::SeqCst))
        {
            return Err("同期・接続・停止処理が残っているため終了できません。すべてのタブの同期を停止し、停止完了後にもう一度ウィンドウを閉じてください。".into());
        }
        if self.closing.swap(true, Ordering::SeqCst) {
            return Err("終了処理中です。しばらくお待ちください。".into());
        }
        // Archive work keeps its slot until worker exit, but close cancels it
        // immediately rather than waiting for the later stop_all thread.
        for op in self
            .operations
            .lock()
            .map_err(|_| "Operation lock failed")?
            .values()
        {
            if op.archive {
                op.stop.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
    fn claim_start(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        let _gate = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application is closing".into());
        }
        let mut starts = self.starts.lock().map_err(|_| "Start lock failed")?;
        let (token, claimed) = starts.get_mut(id).ok_or("Start not prepared")?;
        if *claimed {
            return Err("Start already running".into());
        }
        *claimed = true;
        Ok(token.clone())
    }
    fn start_validation_epoch(&self) -> Result<u64, String> {
        let epoch = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application is closing".into());
        }
        if *epoch == u64::MAX {
            return Err(
                "Mutation counter exhausted; restart application before starting sync".into(),
            );
        }
        Ok(*epoch)
    }
    fn lock_start_registration(
        &self,
        validated_epoch: u64,
    ) -> Result<std::sync::MutexGuard<'_, u64>, String> {
        let epoch = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        if *epoch != validated_epoch || *epoch == u64::MAX {
            return Err("A file operation changed reservations during sync setup. Refresh both roots and start sync again".into());
        }
        Ok(epoch)
    }
    pub fn prepare(&self, id: String) -> Result<(), String> {
        if id.is_empty()
            || id.len() > 64
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Invalid job id".into());
        }
        let _gate = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        if jobs.contains_key(&id) {
            return Err("Duplicate job id".into());
        }
        let mut starts = self.starts.lock().map_err(|_| "Start lock failed")?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application is closing".into());
        }
        if starts.contains_key(&id) {
            return Err("Duplicate start id".into());
        }
        if starts.len() + jobs.len() >= 16 {
            return Err("At most 16 jobs".into());
        }
        starts.insert(id.clone(), (Arc::new(AtomicBool::new(false)), false));
        self.start_failed.store(false, Ordering::SeqCst);
        if let Ok(mut failed)=self.failed_starts.lock(){failed.remove::<str>(id.as_ref());}
        Ok(())
    }
    pub fn prepared_start_token(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        if id.is_empty()
            || id.len() > 64
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Invalid job id".into());
        }
        let _gate = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        let mut starts = self.starts.lock().map_err(|_| "Start lock failed")?;
        if self.closing.load(Ordering::SeqCst) || jobs.contains_key(id) {
            return Err("Application closing or job already registered".into());
        }
        if let Some((token, claimed)) = starts.get(id) {
            if *claimed {
                return Err("Start already running".into());
            }
            return Ok(token.clone());
        }
        if starts.len() + jobs.len() >= 16 {
            return Err("At most 16 jobs".into());
        }
        let token = Arc::new(AtomicBool::new(false));
        starts.insert(id.into(), (token.clone(), false));
        self.start_failed.store(false, Ordering::SeqCst);
        if let Ok(mut failed)=self.failed_starts.lock(){failed.remove::<str>(id.as_ref());}
        Ok(token)
    }
    pub fn record_start_failure(&self,id:&str) {
        if let Ok(starts)=self.starts.lock() {
            if starts.get(id).is_some_and(|(stop,_)| !stop.load(Ordering::SeqCst)) {self.start_failed.store(true,Ordering::SeqCst);if let Ok(mut failed)=self.failed_starts.lock(){failed.insert(id.into());}}
        }
    }
    pub fn taskbar_state(&self)->Result<crate::taskbar_status::TaskbarState,String> {
        use crate::taskbar_status::{aggregate,NativeSyncState as N};
        let jobs=self.jobs.lock().map_err(|_|"Job lock failed")?;
        let starts=self.starts.lock().map_err(|_|"Start lock failed")?;
        let mut states=Vec::new();
        if self.start_failed.load(Ordering::SeqCst){states.push(N::Error);}
        for job in jobs.values(){
            let s=job.status.lock().map_err(|_|"Status lock failed")?;
            states.push(match s.status.as_str(){"stopping"=>N::Stopping,"stopped"=>N::Stopped,"failed"=>N::Error,_=>if job.handle.as_ref().is_some_and(|h|h.is_finished()){N::Error}else{s.activity.phase()}});
        }
        Ok(aggregate(states,starts.values().any(|(stop,_)|!stop.load(Ordering::SeqCst))))
    }
    pub fn discard_prepared_start(&self, id: &str) {
        if let Ok(_gate) = self.mutation_gate.lock() {
            if let Ok(mut starts) = self.starts.lock() {
                if starts.get(id).is_some_and(|(_, claimed)| !*claimed) {
                    starts.remove(id);
                }
            }
        }
    }
    pub fn start(
        &self,
        id: String,
        p: Profile,
        local: String,
        remote: String,
        passphrase: zeroize::Zeroizing<String>,
        options: SyncOptions,
    ) -> Result<(), String> {
        {
            let starts = self.starts.lock().map_err(|_| "Start lock failed")?;
            if !starts.contains_key(&id) {
                drop(starts);
                self.prepare(id.clone())?;
            }
        }
        let stop = self.claim_start(&id)?;
        let result = self.start_inner(id.clone(), p, local, remote, passphrase, stop, options);
        if result.is_err() { self.record_start_failure(&id); }
        self.starts
            .lock()
            .map_err(|_| "Start lock failed")?
            .remove(&id);
        result
    }
    fn start_inner(
        &self,
        id: String,
        p: Profile,
        local: String,
        remote: String,
        passphrase: zeroize::Zeroizing<String>,
        stop: Arc<AtomicBool>,
        options: SyncOptions,
    ) -> Result<(), String> {
        if id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Invalid job id".into());
        }
        // Snapshot before ANY path/network validation. No gate is held while
        // resolving paths or connecting; registration checks the same epoch.
        let validated_epoch = self.start_validation_epoch()?;
        let rules = crate::exclusion::Rules::compile(&options.exclusion_rules)?;
        let root = std::fs::canonicalize(local).map_err(|_| "Local folder not found")?;
        if !root.is_dir() {
            return Err("Local root is not a folder".into());
        }
        self.check_local_operations(&root)?;
        let root_identity = local_root_identity(&root)?;
        let remote = sftp::normalize(&remote)?;
        use std::net::ToSocketAddrs;
        let endpoints: Vec<_> = (p.host.as_str(), p.port)
            .to_socket_addrs()
            .map_err(|_| "Cannot resolve server endpoint")?
            .collect();
        let (mut connection, identity) = sftp::connect(&p, &passphrase, &stop)?;
        let remote = sftp::normalize(&connection.root(&remote, &stop)?)?;
        let _gate = self.lock_start_registration(validated_epoch)?;
        let mut jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        if self.closing.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst) {
            return Err("Start cancelled or application closing".into());
        }
        if jobs.len() >= 16 {
            return Err("At most 16 tabs; close a stopped tab first".into());
        }
        if jobs.contains_key(&id) {
            return Err("Duplicate job id".into());
        }
        for op in self
            .operations
            .lock()
            .map_err(|_| "Operation lock failed")?
            .values()
        {
            if op.local.iter().any(|path| {
                crate::file_ops::local_contains(path, &root)
                    || crate::file_ops::local_contains(&root, path)
            }) || ((op.identity == identity
                || op.endpoints.iter().any(|e| endpoints.contains(e)))
                && op.remote.iter().any(|path| sftp::overlap(path, &remote)))
            {
                return Err("An overlapping file operation is in progress; wait for it before starting sync".into());
            }
        }
        for j in jobs.values() {
            if (j.identity == identity || j.endpoints.iter().any(|e| endpoints.contains(e)))
                && sftp::overlap(&j.remote, &remote)
                && j.status.lock().map_err(|_| "Status lock failed")?.status != "stopped"
            {
                return Err(
                    "Overlapping remote destination is already reserved (including failed jobs)"
                        .into(),
                );
            }
        }
        let state = Arc::new(Mutex::new(Status::new()));
        let retry = Arc::new(AtomicBool::new(false));
        let st = state.clone();
        let cancel = stop.clone();
        let again = retry.clone();
        let job_remote = remote.clone();
        let job_id = id.clone();
        let expected_identity = identity.clone();
        let job_local = root.clone();
        let handle = thread::spawn(move || {
            worker(
                p,
                root,
                job_remote,
                job_id,
                connection,
                st,
                cancel,
                again,
                passphrase,
                expected_identity,
                rules,
                options,
                root_identity,
            );
        });
        jobs.insert(
            id,
            Job {
                local: job_local,
                identity,
                endpoints,
                remote,
                status: state,
                stop,
                retry,
                handle: Some(handle),
            },
        );
        Ok(())
    }
    pub fn status(&self, id: &str) -> Result<Status, String> {
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        let job = jobs.get(id).ok_or("Job not found")?;
        let mut value = job.status.lock().map_err(|_| "Status lock failed")?.clone();
        value.stop_complete = value.failure.is_some() && job.handle.as_ref().is_some_and(|h| h.is_finished());
        Ok(value)
    }
    pub fn retry(&self, id: &str) -> Result<(), String> {
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        jobs.get(id).ok_or("Job not found")?;
        Err("This failure requires stopping and starting a new sync for a full rescan".into())
    }
    pub fn stop(&self, id: &str) -> Result<(), String> {
        self.stop_with_summary(id).map(|_| ())
    }
    pub fn stop_with_summary(&self, id: &str) -> Result<StopSummary, String> {
        let mut jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        if !jobs.contains_key(id) {
            let starts = self.starts.lock().map_err(|_| "Start lock failed")?;
            let (stop, _) = starts.get(id).ok_or("Job not found")?;
            stop.store(true, Ordering::SeqCst);
            return Ok(StopSummary::default());
        }
        let j = jobs.get_mut(id).ok_or("Job not found")?;
        if j.handle.is_none() {
            return Err("Sync is already stopping; wait until it finishes".into());
        }
        j.stop.store(true, Ordering::Relaxed);
        j.status.lock().map_err(|_| "Status lock failed")?.status = "stopping".into();
        let handle = j.handle.take();
        let final_status = j.status.clone();
        drop(jobs);
        let result = handle
            .map(|h| h.join())
            .transpose()
            .map_err(|_| "Sync worker panicked".to_string());
        self.jobs.lock().map_err(|_| "Job lock failed")?.remove(id);
        if result.is_err() { self.start_failed.store(true,Ordering::SeqCst); }
        result?;
        let summary = final_status.lock().map_err(|_| "Status lock failed")?.stop_summary.clone();
        Ok(summary)
    }
    pub fn stop_all(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.operations.lock().unwrap().retain(|_, op| {
            op.stop.store(true, Ordering::SeqCst);
            // An acknowledged preparation may never dispatch a worker. Only
            // claimed operations have worker cleanup to await.
            op.claimed
        });
        for (stop, _) in self.starts.lock().unwrap().values() {
            stop.store(true, Ordering::SeqCst);
        }
        let ids: Vec<_> = self.jobs.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
        loop {
            // Release each lock before inspecting the next collection; final
            // start registration takes jobs then operations under the gate.
            let operations_pending = !self.operations.lock().unwrap().is_empty();
            let starts_pending = self
                .starts
                .lock()
                .unwrap()
                .values()
                .any(|(_, claimed)| *claimed);
            let jobs_pending = !self.jobs.lock().unwrap().is_empty();
            if !operations_pending && !starts_pending && !jobs_pending {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn prepare_operation(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        self.operation_token(id, false, false, false)
    }
    pub fn claim_operation(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        self.operation_token(id, true, false, false)
    }
    pub fn claim_prepared_upload(&self,id:&str)->Result<Arc<AtomicBool>,String>{
        self.operation_token(id,true,true,true)
    }    pub fn claim_archive_operation(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        self.operation_token(id, true, true, false)
    }
    fn operation_token(
        &self,
        id: &str,
        claim: bool,
        archive: bool,
        prepared: bool,
    ) -> Result<Arc<AtomicBool>, String> {
        if id.is_empty()
            || id.len() > 64
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("Invalid operation id".into());
        }
        let _gate = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        let mut ops = self
            .operations
            .lock()
            .map_err(|_| "Operation lock failed")?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application closing".into());
        }
        if archive && ops.values().filter(|op| op.archive).count() >= 2 {
            return Err("At most two archive workers (including queued/stopping workers)".into());
        }
        if let Some(op) = ops.get_mut(id) {
            if !claim || op.claimed {
                return Err("Duplicate operation id or operation already claimed".into());
            }
            op.claimed = true;
            op.archive = archive;
            return Ok(op.stop.clone());
        }
        if prepared {return Err("Upload operation must be prepared first".into());}
        if ops.values().filter(|op|!op.persistent).count() >= 8 {
            return Err(
                "Application closing, duplicate operation, or at most eight concurrent operations"
                    .into(),
            );
        }
        let stop = Arc::new(AtomicBool::new(false));
        ops.insert(
            id.into(),
            Operation {
                editor: false,
                editor_local: vec![],
                document: None,
                persistent: false,
                progress: Arc::new(crate::operation_progress::Progress::default()),
                stop: stop.clone(),
                claimed: claim,
                archive,
                local: vec![],
                remote: vec![],
                identity: String::new(),
                endpoints: vec![],
            },
        );
        Ok(stop)
    }
    pub fn finish_operation(&self, id: &str) {
        if let Ok(mut epoch) = self.mutation_gate.lock() {
            if let Ok(mut ops) = self.operations.lock() {
                if let Some(op) = ops.remove(id) {
                    if !op.local.is_empty() || !op.remote.is_empty() {
                        *epoch = epoch.saturating_add(1);
                    }
                }
            }
        }
    }
    pub fn retain_editor_reservation(&self,id:&str,token:&str)->Result<EditorReservation,String>{
        let _gate=self.mutation_gate.lock().map_err(|_|"Reservation lock failed")?;
        let mut ops=self.operations.lock().map_err(|_|"Operation lock failed")?;
        let key=format!("editor-{token}");if ops.contains_key(&key){return Err("Duplicate editor reservation".into());}
        let op=ops.get_mut(id).ok_or("Editor operation no longer reserved")?;crate::file_ops::check(&op.stop)?;op.document=Some(token.into());let mut held=op.clone();held.stop=Arc::new(AtomicBool::new(false));held.archive=false;held.persistent=true;ops.insert(key.clone(),held);
        Ok(EditorReservation{key,operations:self.operations.clone(),gate:self.mutation_gate.clone()})
    }
    pub fn mark_editor_operation(&self,id:&str)->Result<(),String>{let _gate=self.mutation_gate.lock().map_err(|_|"Reservation lock failed")?;let mut ops=self.operations.lock().map_err(|_|"Operation lock failed")?;ops.get_mut(id).ok_or("Editor operation no longer reserved")?.editor=true;Ok(())}
    pub fn bind_editor_operation(&self,id:&str,token:&str)->Result<(),String>{
        let _gate=self.mutation_gate.lock().map_err(|_|"Reservation lock failed")?;let mut ops=self.operations.lock().map_err(|_|"Operation lock failed")?;
        if !ops.get(&format!("editor-{token}")).is_some_and(|op|op.persistent&&op.document.as_deref()==Some(token)){return Err("Editor reservation is closed".into());}
        let op=ops.get_mut(id).ok_or("Editor operation no longer reserved")?;op.document=Some(token.into());op.editor=true;Ok(())
    }
    pub fn operation_progress(&self,id:&str)->Option<Arc<crate::operation_progress::Progress>>{
        self.operations.lock().ok()?.get(id).map(|op|op.progress.clone())
    }
    pub fn discard_prepared_operation(&self, id: &str) {
        if let Ok(_gate) = self.mutation_gate.lock() {
            if let Ok(mut ops) = self.operations.lock() {
                if ops.get(id).is_some_and(|op| !op.claimed) {
                    ops.remove(id);
                }
            }
        }
    }
    pub fn cancel_operation(&self, id: &str) -> Result<(), String> {
        let ops = self
            .operations
            .lock()
            .map_err(|_| "Operation lock failed")?;
        let op = ops.get(id).ok_or(
            "Operation is not prepared or has already finished; cancellation was not registered",
        )?;
        op.stop.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn operation_claimed(&self,id:&str)->Result<bool,String>{Ok(self.operations.lock().map_err(|_|"Operation lock failed")?.get(id).is_some_and(|op|op.claimed))}
    pub fn reserve_operation(
        &self,
        id: &str,
        local: Vec<PathBuf>,
        remote: Vec<String>,
        identity: String,
        endpoints: Vec<std::net::SocketAddr>,
        destructive_local: bool,
    ) -> Result<(), String> {
        self.reserve_operation_inner(
            id,
            local,
            remote,
            identity,
            endpoints,
            destructive_local,
            None,
            false,
        )
    }
    pub fn reserve_upload_operation(&self,id:&str,local:Vec<PathBuf>,remote:Vec<String>,identity:String,endpoints:Vec<std::net::SocketAddr>)->Result<(),String>{
        self.reserve_operation_inner(id,local,remote,identity,endpoints,false,None,true)
    }    pub fn reserve_archive_operation(
        &self,
        id: &str,
        source: PathBuf,
        target: PathBuf,
        parent: PathBuf,
    ) -> Result<(), String> {
        self.reserve_operation_inner(
            id,
            vec![source, target, parent.clone()],
            vec![],
            String::new(),
            vec![],
            false,
            Some(parent),
            false,
        )
    }
    pub fn reserve_archive_sources(&self,id:&str,mut sources:Vec<PathBuf>,target:PathBuf,parent:PathBuf)->Result<(),String>{
        sources.push(target);sources.push(parent.clone());
        self.reserve_operation_inner(id,sources,vec![],String::new(),vec![],false,Some(parent),false)
    }
    fn check_local_operations(&self, root: &Path) -> Result<(), String> {
        let ops = self
            .operations
            .lock()
            .map_err(|_| "Operation lock failed")?;
        if ops.values().any(|op| {
            op.local.iter().any(|p| {
                crate::file_ops::local_contains(p, root) || crate::file_ops::local_contains(root, p)
            })
        }) {
            return Err("An overlapping local operation is in progress".into());
        }
        Ok(())
    }
    fn reserve_operation_inner(
        &self,
        id: &str,
        local: Vec<PathBuf>,
        remote: Vec<String>,
        identity: String,
        endpoints: Vec<std::net::SocketAddr>,
        destructive_local: bool,
        archive_parent: Option<PathBuf>,
        upload: bool,
    ) -> Result<(), String> {
        let mut epoch = self
            .mutation_gate
            .lock()
            .map_err(|_| "Reservation lock failed")?;
        let jobs = self.jobs.lock().map_err(|_| "Job lock failed")?;
        let mut ops = self
            .operations
            .lock()
            .map_err(|_| "Operation lock failed")?;
        let op = ops.get(id).ok_or("Operation no longer reserved")?;
        let mut editor_local=local.clone();if let Some(parent)=&archive_parent{if editor_local.last()!=Some(parent){return Err("Invalid archive staging reservation".into());}editor_local.pop();}
        crate::file_ops::check(&op.stop)?;
        if self.closing.load(Ordering::SeqCst) {
            return Err("Application closing".into());
        }
        for job in jobs.values() {
            if job.status.lock().map_err(|_| "Status lock failed")?.status == "stopped" {
                continue;
            }
            if let Some(parent) = &archive_parent {
                if crate::file_ops::local_contains(parent, &job.local)
                    || crate::file_ops::local_contains(&job.local, parent)
                {
                    return Err("Archive staging overlaps a sync root; stop sync before creating archives here".into());
                }
            }
            if upload && local.iter().any(|source| crate::file_ops::local_contains(source,&job.local) || crate::file_ops::local_contains(&job.local,source)) {
                return Err("Stop overlapping local sync before uploading its sources".into());
            }
            if destructive_local
                && local
                    .first()
                    .is_some_and(|source| crate::file_ops::local_contains(source, &job.local))
            {
                return Err(
                    "Stop sync before moving or deleting its local root or ancestor".into(),
                );
            }
            if (identity == job.identity || endpoints.iter().any(|e| job.endpoints.contains(e)))
                && remote.iter().any(|path| sftp::overlap(path, &job.remote))
            {
                return Err("Stop the overlapping sync job before changing this remote path (including failed/stopping jobs)".into());
            }
        }
        for (other_id, other) in ops.iter() {
            if other_id == id || (op.document.is_some() && op.document==other.document) {
                continue;
            }
            let local_paths=if other.editor{&editor_local}else{&local};let other_paths=if op.editor{&other.editor_local}else{&other.local};
            if local_paths.iter().any(|a| {
                other_paths.iter().any(|b| {
                    crate::file_ops::local_contains(a, b) || crate::file_ops::local_contains(b, a)
                })
            }) || ((identity == other.identity
                || endpoints.iter().any(|e| other.endpoints.contains(e)))
                && remote
                    .iter()
                    .any(|a| other.remote.iter().any(|b| sftp::overlap(a, b))))
            {
                return Err("An overlapping file operation is in progress".into());
            }
        }
        let op = ops.get_mut(id).unwrap();
        *epoch = epoch
            .checked_add(1)
            .ok_or("Mutation counter exhausted; restart application before changing files")?;
        op.local = local;
        op.editor_local=editor_local;
        op.claimed = true;
        op.remote = remote;
        op.identity = identity;
        op.endpoints = endpoints;
        Ok(())
    }
}

#[cfg(test)]
mod window_taskbar_tests {
    use super::*;
    use crate::taskbar_status::TaskbarState as T;
    #[test]fn pending_and_failed_starts_are_scoped_to_their_window_job_ids(){let e=Engine::default();e.prepare("one".into()).unwrap();assert_eq!(e.taskbar_state_for(&["one".into()]).unwrap(),T::Working);assert_eq!(e.taskbar_state_for(&["other".into()]).unwrap(),T::Idle);e.record_start_failure("one");e.discard_prepared_start("one");assert_eq!(e.taskbar_state_for(&["one".into()]).unwrap(),T::Error);assert_eq!(e.taskbar_state_for(&["other".into()]).unwrap(),T::Idle);}
}
fn worker(
    p: Profile,
    root: PathBuf,
    remote: String,
    id: String,
    mut initial: sftp::Connection,
    state: Arc<Mutex<Status>>,
    stop: Arc<AtomicBool>,
    _retry: Arc<AtomicBool>,
    passphrase: zeroize::Zeroizing<String>,
    expected_identity: String,
    rules: crate::exclusion::Rules,
    options: SyncOptions,
    root_identity: (u64, u64),
) {
    let decisions=state.lock().unwrap().decisions.clone();
    initial.diagnostics=Some(decisions.clone());
    let fatal = |error: String| {
        let mut s = state.lock().unwrap();
        if s.failure.is_none() { s.status = if stop.load(Ordering::Relaxed) { "stopping" } else { "failed" }.into(); }
        s.speed = 0;
        s.failure(&error, stop.load(Ordering::Relaxed));
        let pending=s.pending;
        s.record_stopped_queue(pending);
    };
    let (tx, rx) = std::sync::mpsc::sync_channel(10000);
    let overflow = Arc::new(AtomicBool::new(false));
    let of = overflow.clone();
    let event_epoch=Arc::new(AtomicU64::new(0));
    let callback_epoch=event_epoch.clone();
    let callback_state=state.clone();
    let callback_stop=stop.clone();
    let watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if matches!(&event,Ok(e) if matches!(e.kind,notify::EventKind::Access(_))) {
                return;
            }
            let mut status=callback_state.lock().unwrap();
            if status.failure.is_some() { return; }
            callback_epoch.fetch_add(1,Ordering::SeqCst);
            status.activity.mark_working();
            if event.as_ref().is_err() || matches!(&event,Ok(e) if e.need_rescan()) {
                status.failure_context("Watcher error: stop and restart for a full rescan",None,"watch","unknown",0,false);
                callback_stop.store(true,Ordering::SeqCst);
                return;
            }
            #[cfg(test)] if let Ok(event)=&event{for path in &event.paths{new_file_wait_tests::mark(path,"watch");sync_notice_test_hooks::observed(path);}}
            if tx.try_send((Instant::now(), event)).is_err() {
                status.failure_context("Watcher overflow: stop and restart for a full rescan",None,"watch","unknown",0,false);
                callback_stop.store(true,Ordering::SeqCst);
                of.store(true, Ordering::Relaxed);
            }
        });
    let mut watcher = match watcher {
        Ok(w) => w,
        Err(_) => {
            fatal("File watcher initialization failed; stop and restart".into());
            return;
        }
    };
    let watch_mode = if options.recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    if watcher.watch(&root, watch_mode).is_err() {
        fatal("Cannot monitor local folder; stop and restart".into());
        return;
    }
    #[cfg(test)] startup_measure::mark("local_begin");
    let mut queue = HashMap::new();
    let mut directories: HashMap<PathBuf, Option<DeletionBasis<sftp::RemoteDirectoryStamp>>> = HashMap::new();
    if let Err(error) = crate::initial_scan::walk(&root,&stop,&rules,options.recursive,options.delete_removed, |path,is_directory| {
        if is_directory { directories.entry(path.clone()).or_insert(None); }
        enqueue_at(&mut queue,path,Instant::now())
    }) {
        let mut status=state.lock().unwrap();
        status.failure_context(&error.reason,error.relative_path.as_deref(),"scan","not_committed",queue.len(),stop.load(Ordering::Relaxed));
        status.record_stopped_queue(queue.len());
        return;
    }
    #[cfg(test)] startup_measure::mark("local_done");
    state.lock().unwrap().activity.scan_finished();
    state.lock().unwrap().log("Initial local scan completed");
    state.lock().unwrap().pending=queue.len();
    if initial.upload_cap<4{state.lock().unwrap().log(&format!("Server upload concurrency cap: {}; applies before writes",initial.upload_cap));}
    let mut connection = Some(initial);
    let mut parallel=engine_parallel::Parallel::default();
    let mut inventory: HashMap<PathBuf, DeletionBasis<sftp::RemoteStamp>> = HashMap::new();
    let mut listing_hints: HashMap<PathBuf,ListingHint> = HashMap::new();
    let mut absent_candidates:HashMap<PathBuf,crate::listing_absence::ListedAbsence>=HashMap::new();
    let mut listing_session=1u64;
    let mut file_authority_bytes = 0usize;
    let mut retained_directories = sftp::RetainedDirectories::default();
    let mut directory_authority_bytes=0usize;
    if let Err(error) = crate::file_ops::check(&stop).and_then(|()| {
        if local_root_identity(&root)? != root_identity { return Err("Local root changed during initial scan; deletion refused".into()); }
        if options.delete_removed {
            #[cfg(test)] startup_measure::mark("mirror_begin");
            let snapshot = sftp::mirror_snapshot(connection.as_mut().unwrap(), &remote, &rules, options.recursive, &stop)?;
            #[cfg(test)] startup_measure::mark("mirror_done");
            // Authority is published only after both scans have completed and the
            // original readable root still exists. Every removal rechecks absence.
            if local_root_identity(&root)? != root_identity { return Err("Local root changed during mirror inventory; deletion refused".into()); }
            for entry in std::fs::read_dir(&root).map_err(|_| "Local root unreadable after mirror inventory")? { entry.map_err(|_| "Local root entry unreadable after mirror inventory")?; }
            // Only the initial, locally eligible queue can acquire absence hints.
            // Complete-listing coverage proves absence; missing map entries alone
            // do not. These tokens contain no stamp or deletion authority.
            let mut candidate_bytes=0usize;
            for path in queue.keys().filter(|p|!directories.contains_key(*p)) {
                if !rules.excludes(path,false)? {
                    if let Some(candidate)=snapshot.coverage.candidate(path,listing_session){
                        if crate::listing_absence::reserve_candidate(&mut candidate_bytes,path.as_os_str().len()){decisions.record(path,DecisionReason::MissingRemote,DecisionMetadata::default());absent_candidates.insert(path.clone(),candidate);}
                    }
                }
            }
            for (path, stamp) in snapshot.files {
                listing_hints.insert(path.clone(),ListingHint::from_listing(stamp.size,Some(stamp.mtime),listing_session));
                remember_file(&mut inventory,path.clone(),stamp.clone(),&mut file_authority_bytes)?;
                inventory.insert(path.clone(),DeletionBasis::listed_after_complete_inventory(stamp,listing_session));
                enqueue_at(&mut queue,path,Instant::now())?;
            }
            retained_directories = snapshot.retained;
            for (path,stamp) in snapshot.directories {
                if directories.len() >= 10000 && !directories.contains_key(&path) { return Err("Directory tracking limit reached; deletion refused".into()); }
                remember_directory(&mut directories,path.clone(),stamp.clone(),&mut directory_authority_bytes)?;
                directories.insert(path.clone(),Some(DeletionBasis::listed_after_complete_inventory(stamp,listing_session)));
                // No-op classification only: complete traversal guards already
                // succeeded. Real RMDIR/MKDIR still use fresh mutation guards.
                // This queue still contains initial-scan entries only. Watcher
                // events remain in rx until the loop below and are not consumed.
                if directory_action(&root,&path,&root_identity,&stop)?==LocalAction::Skip {
                    crate::file_ops::check(&stop)?;
                    queue.remove(&path);
                    state.lock().unwrap().log(&format!("Listed existing directory {}",path.display()));
                }else{enqueue_at(&mut queue,path,Instant::now())?;}
            }
            state.lock().unwrap().log("Mirror inventory verified; only in-scope source-absent files and empty directories may be deleted");
        } else {
            // Consume this read-only pass BEFORE any upload. Nothing is retained
            // as a guard/cache across mutations, reconnects, or watcher events.
            let paths:Vec<_>=queue.keys().cloned().collect();
            if let Some(snapshot)=sftp::comparison_snapshot(connection.as_mut().unwrap(),&remote,&paths,listing_session,&stop)?{
                if local_root_identity(&root)?!=root_identity{return Err("Local root changed during comparison inventory".into());}
                let mut skipped=0usize;
                for (path,hint) in snapshot.hints{
                    crate::file_ops::check(&stop)?;
                    if local_transfer_action(&root,&path,&root_identity,false,&stop)?!=LocalAction::Upload{continue;}
                    match sftp::listing_candidate(&root,&path,&hint,listing_session,&stop)?{
                        Candidate::ListedUnchanged=>{decisions.record(&path,DecisionReason::Unchanged,DecisionMetadata::default());queue.remove(&path);skipped+=1;state.lock().unwrap().log(&format!("Skipped unchanged {} (complete directory listing)",path.display()));},
                        Candidate::SourceChanged=>if let Some(item)=queue.get_mut(&path){decisions.record(&path,DecisionReason::SourceChanged,DecisionMetadata::default());item.force_upload=true;item.last=Instant::now();},
                        Candidate::FreshComparison=>(),
                    }
                }
                for path in snapshot.missing{if let Some(item)=queue.get_mut(&path){decisions.record(&path,DecisionReason::MissingRemote,DecisionMetadata::default());item.force_upload=true;}}
                if local_root_identity(&root)?!=root_identity{return Err("Local root changed during comparison inventory".into());}
                let mut status=state.lock().unwrap();status.pending=queue.len();
                status.log(&format!("Read-only comparison listed {} directories; skipped {} unchanged files",snapshot.directories,skipped));
            }else{
                decisions.record(Path::new(""),DecisionReason::ListingUnavailable,DecisionMetadata::default());
                state.lock().unwrap().log("Comparison listing unavailable, ambiguous or over limit; using fresh per-file comparison");
            }
        }
        Ok(())
    }) {
        let mut s=state.lock().unwrap();
        s.failure_context(&error,None,"inventory","not_committed",queue.len(),stop.load(Ordering::Relaxed));
        s.record_stopped_queue(queue.len());
        return;
    }
    state.lock().unwrap().log("Comparison uses size and whole-second UTC mtime; equal metadata does not prove equal content");
    let mut delete_enabled = options.delete_removed;
    let mut blocked = false;
    let mut rescan_required = false;
    let mut last_transfer = Instant::now();
    let mut parallel_unconsumed_events=false;
    'worker: while !stop.load(Ordering::Relaxed) {
        let mut completed_work=false;
        if state.lock().unwrap().failure.is_some() { break; }
        if overflow.swap(false, Ordering::Relaxed) {
            fatal("Watcher overflow: stop and restart for a full rescan".into());
            rescan_required = true;
            blocked = true;
        }
        let observed_epoch=event_epoch.load(Ordering::SeqCst);
        let mut events_drained=false;
        for _ in 0..2000 {
            let (detected,event)=match rx.try_recv(){
                Ok(value)=>value,
                Err(std::sync::mpsc::TryRecvError::Empty)=>{events_drained=true;break;},
                Err(std::sync::mpsc::TryRecvError::Disconnected)=>{fatal("Watcher error: stop and restart for a full rescan".into());blocked=true;rescan_required=true;break;}
            };
            match event {
                Err(_) => {
                    fatal("Watcher error: stop and restart for a full rescan".into());
                    rescan_required = true;
                    blocked = true;
                }
                Ok(e) => {
                    if e.need_rescan() {
                        fatal("Watcher requested rescan: stop and restart".into());
                        rescan_required = true;
                        blocked = true;
                    }
                    if matches!(e.kind, notify::EventKind::Access(_)) {
                        continue;
                    }
                    for path in e.paths {
                        if let Ok(relative)=path.strip_prefix(&root) {
                            // Reading a directory can report Modify(Any) on
                            // Windows. Remote absence is unaffected by local
                            // directory metadata; fresh local guards still run.
                            let structural=matches!(e.kind,notify::EventKind::Create(_)|notify::EventKind::Remove(_)|notify::EventKind::Modify(notify::event::ModifyKind::Name(_)));
                            crate::listing_absence::invalidate_path(&mut absent_candidates,relative,directories.contains_key(relative),structural);
                        }
                        let result = match std::fs::symlink_metadata(&path) {
                            Ok(meta) if reparse(&meta) => Ok(()),
                            Ok(meta) if meta.is_dir() => {
                                if matches!(
                                    e.kind,
                                    notify::EventKind::Create(_)
                                        | notify::EventKind::Modify(
                                            notify::event::ModifyKind::Name(_)
                                        )
                                ) {
                                    queue_candidate(
                                        &path, &root, true, &mut queue, &stop, &rules, detected, options.recursive,
                                    ).and_then(|()| if delete_enabled && options.recursive { queue_directories(&path,&root,&mut queue,&mut directories,&stop,&rules,detected) } else { Ok(()) })
                                } else {
                                    Ok(())
                                }
                            },
                            Ok(meta) if meta.is_file() => {
                                queue_candidate(
                                    &path, &root, false, &mut queue, &stop, &rules, detected, options.recursive,
                                ).map(|()|{if let Ok(relative)=path.strip_prefix(&root){if let Some(item)=queue.get_mut(relative){let time=meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|t|u32::try_from(t.as_secs()).ok());decisions.record(relative,DecisionReason::Watcher,DecisionMetadata::new(meta.len(),time,None,None));item.force_upload=true;}}})
                            },
                            Ok(_) => Ok(()),
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                if delete_enabled {
                                    queue_removed(&path, &root, &inventory, &mut queue, &rules, options.recursive, detected).and_then(|()| {
                                        let relative=path.strip_prefix(&root).map_err(|_| "Watcher path outside root")?;
                                        for known in directories.keys() {
                                            if known.starts_with(relative) && !rules.excludes(known,true)? { enqueue_at(&mut queue,known.clone(),detected)?; }
                                        }
                                        Ok(())
                                    })
                                } else { Ok(()) }
                            },
                            Err(_) => Err("Local watcher path inaccessible; stop and restart for a full rescan".into()),
                        };
                        if let Err(error) = result {
                            fatal(error);
                            rescan_required = true;
                            blocked = true;
                        }
                    }
                }
            }
        }
        if state.lock().unwrap().failure.is_some() { break; }
        {
            let mut s = state.lock().unwrap();
            s.pending = queue.len();
            let drained=events_drained && event_epoch.load(Ordering::SeqCst)==observed_epoch;
            s.deletion_rescan_required=delete_enabled && (inventory.values().any(DeletionBasis::is_suspended)
                || directories.values().flatten().any(DeletionBasis::is_suspended));
            let deletion_rescan_required=s.deletion_rescan_required;
            s.activity.set_deletion_rescan_required(deletion_rescan_required);
            let unsafe_state=blocked || rescan_required || (options.delete_removed&&!delete_enabled) || (queue.is_empty()&&directories.values().any(Option::is_none));
            s.activity.settle(queue.len(),drained,false,stop.load(Ordering::SeqCst),unsafe_state);
            if last_transfer.elapsed() > Duration::from_secs(2) {
                s.speed = 0;
            }
        }
        if blocked {
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        let mut ready = queue
            .iter()
            .filter(|(path, v)| {
                v.last.elapsed() >= Duration::from_millis(500)
                    && (!directories.contains_key(*path)
                        || root.join(path).is_dir()
                        || !queue
                            .keys()
                            .any(|child| child != *path && child.starts_with(path)))
            })
            .min_by_key(|(path, _)| {
                let depth = path.components().count();
                if directories.contains_key(*path) && root.join(path).is_dir() {
                    (1, depth)
                } else if directories.contains_key(*path) {
                    (2, 64usize.saturating_sub(depth))
                } else {
                    (0, depth)
                }
            })
            .map(|(k, _)| k.clone());
        // Only this source's missing ancestors precede it; each guarded mkdir
        // records its own receipt rather than upload creating untracked parents.
        if delete_enabled {
            if let Some(candidate)=ready.clone().filter(|path|root.join(path).exists()) {
                let mut parents:Vec<_>=candidate.parent().into_iter().flat_map(Path::ancestors)
                    .filter(|path|!path.as_os_str().is_empty()).map(Path::to_path_buf).collect();
                parents.reverse();
                for parent in &parents {
                    if !directories.contains_key(parent){
                        if directories.len()>=10000 {fatal("Directory tracking limit reached; deletion refused".into());break;}
                        directories.insert(parent.clone(),None);
                        if let Err(error)=enqueue_at(&mut queue,parent.clone(),Instant::now()){fatal(error);break;}
                    }
                    // An unknown initial parent can already be tracked without
                    // a queue entry. Register once; never reset debounce in a loop.
                    if directories.get(parent).is_some_and(Option::is_none)&&!queue.contains_key(parent){
                        if let Err(error)=enqueue_at(&mut queue,parent.clone(),Instant::now()){fatal(error);break;}
                    }
                }
                if state.lock().unwrap().failure.is_some(){break;}
                if let Some(parent)=parents.into_iter().find(|parent|directories.get(parent).is_some_and(Option::is_none)) {
                    ready=queue.get(&parent).filter(|item|item.last.elapsed()>=Duration::from_millis(500)).map(|_|parent);
                }
            }
        }
        let absent_candidate=ready.as_ref().filter(|p|!directories.contains_key(*p)
            && queue.get(*p).is_some_and(|v|!v.force_upload)
            && connection.as_ref().is_some_and(|c|!c.needs_recycle()))
            .and_then(|p|absent_candidates.remove(p)).filter(|c|c.matches(listing_session));
        // Hints classify once and never publish a deletion permit. The separate
        // complete-inventory baseline is checked freshly at the actual mutation.
        if let Some(path)=ready.as_ref().filter(|p|!directories.contains_key(*p)
            &&queue.get(*p).is_some_and(|v|!v.force_upload&&!v.batch_checked)
            &&connection.as_ref().is_some_and(|c|!c.needs_recycle())) {
            if let Some(hint)=listing_hints.remove(path) {
                let result=local_transfer_action(&root,path,&root_identity,delete_enabled&&inventory.contains_key(path),&stop)
                    .and_then(|action|if action==LocalAction::Upload {sftp::listing_candidate(&root,path,&hint,listing_session,&stop)}else{Ok(Candidate::FreshComparison)});
                match result {
                    Ok(Candidate::ListedUnchanged)=>{
                        decisions.record(path,DecisionReason::Unchanged,DecisionMetadata::default());
                        if stop.load(Ordering::SeqCst){break;}
                        queue.remove(path);
                        state.lock().unwrap().log(&format!("Skipped listed unchanged {}; deletion uses the complete-listing baseline",path.display()));
                        continue;
                    },
                    Ok(Candidate::FreshComparison)=>(),
                    Ok(Candidate::SourceChanged)=>{
                        decisions.record(path,DecisionReason::SourceChanged,DecisionMetadata::default());
                        if let Some(item)=queue.get_mut(path){item.force_upload=true;item.last=Instant::now();}
                        state.lock().unwrap().log(&format!("Local source changed; waiting to resend {}",path.display()));
                        continue;
                    },
                    Err(error)=>{state.lock().unwrap().failure_context(&error,Some(path),"compare","not_committed",queue.len(),stop.load(Ordering::Relaxed));break;}
                }
            }
        }
        // Unrelated directory adoption must not block the first file transfer.
        // Once directory work is selected, confirm existing peers read-only in
        // bounded batches. Missing targets still use serial creation below.
        if ready.as_ref().is_some_and(|p|directories.contains_key(p)&&root.join(p).is_dir()
            &&queue.get(p).is_some_and(|v|!v.batch_checked))
            &&connection.as_ref().is_some_and(|c|!c.needs_recycle()) {
            let candidates:Vec<_>=queue.iter().filter(|(p,v)|directories.get(*p).is_some_and(Option::is_some)
                &&!v.batch_checked&&v.last.elapsed()>=Duration::from_millis(500)&&root.join(p).is_dir())
                .map(|(p,_)|p.clone()).take(4).collect();
            if candidates.len()>1 {
                let verify=|path:&Path|{
                    if directory_action(&root,path,&root_identity,&stop)?!=LocalAction::Skip{return Err("Local directory disappeared during verification".into());}Ok(())
                };
                let result=sftp::authorize_existing_directories(connection.as_mut().unwrap(),&remote,&candidates,&stop,&verify);
                match result {
                    Err((path,error))=>{state.lock().unwrap().failure_context(&error,path.as_deref(),"directory","not_committed",queue.len(),stop.load(Ordering::Relaxed));break;},
                    Ok(results)=>{
                        if stop.load(Ordering::SeqCst){break;}
                        let mut failed=false;
                        for (path,stamp) in candidates.into_iter().zip(results){
                            if let Some(_stamp)=stamp {
                                // Confirmation cannot change the fixed basis.
                                queue.remove(&path);
                            }else if let Some(item)=queue.get_mut(&path){item.batch_checked=true;}
                        }
                        if failed{break;}
                        state.lock().unwrap().pending=queue.len();
                        continue;
                    }
                }
            }
        }
        // Compare at most four independent files on the existing authenticated
        // session. Publish no authority/skip result until the entire batch has
        // succeeded. Upload/delete paths retain their fresh mutation guards.
        if absent_candidate.is_none() && ready.as_ref().is_some_and(|p|!directories.contains_key(p)&&queue.get(p).is_some_and(|v|!v.force_upload&&!v.batch_checked))
            && connection.as_ref().is_some_and(|c|!c.needs_recycle()) {
            let mut candidates:Vec<_>=queue.iter().filter(|(p,v)|!directories.contains_key(*p)
                && !absent_candidates.contains_key(*p) && !v.force_upload && !v.batch_checked && v.last.elapsed()>=Duration::from_millis(500)
                && !rules.excludes(p,false).unwrap_or(true) && (options.recursive||p.components().count()==1))
                .map(|(p,_)|p.clone()).take(4).collect();
            candidates.sort_by_key(|p|(p.components().count(),p.clone()));
            let mut files=Vec::new();let mut invalid=None;
            let mut hinted=Vec::new();
            for path in candidates {
                match local_transfer_action(&root,&path,&root_identity,delete_enabled&&inventory.contains_key(&path),&stop){
                    Ok(LocalAction::Upload)=>{
                        if let Some(hint)=listing_hints.get(&path).copied() {
                            match sftp::observe_listing_candidate(&root,&path,&hint,listing_session,&stop) {
                                Ok(observation)=>match observation.candidate() {
                                    Candidate::ListedUnchanged=>hinted.push((path,observation,false)),
                                    Candidate::SourceChanged=>hinted.push((path,observation,true)),
                                    Candidate::FreshComparison=>files.push(path),
                                },
                                Err(error)=>{invalid=Some((Some(path),error));break;}
                            }
                        }else{files.push(path);}
                    },Ok(_)=>(),Err(e)=>{invalid=Some((Some(path),e));break;}
                }
            }
            // Only actual fresh-comparison candidates consume their hints here.
            for path in &files {listing_hints.remove(path);}
            let batch=if let Some(error)=invalid {Err(error)} else if files.len()>1 {
                sftp::compare_files(connection.as_mut().unwrap(),&root,&files,&remote,&stop)
            } else {Ok(Vec::new())};
            match batch {
                Err((path,error))=>{
                    state.lock().unwrap().failure_context(&error,path.as_deref(),"compare","not_committed",queue.len(),stop.load(Ordering::Relaxed));break;
                },
                Ok(results)=>{
                    if stop.load(Ordering::SeqCst){break;}
                    // Hint decisions cannot survive a slow peer without local
                    // revalidation. Initial dirtiness is sticky even when the
                    // later size/whole-second mtime happens to match again.
                    let mut listing_decisions=Vec::new();let mut hint_error=None;
                    for (path,mut observation,was_dirty) in hinted {
                        match observation.revalidate(&stop) {
                            Ok(candidate)=>listing_decisions.push((path,was_dirty||candidate!=Candidate::ListedUnchanged)),
                            Err(error)=>{hint_error=Some((path,error));break;}
                        }
                    }
                    if let Some((path,error))=hint_error {
                        state.lock().unwrap().failure_context(&error,Some(&path),"compare","not_committed",queue.len(),stop.load(Ordering::Relaxed));break;
                    }
                    let mut consumed=false;let mut failed=false;
                    {
                        let mut status=state.lock().unwrap();
                        for (path,dirty) in listing_decisions {
                            if stop.load(Ordering::SeqCst)||status.failure.is_some(){break 'worker;}
                            listing_hints.remove(&path);
                            if dirty {
                                decisions.record(&path,DecisionReason::SourceChanged,DecisionMetadata::default());
                                if let Some(item)=queue.get_mut(&path){item.force_upload=true;item.last=Instant::now();}
                                status.log(&format!("Local source changed; waiting to resend {}",path.display()));
                            }else{
                                decisions.record(&path,DecisionReason::Unchanged,DecisionMetadata::default());
                                queue.remove(&path);
                                status.log(&format!("Skipped listed unchanged {}; deletion uses the complete-listing baseline",path.display()));
                            }
                            // A peer skip does not invalidate the selected work.
                            consumed|=ready.as_ref()==Some(&path);
                        }
                        status.pending=queue.len();
                    }
                    for (path,result) in files.into_iter().zip(results){
                        match result {
                            sftp::FileComparison::Unchanged(_stamp)=>{
                                // Read-only matches never rebase deletion state.
                                queue.remove(&path);consumed=true;
                                state.lock().unwrap().log(&format!("Skipped unchanged {}",path.display()));
                            },
                            sftp::FileComparison::SourceChanged=>{
                                if let Some(item)=queue.get_mut(&path){item.last=Instant::now();item.force_upload=true;}
                                state.lock().unwrap().log(&format!("Local source changed; waiting to resend {}",path.display()));
                                consumed=true;
                            },
                            sftp::FileComparison::Upload{remote_newer}=>{
                                // A positive comparison is only a scheduling decision,
                                // never deletion authority or a mutation permit. Repeating
                                // the same metadata walk serially defeats the read batch.
                                // upload() still checks the current local source, every
                                // remote ancestor, target type and staging/commit guards.
                                if let Some(item)=queue.get_mut(&path){item.batch_checked=true;item.force_upload=true;}
                                if remote_newer {state.lock().unwrap().log(&format!("Remote newer; source-authoritative overwrite {}",path.display()));}
                            }
                        }
                    }
                    if failed {break;}
                    if consumed {state.lock().unwrap().pending=queue.len();continue;}
                }
            }
        }
        // Recheck only bounded, previously-uploaded content after local notices.
        // No initial tree hashing, no cross-connection cache, no write authority.
        // Parallel dispatch excludes cached candidates until this check consumes them.
        if let (Some(selected),Some(c))=(ready.as_ref(),connection.as_mut()) {
            if queue.get(selected).is_some_and(|item|item.force_upload)
                &&c.has_upload_fingerprint(&root,selected,&remote)&&!c.needs_recycle() {
                let mut candidates=vec![selected.clone()];
                for (path,item) in &queue {
                    if candidates.len()>=4{break;}
                    if path!=selected&&path.parent()==selected.parent()&&item.force_upload
                        &&item.last.elapsed()>=Duration::from_millis(500)
                        &&!directories.contains_key(path)&&c.has_upload_fingerprint(&root,path,&remote){candidates.push(path.clone());}
                }
                for path in candidates {
                    if rules.excludes(&path,false).unwrap_or(true)||(!options.recursive&&path.components().count()!=1){c.forget_upload_fingerprint(&root,&path,&remote);continue;}
                    let before=event_epoch.load(Ordering::SeqCst);
                    let result=local_transfer_action(&root,&path,&root_identity,delete_enabled&&inventory.contains_key(&path),&stop)
                        .and_then(|action|if action==LocalAction::Upload{sftp::unchanged_uploaded_content(c,&root,&path,&remote,&stop)}else{Ok(false)});
                    match result {
                        Ok(true) if events_drained&&before==observed_epoch&&before==event_epoch.load(Ordering::SeqCst)&&!stop.load(Ordering::SeqCst)=>{
                            queue.remove(&path);
                            let mut status=state.lock().unwrap();status.pending=queue.len();
                            status.log("Skipped unchanged content after local notice");
                            decisions.record(&path,DecisionReason::ContentUnchanged,DecisionMetadata::default());
                        },
                        Ok(_)=>c.forget_upload_fingerprint(&root,&path,&remote),
                        Err(error)=>{state.lock().unwrap().failure_context(&error,Some(&path),"compare","not_committed",queue.len(),stop.load(Ordering::SeqCst));break 'worker;}
                    }
                }
                if !queue.contains_key(selected){continue;}
            }
        }
        if let Some(path)=ready.as_ref(){
            if let Some(c)=connection.as_mut(){
                if let Some(committed)=engine_parallel::run(&mut parallel,path,absent_candidate.as_ref().is_some_and(|a|a.matches(listing_session)),&mut queue,c,&root,root_identity,&remote,&id,&stop,&state,&rules,&options,delete_enabled,&directories,&mut inventory,&mut file_authority_bytes,&mut listing_hints,&mut absent_candidates,listing_session){
                    if committed{last_transfer=Instant::now();}
                    if stop.load(Ordering::SeqCst)||state.lock().unwrap().failure.is_some(){parallel_unconsumed_events=event_epoch.load(Ordering::SeqCst)!=observed_epoch;break;}
                    thread::yield_now();continue;
                }
            }
        }
        if let Some(path) = ready {
            #[cfg(test)] new_file_wait_tests::mark(&root.join(&path),"selected");
            // Serial comparisons and forced uploads supersede the original hint
            // too; a later directory event must never resurrect that observation.
            listing_hints.remove(&path);
            state.lock().unwrap().activity.mark_working();
            let mut item = queue.remove(&path).unwrap();
            let is_directory = directories.contains_key(&path);
            if rules.excludes(&path, is_directory).unwrap_or(true)
                || (!options.recursive && path.components().count() != 1)
            {
                continue;
            }
            let local_action = if is_directory {
                directory_action(&root, &path, &root_identity, &stop)
            } else {
                local_transfer_action(
                    &root,
                    &path,
                    &root_identity,
                    delete_enabled && inventory.contains_key(&path),
                    &stop,
                )
            };
            match local_action {
                Ok(LocalAction::Skip) if !is_directory => continue,
                Ok(_) => (),
                Err(error) => {
                    state.lock().unwrap().failure_context(&error,Some(&path),"validate","not_committed",queue.len()+1,stop.load(Ordering::Relaxed));
                    queue.insert(path, item);
                    break;
                }
            }
            let start = Instant::now();
            if connection.as_ref().is_some_and(|c| c.needs_recycle()) {
                parallel.reset();
                absent_candidates.clear();
                listing_hints.clear();
                listing_session=listing_session.saturating_add(1);
                for basis in inventory.values_mut(){basis.suspend();}
                file_authority_bytes=inventory.keys().map(|path|path.as_os_str().len()*2).sum();
                suspend_directories(&mut directories);
                directory_authority_bytes=0;
                connection = None;
                state
                    .lock()
                    .unwrap()
                    .log("Opening a new verified SFTP session");
            }
            if connection.is_none() {
                suspend_directories(&mut directories);
                directory_authority_bytes=0;
                match sftp::connect(&p, &passphrase, &stop) {
                    Ok((mut s, identity)) => {
                        if identity != expected_identity {
                            state.lock().unwrap().failure_context("Server identity changed; stop and verify before starting again",Some(&path),"connect","not_committed",queue.len()+1,false);
                            queue.insert(path, item);
                            break;
                        }
                        s.diagnostics=Some(decisions.clone());
                        connection = Some(s)
                    }
                    Err(e) => {
                        state.lock().unwrap().failure_context(&e,Some(&path),"connect","not_committed",queue.len()+1,stop.load(Ordering::Relaxed));
                        queue.insert(path, item);
                        break;
                    }
                }
            }
            // Revalidate after reconnect: a pending deletion may have become an
            // upload while the connection was unavailable.
            let mut operation = if is_directory {"directory"} else {"compare"};
            let mut source_changed = false;
            let transfer: Result<(u64,Option<sftp::RemoteStamp>,LocalAction,bool),String> = (|| {
                if is_directory {
                    let action = directory_action(&root, &path, &root_identity, &stop)?;
                    let connection = connection.as_mut().unwrap();
                    if action == LocalAction::Delete {
                        if inventory.iter().any(|(child,basis)|child.starts_with(&path)&&basis.is_suspended())
                            ||directories.iter().any(|(child,basis)|child!=&path&&child.starts_with(&path)&&basis.as_ref().is_none_or(DeletionBasis::is_suspended)) {
                            return Err("Descendant deletion basis suspended after reconnect or incomplete verification; stop and restart".into());
                        }
                        if retained_directories.contains(&path) {
                            if let Some(Some(stamp))=directories.remove(&path) {directory_authority_bytes=directory_authority_bytes.saturating_sub(stamp.authority_bytes());}
                            state.lock().unwrap().log(&format!("Retained remote directory with excluded or unsupported entries {}",path.display()));
                            return Ok((0,None,LocalAction::Skip,false));
                        }
                        let _local_parents = deletion_parent_guard(&root, &path)?;
                        let stamp=directories.get(&path).and_then(Option::as_ref).ok_or("Directory deletion authority unavailable after reconnect or incomplete verification; restore local directory or stop and restart")?.expected(listing_session)?;
                        let removed = sftp::delete_owned_directory(
                            connection,
                            &remote,
                            &path,
                            stamp,
                            &stop,
                            &|| {
                                if directory_action(&root, &path, &root_identity, &stop)?
                                    != LocalAction::Delete
                                {
                                    return Err("Local directory recreated before remote removal; deletion refused".into());
                                }
                                Ok(())
                            },
                        )?;
                        if !removed {
                            retained_directories.retain(&path)?;
                            state.lock().unwrap().log(&format!("Retained nonempty remote directory {}",path.display()));
                        }
                        if let Some(Some(stamp))=directories.remove(&path) {directory_authority_bytes=directory_authority_bytes.saturating_sub(stamp.authority_bytes());}
                        return Ok((0, None, if removed {LocalAction::Delete} else {LocalAction::Skip}, removed));
                    }
                    let (stamp, created) =
                        sftp::authorize_directory_observed(connection, &remote, &path, &stop, &|| {
                            if directory_action(&root, &path, &root_identity, &stop)?
                                != LocalAction::Skip
                            {
                                return Err(
                                    "Local directory disappeared during verification".into()
                                );
                            }
                            Ok(())
                        })?;
                    if created {
                        remember_directory(&mut directories,path.clone(),stamp,&mut directory_authority_bytes)?;
                    } else if let Some(basis)=directories.get_mut(&path) {
                        if basis.is_none(){*basis=Some(DeletionBasis::Suspended);}
                    }
                    return Ok((0, None, LocalAction::Skip, created));
                }
                let action = local_transfer_action(
                    &root,
                    &path,
                    &root_identity,
                    delete_enabled && inventory.contains_key(&path),
                    &stop,
                )?;
                let connection = connection.as_mut().unwrap();
                if action == LocalAction::Upload && !item.force_upload && !absent_candidate.as_ref().is_some_and(|c|c.matches(listing_session)) {
                    match sftp::compare_file(connection,&root,&path,&remote,&stop)? {
                        sftp::FileComparison::SourceChanged => { source_changed=true; return Ok((0,None,LocalAction::Skip,false)); },
                        sftp::FileComparison::Unchanged(_stamp) => return Ok((0,None,LocalAction::Skip,false)),
                        sftp::FileComparison::Upload { remote_newer: true } => state.lock().unwrap().log(&format!("Remote newer; source-authoritative overwrite {}",path.display())),
                        sftp::FileComparison::Upload { remote_newer: false } => (),
                    }
                }
                match action {
                    LocalAction::Upload if delete_enabled => {
                        operation = "upload";
                        match sftp::upload_recorded(connection, &root, &path, &remote, &stop, &id)? {
                            sftp::SourceOutcome::Complete((bytes,stamp)) => Ok((bytes,Some(stamp),LocalAction::Upload,true)),
                            sftp::SourceOutcome::Changed { committed } => { source_changed=true;
                                Ok(match committed { Some((bytes,stamp)) => (bytes,Some(stamp),LocalAction::Upload,true), None => (0,None,LocalAction::Skip,false) })
                            },
                        }
                    }
                    LocalAction::Upload => {
                        operation = "upload";
                        match sftp::upload(connection, &root, &path, &remote, &stop, &id)? {
                            sftp::SourceOutcome::Complete(receipt) => Ok((receipt.bytes,None,LocalAction::Upload,true)),
                            sftp::SourceOutcome::Changed { .. } => { source_changed=true; Ok((0,None,LocalAction::Skip,false)) },
                        }
                    }
                    LocalAction::Delete => {
                        operation = "delete";
                        let stamp = inventory
                            .get(&path)
                            .ok_or("File was not uploaded by this sync job")?.expected(listing_session)?;
                        let _local_parents = deletion_parent_guard(&root,&path)?;
                        sftp::delete_uploaded_file(connection, &remote, &path, stamp, &stop, &|| {
                            if local_transfer_action(&root,&path,&root_identity,true,&stop)? != LocalAction::Delete { return Err("Local file recreated before remote removal; deletion refused".into()); }
                            Ok(())
                        })?;
                        Ok((0, None, LocalAction::Delete, true))
                    }
                    LocalAction::Skip => Ok((0, None, LocalAction::Skip, false)),
                }
            })();
            match transfer {
                Ok((bytes, stamp, action, changed)) => {
                    if source_changed && action == LocalAction::Skip {
                        decisions.record(&path,DecisionReason::SourceChanged,DecisionMetadata::default());
                        let mut status=state.lock().unwrap();
                        if stop.load(Ordering::SeqCst) || status.failure.is_some() { break; }
                        item.last=Instant::now(); item.force_upload=true; queue.insert(path.clone(),item);
                        status.pending=queue.len(); status.speed=0;
                        status.log(&format!("Local source changed; waiting to resend {}",path.display()));
                        continue;
                    }
                    if let Some(stamp) = stamp {
                        if let Err(error) = remember_file(&mut inventory,path.clone(),stamp,&mut file_authority_bytes) {
                            delete_enabled=false; inventory.clear(); directories.clear();
                            let mut status=state.lock().unwrap();
                            status.failure_context(&error,Some(&path),"record",if changed {"committed"} else {"not_committed"},queue.len()+1,false);
                            if changed {
                                status.committed_remote_change(&remote,&path);
                                if action==LocalAction::Upload {status.sent+=1;}
                            }
                            queue.insert(path.clone(),item.clone());
                            break;
                        }
                    }
                    if action == LocalAction::Skip {
                        if is_directory {
                            let mut status = state.lock().unwrap();
                            if changed { status.committed_remote_change(&remote, &path); }
                            status.pending = queue.len();
                            let message=if changed {format!("Created remote directory {}",path.display())}
                                else {format!("Verified local/remote directory {}",path.display())};
                            status.log(&message);
                        } else { state.lock().unwrap().log(&format!("Skipped unchanged {}",path.display())); }
                        continue;
                    }
                    completed_work=true;
                    last_transfer = Instant::now();
                    let mut s = state.lock().unwrap();
                    if is_directory && action == LocalAction::Delete {
                        s.committed_remote_directory_removal(&remote, &path);
                    } else {
                        s.committed_remote_change(&remote, &path);
                    }
                    if action == LocalAction::Delete {
                        if let Some(stamp)=inventory.remove(&path) { file_authority_bytes=file_authority_bytes.saturating_sub(stamp.authority_bytes()+path.as_os_str().len()*2); }
                        s.log(&format!(
                            "{} {}",
                            if is_directory {
                                "Deleted verified empty directory"
                            } else {
                                "Deleted verified file"
                            },
                            path.display()
                        ));
                    } else {
                        s.sent += 1;
                        s.log(&format!("Uploaded {}", path.display()));
                    }
                    s.latency = item.first.elapsed().as_millis() as u64;
                    s.speed = if s.failure.is_some() {0} else {(bytes as f64 / start.elapsed().as_secs_f64().max(0.001)) as u64};
                    s.pending = queue.len();
                    if source_changed && !stop.load(Ordering::SeqCst) && s.failure.is_none() {
                        decisions.record(&path,DecisionReason::SourceChanged,DecisionMetadata::default());
                        item.last=Instant::now(); item.force_upload=true; queue.insert(path.clone(),item);
                        s.pending=queue.len(); s.speed=0;
                        s.log(&format!("Local source changed; waiting to resend {}",path.display()));
                    }
                }
                Err(e) => {
                    suspend_directories(&mut directories);
                    directory_authority_bytes=0;
                    connection = None;
                    let commit_state = if e.starts_with("Upload committed; ") { "committed" }
                        else if operation == "directory" || operation == "delete" || e.contains("final rename") || e.contains("may have completed") || e.contains("outcome is uncertain") { "unknown" }
                        else { "not_committed" };
                    let mut s = state.lock().unwrap();
                    s.failure_context(&e,Some(&path),operation,commit_state,queue.len()+1,stop.load(Ordering::Relaxed));
                    if commit_state=="committed" {
                        s.committed_remote_change(&remote,&path);
                        if operation=="upload" {s.sent+=1;}
                    }
                    queue.insert(path,item);
                    break;
                }
            }
        }
        if stop.load(Ordering::SeqCst)||state.lock().unwrap().failure.is_some(){break;}
        if ready_after_completed_work(completed_work,&queue,event_epoch.load(Ordering::SeqCst)!=observed_epoch) {
            // Re-enter event/stop/debounce/parent checks, without throttling
            // already eligible work or watcher events received during transfer.
            // The next iteration still applies the full per-path debounce.
            thread::yield_now();
        }else{thread::sleep(Duration::from_millis(100));}
    }
    let mut s = state.lock().unwrap();
    if s.failure.is_none() {
        s.status = "stopped".into();
        s.activity.stopped();
    }
    s.speed = 0;
    s.record_stopped_queue(queue.len());
    s.stop_summary.known_unreflected|=parallel_unconsumed_events;
    if s.failure.is_some() { s.log("Sync stopped after error; manual restart performs a full scan. Staging or already committed changes may remain."); }
    else { s.log("Stopped; pending changes discarded. Restart performs a full scan."); }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_error_is_latched_with_context_and_survives_log_eviction() {
        let mut s=Status::new();
        s.failure_context("Local source changed during upload; staging was not committed",Some(Path::new("nested/file.txt")),"upload","not_committed",3,false);
        assert_eq!(s.status,"failed");
        assert_eq!(s.speed,0);
        for _ in 0..110 {s.log("ordinary progress");}
        let failure=s.failure.as_ref().unwrap();
        assert_eq!(failure.relative_path.as_deref(),Some("nested/file.txt"));
        assert_eq!(failure.operation,"upload");
        assert_eq!(failure.commit_state,"not_committed");
        assert!(failure.requires_rescan);
        s.record_stopped_queue(3);
        assert_eq!(s.pending,3);
        assert!(s.stop_summary.known_unreflected);
        assert_eq!(Status::new().status,"running");
    }
    #[test]
    fn structured_failure_never_exposes_an_absolute_target() {
        let mut s=Status::new();
        s.failure_context("Local source unavailable",Some(Path::new("C:\\private\\name")),"upload","not_committed",1,false);
        assert!(s.failure.unwrap().relative_path.is_none());
    }
    #[test]
    fn committed_journal_exhaustion_stops_job_and_keeps_commit_state() {
        let mut s=Status::new();s.remote_changes.revision=MAX_REMOTE_REVISION;
        s.committed_remote_change("/synthetic",Path::new("file"));
        assert_eq!(s.status,"failed");
        assert_eq!(s.failure.unwrap().commit_state,"committed");
    }
    #[cfg(windows)]
    #[test]
    fn complete_scan_refuses_unreadable_source_entries_before_mirror_authority() {
        use std::os::windows::fs::OpenOptionsExt;
        let root=std::env::temp_dir().join(format!("nearly-unreadable-scan-{}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path=root.join("locked.txt");std::fs::write(&path,b"generated").unwrap();
        let held=std::fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        let mut queue=HashMap::new();
        let result=scan(&root,&root,&mut queue,&AtomicBool::new(false),&crate::exclusion::Rules::compile("").unwrap(),true);
        let excluded=scan(&root,&root,&mut HashMap::new(),&AtomicBool::new(false),&crate::exclusion::Rules::compile("locked.txt").unwrap(),true);
        drop(held);std::fs::remove_file(&path).unwrap();std::fs::remove_dir(&root).unwrap();
        assert!(result.is_err(),"An unreadable source entry cannot count as a completed scan before mirror deletion");
        assert!(excluded.is_ok(),"Excluded unreadable files are outside the mirror scope");
    }
    #[test]
    fn scan_depth_is_bounded_even_for_empty_directories_after_filtering() {
        let fixture = std::env::temp_dir().join(format!(
            "sf-depth-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&fixture).unwrap();
        // canonicalize supplies the extended-length Windows prefix when needed.
        let root = std::fs::canonicalize(&fixture).unwrap();
        let mut deepest = root.clone();
        for _ in 0..65 {
            deepest.push("d");
            std::fs::create_dir(&deepest).unwrap();
        }
        let stop = AtomicBool::new(false);
        let rules = crate::exclusion::Rules::compile("").unwrap();
        let mut queue = HashMap::new();
        let error = scan(&root, &root, &mut queue, &stop, &rules, true).unwrap_err();
        assert!(error.contains("depth") && error.contains("64"));
        assert!(
            queue.is_empty(),
            "Empty directories must not evade the bound through the file-queue limit"
        );
        let excluded = crate::exclusion::Rules::compile(&format!(
            "/{}/",
            std::iter::repeat_n("d", 65).collect::<Vec<_>>().join("/")
        ))
        .unwrap();
        scan(&root, &root, &mut queue, &stop, &excluded, true).unwrap();
        scan(&root, &root, &mut queue, &stop, &rules, false).unwrap();
        std::fs::remove_dir(&deepest).unwrap();
        scan(&root, &root, &mut queue, &stop, &rules, true).unwrap();
        std::fs::remove_dir_all(fixture).unwrap();
    }
    #[test]
    fn session_can_link_to_exact_acknowledged_start_token_without_resetting_cancel() {
        let engine = Engine::default();
        engine.prepare("session-start".into()).unwrap();
        let token = engine.prepared_start_token("session-start").unwrap();
        engine.stop("session-start").unwrap();
        let same = engine.prepared_start_token("session-start").unwrap();
        assert!(Arc::ptr_eq(&token, &same));
        assert!(same.load(Ordering::SeqCst));
        let claimed = engine.claim_start("session-start").unwrap();
        assert!(Arc::ptr_eq(&same, &claimed));
        engine.discard_prepared_start("session-start");
        assert!(
            engine.starts.lock().unwrap().contains_key("session-start"),
            "Cannot discard another claimed worker"
        );
        engine.starts.lock().unwrap().remove("session-start");
        engine.prepared_start_token("direct-session-call").unwrap();
        engine.discard_prepared_start("direct-session-call");
        assert!(engine.starts.lock().unwrap().is_empty());
    }
    #[test]
    fn sync_option_defaults_keep_deletion_opt_in_and_recursive_uploads() {
        let options = SyncOptions::default();
        assert!(!options.delete_removed);
        assert!(options.recursive);
        assert!(options.exclusion_rules.is_empty());
    }
    #[test]
    fn directory_removal_queues_only_owned_allowed_files_and_coalesces_recreation() {
        let root = Path::new("C:\\generated\\sync-root");
        let rules = crate::exclusion::Rules::compile("excluded/\n*.tmp\n").unwrap();
        let mut known = HashMap::new();
        for path in [
            "top.txt",
            "folder/first.txt",
            "folder/deep/second.txt",
            "folder/cache.tmp",
            "excluded/secret.txt",
        ] {
            known.insert(PathBuf::from(path), ());
        }
        let now = Instant::now();
        let mut queue = HashMap::new();
        queue_removed(
            &root.join("folder"),
            root,
            &known,
            &mut queue,
            &rules,
            true,
            now,
        )
        .unwrap();
        assert_eq!(queue.len(), 2);
        assert!(queue.contains_key(Path::new("folder/first.txt")));
        assert!(queue.contains_key(Path::new("folder/deep/second.txt")));
        assert!(!queue.contains_key(Path::new("folder/unowned.txt")));
        let later = now + Duration::from_millis(10);
        enqueue_at(&mut queue, PathBuf::from("folder/first.txt"), later).unwrap();
        assert_eq!(
            queue.len(),
            2,
            "Latest local state decides upload versus delete for the same queue entry"
        );
        assert_eq!(queue[Path::new("folder/first.txt")].first, now);
        assert_eq!(queue[Path::new("folder/first.txt")].last, later);
        let mut root_only = HashMap::new();
        queue_removed(root, root, &known, &mut root_only, &rules, false, now).unwrap();
        assert_eq!(root_only.len(), 1);
        assert!(root_only.contains_key(Path::new("top.txt")));
    }
    #[test]
    fn uploaded_inventory_is_bounded_without_forgetting_existing_paths() {
        let mut known = HashMap::new();
        for i in 0..10000 {
            remember_upload(&mut known, PathBuf::from(format!("owned-{i}")), 1).unwrap();
        }
        assert!(remember_upload(&mut known, PathBuf::from("new-overflow"), 1).is_err());
        assert_eq!(known.len(), 10000);
        remember_upload(&mut known, PathBuf::from("owned-0"), 2).unwrap();
        assert_eq!(known[Path::new("owned-0")], 2);
    }
    #[test]
    fn invalid_exclusion_rules_fail_before_filesystem_or_connection_validation() {
        let engine = Engine::default();
        let profile = Profile {
            id: "generated".into(),
            name: "generated".into(),
            host: "invalid.invalid".into(),
            port: 22,
            user: "generated".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: String::new(),
            host_key: String::new(),
        };
        let result = engine.start(
            "invalid-rules".into(),
            profile,
            "does-not-exist".into(),
            "/generated".into(),
            zeroize::Zeroizing::new(String::new()),
            SyncOptions {
                exclusion_rules: "[broken".into(),
                ..SyncOptions::default()
            },
        );
        assert!(result.unwrap_err().contains("exclusion rule"));
        assert!(engine.jobs.lock().unwrap().is_empty());
        assert!(engine.starts.lock().unwrap().is_empty());
    }
    #[test]
    fn deletion_requires_original_accessible_root_and_rechecks_recreated_files() {
        let fixture = std::env::temp_dir().join(format!(
            "syncfiles-deletion-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = fixture.join("root");
        std::fs::create_dir_all(root.join("nested/deep")).unwrap();
        let identity = local_root_identity(&root).unwrap();
        let stop = AtomicBool::new(false);
        let relative = Path::new("nested/deep/file.txt");
        assert_eq!(
            local_transfer_action(&root, relative, &identity, true, &stop).unwrap(),
            LocalAction::Delete
        );
        std::fs::write(root.join(relative), b"recreated").unwrap();
        assert_eq!(
            local_transfer_action(&root, relative, &identity, true, &stop).unwrap(),
            LocalAction::Upload
        );
        std::fs::remove_file(root.join(relative)).unwrap();
        std::fs::remove_dir_all(root.join("nested")).unwrap();
        assert_eq!(
            local_transfer_action(&root, relative, &identity, true, &stop).unwrap(),
            LocalAction::Delete
        );
        assert_eq!(
            local_transfer_action(&root, relative, &identity, false, &stop).unwrap(),
            LocalAction::Skip
        );
        std::fs::write(root.join("not-a-directory"), b"file").unwrap();
        assert!(
            local_transfer_action(
                &root,
                Path::new("not-a-directory/child.txt"),
                &identity,
                true,
                &stop
            )
            .is_err(),
            "An inaccessible or changed parent must not imply deletion"
        );
        assert!(
            local_transfer_action(&root, Path::new("../outside"), &identity, true, &stop).is_err()
        );
        std::fs::rename(&root, fixture.join("unplugged")).unwrap();
        assert!(local_transfer_action(&root, relative, &identity, true, &stop).is_err());
        std::fs::create_dir(&root).unwrap();
        assert!(
            local_transfer_action(&root, relative, &identity, true, &stop).is_err(),
            "A replacement directory must not impersonate the original root"
        );
        stop.store(true, Ordering::Relaxed);
        assert!(local_transfer_action(&root, relative, &identity, true, &stop).is_err());
        std::fs::remove_dir_all(fixture).unwrap();
    }
    #[test]
    fn exclusion_snapshot_filters_initial_scan_directory_events_and_file_events() {
        let fixture = std::env::temp_dir().join(format!(
            "syncfiles-exclusions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(fixture.join("blocked/deep")).unwrap();
        std::fs::create_dir_all(fixture.join("nested")).unwrap();
        for path in [
            "blocked/keep.txt",
            "blocked/deep/secret.txt",
            "nested/cache.tmp",
            "nested/visible.txt",
            "keep.tmp",
            "visible.txt",
            ".gitignore",
        ] {
            std::fs::write(fixture.join(path), b"*\n").unwrap();
        }
        let mut text = String::from("blocked/\n!blocked/keep.txt\n*.tmp\n!keep.tmp\n");
        let rules = crate::exclusion::Rules::compile(&text).unwrap();
        text.clear(); // Editing saved/dialog text cannot change this job's rules.
        let stop = AtomicBool::new(false);
        let mut initial = HashMap::new();
        scan(&fixture, &fixture, &mut initial, &stop, &rules, true).unwrap();
        let expected: std::collections::HashSet<PathBuf> = [
            "keep.tmp",
            "visible.txt",
            ".gitignore",
            "nested/visible.txt",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(
            initial
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
            expected
        );
        let mut root_only = HashMap::new();
        scan(&fixture, &fixture, &mut root_only, &stop, &rules, false).unwrap();
        assert_eq!(root_only.len(), 3);
        assert!(!root_only.contains_key(Path::new("nested/visible.txt")));
        queue_candidate(
            &fixture.join("nested/visible.txt"),
            &fixture,
            false,
            &mut root_only,
            &stop,
            &rules,
            Instant::now(),
            false,
        )
        .unwrap();
        assert_eq!(
            root_only.len(),
            3,
            "Recursive OFF also filters a directly delivered descendant watcher event"
        );
        let mut events = HashMap::new();
        for (path, is_dir) in [
            ("blocked", true),
            ("blocked/keep.txt", false),
            ("nested", true),
            ("nested/cache.tmp", false),
            ("keep.tmp", false),
            ("visible.txt", false),
            (".gitignore", false),
        ] {
            queue_candidate(
                &fixture.join(path),
                &fixture,
                is_dir,
                &mut events,
                &stop,
                &rules,
                Instant::now(),
                true,
            )
            .unwrap();
        }
        assert_eq!(
            events
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
            expected
        );
        let mut rescan = HashMap::new();
        scan(&fixture, &fixture, &mut rescan, &stop, &rules, true).unwrap();
        assert_eq!(
            rescan
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
            expected
        );
        assert!(queue_candidate(
            &fixture.parent().unwrap().join("outside"),
            &fixture,
            false,
            &mut events,
            &stop,
            &rules,
            Instant::now(),
            true
        )
        .is_err());
        std::fs::remove_dir_all(fixture).unwrap();
    }
    #[test]
    fn errors_are_counted_once_independently_of_logs_retries_and_stop() {
        let mut status = Status::new();
        assert_eq!(serde_json::to_value(&status).unwrap()["errorCount"], 0);
        for _ in 0..3 {
            status.failure("Upload failed", false);
        }
        status.log("Automatic retry limit reached. Retry or stop explicitly.");
        status.status = "running".into();
        status.log("Retry requested");
        status.failure("Transfer cancelled", true);
        status.status = "stopped".into();
        for _ in 0..110 {
            status.log("ordinary progress");
        }
        assert_eq!(status.logs.len(), 100);
        assert_eq!(serde_json::to_value(&status).unwrap()["errorCount"], 3);
        assert_eq!(Status::new().error_count, 0);
    }
    #[test]
    fn error_counter_saturates_without_wrapping() {
        let mut status = Status::new();
        status.error_count = u64::MAX;
        status.failure("Watcher failed", false);
        assert_eq!(status.error_count, u64::MAX);
    }
    #[test]
    fn coalesce_and_bound() {
        let mut q = HashMap::new();
        for _ in 0..20 {
            enqueue(&mut q, "a".into()).unwrap();
        }
        assert_eq!(q.len(), 1);
        for i in 1..10000 {
            enqueue(&mut q, format!("a{i}").into()).unwrap();
        }
        assert!(enqueue(&mut q, "overflow".into()).is_err());
        assert_eq!(q.len(), 10000);
    }
    #[test]
    fn retry_delay_does_not_panic() {
        let future = Instant::now() + Duration::from_secs(10);
        assert_eq!(future.elapsed(), Duration::ZERO);
    }
    pub(super) fn reserved_job(local: PathBuf, remote: &str) -> Job {
        Job {
            local,
            remote: remote.into(),
            identity: "host-key".into(),
            endpoints: vec!["127.0.0.1:2222".parse().unwrap()],
            status: Arc::new(Mutex::new(Status::new())),
            stop: Arc::new(AtomicBool::new(false)),
            retry: Arc::new(AtomicBool::new(false)),
            handle: None,
        }
    }
    #[test]
    fn file_reservations_protect_sync_roots_aliases_failed_and_stopping_jobs() {
        let engine = Engine::default();
        let root = PathBuf::from("C:\\generated\\root");
        engine
            .jobs
            .lock()
            .unwrap()
            .insert("job".into(), reserved_job(root.clone(), "/upload"));
        engine.prepare_operation("op").unwrap();
        assert!(engine
            .reserve_operation(
                "op",
                vec![root.parent().unwrap().to_path_buf()],
                vec![],
                String::new(),
                vec![],
                true
            )
            .is_err());
        assert!(engine
            .reserve_operation(
                "op",
                vec![root.join("child.txt")],
                vec![],
                String::new(),
                vec![],
                true
            )
            .is_ok());
        for status in ["running", "failed", "stopping"] {
            engine.jobs.lock().unwrap()["job"]
                .status
                .lock()
                .unwrap()
                .status = status.into();
            assert!(engine
                .reserve_operation(
                    "op",
                    vec![],
                    vec!["/upload/child".into()],
                    "other-profile-host-key".into(),
                    vec!["127.0.0.1:2222".parse().unwrap()],
                    false
                )
                .is_err());
            assert!(engine
                .reserve_operation(
                    "op",
                    vec![],
                    vec!["/upload".into()],
                    "host-key".into(),
                    vec![],
                    false
                )
                .is_err());
        }
        assert!(engine
            .reserve_operation(
                "op",
                vec![],
                vec!["/other".into()],
                "host-key".into(),
                vec![],
                false
            )
            .is_ok());
        engine.prepare_operation("second").unwrap();
        assert!(engine
            .reserve_operation(
                "second",
                vec![],
                vec!["/other/child".into()],
                "host-key".into(),
                vec![],
                false
            )
            .is_err());
        engine.finish_operation("op");
        assert!(engine
            .reserve_operation(
                "second",
                vec![],
                vec!["/other/child".into()],
                "host-key".into(),
                vec![],
                false
            )
            .is_ok());
    }
    #[test]
    fn operation_tokens_are_bounded_and_cancelled_before_worker_dispatch() {
        let engine = Engine::default();
        let token = engine.prepare_operation("first").unwrap();
        engine.cancel_operation("first").unwrap();
        assert!(token.load(Ordering::SeqCst));
        assert!(engine.prepare_operation("first").is_err());
        for i in 0..7 {
            engine.prepare_operation(&format!("op-{i}")).unwrap();
        }
        assert!(engine.prepare_operation("overflow").is_err());
        assert!(engine
            .reserve_operation("first", vec![], vec![], String::new(), vec![], false)
            .is_err());
        engine.finish_operation("first");
        assert!(engine.prepare_operation("replacement").is_ok());
    }
    #[test]
    fn completed_intervening_mutation_invalidates_pending_start_validation() {
        let engine = Engine::default();
        let fixture = std::env::temp_dir().join(format!(
            "syncfiles-start-race-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&fixture).unwrap();
        let source = fixture.join("validated-root");
        let moved = fixture.join("moved-root");
        std::fs::create_dir(&source).unwrap();
        let validated_epoch = engine.start_validation_epoch().unwrap();
        let validated_root = std::fs::canonicalize(&source).unwrap();
        engine.prepare_operation("completed-move").unwrap();
        engine
            .reserve_operation(
                "completed-move",
                vec![validated_root],
                vec![],
                String::new(),
                vec![],
                true,
            )
            .unwrap();
        crate::file_ops::local(
            crate::file_ops::Action::Move,
            &source,
            Some(&moved),
            &AtomicBool::new(false),
        )
        .unwrap();
        engine.finish_operation("completed-move");
        assert!(!source.exists());
        assert!(moved.is_dir());
        assert!(engine.operations.lock().unwrap().is_empty());
        assert_ne!(*engine.mutation_gate.lock().unwrap(),validated_epoch,"A completed mutation must invalidate stale start validation after its reservation disappears");
        assert!(
            engine.lock_start_registration(validated_epoch).is_err(),
            "The actual final start-registration guard must reject stale roots"
        );
        let refreshed_epoch = engine.start_validation_epoch().unwrap();
        assert!(
            engine.lock_start_registration(refreshed_epoch).is_ok(),
            "An explicit fresh start can revalidate after the completed operation"
        );
        std::fs::remove_dir_all(fixture).unwrap();
    }
    #[test]
    fn mutation_completion_after_validation_snapshot_also_invalidates_start() {
        let engine = Engine::default();
        engine.prepare_operation("already-running").unwrap();
        engine
            .reserve_operation(
                "already-running",
                vec![],
                vec!["/validated-root".into()],
                "host-key".into(),
                vec![],
                false,
            )
            .unwrap();
        let validated_epoch = engine.start_validation_epoch().unwrap();
        engine.finish_operation("already-running");
        assert!(engine.operations.lock().unwrap().is_empty());
        assert!(
            engine.lock_start_registration(validated_epoch).is_err(),
            "Completion must advance the epoch even when reservation preceded the setup snapshot"
        );
    }
    #[test]
    fn exhausted_mutation_epoch_cannot_wrap_into_valid_start() {
        let engine = Engine::default();
        *engine.mutation_gate.lock().unwrap() = u64::MAX;
        assert!(engine.start_validation_epoch().is_err());
        assert!(engine.lock_start_registration(u64::MAX).is_err());
    }
    #[test]
    fn shutdown_cancels_and_waits_for_operations_and_claimed_starts() {
        let engine = Arc::new(Engine::default());
        let token = engine.prepare_operation("shutdown-operation").unwrap();
        engine.claim_operation("shutdown-operation").unwrap();
        engine.prepare("shutdown-start".into()).unwrap();
        let start_token = {
            let mut starts = engine.starts.lock().unwrap();
            let (token, claimed) = starts.get_mut("shutdown-start").unwrap();
            *claimed = true;
            token.clone()
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let closing_engine = engine.clone();
        let closer = thread::spawn(move || {
            closing_engine.stop_all();
            tx.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while (!token.load(Ordering::SeqCst) || !start_token.load(Ordering::SeqCst))
            && Instant::now() < deadline
        {
            thread::yield_now();
        }
        assert!(token.load(Ordering::SeqCst));
        assert!(start_token.load(Ordering::SeqCst));
        assert!(
            rx.recv_timeout(Duration::from_millis(30)).is_err(),
            "Shutdown must await workers instead of only setting cancellation"
        );
        engine.finish_operation("shutdown-operation");
        engine.starts.lock().unwrap().remove("shutdown-start");
        rx.recv_timeout(Duration::from_secs(2))
            .expect("Shutdown must finish after worker cleanup without a lock inversion");
        closer.join().unwrap();
    }
    #[test]
    fn prepared_cancel_survives_claim_and_prevents_generated_source_mutation() {
        let engine = Engine::default();
        let id = "early-cancel";
        let prepared = engine.prepare_operation(id).unwrap();
        engine.cancel_operation(id).unwrap();
        let claimed = engine.claim_operation(id).unwrap();
        assert!(Arc::ptr_eq(&prepared, &claimed));
        assert!(claimed.load(Ordering::SeqCst));
        assert!(engine.claim_operation(id).is_err());
        let fixture = std::env::temp_dir().join(format!(
            "syncfiles-early-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&fixture).unwrap();
        let source = fixture.join("source");
        let target = fixture.join("target");
        std::fs::write(&source, b"must remain").unwrap();
        let request = crate::file_ops::Request {
            items:vec![],
            id: id.into(),
            side: crate::file_ops::Side::Local,
            action: crate::file_ops::Action::Move,
            source: source.to_str().unwrap().into(),
            destination: Some(target.to_str().unwrap().into()),
            profile: None,
            session_id: None,
            passphrase: zeroize::Zeroizing::new(String::new()),
            confirm_delete: false,
        };
        assert!(crate::file_ops::run(&engine, request, &claimed).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"must remain");
        assert!(!target.exists());
        engine.finish_operation(id);
        std::fs::remove_dir_all(fixture).unwrap();
    }
    #[test]
    fn shutdown_discards_unclaimed_preparations_and_rejects_late_dispatch() {
        let engine = Engine::default();
        let token = engine.prepare_operation("prepared-only").unwrap();
        engine.stop_all();
        assert!(token.load(Ordering::SeqCst));
        assert!(engine.operations.lock().unwrap().is_empty());
        assert!(engine.claim_operation("prepared-only").is_err());
        assert!(engine.prepare_operation("new-preparation").is_err());
    }
    #[test]
    fn compatibility_autoclaim_is_atomic_and_missing_cancel_is_explicit() {
        let engine = Engine::default();
        assert!(engine.cancel_operation("not-dispatched").is_err());
        let token = engine.claim_operation("direct-native-call").unwrap();
        assert!(!token.load(Ordering::SeqCst));
        assert!(engine.claim_operation("direct-native-call").is_err());
        assert!(engine.prepare_operation("direct-native-call").is_err());
        engine.cancel_operation("direct-native-call").unwrap();
        assert!(token.load(Ordering::SeqCst));
        engine.finish_operation("direct-native-call");
        assert!(engine.cancel_operation("direct-native-call").is_err());
    }
    #[test]
    fn normal_close_refuses_prepared_initial_connection_without_cancelling_it() {
        let engine = Engine::default();
        engine.prepare("connecting".into()).unwrap();
        assert!(engine.try_begin_close().is_err());
        assert!(!engine.closing.load(Ordering::SeqCst));
        assert!(!engine.starts.lock().unwrap()["connecting"]
            .0
            .load(Ordering::SeqCst));
    }
    #[test]
    fn normal_close_blocks_every_job_state_including_reconnect_and_pending_cleanup() {
        for status in ["running", "reconnecting", "failed", "stopping", "stopped"] {
            let engine = Engine::default();
            let job = reserved_job(PathBuf::from("C:\\generated"), "/upload");
            job.status.lock().unwrap().status = status.into();
            let stop = job.stop.clone();
            engine
                .jobs
                .lock()
                .unwrap()
                .insert("background-tab".into(), job);
            let message = engine.try_begin_close().unwrap_err();
            assert!(message.contains("停止完了後"));
            assert!(!engine.closing.load(Ordering::SeqCst));
            assert!(!stop.load(Ordering::SeqCst));
        }
    }
    #[test]
    fn close_waits_for_cancelled_initial_start_cleanup_but_not_unclaimed_cancel() {
        let engine = Engine::default();
        engine.prepare("initial".into()).unwrap();
        let token = engine.claim_start("initial").unwrap();
        engine.stop("initial").unwrap();
        assert!(token.load(Ordering::SeqCst));
        assert!(engine.try_begin_close().is_err());
        engine.starts.lock().unwrap().remove("initial");
        assert!(engine.try_begin_close().is_ok());
        assert!(engine.prepare("too-late".into()).is_err());
        let engine = Engine::default();
        engine.prepare("not-dispatched".into()).unwrap();
        engine.stop("not-dispatched").unwrap();
        assert!(engine.try_begin_close().is_ok());
        assert!(engine.claim_start("not-dispatched").is_err());
    }
    #[test]
    fn close_remains_blocked_until_stop_worker_join_completes() {
        let engine = Arc::new(Engine::default());
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut job = reserved_job(PathBuf::from("C:\\generated"), "/upload");
        job.handle = Some(thread::spawn(move || {
            release_rx.recv().unwrap();
        }));
        engine.jobs.lock().unwrap().insert("stopping".into(), job);
        let stop_engine = engine.clone();
        let stopper = thread::spawn(move || stop_engine.stop("stopping"));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let stopping = engine
                .jobs
                .lock()
                .unwrap()
                .get("stopping")
                .is_some_and(|job| job.handle.is_none());
            if stopping {
                break;
            }
            assert!(Instant::now() < deadline, "Stop must reach join");
            thread::yield_now();
        }
        assert!(
            engine.try_begin_close().is_err(),
            "Taking the worker handle must not remove close protection before join completes"
        );
        assert!(!engine.closing.load(Ordering::SeqCst));
        release_tx.send(()).unwrap();
        stopper.join().unwrap().unwrap();
        assert!(engine.jobs.lock().unwrap().is_empty());
        assert!(engine.try_begin_close().is_ok());
    }
    #[test]
    fn prepare_and_close_are_atomic_against_each_other() {
        for _ in 0..50 {
            let engine = Arc::new(Engine::default());
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let preparing = engine.clone();
            let ready = barrier.clone();
            let prepare = thread::spawn(move || {
                ready.wait();
                preparing.prepare("concurrent".into())
            });
            let closing = engine.clone();
            let ready = barrier.clone();
            let close = thread::spawn(move || {
                ready.wait();
                closing.try_begin_close()
            });
            barrier.wait();
            let prepared = prepare.join().unwrap().is_ok();
            let closed = close.join().unwrap().is_ok();
            assert_ne!(
                prepared, closed,
                "Either preparation reserves the connection or close commits, never both"
            );
        }
    }
    #[test]
    fn cancelled_preparation_claim_and_close_are_atomic_against_each_other() {
        for _ in 0..50 {
            let engine = Arc::new(Engine::default());
            engine.prepare("concurrent".into()).unwrap();
            engine.stop("concurrent").unwrap();
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let starting = engine.clone();
            let ready = barrier.clone();
            let claim = thread::spawn(move || {
                ready.wait();
                starting.claim_start("concurrent")
            });
            let closing = engine.clone();
            let ready = barrier.clone();
            let close = thread::spawn(move || {
                ready.wait();
                closing.try_begin_close()
            });
            barrier.wait();
            let claimed = claim.join().unwrap().is_ok();
            let closed = close.join().unwrap().is_ok();
            assert_ne!(
                claimed, closed,
                "Close must reject a claimed worker, or the late claim must reject committed close"
            );
        }
    }
    #[test]
    fn file_operations_alone_do_not_prevent_normal_close() {
        let engine = Engine::default();
        let token = engine.claim_operation("file-operation-only").unwrap();
        assert!(engine.try_begin_close().is_ok());
        assert!(!token.load(Ordering::SeqCst));
        assert!(engine.prepare("new-sync".into()).is_err());
        assert!(engine.claim_operation("new-operation").is_err());
        engine.finish_operation("file-operation-only");
        engine.stop_all();
    }
    #[test]
    fn archive_slots_preserve_early_cancel_and_remain_occupied_until_finish() {
        let engine = Engine::default();
        engine.prepare_operation("first").unwrap();
        engine.cancel_operation("first").unwrap();
        let first = engine.claim_archive_operation("first").unwrap();
        assert!(first.load(Ordering::SeqCst));
        engine.claim_archive_operation("second").unwrap();
        assert!(engine.claim_archive_operation("third").is_err());
        engine.cancel_operation("second").unwrap();
        assert!(engine.claim_archive_operation("third").is_err());
        engine.finish_operation("first");
        assert!(engine.claim_archive_operation("third").is_ok());
    }
    #[test]
    fn close_cancels_archive_without_releasing_its_worker_slot() {
        let engine = Engine::default();
        let token = engine.claim_archive_operation("archive-close").unwrap();
        engine.try_begin_close().unwrap();
        assert!(token.load(Ordering::SeqCst));
        assert_eq!(engine.operations.lock().unwrap().len(), 1);
        engine.finish_operation("archive-close");
    }
    #[test]
    fn archives_reject_active_failed_stopping_sync_staging_and_reserve_future_starts() {
        let engine = Engine::default();
        engine.claim_archive_operation("archive").unwrap();
        let root = PathBuf::from("C:\\generated\\watch");
        let job = reserved_job(root.clone(), "/remote");
        engine.jobs.lock().unwrap().insert("job".into(), job);
        for status in ["running", "failed", "stopping"] {
            engine
                .jobs
                .lock()
                .unwrap()
                .get("job")
                .unwrap()
                .status
                .lock()
                .unwrap()
                .status = status.into();
            assert!(engine
                .reserve_archive_operation(
                    "archive",
                    PathBuf::from("C:\\source"),
                    root.join("out.zip"),
                    root.clone()
                )
                .is_err());
        }
        engine
            .jobs
            .lock()
            .unwrap()
            .get("job")
            .unwrap()
            .status
            .lock()
            .unwrap()
            .status = "stopped".into();
        engine
            .reserve_archive_operation(
                "archive",
                PathBuf::from("C:\\source"),
                root.join("out.zip"),
                root.clone(),
            )
            .unwrap();
        assert!(engine.check_local_operations(&root).is_err());
        engine.finish_operation("archive");
        assert!(engine.check_local_operations(&root).is_ok());
    }
}

#[cfg(test)]
mod directory_regression {
    use super::*;
    struct Fixture {
        output: PathBuf,
        remote: PathBuf,
        profile: Profile,
        secret: String,
    }
    impl Fixture {
        fn load() -> Self {
            let value: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(
                    std::env::var("NEARLY_DIRECTORY_FIXTURE").expect("generated fixture only"),
                )
                .unwrap(),
            )
            .unwrap();
            Self {
                output: PathBuf::from(value["root"].as_str().unwrap()),
                remote: PathBuf::from(value["remote"].as_str().unwrap()),
                secret: value["passphrase"].as_str().unwrap().into(),
                profile: Profile {
                    id: "dir-fixture".into(),
                    name: "Generated localhost".into(),
                    host: "127.0.0.1".into(),
                    port: value["port"].as_u64().unwrap() as u16,
                    user: "fixture".into(),
                    auth: "key".into(),
                    mode: "sftp".into(),
                    key_file: value["key"].as_str().unwrap().into(),
                    host_key: value["fingerprint"].as_str().unwrap().into(),
                },
            }
        }
        fn roots(&self, name: &str) -> (PathBuf, PathBuf) {
            let local = self.output.join(name);
            let remote = self.remote.join(name);
            std::fs::create_dir(&local).unwrap();
            std::fs::create_dir(&remote).unwrap();
            (local, remote)
        }
        fn start(&self, name: &str, local: &Path, options: SyncOptions) -> Engine {
            let engine = Engine::default();
            engine
                .start(
                    name.into(),
                    self.profile.clone(),
                    local.to_string_lossy().into_owned(),
                    format!("/{name}"),
                    zeroize::Zeroizing::new(self.secret.clone()),
                    options,
                )
                .unwrap();
            engine
        }
    }
    fn wait(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "generated directory regression timed out"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
    fn write(root: &Path, path: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"generated owned content").unwrap();
    }
    fn settled(engine: &Engine, id: &str) {
        wait(|| engine.status(id).unwrap().pending == 0);
        thread::sleep(Duration::from_millis(800));
        let status = engine.status(id).unwrap();
        assert_eq!(status.pending, 0, "{:?}", status.logs);
        assert_eq!(status.error_count, 0, "{:?}", status.logs);
    }
    fn set_mtime(path: &Path, seconds: u64, nanos: u32) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(
            std::time::UNIX_EPOCH + Duration::new(seconds, nanos),
        )).unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/sync-difference-test.mjs"]
    fn sync_difference_generated_localhost_metadata_and_resume() {
        let f = Fixture::load();
        let (local, remote) = f.roots("difference-metadata");
        write(&local, "same.txt");
        set_mtime(&local.join("same.txt"), 1_700_000_000, 750_000_000);
        let engine = f.start("difference-metadata", &local, SyncOptions::default());
        wait(|| engine.status("difference-metadata").unwrap().sent == 1);
        settled(&engine, "difference-metadata");
        assert_eq!(std::fs::metadata(remote.join("same.txt")).unwrap().modified().unwrap()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(), 1_700_000_000,
            "Upload must preserve source mtime at SFTPv3 second precision");
        engine.stop("difference-metadata").unwrap();
        let resumed = f.start("difference-metadata", &local, SyncOptions::default());
        settled(&resumed, "difference-metadata");
        let status = resumed.status("difference-metadata").unwrap();
        assert_eq!(status.sent, 0, "Resume new job must skip unchanged metadata: {:?}", status.logs);
        assert_eq!(status.remote_changes.revision, 0);
        assert!(status.logs.iter().any(|line| line.starts_with("Skipped unchanged ")));
        set_mtime(&local.join("same.txt"), 1_700_000_001, 0);
        wait(|| resumed.status("difference-metadata").unwrap().sent == 1);
        std::fs::write(local.join("same.txt"), b"changed size").unwrap();
        wait(|| std::fs::read(remote.join("same.txt")).ok().as_deref() == Some(b"changed size"));
        write(&local, "added.txt");
        wait(|| remote.join("added.txt").is_file());
        settled(&resumed,"difference-metadata");
        let before_burst=resumed.status("difference-metadata").unwrap().sent;
        for n in 1..=20 { std::fs::write(local.join("added.txt"),vec![n as u8;n]).unwrap(); }
        wait(|| std::fs::read(remote.join("added.txt")).ok()==Some(vec![20u8;20]));
        settled(&resumed,"difference-metadata");
        assert_eq!(resumed.status("difference-metadata").unwrap().sent,before_burst+1,"Burst events must coalesce to the latest file");
        resumed.stop("difference-metadata").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/sync-difference-test.mjs"]
    fn sync_difference_generated_localhost_initial_mirror_and_skipped_delete() {
        let f = Fixture::load();
        let (local, remote) = f.roots("difference-mirror");
        write(&local, "same.txt"); write(&remote, "same.txt");
        for root in [&local, &remote] { set_mtime(&root.join("same.txt"), 1_700_000_000, 0); }
        write(&remote, "remote-only/nested/remove.txt");
        write(&remote, "kept/nested/keep.tmp");
        write(&remote, "excluded/keep.txt");
        let engine = f.start("difference-mirror", &local, SyncOptions {
            delete_removed: true, exclusion_rules: "*.tmp\nexcluded/".into(), ..SyncOptions::default()
        });
        wait(|| !remote.join("remote-only").exists());
        settled(&engine, "difference-mirror");
        assert_eq!(engine.status("difference-mirror").unwrap().sent, 0);
        assert!(remote.join("kept/nested/keep.tmp").is_file());
        assert!(remote.join("excluded/keep.txt").is_file());
        engine.stop("difference-mirror").unwrap();
        let engine=f.start("difference-mirror",&local,SyncOptions { delete_removed:true,exclusion_rules:"*.tmp\nexcluded/".into(),..SyncOptions::default() });
        settled(&engine,"difference-mirror");
        assert_eq!(engine.status("difference-mirror").unwrap().sent,0);
        assert_eq!(engine.status("difference-mirror").unwrap().remote_changes.revision,0,"Adopting unchanged directories must not dirty the browse journal");
        std::fs::remove_file(local.join("same.txt")).unwrap();
        wait(|| !remote.join("same.txt").exists());
        settled(&engine, "difference-mirror");
        engine.stop("difference-mirror").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/sync-difference-test.mjs"]
    fn sync_difference_generated_localhost_scope_and_remote_changes() {
        let f = Fixture::load();
        for (name, delete, recursive) in [("difference-off", false, true), ("difference-shallow", true, false)] {
            let (local, remote) = f.roots(name);
            write(&remote, "root-only.txt"); write(&remote, "nested/keep.txt");
            write(&local, "source.txt");
            let engine = f.start(name, &local, SyncOptions { delete_removed: delete, recursive, ..SyncOptions::default() });
            wait(|| remote.join("source.txt").is_file());
            settled(&engine, name);
            assert_eq!(remote.join("root-only.txt").exists(), !delete);
            assert!(remote.join("nested/keep.txt").is_file());
            engine.stop(name).unwrap();
        }
        let (local, remote) = f.roots("difference-newer");
        write(&local, "newer.txt"); std::fs::write(remote.join("newer.txt"), b"different remote bytes").unwrap();
        set_mtime(&local.join("newer.txt"), 1_700_000_000, 0);
        set_mtime(&remote.join("newer.txt"), 1_800_000_000, 0);
        let engine = f.start("difference-newer", &local, SyncOptions { delete_removed: true, ..SyncOptions::default() });
        wait(|| std::fs::read(remote.join("newer.txt")).ok() == std::fs::read(local.join("newer.txt")).ok());
        settled(&engine, "difference-newer");
        assert!(engine.status("difference-newer").unwrap().logs.iter().any(|line| line.starts_with("Remote newer; source-authoritative overwrite ")));
        // A changed remote file must not inherit the original deletion authority.
        std::fs::write(remote.join("newer.txt"), b"independent remote edit").unwrap();
        std::fs::remove_file(local.join("newer.txt")).unwrap();
        wait(|| engine.status("difference-newer").unwrap().error_count > 0);
        assert_eq!(std::fs::read(remote.join("newer.txt")).unwrap(), b"independent remote edit");
        engine.stop("difference-newer").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/sync-difference-test.mjs"]
    fn sync_difference_generated_localhost_inventory_and_delete_guards() {
        let f=Fixture::load();
        for name in ["difference-partial","difference-mutated","difference-root-race"] {
            let (local,remote)=f.roots(name);
            write(&remote,"orphan.txt");
            if name=="difference-partial" { for n in 0..101 { write(&remote,&format!("entry-{n}.txt")); } }
            let engine=f.start(name,&local,SyncOptions {delete_removed:true,..SyncOptions::default()});
            wait(||engine.status(name).unwrap().error_count>0);
            assert!(remote.join("orphan.txt").is_file(),"{name} must not infer deletion from uncertain source/remote state");
            if name=="difference-partial" { assert_eq!(std::fs::read_dir(&remote).unwrap().count(),102,"Partial listing cannot publish even the first batch's authority"); }
            engine.stop(name).unwrap();
        }
        let (local,remote)=f.roots("difference-unsupported");
        write(&remote,"link.txt"); write(&remote,"remove.txt");
        let engine=f.start("difference-unsupported",&local,SyncOptions {delete_removed:true,..SyncOptions::default()});
        wait(||!remote.join("remove.txt").exists());
        settled(&engine,"difference-unsupported");
        assert!(remote.join("link.txt").exists(),"Symlink metadata must never authorize deletion");
        engine.stop("difference-unsupported").unwrap();
        let (local,remote)=f.roots("difference-real-link");
        let engine=f.start("difference-real-link",&local,SyncOptions {delete_removed:true,..SyncOptions::default()});
        settled(&engine,"difference-real-link");
        assert!(std::fs::symlink_metadata(remote.join("link")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(f.remote.join("other/link-sentinel.txt")).unwrap(),b"generated out-of-selected-root sentinel");
        engine.stop("difference-real-link").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/sync-difference-test.mjs"]
    fn sync_difference_generated_localhost_timestamp_refusal_preserves_target() {
        let f=Fixture::load();
        for name in ["difference-timestamp-refused","difference-timestamp-lying"] {
            let (local,remote)=f.roots(name);write(&local,"target.txt");
            set_mtime(&local.join("target.txt"),1_700_000_000,0);
            std::fs::write(remote.join("target.txt"),b"existing remote must survive").unwrap();
            let stop=AtomicBool::new(false);
            let (mut connection,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
            let error=sftp::upload(&mut connection,&local.canonicalize().unwrap(),Path::new("target.txt"),&format!("/{name}"),&stop,"generated").unwrap_err();
            assert!(error.contains("timestamp"),"{error}");
            assert_eq!(std::fs::read(remote.join("target.txt")).unwrap(),b"existing remote must survive");
            assert!(std::fs::read_dir(&remote).unwrap().any(|e|e.unwrap().file_name().to_string_lossy().ends_with(".part")));
        }
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/sync-difference-test.mjs"]
    fn sync_difference_generated_localhost_stop_during_inventory_preserves_queue_summary() {
        let f=Fixture::load();let (local,remote)=f.roots("difference-stop-inventory");
        write(&local,"pending.txt");write(&remote,"orphan.txt");
        let engine=f.start("difference-stop-inventory",&local,SyncOptions {delete_removed:true,..SyncOptions::default()});
        wait(||f.output.join("inventory-stop-observed").exists());
        let summary=engine.stop_with_summary("difference-stop-inventory").unwrap();
        assert!(summary.known_unreflected,"Canceled inventory must retain the already-scanned transfer queue in the stop summary");
        assert!(remote.join("orphan.txt").exists());assert!(!remote.join("pending.txt").exists());
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/directory-delete-test.mjs"]
    fn directory_deletion_generated_localhost_basics() {
        let f = Fixture::load();
        let (local, remote) = f.roots("dir-basics");
        std::fs::create_dir_all(local.join("empty/nested")).unwrap();
        std::fs::create_dir_all(local.join("preexisting/sub")).unwrap();
        std::fs::create_dir_all(remote.join("preexisting/sub")).unwrap();
        std::fs::create_dir_all(remote.join("remote-only/nested")).unwrap();
        write(&local, "nonempty/deep/file.txt");
        write(&local, "preexisting/sub/owned.txt");
        write(&local, "rename/deep/name.txt");
        write(&local, "excluded/cache.txt");
        let engine = f.start(
            "dir-basics",
            &local,
            SyncOptions {
                delete_removed: true,
                exclusion_rules: "excluded/\n*.tmp".into(),
                ..SyncOptions::default()
            },
        );
        wait(|| {
            remote.join("empty/nested").is_dir()
                && remote.join("nonempty/deep/file.txt").is_file()
                && remote.join("preexisting/sub/owned.txt").is_file()
                && remote.join("rename/deep/name.txt").is_file()
        });
        settled(&engine, "dir-basics");
        assert!(!remote.join("excluded").exists());
        assert!(!remote.join("remote-only").exists());
        for path in ["empty", "nonempty", "preexisting"] {
            std::fs::remove_dir_all(local.join(path)).unwrap();
        }
        wait(|| {
            ["empty", "nonempty", "preexisting"]
                .iter()
                .all(|path| !remote.join(path).exists())
        });
        std::fs::rename(local.join("rename"), local.join("renamed")).unwrap();
        wait(|| !remote.join("rename").exists() && remote.join("renamed/deep/name.txt").is_file());
        settled(&engine, "dir-basics");
        std::fs::remove_dir_all(local.join("renamed")).unwrap();
        std::fs::create_dir_all(local.join("renamed/deep")).unwrap();
        thread::sleep(Duration::from_millis(1500));
        assert!(remote.join("renamed/deep").is_dir());
        assert!(!remote.join("remote-only").exists());
        engine.stop("dir-basics").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture"]
    fn directory_deletion_generated_localhost_stop_summary_preserves_final_queue() {
        let f=Fixture::load();let (local,_remote)=f.roots("stop-summary");write(&local,"queued.txt");
        let engine=f.start("stop-summary",&local,SyncOptions::default());
        wait(|| engine.status("stop-summary").unwrap().pending>0);
        let summary=engine.stop_with_summary("stop-summary").unwrap();
        assert!(summary.known_unreflected,"Stopping before the debounce window must report the worker's retained queue");
    }
    #[test]
    #[ignore = "generated localhost fixture with held target-stat response"]
    fn directory_deletion_generated_localhost_stop_summary_canceled_transfer() {
        let f=Fixture::load();let (local,remote)=f.roots("stop-inflight");write(&local,"cancel.txt");
        std::fs::write(f.output.join("hold-stop-transfer"), b"generated injection").unwrap();
        let engine=f.start("stop-inflight",&local,SyncOptions::default());
        wait(|| f.output.join("stop-transfer-observed").exists());
        let summary=engine.stop_with_summary("stop-inflight").unwrap();
        assert!(summary.known_unreflected,"Canceled in-flight work must be requeued before publishing final stop summary");
        assert!(!remote.join("cancel.txt").exists());
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/directory-delete-test.mjs"]
    fn directory_deletion_generated_localhost_committed_journal() {
        let f = Fixture::load();
        let (local, remote) = f.roots("journal-committed");
        write(&local, "nested/owned.txt");
        std::fs::create_dir(local.join("empty")).unwrap();
        let engine = f.start("journal-committed", &local, SyncOptions { delete_removed: true, ..SyncOptions::default() });
        wait(|| remote.join("nested/owned.txt").is_file() && remote.join("empty").is_dir());
        settled(&engine, "journal-committed");
        let before = engine.status("journal-committed").unwrap().remote_changes;
        assert!(before.records.iter().any(|record| record.path == "/journal-committed/nested"));
        assert!(before.records.iter().any(|record| record.path == "/journal-committed"));
        std::fs::remove_file(local.join("nested/owned.txt")).unwrap();
        std::fs::remove_dir(local.join("empty")).unwrap();
        wait(|| !remote.join("nested/owned.txt").exists() && !remote.join("empty").exists());
        settled(&engine, "journal-committed");
        let after = engine.status("journal-committed").unwrap().remote_changes;
        let changes: Vec<_> = after.records.iter().filter(|record| record.revision > before.revision).collect();
        assert!(changes.iter().any(|record| record.path == "/journal-committed/nested"), "File deletion must dirty its remote parent");
        assert!(changes.iter().any(|record| record.path == "/journal-committed"), "Directory deletion must dirty its remote parent");
        assert!(changes.iter().any(|record| record.removed_directory.as_deref() == Some("/journal-committed/empty")), "Successful rmdir must invalidate current views inside its removed subtree");
        assert!(changes.iter().filter(|record| record.path == "/journal-committed/nested").all(|record| record.removed_directory.is_none()), "File deletion must not claim a removed directory");
        assert!(changes.iter().all(|record| record.path.starts_with("/journal-committed")));
        engine.stop("journal-committed").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture launched by scripts/directory-delete-test.mjs"]
    fn directory_deletion_generated_localhost_changed_staging_resends_latest() {
        let f = Fixture::load();
        let (local, remote) = f.roots("journal-failed");
        let source = local.join("changing.bin");
        std::fs::write(&source, vec![17u8; 32 * 1024 * 1024]).unwrap();
        let engine = f.start("journal-failed", &local, SyncOptions::default());
        // Actual SFTP staging must begin before changing the source. The old
        // stage must not become a final mixed file; the latest source is resent.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if std::fs::read_dir(&remote).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".part")) { break; }
            assert!(Instant::now() < deadline, "Generated SFTP staging did not begin");
            thread::sleep(Duration::from_millis(1));
        }
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&source).unwrap().write_all(b"generated concurrent edit").unwrap();
        // Debug-build localhost encryption of 32 MiB can exceed the small-file
        // fixture's 15s helper deadline. Await its actual final result instead.
        let deadline = Instant::now() + Duration::from_secs(90);
        while !remote.join("changing.bin").is_file() || engine.status("journal-failed").unwrap().pending != 0 {
            assert_eq!(engine.status("journal-failed").unwrap().error_count,0);
            if Instant::now() >= deadline {
                engine.stop("journal-failed").unwrap();
                panic!("Generated SFTP staging did not reach a final result");
            }
            thread::sleep(Duration::from_millis(20));
        }
        let complete = engine.status("journal-failed").unwrap();
        assert_eq!(std::fs::read(remote.join("changing.bin")).unwrap(),std::fs::read(&source).unwrap());
        assert_eq!(complete.error_count,0);
        assert!(!complete.remote_changes.records.is_empty());
        assert!(!std::fs::read_dir(&remote).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".part")));
        engine.stop("journal-failed").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture"]
    fn directory_deletion_generated_localhost_preservation() {
        let f = Fixture::load();
        for (name, options) in [
            ("dir-off", SyncOptions::default()),
            (
                "dir-shallow",
                SyncOptions {
                    delete_removed: true,
                    recursive: false,
                    ..SyncOptions::default()
                },
            ),
        ] {
            let (local, remote) = f.roots(name);
            write(&local, "nested/owned.txt");
            write(&local, "root.txt");
            let engine = f.start(name, &local, options);
            wait(|| remote.join("root.txt").is_file());
            settled(&engine, name);
            if name == "dir-off" {
                assert!(remote.join("nested/owned.txt").exists());
            } else {
                assert!(!remote.join("nested").exists());
            }
            std::fs::remove_dir_all(local.join("nested")).unwrap();
            thread::sleep(Duration::from_millis(1200));
            if name == "dir-off" {
                assert!(remote.join("nested/owned.txt").exists());
            }
            engine.stop(name).unwrap();
        }
        let (local, remote) = f.roots("dir-unknown");
        write(&local, "owned/deep/file.txt");
        let engine = f.start(
            "dir-unknown",
            &local,
            SyncOptions {
                delete_removed: true,
                exclusion_rules: "*.tmp".into(),
                ..SyncOptions::default()
            },
        );
        wait(|| remote.join("owned/deep/file.txt").exists());
        settled(&engine, "dir-unknown");
        write(&remote, "owned/deep/unknown.tmp");
        std::fs::remove_dir_all(local.join("owned")).unwrap();
        wait(|| !remote.join("owned/deep/file.txt").exists());
        settled(&engine,"dir-unknown");
        assert!(remote.join("owned/deep/unknown.tmp").exists());
        assert_eq!(engine.status("dir-unknown").unwrap().pending, 0);
        engine.stop("dir-unknown").unwrap();
        let (local, remote) = f.roots("dir-type");
        std::fs::create_dir(local.join("changed")).unwrap();
        let engine = f.start(
            "dir-type",
            &local,
            SyncOptions {
                delete_removed: true,
                ..SyncOptions::default()
            },
        );
        wait(|| remote.join("changed").is_dir());
        settled(&engine, "dir-type");
        std::fs::remove_dir(local.join("changed")).unwrap();
        std::fs::write(local.join("changed"), b"changed type").unwrap();
        wait(|| engine.status("dir-type").unwrap().error_count > 0);
        assert!(remote.join("changed").is_dir());
        assert!(engine.status("dir-type").unwrap().pending > 0);
        engine.stop("dir-type").unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture"]
    fn directory_deletion_generated_localhost_boundary_failures() {
        let f = Fixture::load();
        let (local, remote) = f.roots("dir-boundaries");
        let stop = AtomicBool::new(false);
        for name in [
            "race-child",
            "denied",
            "late-local",
            "cancelled",
            "changed",
            "uncertain",
        ] {
            std::fs::create_dir(local.join(name)).unwrap();
            let (mut connection, _) = sftp::connect(&f.profile, &f.secret, &stop).unwrap();
            let stamp = sftp::authorize_directory(
                &mut connection,
                "/dir-boundaries",
                Path::new(name),
                &stop,
                &|| Ok(()),
            )
            .unwrap();
            if name == "changed" {
                std::fs::remove_dir(remote.join(name)).unwrap();
                std::fs::write(remote.join(name), b"remote type change").unwrap();
            }
            if name == "cancelled" {
                stop.store(true, Ordering::Relaxed);
            }
            let result = sftp::delete_owned_directory(
                &mut connection,
                "/dir-boundaries",
                Path::new(name),
                &stamp,
                &stop,
                &|| {
                    if name == "late-local" {
                        Err("generated recreation at final boundary".into())
                    } else {
                        Ok(())
                    }
                },
            );
            assert!(result.is_err(), "{name} should fail closed");
            stop.store(false, Ordering::Relaxed);
            if name == "uncertain" {
                assert!(!remote.join(name).exists());
            } else {
                assert!(remote.join(name).exists());
            }
            if name == "race-child" {
                assert!(remote.join(name).join("concurrent.txt").exists());
            }
        }
    }
    #[test]
    #[ignore = "generated localhost fixture"]
    fn directory_deletion_generated_localhost_error_stops_until_manual_restart() {
        let f = Fixture::load();
        let (local, remote) = f.roots("dir-reconnect");
        std::fs::create_dir(local.join("owned")).unwrap();
        let engine = f.start(
            "dir-reconnect",
            &local,
            SyncOptions {
                delete_removed: true,
                ..SyncOptions::default()
            },
        );
        wait(|| remote.join("owned").exists());
        settled(&engine, "dir-reconnect");
        std::fs::write(
            f.output.join("inject-disconnect"),
            b"generated failure trigger",
        )
        .unwrap();
        write(&local, "trigger.txt");
        wait(|| {
            let status = engine.status("dir-reconnect").unwrap();
            status.status == "failed" && status.stop_complete
        });
        let failed = engine.status("dir-reconnect").unwrap();
        assert_eq!(failed.error_count, 1);
        assert_eq!(failed.failure.as_ref().unwrap().relative_path.as_deref(), Some("trigger.txt"));
        assert!(!remote.join("trigger.txt").exists());
        assert!(failed.pending > 0);
        assert!(engine.retry("dir-reconnect").is_err());
        // A failed job no longer reconnects automatically. Subsequent local
        // changes must not perform uploads or consume stale deletion authority.
        std::fs::remove_dir(local.join("owned")).unwrap();
        std::fs::write(local.join("trigger.txt"), b"latest content after failure").unwrap();
        thread::sleep(Duration::from_millis(1000));
        assert!(remote.join("owned").is_dir());
        assert!(!remote.join("trigger.txt").exists());
        let stopped = engine.status("dir-reconnect").unwrap();
        assert_eq!(stopped.status, "failed");
        assert_eq!(stopped.error_count, 1);
        engine.stop("dir-reconnect").unwrap();
        // Explicit new start builds a fresh inventory and evaluates the latest
        // source state rather than replaying the failed session's queue/stamps.
        let resumed = f.start("dir-reconnect", &local, SyncOptions {
            delete_removed: true,
            ..SyncOptions::default()
        });
        wait(|| std::fs::read(remote.join("trigger.txt")).ok().as_deref() == Some(b"latest content after failure"));
        wait(|| !remote.join("owned").exists());
        settled(&resumed, "dir-reconnect");
        resumed.stop("dir-reconnect").unwrap();
    }
    #[test]
    fn directory_scope_and_local_guards() {
        let root = std::env::temp_dir().join(format!(
            "nearly-dir-unit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("keep/deep")).unwrap();
        std::fs::create_dir_all(root.join("excluded/deep")).unwrap();
        let stop = AtomicBool::new(false);
        let identity = local_root_identity(&root).unwrap();
        let mut queue = HashMap::new();
        let mut dirs = HashMap::new();
        let rules = crate::exclusion::Rules::compile("excluded/").unwrap();
        queue_directories(
            &root,
            &root,
            &mut queue,
            &mut dirs,
            &stop,
            &rules,
            Instant::now(),
        )
        .unwrap();
        assert_eq!(queue.len(), 2);
        assert_eq!(dirs.len(), 2);
        assert!(!dirs.contains_key(Path::new("")));
        assert!(!dirs.contains_key(Path::new("excluded")));
        assert_eq!(
            directory_action(&root, Path::new("keep/deep"), &identity, &stop).unwrap(),
            LocalAction::Skip
        );
        std::fs::remove_dir_all(root.join("keep")).unwrap();
        assert_eq!(
            directory_action(&root, Path::new("keep/deep"), &identity, &stop).unwrap(),
            LocalAction::Delete
        );
        std::fs::write(root.join("keep"), b"type change").unwrap();
        assert!(directory_action(&root, Path::new("keep/deep"), &identity, &stop).is_err());
        assert!(directory_action(&root, Path::new("../outside"), &identity, &stop).is_err());
        stop.store(true, Ordering::Relaxed);
        assert!(directory_action(&root, Path::new("absent"), &identity, &stop).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod remote_change_journal_tests {
    use super::*;

    #[test]
    fn new_status_has_empty_committed_remote_journal() {
        let status = serde_json::to_value(Status::new()).unwrap();
        assert_eq!(status["remoteChanges"], serde_json::json!({"revision":0,"records":[],"truncated":false}));
    }

    #[test]
    fn successful_rmdir_identifies_removed_subtree_but_file_changes_do_not() {
        let mut status = Status::new();
        status.committed_remote_change("/sync", Path::new("file.txt"));
        status.committed_remote_directory_removal("/sync", Path::new("empty/nested"));
        status.committed_remote_directory_removal("/", Path::new("top"));
        let journal = serde_json::to_value(&status.remote_changes).unwrap();
        assert!(journal["records"][0].get("removedDirectory").is_none());
        assert_eq!(journal["records"][1]["path"], "/sync/empty");
        assert_eq!(journal["records"][1]["removedDirectory"], "/sync/empty/nested");
        assert_eq!(journal["records"][2]["removedDirectory"], "/top");
    }

    #[test]
    fn successful_mutations_record_absolute_parents_with_new_cursors() {
        let mut status = Status::new();
        status.committed_remote_change("/sync", Path::new("top.txt"));
        status.committed_remote_change("/sync", Path::new("nested/deep/file.txt"));
        status.committed_remote_change("/", Path::new("nested/empty"));
        status.committed_remote_change("/sync", Path::new("top.txt"));
        let journal = serde_json::to_value(&status.remote_changes).unwrap();
        assert_eq!(journal, serde_json::json!({"revision":4,"truncated":false,"records":[
            {"revision":1,"path":"/sync"},{"revision":2,"path":"/sync/nested/deep"},
            {"revision":3,"path":"/nested"},{"revision":4,"path":"/sync"}]}));
    }

    #[test]
    fn failed_or_canceled_transfers_do_not_publish_remote_changes() {
        let mut status = Status::new();
        status.failure("staging write failed", false);
        status.failure("operation stopped", true);
        assert_eq!(status.remote_changes.revision, 0);
        assert!(status.remote_changes.records.is_empty());
    }

    #[test]
    fn bounded_history_preserves_contiguous_recent_revisions_and_detectable_gap() {
        let mut status = Status::new();
        for n in 0..70 { status.committed_remote_change("/sync", Path::new(&format!("folder-{n}/file"))); }
        let journal = status.remote_changes;
        assert_eq!(journal.revision, 70);
        assert!(journal.truncated);
        assert_eq!(journal.records.len(), REMOTE_CHANGE_LIMIT);
        assert_eq!(journal.records.first().unwrap().revision, 7);
        assert_eq!(journal.records.last().unwrap().revision, 70);
        assert_eq!(journal.records.first().unwrap().path, "/sync/folder-6");
    }

    #[test]
    fn cursor_exhaustion_is_safe_integer_bounded_and_requires_restart() {
        let mut status = Status::new();
        status.remote_changes.revision = MAX_REMOTE_REVISION - 1;
        status.committed_remote_change("/sync", Path::new("last.txt"));
        assert_eq!(status.remote_changes.revision, MAX_REMOTE_REVISION);
        status.committed_remote_change("/sync", Path::new("next.txt"));
        assert_eq!(status.remote_changes.revision, MAX_REMOTE_REVISION);
        assert!(status.remote_changes.truncated);
        assert_eq!(status.remote_changes.records.len(), 1);
        assert_eq!(status.remote_changes.records[0].path, "/sync");
        status.activity.scan_finished();
        status.activity.settle(0, true, false, false, false);
        assert_eq!(status.activity.phase(), crate::taskbar_status::NativeSyncState::Error);
    }
}

#[cfg(test)]
mod stop_summary_tests {
    use super::*;
    #[test]
    fn prepared_cancel_and_unscanned_status_are_unknown_without_claiming_completion() {
        let e=Engine::default();e.prepare("prepared".into()).unwrap();
        assert!(!e.stop_with_summary("prepared").unwrap().known_unreflected);
        assert!(!Status::new().stop_summary.known_unreflected);
        assert_eq!(serde_json::to_value(StopSummary::default()).unwrap(),serde_json::json!({"knownUnreflected":false}));
        assert!(serde_json::to_value(Status::new()).unwrap().get("stopSummary").is_none());
    }
    #[test]
    fn stop_joins_before_reading_final_worker_queue_even_when_public_pending_was_zero() {
        let e=Engine::default();let state=Arc::new(Mutex::new(Status::new()));
        let stop=Arc::new(AtomicBool::new(false));let worker_stop=stop.clone();let worker_state=state.clone();
        let handle=thread::spawn(move||{while !worker_stop.load(Ordering::SeqCst){thread::yield_now();}let mut s=worker_state.lock().unwrap();s.record_stopped_queue(3);s.status="stopped".into();});
        e.jobs.lock().unwrap().insert("final".into(),Job{local:PathBuf::from("C:\\generated"),identity:String::new(),endpoints:vec![],remote:"/generated".into(),status:state.clone(),stop,retry:Arc::new(AtomicBool::new(false)),handle:Some(handle)});
        assert_eq!(state.lock().unwrap().pending,0);
        assert!(e.stop_with_summary("final").unwrap().known_unreflected);
        assert!(e.jobs.lock().unwrap().is_empty());
    }
    #[test]
    fn final_empty_queue_remains_unknown_and_preserves_existing_stop_api() {
        let mut s=Status::new();s.pending=8;s.record_stopped_queue(0);
        assert!(!s.stop_summary.known_unreflected);assert_eq!(s.pending,0);
        let e=Engine::default();e.prepare("old-api".into()).unwrap();assert!(e.stop("old-api").is_ok());
    }
}

#[cfg(test)]
#[path="startup_pipeline_tests.rs"]
mod startup_pipeline_tests;

#[cfg(test)] mod taskbar_integration_tests {
 use super::*; use crate::taskbar_status::{TaskbarState as T,NativeSyncState as N};
 #[test] fn phase_is_display_only_and_internal_activity_stays_private(){
  let mut s=Status::new();
  let phase=|s:&Status,expected:&str|{let json=serde_json::to_value(s).unwrap();assert_eq!(json["syncPhase"],expected);assert!(json.get("activity").is_none());assert!(json.get("hard_error").is_none());};
  phase(&s,"scanning");s.activity.mark_working();phase(&s,"working");s.activity.scan_finished();s.activity.settle(0,true,false,false,false);phase(&s,"caught_up");
  s.activity.set_deletion_rescan_required(true);s.activity.settle(0,true,false,false,false);phase(&s,"deletion_rescan_required");
  s.activity.failure(true);phase(&s,"error");s.activity.settle(0,true,false,true,false);phase(&s,"stopping");s.activity.stopped();phase(&s,"stopped");
 }
 #[test] fn native_activity_is_not_frontend_or_settings_data(){let status=Status::new();assert_eq!(status.activity.phase(),N::Scanning);let json=serde_json::to_value(status).unwrap();assert!(json.get("activity").is_none());}
 #[test] fn prepared_start_failure_and_cancel_are_truthful(){let e=Engine::default();assert_eq!(e.taskbar_state().unwrap(),T::Idle);e.prepare("one".into()).unwrap();assert_eq!(e.taskbar_state().unwrap(),T::Working);e.record_start_failure("one");e.discard_prepared_start("one");assert_eq!(e.taskbar_state().unwrap(),T::Error);e.prepare("two".into()).unwrap();assert_eq!(e.taskbar_state().unwrap(),T::Working);e.stop("two").unwrap();e.record_start_failure("two");e.discard_prepared_start("two");assert_eq!(e.taskbar_state().unwrap(),T::Idle);e.record_start_failure("unknown");assert_eq!(e.taskbar_state().unwrap(),T::Idle);}
 #[test] fn terminal_failure_never_automatically_recovers(){let mut s=Status::new();s.activity.settle(0,true,false,false,false);assert_eq!(s.activity.phase(),N::Scanning);s.activity.scan_finished();s.failure("transient",false);s.activity.settle(1,true,false,false,false);assert_eq!(s.activity.phase(),N::Error);s.activity.settle(0,true,false,false,false);assert_eq!(s.activity.phase(),N::Error);assert_eq!(s.error_count,1);s.activity.settle(0,true,false,true,false);assert_eq!(s.activity.phase(),N::Stopping);}
}
#[cfg(test)]
#[path="completion_attention_tests.rs"]
mod completion_attention_tests;
#[cfg(test)] mod upload_guard_tests {
 use super::*;
 #[test] fn upload_requires_preparation_preserves_early_cancel_and_shutdown(){let e=Engine::default();assert!(e.claim_prepared_upload("upload").is_err());e.prepare_operation("upload").unwrap();e.cancel_operation("upload").unwrap();let stop=e.claim_prepared_upload("upload").unwrap();assert!(stop.load(Ordering::SeqCst));assert!(e.claim_prepared_upload("upload").is_err());e.finish_operation("upload");e.prepare_operation("fresh").unwrap();let stop=e.claim_prepared_upload("fresh").unwrap();e.try_begin_close().unwrap();assert!(stop.load(Ordering::SeqCst));}
 #[test] fn upload_reservation_rejects_local_and_remote_sync_overlap(){let e=Engine::default();let root=PathBuf::from("C:\\generated\\upload");let job=super::tests::reserved_job(root.clone(),"/target");e.jobs.lock().unwrap().insert("sync".into(),job);e.prepare_operation("upload").unwrap();e.claim_prepared_upload("upload").unwrap();assert!(e.reserve_upload_operation("upload",vec![root.join("item")],vec![],String::new(),vec![]).is_err());assert!(e.reserve_upload_operation("upload",vec![],vec!["/target/child".into()],"host-key".into(),vec![]).is_err());assert!(e.reserve_upload_operation("upload",vec![],vec!["/target/child".into()],"alias".into(),vec!["127.0.0.1:2222".parse().unwrap()]).is_err());}
}
#[cfg(test)]
#[path = "startup_measure_fixture.rs"]
mod startup_measure;

#[cfg(test)]
#[path = "empty_remote_tests.rs"]
mod empty_remote_tests;
