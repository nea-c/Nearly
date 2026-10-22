use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug)]
pub struct ScanError {
    pub relative_path: Option<PathBuf>,
    pub reason: String,
}
impl ScanError {
    fn at(relative: &Path, reason: impl Into<String>) -> Self {
        Self {
            relative_path: if relative.as_os_str().is_empty() {
                None
            } else {
                Some(relative.to_path_buf())
            },
            reason: reason.into(),
        }
    }
}
impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

fn check(stop: &AtomicBool) -> Result<(), String> {
    if stop.load(Ordering::Relaxed) {
        Err("Operation stopped".into())
    } else {
        Ok(())
    }
}

fn reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

/// Build file and optional directory candidates in one complete traversal.
/// Emitted candidates are provisional: callers must not authorize deletion until
/// this traversal AND the remote inventory succeed and root identity is rechecked.
/// The callback retains ownership of the bounded pending queue and directory map.
pub fn walk<F>(
    root: &Path,
    stop: &AtomicBool,
    rules: &crate::exclusion::Rules,
    recursive: bool,
    track_directories: bool,
    mut emit: F,
) -> Result<(), ScanError>
where
    F: FnMut(PathBuf, bool) -> Result<(), String>,
{
    let mut candidates = 0usize;
    let mut directories = 0usize;
    walk_directory(
        root,
        root,
        stop,
        rules,
        recursive,
        track_directories && recursive,
        &mut candidates,
        &mut directories,
        &mut emit,
    )
}

