//! Bounded, nonrecursive notices for the visible local explorer directory.
//! Polling this registry never reads a directory or performs a filesystem scan.
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
const MAX_WATCHES: usize = 16;
const QUIET: Duration = Duration::from_millis(150);
const MAX_WAIT: Duration = Duration::from_millis(500);
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalWatchSnapshot {
    pub token: u64,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Default)]
pub struct LocalWatchRegistry {
    entries: Mutex<HashMap<String, WatchEntry>>,
}
struct WatchEntry {
    token: u64,
    path: PathBuf,
    _watcher: RecommendedWatcher,
    notice: Arc<Mutex<Notice>>,
}
#[derive(Default)]
struct Notice {
    revision: u64,
    first: Option<Instant>,
    last: Option<Instant>,
    error: Option<String>,
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("Invalid local watch ID".into());
    }
    Ok(())
}
fn same_path(left: &std::path::Path, right: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        let left = left.to_string_lossy();
        let right = right.to_string_lossy();
        left.strip_prefix(r"\\?\")
            .unwrap_or(&left)
            .replace('\\', "/")
            .eq_ignore_ascii_case(
                &right
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&right)
                    .replace('\\', "/"),
            )
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}
fn local_directory(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.chars().any(char::is_control) || path.encode_utf16().count() > 32767
    {
        return Err("Invalid local watch path".into());
    }
    #[cfg(windows)]
    {
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
        let ordinary = path.strip_prefix(r"\\?\").unwrap_or(path);
        let bytes = ordinary.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
        {
            return Err("Local directory watching requires an absolute local drive path".into());
        }
        let wide: Vec<u16> = format!("{}:\\", bytes[0] as char)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        if !matches!(
            unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) },
            2 | 3 | 5 | 6
        ) {
            return Err("Local directory watching requires an available local drive".into());
        }
    }
    let path = std::path::Path::new(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Local directory watching requires an absolute path without traversal".into());
    }
    // Registration checks components without enumerating directory contents.
    // Refuse links/junctions before canonicalizing so a local alias cannot start
    // a watcher on a network share or an unexpected target.
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part.as_os_str());
        if matches!(part, std::path::Component::Prefix(_)) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|_| "Local watch directory is unavailable")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Local directory watching refuses reparse points".into());
            }
        }
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Local watch path is not an ordinary directory".into());
        }
    }
    std::fs::canonicalize(path).map_err(|_| "Local watch directory cannot be resolved".into())
}
impl Notice {
    fn record(&mut self, event: notify::Result<Event>, root: &std::path::Path, now: Instant) {
        match event {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                let relevant = event.paths.is_empty()
                    || event.paths.iter().any(|path| {
                        same_path(path, root)
                            || path.parent().is_some_and(|parent| same_path(parent, root))
                    });
                if !relevant && !event.need_rescan() {
                    return;
                }
                if event.need_rescan() {
                    self.error = Some(
                        "Local directory watcher lost events; refresh and watch the folder again"
                            .into(),
                    );
                } else if matches!(
                    event.kind,
                    EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
                ) && event.paths.iter().any(|path| same_path(path, root))
                {
                    self.error = Some(
                        "The watched local folder moved or was removed; select the folder again"
                            .into(),
                    );
                }
            }
            Err(_) => {
                self.error = Some(
                    "Local directory watcher failed; refresh and watch the folder again".into(),
                );
            }
        }
        self.first.get_or_insert(now);
        self.last = Some(now);
    }
    fn snapshot(&mut self, token: u64, now: Instant) -> LocalWatchSnapshot {
        if let (Some(first), Some(last)) = (self.first, self.last) {
            if now.saturating_duration_since(last) >= QUIET
                || now.saturating_duration_since(first) >= MAX_WAIT
            {
                match self.revision.checked_add(1) {
                    Some(revision) => self.revision = revision,
                    None => self.error = Some(
                        "Local directory watcher revision limit reached; watch the folder again"
                            .into(),
                    ),
                }
                self.first = None;
                self.last = None;
            }
        }
        LocalWatchSnapshot {
            token,
            revision: self.revision,
            error: self.error.clone(),
        }
    }
}
impl LocalWatchRegistry {
    pub fn watch(&self, id: &str, path: &str, token: u64) -> Result<LocalWatchSnapshot, String> {
        valid_id(id)?;
        if token == 0 {
            return Err("Invalid local watch token".into());
        }
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Local watcher registry lock failed")?;
        if let Some(existing) = entries.get(id) {
            if token < existing.token {
                return Err("Stale local watch token".into());
            }
        } else if entries.len() >= MAX_WATCHES {
            return Err("At most 16 local directory watches are allowed".into());
        }
        let path = local_directory(path)?;
        if let Some(existing) = entries.get(id) {
            if token == existing.token {
                if !same_path(&path, &existing.path) {
                    return Err("Local watch token already belongs to another directory".into());
                }
                return existing
                    .notice
                    .lock()
                    .map_err(|_| "Local watcher notice lock failed".into())
                    .map(|mut notice| notice.snapshot(token, Instant::now()));
            }
        }
        let notice = Arc::new(Mutex::new(Notice::default()));
        // The Windows backend closes asynchronously on Drop. A late callback
        // must not retain or mutate the retired registration state.
        let callback_notice = Arc::downgrade(&notice);
        let callback_path = path.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            if let Some(notice) = callback_notice.upgrade() {
                if let Ok(mut notice) = notice.lock() {
                    notice.record(event, &callback_path, Instant::now());
                }
            }
        })
        .map_err(|_| "Local directory watcher could not be initialized")?;
        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|_| "Local directory watcher could not watch the folder")?;
        // One bounded nonrecursive parent subscription detects rename/deletion
        // of the displayed folder itself. Sibling events are filtered out.
        if let Some(parent) = path.parent() {
            watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .map_err(|_| "Local directory watcher could not watch the parent folder")?;
        }
        let snapshot = notice
            .lock()
            .map_err(|_| "Local watcher notice lock failed")?
            .snapshot(token, Instant::now());
        let old = entries.insert(
            id.into(),
            WatchEntry {
                token,
                path,
                _watcher: watcher,
                notice,
            },
        );
        drop(entries);
        drop(old);
        Ok(snapshot)
    }
    pub fn status(&self, id: &str) -> Result<LocalWatchSnapshot, String> {
        valid_id(id)?;
        let entries = self
            .entries
            .lock()
            .map_err(|_| "Local watcher registry lock failed")?;
        let entry = entries.get(id).ok_or("Local directory watch not found")?;
        let result = entry
            .notice
            .lock()
            .map_err(|_| "Local watcher notice lock failed")?
            .snapshot(entry.token, Instant::now());
        Ok(result)
    }
    pub fn unwatch(&self, id: &str, token: u64) -> Result<bool, String> {
        valid_id(id)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Local watcher registry lock failed")?;
        if entries.get(id).is_none_or(|entry| entry.token != token) {
            return Ok(false);
        }
        let old = entries.remove(id);
        drop(entries);
        drop(old);
        Ok(true)
    }
    pub fn clear(&self) -> Result<(), String> {
        let old = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| "Local watcher registry lock failed")?;
            std::mem::take(&mut *entries)
        };
        drop(old);
        Ok(())
    }
}
impl Drop for LocalWatchRegistry {
    fn drop(&mut self) {
        if let Ok(entries) = self.entries.get_mut() {
            entries.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        thread,
    };
    struct Generated(PathBuf);
    impl Generated {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let root = std::env::temp_dir().join(format!(
                "nearly-local-watch-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn folder(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::create_dir(&path).unwrap();
            path
        }
    }
    impl Drop for Generated {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn text(path: &Path) -> &str {
        path.to_str().unwrap()
    }
    fn changed(registry: &LocalWatchRegistry, id: &str, previous: u64) -> LocalWatchSnapshot {
        let end = Instant::now() + Duration::from_secs(6);
        loop {
            let snapshot = registry.status(id).unwrap();
            if snapshot.revision > previous {
                return snapshot;
            }
            assert!(
                Instant::now() < end,
                "generated watcher did not report a change: {snapshot:?}"
            );
            thread::sleep(Duration::from_millis(25));
        }
    }
    fn stable(registry: &LocalWatchRegistry, id: &str) -> LocalWatchSnapshot {
        thread::sleep(Duration::from_millis(600));
        registry.status(id).unwrap()
    }
    #[test]
    fn local_watch_generated_create_edit_rename_delete_and_burst() {
        let fixture = Generated::new();
        let root = fixture.folder("visible");
        let registry = LocalWatchRegistry::default();
        let initial = registry.watch("pane", text(&root), 1).unwrap();
        assert_eq!(initial.revision, 0);
        assert_eq!(initial.token, 1);
        assert!(initial.error.is_none());
        let file = root.join("generated.txt");
        std::fs::write(&file, b"created").unwrap();
        let created = changed(&registry, "pane", 0);
        assert!(created.error.is_none());
        let revision = stable(&registry, "pane").revision;
        std::fs::write(&file, b"edited generated contents").unwrap();
        changed(&registry, "pane", revision);
        let revision = stable(&registry, "pane").revision;
        let renamed = root.join("renamed.txt");
        std::fs::rename(&file, &renamed).unwrap();
        changed(&registry, "pane", revision);
        let revision = stable(&registry, "pane").revision;
        std::fs::remove_file(renamed).unwrap();
        changed(&registry, "pane", revision);
        let revision = stable(&registry, "pane").revision;
        for index in 0..40 {
            std::fs::write(root.join(format!("burst-{index}.txt")), b"generated burst").unwrap();
        }
        changed(&registry, "pane", revision);
        let end = stable(&registry, "pane");
        assert!(
            end.revision <= revision + 3,
            "burst notices were not coalesced: {end:?}"
        );
        assert!(end.error.is_none());
    }
    #[test]
    fn local_watch_replace_stale_token_unwatch_and_drop_release_callback() {
        let fixture = Generated::new();
        let old = fixture.folder("old");
        let new = fixture.folder("new");
        let registry = LocalWatchRegistry::default();
        registry.watch("pane", text(&old), 10).unwrap();
        let weak = {
            let entries = registry.entries.lock().unwrap();
            Arc::downgrade(&entries["pane"].notice)
        };
        registry.watch("pane", text(&new), 11).unwrap();
        assert!(!registry.unwatch("pane", 10).unwrap());
        assert!(registry.watch("pane", text(&old), 9).is_err());
        assert!(registry.watch("pane", text(&old), 11).is_err());
        std::fs::write(
            old.join("stale.txt"),
            b"old callback must not dirty replacement",
        )
        .unwrap();
        assert_eq!(stable(&registry, "pane").revision, 0);
        assert!(weak.upgrade().is_none());
        std::fs::write(new.join("visible.txt"), b"new callback").unwrap();
        changed(&registry, "pane", 0);
        let same = registry.watch("pane", text(&new), 11).unwrap();
        assert!(same.revision > 0);
        assert!(registry.unwatch("pane", 11).unwrap());
        assert!(registry.status("pane").is_err());
        assert!(!registry.unwatch("pane", 11).unwrap());
        for token in 1..=12 {
            registry.watch("pane", text(&new), token).unwrap();
            assert!(registry.unwatch("pane", token).unwrap());
        }
        registry.watch("pane", text(&new), 1).unwrap();
        let weak = {
            let entries = registry.entries.lock().unwrap();
            Arc::downgrade(&entries["pane"].notice)
        };
        drop(registry);
        assert!(weak.upgrade().is_none());
    }
    #[test]
    fn local_watch_capacity_and_clear_are_bounded() {
        let fixture = Generated::new();
        let registry = LocalWatchRegistry::default();
        for index in 0..MAX_WATCHES {
            registry
                .watch(&format!("pane-{index}"), text(&fixture.0), 1)
                .unwrap();
        }
        assert!(registry.watch("overflow", text(&fixture.0), 1).is_err());
        assert_eq!(registry.entries.lock().unwrap().len(), MAX_WATCHES);
        registry.watch("pane-0", text(&fixture.0), 2).unwrap();
        registry.clear().unwrap();
        assert!(registry.entries.lock().unwrap().is_empty());
        assert!(registry.status("pane-0").is_err());
        registry.watch("replacement", text(&fixture.0), 1).unwrap();
    }
    #[test]
    fn local_watch_rejects_invalid_ids_tokens_paths_and_files() {
        let fixture = Generated::new();
        let registry = LocalWatchRegistry::default();
        for id in ["", "../bad", "a/b"] {
            assert!(registry.watch(id, text(&fixture.0), 1).is_err());
        }
        assert!(registry.watch("pane", text(&fixture.0), 0).is_err());
        assert!(registry.watch("pane", "relative", 1).is_err());
        assert!(registry
            .watch("pane", text(&fixture.0.join("absent")), 1)
            .is_err());
        let file = fixture.0.join("file.txt");
        std::fs::write(&file, b"generated").unwrap();
        assert!(registry.watch("pane", text(&file), 1).is_err());
        assert!(registry.entries.lock().unwrap().is_empty());
        #[cfg(windows)]
        {
            assert!(registry
                .watch("pane", r"\\generated-host\share", 1)
                .is_err());
            assert!(registry.watch("pane", r"\\.\C:\", 1).is_err());
        }
    }
    #[test]
    fn local_watch_notice_ignores_access_and_unrelated_or_recursive_paths() {
        use notify::event::{AccessKind, CreateKind};
        let root = Path::new("C:/generated/visible");
        let now = Instant::now();
        let mut notice = Notice::default();
        for event in [
            Event::new(EventKind::Access(AccessKind::Any)).add_path(root.join("file")),
            Event::new(EventKind::Create(CreateKind::File)).add_path(root.join("deep/file")),
            Event::new(EventKind::Create(CreateKind::File))
                .add_path(Path::new("C:/generated/sibling").to_path_buf()),
        ] {
            notice.record(Ok(event), root, now);
        }
        assert_eq!(notice.snapshot(1, now + MAX_WAIT).revision, 0);
        notice.record(
            Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(root.join("direct"))),
            root,
            now,
        );
        assert_eq!(
            notice
                .snapshot(1, now + QUIET - Duration::from_millis(1))
                .revision,
            0
        );
        assert_eq!(notice.snapshot(1, now + QUIET).revision, 1);
        assert_eq!(notice.snapshot(1, now + MAX_WAIT).revision, 1);
    }
    #[test]
    fn local_watch_notice_coalesces_continuous_burst_and_preserves_errors() {
        let root = Path::new("C:/generated/visible");
        let now = Instant::now();
        let mut notice = Notice::default();
        for offset in [0, 100, 200, 300, 400] {
            notice.record(
                Ok(Event::new(EventKind::Any).add_path(root.join("file"))),
                root,
                now + Duration::from_millis(offset),
            );
            assert_eq!(
                notice
                    .snapshot(5, now + Duration::from_millis(offset))
                    .revision,
                0
            );
        }
        assert_eq!(notice.snapshot(5, now + MAX_WAIT).revision, 1);
        notice.record(
            Err(notify::Error::generic(
                "generated private detail must not leak",
            )),
            root,
            now + MAX_WAIT,
        );
        let error = notice.snapshot(5, now + MAX_WAIT + QUIET);
        assert_eq!(error.revision, 2);
        assert!(error.error.is_some());
        assert!(!error.error.unwrap().contains("private detail"));
        assert!(notice
            .snapshot(5, now + MAX_WAIT + MAX_WAIT)
            .error
            .is_some());
    }
    #[test]
    fn local_watch_generated_watched_folder_rename_is_reported() {
        let fixture = Generated::new();
        let root = fixture.folder("visible");
        let registry = LocalWatchRegistry::default();
        registry.watch("pane", text(&root), 1).unwrap();
        std::fs::rename(&root, fixture.0.join("moved")).unwrap();
        let snapshot = changed(&registry, "pane", 0);
        assert!(snapshot.error.is_some());
    }
    #[test]
    fn local_watch_rescan_and_revision_exhaustion_stay_explicit_without_wrap() {
        let root = Path::new("C:/generated/visible");
        let now = Instant::now();
        let mut notice = Notice::default();
        notice.record(
            Ok(Event::new(EventKind::Any).set_flag(notify::event::Flag::Rescan)),
            root,
            now,
        );
        let snapshot = notice.snapshot(4, now + QUIET);
        assert_eq!(snapshot.revision, 1);
        assert!(snapshot.error.unwrap().contains("lost events"));
        let mut notice = Notice {
            revision: u64::MAX,
            ..Notice::default()
        };
        notice.record(Ok(Event::new(EventKind::Any)), root, now);
        let snapshot = notice.snapshot(4, now + QUIET);
        assert_eq!(snapshot.revision, u64::MAX);
        assert!(snapshot.error.unwrap().contains("revision limit"));
    }
    #[test]
    fn local_watch_snapshot_wire_shape_is_small_and_omits_absent_error() {
        let snapshot = LocalWatchSnapshot {
            token: 7,
            revision: 3,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            serde_json::json!({"token":7,"revision":3})
        );
        let snapshot = LocalWatchSnapshot {
            token: 8,
            revision: 0,
            error: Some("fixed owned error".into()),
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap()["error"],
            "fixed owned error"
        );
    }
    #[test]
    fn local_watch_failed_replace_and_deleted_folder_recovery() {
        let fixture = Generated::new();
        let root = fixture.folder("visible");
        let registry = LocalWatchRegistry::default();
        registry.watch("pane", text(&root), 1).unwrap();
        assert!(registry
            .watch("pane", text(&fixture.0.join("absent")), 2)
            .is_err());
        assert_eq!(registry.status("pane").unwrap().token, 1);
        std::fs::remove_dir(&root).unwrap();
        let removed = changed(&registry, "pane", 0);
        assert!(removed.error.is_some());
        std::fs::create_dir(&root).unwrap();
        let restored = registry.watch("pane", text(&root), 2).unwrap();
        assert_eq!(restored.token, 2);
        assert_eq!(restored.revision, 0);
        assert!(restored.error.is_none());
        std::fs::write(root.join("restored.txt"), b"generated restored folder").unwrap();
        assert!(changed(&registry, "pane", 0).error.is_none());
    }
}
