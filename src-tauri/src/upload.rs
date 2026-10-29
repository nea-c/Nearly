use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadRequest {
    pub id: String,
    pub session_id: String,
    pub sources: Vec<String>,
    pub remote: String,
    pub recursive: bool,
    #[serde(default)]
    pub interactive: bool,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UploadStatus {
    Completed,
    Partial,
    Cancelled,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    pub status: UploadStatus,
    pub completed: usize,
    pub bytes: u64,
    /// Bytes streamed, including a partial owned stage; not confirmed published bytes.
    pub transferred_bytes: u64,
    pub skipped: usize,
    pub message: String,
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    #[test]
    fn upload_rejects_traversal_recursive_off_and_duplicate_names() {
        let root = std::env::temp_dir().join(format!("nearly-upload-{}", std::process::id()));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a/item.txt"), b"source unchanged").unwrap();
        std::fs::write(root.join("b/item.txt"), b"second").unwrap();
        std::fs::write(root.join("a/σ.txt"), b"sigma").unwrap();
        std::fs::write(root.join("b/ς.txt"), b"final sigma").unwrap();
        assert!(inventory(
            &[
                root.join("a/σ.txt").to_string_lossy().into(),
                root.join("b/ς.txt").to_string_lossy().into()
            ],
            false,
            &AtomicBool::new(false)
        )
        .is_err());
        let stop = AtomicBool::new(false);
        assert!(inventory(&[root.join("a/../b").to_string_lossy().into()], true, &stop).is_err());
        assert!(inventory(&[root.join("a").to_string_lossy().into()], false, &stop).is_err());
        assert!(inventory(
            &[
                root.join("a/item.txt").to_string_lossy().into(),
                root.join("b/item.txt").to_string_lossy().into()
            ],
            false,
            &stop
        )
        .is_err());
        assert_eq!(
            std::fs::read(root.join("a/item.txt")).unwrap(),
            b"source unchanged"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn upload_ipc_refuses_profile_secrets() {
        assert!(serde_json::from_value::<UploadRequest>(serde_json::json!({"id":"op","sessionId":"session","sources":[],"remote":"/","recursive":false,"profile":{}})).is_err());
    }
}
use std::{
    collections::HashSet,
    fs::{self, File},
    path::PathBuf,
    sync::atomic::AtomicBool,
};
pub struct Entry {
    pub path: PathBuf,
    pub relative: String,
    pub directory: bool,
    pub file: File,
    pub identity: (u32, u64),
    pub size: u64,
    pub modified: std::time::SystemTime,
}
pub struct Inventory {
    pub entries: Vec<Entry>,
    pub roots: Vec<PathBuf>,
    _parents: Vec<File>,
}
pub(crate) fn inventory(sources: &[String], recursive: bool, stop: &AtomicBool) -> Result<Inventory, String> {
    if sources.is_empty() || sources.len() > 10000 {
        return Err("Select 1 to 10,000 sources".into());
    }
    let mut result = Inventory {
        entries: vec![],
        roots: vec![],
        _parents: vec![],
    };
    let mut pending = vec![];
    let mut parents = HashSet::new();
    for source in sources.iter().rev() {
        let path = crate::file_ops::local_path(source, true)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Filesystem roots cannot be uploaded")?
            .to_owned();
        let mut parent = path.parent();
        while let Some(p) = parent {
            if parents.insert(p.to_owned()) {
                result._parents.push(
                    crate::local_publish::lock_dir(p)
                        .map_err(|_| "Cannot lock source parent against replacement")?,
                );
            }
            parent = p.parent();
        }
        result.roots.push(path.clone());
        pending.push((path, name, 0));
    }
    let mut names = HashSet::new();
    while let Some((path, relative, depth)) = pending.pop() {
        crate::file_ops::check(stop)?;
        if depth > 64 || result.entries.len() >= 10000 {
            return Err("Upload exceeds 10,000 entries or depth 64".into());
        }
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Unsupported source name")?;
        crate::file_ops::validate_creation_name(name, crate::file_ops::Side::Local)?;
        if !names.insert(relative.to_uppercase()) {
            return Err("Duplicate or case-ambiguous upload names".into());
        }
        crate::file_ops::local_path(path.to_str().ok_or("Unsupported path")?, true)?;
        let meta = fs::symlink_metadata(&path).map_err(|_| "Source metadata unavailable")?;
        if !crate::local_publish::ordinary(&meta) {
            return Err("Reparse points and unsupported sources are refused".into());
        }
        let directory = meta.is_dir();
        if directory && !recursive {
            return Err("Folders require recursive upload enabled".into());
        }
        let file = if directory {
            crate::local_publish::lock_dir(&path)
        } else {
            crate::local_publish::source_file(&path)
        }
        .map_err(|_| "Cannot lock source against mutation")?;
        let identity =
            crate::local_publish::identity(&file).map_err(|_| "Source identity unavailable")?;
        let locked = file.metadata().map_err(|_| "Source metadata unavailable")?;
        if locked.len() != meta.len() || locked.modified().ok() != meta.modified().ok() {
            return Err("Source changed during validation".into());
        }
        if directory {
            for child in fs::read_dir(&path).map_err(|_| "Cannot inventory source folder")? {
                let child = child.map_err(|_| "Cannot inventory source folder")?;
                let name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| "Unsupported source name")?;
                if pending.len() + result.entries.len() >= 10000 {
                    return Err("Upload exceeds 10,000 entries".into());
                }
                pending.push((child.path(), format!("{relative}/{name}"), depth + 1));
            }
        }
        result.entries.push(Entry {
            path,
            relative,
            directory,
            file,
            identity,
            size: locked.len(),
            modified: locked
                .modified()
                .map_err(|_| "Source timestamp unavailable")?,
        });
    }
    Ok(result)
}
pub fn revalidate(entry: &Entry) -> Result<(), String> {
    crate::file_ops::local_path(entry.path.to_str().ok_or("Unsupported source path")?, true)?;
    let reopened = if entry.directory {
        crate::local_publish::lock_dir(&entry.path)
    } else {
        crate::local_publish::source_file(&entry.path)
    }
    .map_err(|_| "Source changed or locked")?;
    let meta = entry
        .file
        .metadata()
        .map_err(|_| "Source metadata unavailable")?;
    if crate::local_publish::identity(&reopened).map_err(|_| "Source identity unavailable")?
        != entry.identity
        || meta.len() != entry.size
        || meta.modified().ok() != Some(entry.modified)
    {
        return Err("Source changed during upload".into());
    }
    Ok(())
}
fn run_inner(
    engine: &crate::engine::Engine,
    request: UploadRequest,
    profile: &crate::sftp::Profile,
    secret: &str,
    stop: &AtomicBool,
    choices: Option<&crate::transfer_choices::Exchange>,
) -> Result<UploadOutcome, String> {
    use std::net::ToSocketAddrs;
    if request.remote.split('/').any(|p| p == "." || p == "..") {
        return Err("Remote traversal is refused".into());
    }
    let remote = crate::sftp::normalize(&request.remote)?;
    let progress=engine.operation_progress(&request.id);
    if let Some(p)=&progress {p.phase("scanning");}
    let mut tree = inventory(&request.sources, request.recursive, stop)?;
    let total=crate::operation_progress::checked_byte_total(tree.entries.iter().filter(|e|!e.directory).map(|e|Some(e.size)))?;
    if let Some(p)=&progress {p.phase("connecting");}
    let endpoints = (profile.host.as_str(), profile.port)
        .to_socket_addrs()
        .map_err(|_| "Cannot resolve upload endpoint")?
        .collect();
    let (mut connection, identity) = crate::sftp::connect(profile, secret, stop)?;
    engine.reserve_upload_operation(
        &request.id,
        tree.roots.clone(),
        vec![remote.clone()],
        identity,
        endpoints,
    )?;
    if let Some(p)=&progress {p.plan("bytes",total);p.position(1,tree.entries.len());}
    match choices {Some(choices)=>crate::transfer_io::upload(&connection,&remote,&mut tree.entries,stop,choices,progress.as_deref()),None=>crate::sftp::upload_new(&mut connection,&remote,&mut tree.entries,stop,progress.as_deref())}
}
#[cfg(test)]
mod generated_tests {
    use super::*;
    use crate::{engine::Engine, sftp::Profile};
    use std::sync::atomic::Ordering;
    #[test]
    #[ignore = "generated localhost fixture runner only"]
    fn upload_generated_localhost_scenarios() {
        let manifest =
            std::env::var("NEARLY_UPLOAD_FIXTURE").expect("generated-only fixture required");
        let v: serde_json::Value = serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        assert_eq!(v["generatedOnly"], true);
        let root = PathBuf::from(v["root"].as_str().unwrap());
        let remote = PathBuf::from(v["remote"].as_str().unwrap());
        assert!(
            root.starts_with(
                std::env::current_dir()
                    .unwrap()
                    .parent()
                    .unwrap_or(&std::env::current_dir().unwrap())
                    .join("test-results")
            ) || root.starts_with(std::env::current_dir().unwrap().join("test-results"))
        );
        assert_eq!(remote, root.join("remote"));
        assert_eq!(
            PathBuf::from(v["key"].as_str().unwrap()),
            root.join("fixture-v3.ppk")
        );
        let profile = Profile {
            id: "upload-fixture".into(),
            name: "Generated localhost".into(),
            host: "127.0.0.1".into(),
            port: v["port"].as_u64().unwrap() as u16,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: v["key"].as_str().unwrap().into(),
            host_key: v["fingerprint"].as_str().unwrap().into(),
        };
        let secret = v["passphrase"].as_str().unwrap();
        assert!(inventory(
            &[root.join("junction-source").to_string_lossy().into()],
            true,
            &AtomicBool::new(false)
        )
        .is_err());
        let local = root.join("sources");
        fs::create_dir_all(local.join("tree/nested")).unwrap();
        fs::write(
            local.join("tree/nested/child.txt"),
            b"nested immutable source",
        )
        .unwrap();
        fs::write(local.join("one.txt"), b"immutable upload bytes").unwrap();
        let execute = |id: &str, names: &[&str], target: &str, recursive: bool| {
            let e = Engine::default();
            e.prepare_operation(id).unwrap();
            let stop = e.claim_prepared_upload(id).unwrap();
            let req = UploadRequest {
                id: id.into(),
                session_id: "fixture-session".into(),
                sources: names
                    .iter()
                    .map(|n| local.join(n).to_string_lossy().into())
                    .collect(),
                remote: target.into(),
                recursive, interactive:false,
            };
            let result = run(&e, req, &profile, secret, &stop);
            e.finish_operation(id);
            result
        };
        for dir in [
            "success",
            "collision",
            "partial",
            "race",
            "cancel",
            "symlink-parent",
            "case",
            "recursive-off",
        ] {
            fs::create_dir_all(remote.join(dir)).unwrap();
        }
        assert!(execute("remote-link", &["one.txt"], "/link-parent", false).is_err());
        assert!(!remote.join("other/one.txt").exists());
        let result = execute("success", &["one.txt", "tree"], "/success", true).unwrap();
        assert_eq!(result.status, UploadStatus::Completed);
        assert_eq!(result.completed, 4);
        assert_eq!(result.bytes, 45);
        assert_eq!(
            fs::read(remote.join("success/tree/nested/child.txt")).unwrap(),
            b"nested immutable source"
        );
        fs::write(remote.join("collision/one.txt"), b"preexisting sentinel").unwrap();
        assert!(execute("collision", &["tree", "one.txt"], "/collision", true).is_err());
        assert!(!remote.join("collision/tree").exists());
        assert_eq!(
            fs::read(remote.join("collision/one.txt")).unwrap(),
            b"preexisting sentinel"
        );
        fs::write(remote.join("case/ONE.TXT"), b"case sentinel").unwrap();
        assert!(execute("case", &["one.txt"], "/case", false).is_err());
        assert!(execute("recursive-off", &["tree"], "/recursive-off", false).is_err());
        assert!(fs::read_dir(remote.join("recursive-off"))
            .unwrap()
            .next()
            .is_none());
        let result = execute("race", &["one.txt"], "/race", false).unwrap();
        assert_eq!(result.status, UploadStatus::Partial);
        assert_eq!(result.completed, 0);
        assert!(result.message.contains("partial"));
        assert_eq!(
            fs::read(remote.join("race/one.txt")).unwrap(),
            b"race sentinel"
        );
        fs::write(local.join("large.bin"), vec![42; 100000]).unwrap();
        let result = execute("partial", &["large.bin"], "/partial", false).unwrap();
        assert_eq!(result.status, UploadStatus::Partial);
        assert_eq!(result.completed, 0);
        assert!(result.message.contains("partial"));
        assert!(remote.join("partial/large.bin").exists());
        let e = Engine::default();
        e.prepare_operation("cancel").unwrap();
        let stop = e.claim_prepared_upload("cancel").unwrap();
        let signal = root.join("cancel-observed");
        let worker_stop = stop.clone();
        let worker = std::thread::spawn(move || {
            for _ in 0..1000 {
                if signal.exists() {
                    worker_stop.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            panic!("No generated cancellation signal");
        });
        let result = run(
            &e,
            UploadRequest {
                id: "cancel".into(),
                session_id: "fixture".into(),
                sources: vec![local.join("large.bin").to_string_lossy().into()],
                remote: "/cancel".into(),
                recursive: false, interactive:false,
            },
            &profile,
            secret,
            &stop,
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(result.status, UploadStatus::Cancelled);
        assert_eq!(result.completed, 0);
        assert!(result.message.contains("partial"));
        assert_eq!(
            fs::read(local.join("one.txt")).unwrap(),
            b"immutable upload bytes"
        );
        assert_eq!(fs::read(local.join("large.bin")).unwrap(), vec![42; 100000]);
    }
}

pub fn run(
    engine: &crate::engine::Engine,
    request: UploadRequest,
    profile: &crate::sftp::Profile,
    secret: &str,
    stop: &AtomicBool,
) -> Result<UploadOutcome, String> {
    match run_inner(engine, request, profile, secret, stop, None) {
        Err(_) if stop.load(std::sync::atomic::Ordering::SeqCst) => Ok(UploadOutcome {
            status: UploadStatus::Cancelled,
            completed: 0,
            bytes: 0,
            transferred_bytes: 0,
            skipped: 0,
            message: "Upload cancelled before transfer; local sources retained.".into(),
        }),
        result => result,
    }
}
#[cfg(test)]
mod source_lock_tests {
    use super::*;
    #[test]
    fn upload_locked_reads_block_source_mutation_and_identity_replacement() {
        let root = std::env::temp_dir().join(format!("nearly-upload-lock-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("immutable.txt");
        fs::write(&source, b"immutable").unwrap();
        let inventory = inventory(
            &[source.to_string_lossy().into()],
            false,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(fs::OpenOptions::new().write(true).open(&source).is_err());
        assert!(fs::rename(&source, root.join("replaced.txt")).is_err());
        revalidate(&inventory.entries[0]).unwrap();
        drop(inventory);
        assert_eq!(fs::read(&source).unwrap(), b"immutable");
        fs::remove_dir_all(root).unwrap();
    }
}
#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn upload_bounds_sources_depth_and_unsafe_names() {
        let stop = AtomicBool::new(false);
        assert!(inventory(&vec!["C:\\unused".into(); 10001], true, &stop).is_err());
        for name in ["../escape", "CON.txt", "bad:stream", "trailing."] {
            assert!(
                crate::file_ops::validate_creation_name(name, crate::file_ops::Side::Local)
                    .is_err()
            );
        }
        let root = std::env::temp_dir().join(format!("nearly-upload-depth-{}", std::process::id()));
        let mut leaf = root.clone();
        for _ in 0..66 {
            leaf.push("d");
        }
        fs::create_dir_all(&leaf).unwrap();
        assert!(inventory(&[root.to_string_lossy().into()], true, &stop).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

pub fn run_interactive(engine:&crate::engine::Engine,request:UploadRequest,profile:&crate::sftp::Profile,secret:&str,stop:&AtomicBool,choices:&crate::transfer_choices::Exchange)->Result<UploadOutcome,String>{run_inner(engine,request,profile,secret,stop,Some(choices))}