fn walk_directory<F>(
    directory: &Path,
    root: &Path,
    stop: &AtomicBool,
    rules: &crate::exclusion::Rules,
    recursive: bool,
    track_directories: bool,
    candidates: &mut usize,
    directories: &mut usize,
    emit: &mut F,
) -> Result<(), ScanError>
where
    F: FnMut(PathBuf, bool) -> Result<(), String>,
{
    let directory_relative = directory
        .strip_prefix(root)
        .map_err(|_| ScanError::at(Path::new(""), "Local scan path outside root"))?;
    check(stop).map_err(|error| ScanError::at(directory_relative, error))?;
    // Revalidate immediately before descending rather than trusting the parent
    // entry's earlier metadata. Never traverse a directory replaced by a link.
    let current = std::fs::symlink_metadata(directory)
        .map_err(|_| ScanError::at(directory_relative, "Local directory metadata unavailable"))?;
    if !current.is_dir() || reparse(&current) {
        return Err(ScanError::at(
            directory_relative,
            "Local directory changed type or is a reparse point",
        ));
    }
    for entry in std::fs::read_dir(directory)
        .map_err(|_| ScanError::at(directory_relative, "Local directory read failed"))?
    {
        check(stop).map_err(|error| ScanError::at(directory_relative, error))?;
        let entry = entry.map_err(|_| ScanError::at(directory_relative, "Local entry failed"))?;
        let absolute = entry.path();
        let relative = absolute
            .strip_prefix(root)
            .map_err(|_| ScanError::at(directory_relative, "Local scan path outside root"))?;
        let metadata = std::fs::symlink_metadata(&absolute)
            .map_err(|_| ScanError::at(relative, "Local metadata failed"))?;
        if reparse(&metadata) {
            continue;
        }
        let is_directory = metadata.is_dir();
        if !is_directory && !metadata.is_file() {
            continue;
        }
        if rules
            .excludes(relative, is_directory)
            .map_err(|error| ScanError::at(relative, error))?
        {
            continue;
        }
        if is_directory {
            if !recursive {
                continue;
            }
            if relative.components().count() > 64 {
                return Err(ScanError::at(relative, "Local directory depth exceeds 64; stop and restart with a shallower root or exclude the deep directory"));
            }
            if track_directories {
                if *directories >= 10000 {
                    return Err(ScanError::at(
                        relative,
                        "Directory tracking limit reached; stop and restart",
                    ));
                }
                if *candidates >= 10000 {
                    return Err(ScanError::at(
                        relative,
                        "Queue limit reached. Stop and restart to rescan.",
                    ));
                }
                *directories += 1;
                *candidates += 1;
                emit(relative.to_path_buf(), true)
                    .map_err(|error| ScanError::at(relative, error))?;
            }
            walk_directory(
                &absolute,
                root,
                stop,
                rules,
                recursive,
                track_directories,
                candidates,
                directories,
                emit,
            )?;
        } else {
            // Preserve the original complete-readability preflight. Metadata
            // alone must never turn an unreadable source into deletion authority.
            std::fs::File::open(&absolute).map_err(|_| ScanError::at(relative, "Local source entry unreadable; initial scan incomplete, mirror deletion refused"))?;
            check(stop).map_err(|error| ScanError::at(relative, error))?;
            if *candidates >= 10000 {
                return Err(ScanError::at(
                    relative,
                    "Queue limit reached. Stop and restart to rescan.",
                ));
            }
            *candidates += 1;
            emit(relative.to_path_buf(), false).map_err(|error| ScanError::at(relative, error))?;
        }
    }
    check(stop).map_err(|error| ScanError::at(directory_relative, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nearly-initial-scan-{}-{name}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn single_walk_tracks_scoped_files_and_directories() {
        let root = fixture("scope");
        std::fs::create_dir_all(root.join("included")).unwrap();
        std::fs::create_dir_all(root.join("excluded")).unwrap();
        std::fs::write(root.join("included/file"), b"fixture").unwrap();
        std::fs::write(root.join("excluded/file"), b"excluded").unwrap();
        let mut items = Vec::new();
        walk(
            &root,
            &AtomicBool::new(false),
            &crate::exclusion::Rules::compile("excluded/").unwrap(),
            true,
            true,
            |path, directory| {
                items.push((path, directory));
                Ok(())
            },
        )
        .unwrap();
        items.sort();
        assert_eq!(
            items,
            vec![
                (PathBuf::from("included"), true),
                (PathBuf::from("included/file"), false)
            ]
        );
    }

    #[test]
    fn cancellation_and_callback_failure_never_complete_a_partial_scan() {
        let root = fixture("stop");
        let rules = crate::exclusion::Rules::compile("").unwrap();
        assert!(walk(
            &root,
            &AtomicBool::new(true),
            &rules,
            true,
            true,
            |_, _| Ok(())
        )
        .is_err());
        std::fs::write(root.join("file"), b"fixture").unwrap();
        let error = walk(
            &root,
            &AtomicBool::new(false),
            &rules,
            true,
            true,
            |_, _| Err("capacity reached".into()),
        )
        .unwrap_err();
        assert_eq!(error.reason, "capacity reached");
        assert_eq!(error.relative_path, Some(PathBuf::from("file")));
    }

    #[cfg(unix)]
    #[test]
    fn directory_replaced_after_discovery_is_not_traversed() {
        let root = fixture("replacement");
        std::fs::create_dir(root.join("child")).unwrap();
        std::fs::write(root.join("child/file"), b"fixture").unwrap();
        let mut observed = Vec::new();
        let error = walk(
            &root,
            &AtomicBool::new(false),
            &crate::exclusion::Rules::compile("").unwrap(),
            true,
            true,
            |path, directory| {
                observed.push(path.clone());
                if directory {
                    std::fs::rename(root.join(&path), root.join("moved")).unwrap();
                    std::fs::write(root.join(&path), b"replacement").unwrap();
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.reason.contains("changed type"));
        assert_eq!(error.relative_path, Some(PathBuf::from("child")));
        assert_eq!(observed, vec![PathBuf::from("child")]);
    }

    #[test]
    fn directory_type_is_verified_before_enumeration() {
        let parent = fixture("not-directory");
        let root = parent.join("file");
        std::fs::write(&root, b"replacement").unwrap();
        let error = walk(
            &root,
            &AtomicBool::new(false),
            &crate::exclusion::Rules::compile("").unwrap(),
            true,
            true,
            |_, _| panic!("non-directory cannot emit candidates"),
        )
        .unwrap_err();
        assert!(error.reason.contains("changed type"));
        assert_eq!(error.relative_path, None);
    }

    #[test]
    fn cancellation_from_candidate_callback_prevents_more_candidates() {
        let root = fixture("cancel-during-scan");
        std::fs::write(root.join("first"), b"fixture").unwrap();
        std::fs::write(root.join("second"), b"fixture").unwrap();
        let stop = AtomicBool::new(false);
        let mut emitted = 0;
        let result = walk(
            &root,
            &stop,
            &crate::exclusion::Rules::compile("").unwrap(),
            true,
            true,
            |_, _| {
                emitted += 1;
                stop.store(true, Ordering::Relaxed);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(emitted, 1);
    }

    #[test]
    fn empty_directory_depth_limit_applies_without_tracking() {
        let root = fixture("depth");
        let mut deepest = root.clone();
        for _ in 0..65 {
            deepest.push("d");
            std::fs::create_dir(&deepest).unwrap();
        }
        let result = walk(
            &root,
            &AtomicBool::new(false),
            &crate::exclusion::Rules::compile("").unwrap(),
            true,
            false,
            |_, _| Ok(()),
        );
        assert!(result.unwrap_err().reason.contains("depth exceeds 64"));
    }
}
