use crate::sftp::{self, Profile};
#[cfg(test)]
mod batch_request_tests {
    #[test]
    fn remote_multi_selection_is_one_request() {
        let request = serde_json::json!({"id":"batch","side":"remote","action":"delete","source":"/one","destination":null,"profile":null,"passphrase":"","confirmDelete":true,"items":[{"source":"/one","destination":null},{"source":"/two","destination":null}]});
        assert!(serde_json::from_value::<super::Request>(request).is_ok(), "remote selection must reach native as one operation");
    }
}
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(default)]
    pub items: Vec<Selection>,
    pub id: String,
    pub side: Side,
    pub action: Action,
    pub source: String,
    pub destination: Option<String>,
    pub profile: Option<Profile>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub passphrase: zeroize::Zeroizing<String>,
    pub confirm_delete: bool,
}
#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Local,
    Remote,
}
#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Copy,
    Move,
    Delete,
    CreateFile,
    Mkdir,
}
#[derive(Serialize)]
pub struct Outcome {
    #[serde(skip_serializing_if="Vec::is_empty")]
    pub items: Vec<ItemOutcome>,
    pub completed: usize,
    pub message: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {pub source:String,pub destination:Option<String>}
#[derive(Serialize)]
pub struct ItemOutcome {pub source:String,pub completed:bool,pub message:String,pub attempted:bool}
pub fn run(
    engine: &crate::engine::Engine,
    request: Request,
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    if !request.items.is_empty() {return remote_batch(engine,request,stop);}
    if matches!(request.action, Action::CreateFile | Action::Mkdir) {
        return create_entry(engine, request, stop);
    }
    let secret = request.passphrase;
    if request.action == Action::Delete && !request.confirm_delete {
        return Err("Explicit delete confirmation is required".into());
    }
    if request.action != Action::Delete && request.destination.is_none() {
        return Err("A full final destination path is required".into());
    }
    check(stop)?;
    match request.side {
        Side::Local => {
            let source = local_path(&request.source, true)?;
            if source.parent().is_none() {
                return Err("Filesystem root operations are refused".into());
            }
            let target = request
                .destination
                .as_deref()
                .map(|p| local_path(p, false))
                .transpose()?;
            if target.as_ref().is_some_and(|t| local_contains(&source, t)) {
                return Err("Cannot copy/move to the source or its descendant".into());
            }
            let mut paths = vec![source.clone()];
            if let Some(t) = &target {
                paths.push(t.clone());
            }
            engine.reserve_operation(
                &request.id,
                paths,
                vec![],
                String::new(),
                vec![],
                request.action != Action::Copy,
            )?;
            local(request.action, &source, target.as_deref(), stop)
        }
        Side::Remote => {
            let source = remote_path(&request.source)?;
            let target = request
                .destination
                .as_deref()
                .map(remote_path)
                .transpose()?;
            if let Some(target) = &target {
                validate_pair(&source, target)?;
            }
            let profile = request
                .profile
                .ok_or("Remote operation requires a profile")?;
            use std::net::ToSocketAddrs;
            let endpoints = (profile.host.as_str(), profile.port)
                .to_socket_addrs()
                .map_err(|_| "Cannot resolve remote endpoint")?
                .collect();
            let (mut connection, identity) = sftp::connect(&profile, &secret, stop)?;
            let mut paths = vec![source.clone()];
            if let Some(target) = &target {
                paths.push(target.clone());
            }
            engine.reserve_operation(&request.id, vec![], paths, identity, endpoints, false)?;
            let progress=engine.operation_progress(&request.id);
            sftp::file_operation_tracked(
                &mut connection,
                request.action,
                &source,
                target.as_deref(),
                stop,
                progress.as_deref(),
            ).map_err(|error|format!("{error} If a mutation was issued, a partial target or partially deleted tree may remain. Refresh before retrying."))
        }
    }
}
fn remote_batch(engine:&crate::engine::Engine,request:Request,stop:&AtomicBool)->Result<Outcome,String>{
    if request.side!=Side::Remote || !matches!(request.action,Action::Copy|Action::Delete) || request.items.len()>1000 {return Err("Only remote copy/delete selections of at most 1,000 roots can be batched".into());}
    if request.action==Action::Delete && !request.confirm_delete{return Err("Explicit delete confirmation is required".into());}
    let mut paths:Vec<String>=Vec::new();let mut selected=Vec::new();
    for item in &request.items {
        let source=remote_path(&item.source)?;
        let target=if request.action==Action::Delete {if item.destination.is_some(){return Err("Delete must not specify a target".into());}None}else{Some(remote_path(item.destination.as_deref().ok_or("Copy requires destination")?)?)};
        if let Some(t)=&target{validate_pair(&source,t)?;}
        // Reject overlaps across ALL sources and targets before connecting/mutating.
        for path in std::iter::once(&source).chain(target.iter()) {if paths.iter().any(|p|sftp::overlap(p,path)){return Err("Overlapping batch paths are refused".into());}paths.push(path.clone());}
        selected.push((source,target));
    }
    check(stop)?;
    let profile=request.profile.ok_or("Remote operation requires a profile")?;
    use std::net::ToSocketAddrs;
    let endpoints=(profile.host.as_str(),profile.port).to_socket_addrs().map_err(|_|"Cannot resolve remote endpoint")?.collect();
    let (mut connection,identity)=sftp::connect(&profile,&request.passphrase,stop)?;
    engine.reserve_operation(&request.id,vec![],paths,identity,endpoints,false)?;
    let progress=engine.operation_progress(&request.id);let mut outcomes=Vec::new();let mut failed=false;let mut completed=0;
    for (index,(source,target)) in selected.iter().enumerate(){
        if failed || stop.load(Ordering::SeqCst){outcomes.push(ItemOutcome{source:source.clone(),completed:false,attempted:false,message:"Not attempted after cancellation or earlier failure; refresh before retrying".into()});continue;}
        if let Some(p)=&progress{p.item(index+1,selected.len());}
        match sftp::file_operation_tracked(&mut connection,request.action,source,target.as_deref(),stop,progress.as_deref()){
            Ok(out)=>{completed+=out.completed;outcomes.push(ItemOutcome{source:source.clone(),completed:true,attempted:true,message:out.message});}
            Err(error)=>{failed=true;outcomes.push(ItemOutcome{source:source.clone(),completed:false,attempted:true,message:format!("{error}. Partial/uncertain targets may remain; refresh before retrying")});}
        }
    }
    Ok(Outcome{completed,items:outcomes,message:"Remote selection finished; inspect individual results and refresh".into()})
}
pub fn validate_creation_name(name: &str, side: Side) -> Result<(), String> {
    if name.is_empty()
        || name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.encode_utf16().count() > 255
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err("Use a single name of 1 to 255 characters without separators, traversal or control characters".into());
    }
    if side == Side::Local {
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|suffix| {
                    matches!(
                        suffix,
                        "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
        if name.contains(['<', '>', '\"', ':', '|', '?', '*'])
            || name.ends_with(['.', ' '])
            || reserved
        {
            return Err("Windows reserved names, alternate streams, special characters and trailing dots/spaces are refused".into());
        }
    }
    Ok(())
}
fn local_creation_paths(parent: &str, target: &str) -> Result<(PathBuf, PathBuf), String> {
    if [parent, target]
        .iter()
        .any(|p| p.split(['\\', '/']).any(|part| part == "." || part == ".."))
    {
        return Err("Path traversal is refused".into());
    }
    #[cfg(windows)]
    {
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
        let bytes = parent.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'/' | b'\\')
        {
            return Err("Creation requires an ordinary absolute local drive folder".into());
        }
        let root = format!("{}:\\", bytes[0] as char);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        match unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } {
            4 => return Err("Creation on network drives is unsupported".into()),
            0 | 1 => return Err("Creation parent drive is unavailable".into()),
            _ => {}
        }
    }
    let name = Path::new(target)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Creation target needs one filename")?;
    validate_creation_name(name, Side::Local)?;
    let parent = local_path(parent, true)?;
    let target = local_path(target, false)?;
    let target_parent = target.parent().ok_or("Creation target needs a parent")?;
    if !local_contains(&parent, target_parent) || !local_contains(target_parent, &parent) {
        return Err("Creation target must be one immediate child of the selected parent".into());
    }
    Ok((parent, target))
}
pub fn remote_creation_paths(parent: &str, target: &str) -> Result<(String, String), String> {
    if parent.split('/').any(|part| part == "." || part == "..") {
        return Err("Path traversal is refused".into());
    }
    if parent.chars().any(char::is_control) {
        return Err("Path traversal is refused".into());
    }
    let parent = sftp::normalize(parent)?;
    let target = remote_path(target)?;
    let name = target
        .rsplit('/')
        .next()
        .ok_or("Creation target needs one filename")?;
    validate_creation_name(name, Side::Remote)?;
    let expected = format!("{}/{}", parent.trim_end_matches('/'), name);
    if target != expected {
        return Err("Creation target must be one immediate child of the selected parent".into());
    }
    Ok((parent, target))
}
struct LocalCreation {
    target: PathBuf,
    _parents: Vec<fs::File>,
}
impl LocalCreation {
    fn prepare(parent: &Path, target: &Path) -> Result<Self, String> {
        let mut parents = Vec::new();
        for path in parent.ancestors().collect::<Vec<_>>().into_iter().rev() {
            parents.push(lock_directory(path)?);
        }
        local_path(parent.to_str().ok_or("Unsupported creation parent")?, true)?;
        local_path(target.to_str().ok_or("Unsupported creation target")?, false)?;
        Ok(Self {
            target: target.to_path_buf(),
            _parents: parents,
        })
    }
    fn commit(self, action: Action, stop: &AtomicBool) -> Result<Outcome, String> {
        // Final cancellation gate is deliberately after reservation, validation and parent locks.
        check(stop)?;
        match action {
            Action::CreateFile => {
                let file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&self.target)
                    .map_err(|_| "New file creation failed; no existing item was overwritten")?;
                file.sync_all().map_err(|_| {
                    "New file may already exist; creation flush failed. Refresh before retrying"
                })?;
            }
            Action::Mkdir => fs::create_dir(&self.target)
                .map_err(|_| "New folder creation failed; no existing item was overwritten")?,
            _ => return Err("Unsupported creation action".into()),
        }
        Ok(Outcome {
        items:vec![],
            completed: 1,
            message: "Created one new entry; refresh its parent folder.".into(),
        })
    }
}
fn create_entry(
    engine: &crate::engine::Engine,
    request: Request,
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    check(stop)?;
    let target = request
        .destination
        .as_deref()
        .ok_or("A full final destination path is required")?;
    match request.side {
        Side::Local => {
            let (parent, target) = local_creation_paths(&request.source, target)?;
            engine.reserve_operation(
                &request.id,
                vec![target.clone()],
                vec![],
                String::new(),
                vec![],
                false,
            )?;
            LocalCreation::prepare(&parent, &target)?.commit(request.action, stop)
        }
        Side::Remote => {
            let (parent, target) = remote_creation_paths(&request.source, target)?;
            let profile = request
                .profile
                .ok_or("Remote operation requires a profile")?;
            use std::net::ToSocketAddrs;
            let endpoints = (profile.host.as_str(), profile.port)
                .to_socket_addrs()
                .map_err(|_| "Cannot resolve remote endpoint")?
                .collect();
            let (mut connection, identity) = sftp::connect(&profile, &request.passphrase, stop)?;
            engine.reserve_operation(
                &request.id,
                vec![],
                vec![target.clone()],
                identity,
                endpoints,
                false,
            )?;
            sftp::create_entry(&mut connection, request.action, &parent, &target, stop)
        }
    }
}
pub fn check(stop: &AtomicBool) -> Result<(), String> {
    if stop.load(Ordering::SeqCst) {
        Err("Operation cancelled. A previously issued rename/recycle/delete may have completed; partial copies or deletions may remain. Refresh before retrying.".into())
    } else {
        Ok(())
    }
}
pub fn remote_path(path: &str) -> Result<String, String> {
    if path.split('/').any(|part| part == ".." || part == ".") {
        return Err("Path traversal is refused".into());
    }
    let path = sftp::normalize(path)?;
    if path == "/" {
        return Err("Remote filesystem root operations are refused".into());
    }
    Ok(path)
}
pub fn validate_pair(source: &str, target: &str) -> Result<(), String> {
    if source == target || target.starts_with(&format!("{source}/")) {
        return Err("Destination must differ from source and cannot be inside it".into());
    }
    Ok(())
}
fn reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub fn local_path(path: &str, exists: bool) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || path
            .to_string_lossy()
            .split(['/', '\\'])
            .any(|p| p == "." || p == "..")
    {
        return Err("Use an absolute local path without traversal".into());
    }
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if text.starts_with("\\\\")
            || text.get(2..).is_some_and(|s| s.contains(':'))
            || text.chars().any(|c| c.is_control())
        {
            return Err("Only ordinary local drive paths are supported; network/device paths and alternate streams are refused".into());
        }
        for component in path.components() {
            if let Component::Normal(name) = component {
                let name = name.to_string_lossy();
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                if name.ends_with(['.', ' '])
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && stem.as_bytes()[3].is_ascii_digit()
                {
                    return Err("Ambiguous or reserved Windows filename refused".into());
                }
            }
        }
    }
    let mut current = PathBuf::new();
    let count = path.components().count();
    for (index, part) in path.components().enumerate() {
        current.push(part);
        if index + 1 == count && !exists {
            match fs::symlink_metadata(&current) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => return Err("Destination already exists; overwrite is unsupported".into()),
                Err(_) => return Err("Destination metadata unavailable".into()),
            }
        } else if !matches!(part, Component::Prefix(_)) {
            let meta = fs::symlink_metadata(&current).map_err(|_| "Local path unavailable")?;
            if reparse(&meta) {
                return Err("Symlinks and reparse points are refused".into());
            }
            if index + 1 < count && !meta.is_dir() {
                return Err("Local parent is not a directory".into());
            }
        }
    }
    if exists {
        dunce::canonicalize(path).map_err(|_| "Local canonical path unavailable".into())
    } else {
        let parent = dunce::canonicalize(path.parent().ok_or("Destination needs a parent")?)
            .map_err(|_| "Destination parent unavailable")?;
        Ok(parent.join(path.file_name().ok_or("Destination needs a name")?))
    }
}
pub fn local_contains(parent: &Path, child: &Path) -> bool {
    #[cfg(windows)]
    {
        let a = dunce::simplified(parent).to_string_lossy().to_lowercase();
        let b = dunce::simplified(child).to_string_lossy().to_lowercase();
        b == a || b.starts_with(&(a.trim_end_matches('\\').to_owned() + "\\"))
    }
    #[cfg(not(windows))]
    {
        child.starts_with(parent)
    }
}
#[derive(Clone)]
pub struct LocalItem {
    path: PathBuf,
    dir: bool,
    size: u64,
}
fn lock_directory(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_READ_ATTRIBUTES; share read/write but deny directory replacement.
        // BACKUP_SEMANTICS opens directories; OPEN_REPARSE_POINT never follows links.
        options
            .access_mode(0x80)
            .share_mode(3)
            .custom_flags(0x02200000);
    }
    #[cfg(not(windows))]
    {
        options.read(true);
    }
    let file = options
        .open(path)
        .map_err(|_| "Cannot lock local parent against replacement; operation refused")?;
    let meta = file
        .metadata()
        .map_err(|_| "Directory handle metadata unavailable")?;
    if reparse(&meta) || !meta.is_dir() {
        return Err("Local parent changed to a reparse point or unsupported entry".into());
    }
    Ok(file)
}
fn open_copy_source(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let file = options
        .open(path)
        .map_err(|_| "Copy source unavailable or changing; partial target retained")?;
    let meta = file
        .metadata()
        .map_err(|_| "Copy source handle metadata unavailable")?;
    if reparse(&meta) || !meta.is_file() {
        return Err(
            "Copy source is a reparse point or unsupported entry; partial target retained".into(),
        );
    }
    Ok(file)
}
fn local_tree(
    source: &Path,
    stop: &AtomicBool,
    lock_dirs: bool,
) -> Result<(Vec<LocalItem>, Vec<fs::File>), String> {
    let mut pending = vec![(source.to_path_buf(), 0)];
    let mut out = Vec::new();
    let mut locks = Vec::new();
    while let Some((path, depth)) = pending.pop() {
        check(stop)?;
        if depth > 64 || out.len() >= 10000 {
            return Err("Operation tree exceeds 10,000 entries or depth 64".into());
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| "Source metadata unavailable")?;
        if reparse(&meta) || (!meta.is_dir() && !meta.is_file()) {
            return Err("Source tree contains an unsupported entry, symlink or reparse point; nothing was changed".into());
        }
        out.push(LocalItem {
            path: path.clone(),
            dir: meta.is_dir(),
            size: meta.len(),
        });
        if meta.is_dir() {
            if lock_dirs {
                locks.push(lock_directory(&path)?);
            }
            for entry in fs::read_dir(&path).map_err(|_| "Source directory unavailable")? {
                if pending.len() + out.len() >= 10000 {
                    return Err("Operation tree exceeds 10,000 entries".into());
                }
                pending.push((
                    entry.map_err(|_| "Source entry unavailable")?.path(),
                    depth + 1,
                ));
            }
        }
    }
    Ok((out, locks))
}
pub fn local(
    action: Action,
    source: &Path,
    destination: Option<&Path>,
    stop: &AtomicBool,
) -> Result<Outcome, String> {
    // Keep existing ancestor directories stable across local operations. Copy
    // additionally locks source and newly-created destination directories.
    let mut parent_locks = Vec::new();
    for item in [Some(source), destination].into_iter().flatten() {
        let parent = item
            .parent()
            .ok_or("Filesystem root operations are refused")?;
        let ancestors: Vec<_> = parent.ancestors().collect();
        for ancestor in ancestors.into_iter().rev() {
            parent_locks.push(lock_directory(ancestor)?);
        }
    }
    let (tree, _source_locks) = local_tree(source, stop, action == Action::Copy)?;
    check(stop)?;
    match action {
        Action::CreateFile | Action::Mkdir => {
            return Err("Creation requires its dedicated validation path".into())
        }
        Action::Delete => {
            local_path(source.to_str().ok_or("Unsupported path")?, true)?;
            recycle(source, stop)?;
        }
        Action::Move => {
            let destination = destination.ok_or("Move requires destination")?;
            local_path(source.to_str().ok_or("Unsupported path")?, true)?;
            local_path(destination.to_str().ok_or("Unsupported path")?, false)?;
            check(stop)?;
            rename_without_replace(source, destination)?;
        }
        Action::Copy => {
            let destination = destination.ok_or("Copy requires destination")?;
            for item in &tree {
                check(stop)?;
                local_path(item.path.to_str().ok_or("Unsupported source path")?, true)?;
                let target = destination.join(
                    item.path
                        .strip_prefix(source)
                        .map_err(|_| "Source escaped tree")?,
                );
                local_path(target.to_str().ok_or("Unsupported target path")?, false)?;
                if item.dir {
                    fs::create_dir(&target)
                        .map_err(|_| "Copy directory creation failed; partial target retained")?;
                    parent_locks.push(lock_directory(&target)?);
                } else {
                    let mut input = open_copy_source(&item.path)?;
                    let before = input
                        .metadata()
                        .map_err(|_| "Copy source metadata unavailable")?;
                    let mut output=fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_|"Copy target creation failed; no existing item overwritten; partial target retained")?;
                    let mut buf = [0u8; 65536];
                    let mut bytes = 0;
                    loop {
                        check(stop)?;
                        let n = input
                            .read(&mut buf)
                            .map_err(|_| "Copy read failed; partial target retained")?;
                        if n == 0 {
                            break;
                        }
                        output
                            .write_all(&buf[..n])
                            .map_err(|_| "Copy write failed; partial target retained")?;
                        bytes += n as u64;
                    }
                    output
                        .sync_all()
                        .map_err(|_| "Copy flush failed; partial target retained")?;
                    let after = fs::metadata(&item.path)
                        .map_err(|_| "Source changed; partial target retained")?;
                    if bytes != item.size
                        || after.len() != before.len()
                        || after.modified().ok() != before.modified().ok()
                    {
                        return Err("Source changed during copy; partial target retained; source was not removed".into());
                    }
                }
            }
        }
    }
    Ok(Outcome {
        items:vec![],
        completed: tree.len(),
        message:
            "Operation completed. Refresh the folders to reconcile any concurrent external changes."
                .into(),
    })
}
#[cfg(windows)]
fn rename_without_replace(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS},
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Neither REPLACE_EXISTING nor COPY_ALLOWED: collisions and cross-volume
    // moves fail atomically, including a destination created after preflight.
    unsafe {MoveFileExW(PCWSTR(source.as_ptr()),PCWSTR(target.as_ptr()),MOVE_FILE_FLAGS(0))}.map_err(|_|"Move refused (destination collision, cross-volume or permissions). No overwrite or delete-before-copy fallback was attempted; refresh before retrying".into())
}
#[cfg(not(windows))]
fn rename_without_replace(_: &Path, _: &Path) -> Result<(), String> {
    Err("Atomic no-replace move is only implemented on Windows; source retained".into())
}
#[cfg(windows)]
fn recycle(path: &Path, stop: &AtomicBool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::Shell::{
                BHID_Transfer, FOLDERID_RecycleBinFolder, IShellItem, ITransferSource,
                SHCreateItemFromParsingName, SHGetKnownFolderItem, KF_FLAG_DEFAULT,
            },
        },
    };
    // Use the explicit recycle primitive. It has no permanent-delete fallback;
    // unlike DeleteItem + ALLOWUNDO we never invoke RemoveItem/DeleteFile.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "Recycle COM initialization failed; source retained")?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() }
            }
        }
        let _apartment = Apartment;
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let source: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None)
            .map_err(|_| "Recycle source unavailable; source retained")?;
        let parent = source
            .GetParent()
            .map_err(|_| "Recycle parent unavailable; source retained")?;
        let transfer: ITransferSource = parent
            .BindToHandler(None, &BHID_Transfer)
            .map_err(|_| "This location does not support safe recycling; source retained")?;
        let bin: IShellItem =
            SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None)
                .map_err(|_| "Recycle Bin unavailable; source retained")?;
        check(stop)?;
        let _recycled=transfer.RecycleItem(&source,&bin,0).map_err(|_|"Windows could not recycle this item. No permanent-delete fallback was attempted; refresh to verify the source")?;
    }
    Ok(())
}
#[cfg(not(windows))]
fn recycle(_: &Path, _: &AtomicBool) -> Result<(), String> {
    Err("Recycle-only deletion is supported on Windows only; source retained".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_remote_paths_and_self_copy() {
        for path in ["/a/../b", "/a/./b", "/", "relative", "/a\\b"] {
            assert!(remote_path(path).is_err(), "{path}");
        }
        assert!(validate_pair("/a", "/a/b").is_err());
        assert!(validate_pair("/a", "/a").is_err());
        assert!(validate_pair("/a", "/ab").is_ok());
    }
    fn fixture() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "syncfiles-fileops-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        // Engine reservations receive canonical paths from local_path in production.
        // Windows runners can expose an 8.3 alias through the temporary directory.
        dunce::canonicalize(path).unwrap()
    }
    #[test]
    fn creation_final_cancel_after_reservation_and_locked_validation_has_zero_mutations() {
        let root = fixture();
        let target = root.join("cancelled");
        let engine = crate::engine::Engine::default();
        let stop = engine.claim_operation("final-cancel").unwrap();
        let (parent, target) =
            local_creation_paths(root.to_str().unwrap(), target.to_str().unwrap()).unwrap();
        engine
            .reserve_operation(
                "final-cancel",
                vec![target.clone()],
                vec![],
                String::new(),
                vec![],
                false,
            )
            .unwrap();
        let ready = LocalCreation::prepare(&parent, &target).unwrap();
        engine.cancel_operation("final-cancel").unwrap();
        assert!(ready.commit(Action::CreateFile, &stop).is_err());
        assert!(!target.exists());
        engine.finish_operation("final-cancel");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_names_root_parents_and_last_moment_collision_are_safe() {
        for name in ["", " ", ".", "..", "a/b", "a\\b", "a\u{85}b"] {
            assert!(validate_creation_name(name, Side::Remote).is_err());
        }
        assert!(validate_creation_name(&"😀".repeat(128), Side::Remote).is_err());
        for name in [
            "CON.txt", "COM¹", "LPT9", "CON .txt", "name.", "name ", "a:b", "a?b",
        ] {
            assert!(validate_creation_name(name, Side::Local).is_err());
        }
        assert!(validate_creation_name("CON.txt", Side::Remote).is_ok());
        assert_eq!(
            remote_creation_paths("/", "/設定").unwrap(),
            ("/".into(), "/設定".into())
        );
        for (p, t) in [
            ("/", "/a/b"),
            ("/a", "/b"),
            ("/a/..", "/ok"),
            ("/", "/../ok"),
        ] {
            assert!(remote_creation_paths(p, t).is_err());
        }
        let root = fixture();
        let target = root.join("kept");
        assert!(local_creation_paths(
            &format!("{}\\.\\", root.display()),
            target.to_str().unwrap()
        )
        .is_err());
        let ready = LocalCreation::prepare(&root, &target).unwrap();
        fs::write(&target, b"external").unwrap();
        assert!(ready
            .commit(Action::CreateFile, &AtomicBool::new(false))
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"external");
        #[cfg(windows)]
        {
            let drive = root.ancestors().last().unwrap();
            assert!(local_creation_paths(
                drive.to_str().unwrap(),
                &drive.join("creation-test-never-written").to_string_lossy()
            )
            .is_ok());
            assert!(local_creation_paths("D:", "D:\\bad").is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_refuses_reparse_parent_and_existing_link_target() {
        let root = fixture();
        fs::create_dir_all(root.join("real")).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(root.join("link"))
                .arg(root.join("real"))
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        assert!(local_creation_paths(
            &root.join("link").to_string_lossy(),
            &root.join("link/new").to_string_lossy()
        )
        .is_err());
        assert!(local_creation_paths(
            &root.to_string_lossy(),
            &root.join("link").to_string_lossy()
        )
        .is_err());
        #[cfg(windows)]
        fs::remove_dir(root.join("link")).unwrap();
        #[cfg(not(windows))]
        fs::remove_file(root.join("link")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "requires explicit generated localhost fixture metadata"]
    fn creation_generated_localhost_fixture() {
        let path =
            std::env::var("NEARLY_CREATE_FIXTURE").expect("explicit generated fixture required");
        let data: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let profile: Profile = serde_json::from_value(data["profile"].clone()).unwrap();
        assert_eq!(profile.host, "127.0.0.1");
        let key = Path::new(&profile.key_file).canonicalize().unwrap();
        let root = Path::new(&path).parent().unwrap().canonicalize().unwrap();
        assert!(key.starts_with(&root));
        let secret = data["passphrase"].as_str().unwrap();
        let engine = std::sync::Arc::new(crate::engine::Engine::default());
        let call = |id: &str, action: &str, parent: &str, target: &str| {
            let stop = engine.claim_operation(id).unwrap();
            let request:Request=serde_json::from_value(serde_json::json!({"id":id,"side":"remote","action":action,"source":parent,"destination":target,"profile":profile,"passphrase":secret,"confirmDelete":false})).unwrap();
            let result = run(&engine, request, &stop);
            engine.finish_operation(id);
            result
        };
        for (id, action, parent, target) in [
            ("file", "createfile", "/", "/created-empty"),
            ("dir", "mkdir", "/", "/created-dir"),
            ("child", "createfile", "/created-dir", "/created-dir/child"),
        ] {
            assert_eq!(call(id, action, parent, target).unwrap().completed, 1);
        }
        assert!(call("collision", "createfile", "/", "/keep").is_err());
        assert!(call("late-collision", "createfile", "/", "/late-collision").is_err());
        assert!(call("nested", "mkdir", "/", "/missing/deep").is_err());
        assert!(call("symlink", "createfile", "/link", "/link/no-write").is_err());
        assert!(call("denied", "createfile", "/", "/stat-denied").is_err());
        let stop = engine.claim_operation("remote-final-cancel").unwrap();
        let stop_clone = stop.clone();
        let signal = root.join("cancel-request");
        let ack = root.join("cancel-ack");
        let cancel = std::thread::spawn(move || {
            let begin = std::time::Instant::now();
            while !signal.exists() {
                assert!(begin.elapsed() < std::time::Duration::from_secs(15));
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            stop_clone.store(true, Ordering::SeqCst);
            fs::write(ack, b"cancelled").unwrap();
        });
        let request:Request=serde_json::from_value(serde_json::json!({"id":"remote-final-cancel","side":"remote","action":"createfile","source":"/","destination":"/cancel-after-validation","profile":profile,"passphrase":secret,"confirmDelete":false})).unwrap();
        assert!(run(&engine, request, &stop).is_err());
        engine.finish_operation("remote-final-cancel");
        cancel.join().unwrap();
    }
    fn create_request(id: &str, action: &str, parent: &Path, target: &Path) -> Request {
        serde_json::from_value(serde_json::json!({"id":id,"side":"local","action":action,"source":parent.to_str().unwrap(),"destination":target.to_str().unwrap(),"passphrase":"","confirmDelete":false})).expect("creation action must deserialize")
    }
    #[test]
    fn create_entries_are_empty_single_children_and_collisions_never_overwrite() {
        let root = fixture();
        let engine = crate::engine::Engine::default();
        for (id, action, name) in [
            ("new-file", "createfile", "設定.txt"),
            ("new-folder", "mkdir", "folder"),
        ] {
            let target = root.join(name);
            let token = engine.claim_operation(id).unwrap();
            let out = run(&engine, create_request(id, action, &root, &target), &token).unwrap();
            assert_eq!(out.completed, 1);
            engine.finish_operation(id);
            if action == "createfile" {
                assert!(target.is_file());
                assert_eq!(fs::metadata(&target).unwrap().len(), 0);
                fs::write(&target, b"keep").unwrap();
            } else {
                assert!(target.is_dir());
                fs::write(target.join("keep"), b"keep").unwrap();
            }
            let retry = engine.claim_operation("collision").unwrap();
            assert!(run(
                &engine,
                create_request("collision", action, &root, &target),
                &retry
            )
            .is_err());
            engine.finish_operation("collision");
            assert_eq!(
                fs::read(if action == "createfile" {
                    target
                } else {
                    target.join("keep")
                })
                .unwrap(),
                b"keep"
            );
        }
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_rejects_sibling_nested_targets_and_cancelled_preparation_before_mutation() {
        let root = fixture();
        let engine = crate::engine::Engine::default();
        let sibling = root.with_extension("outside");
        for (i, target) in [sibling.clone(), root.join("missing/child")]
            .iter()
            .enumerate()
        {
            let id = format!("bad-{i}");
            let token = engine.claim_operation(&id).unwrap();
            assert!(run(
                &engine,
                create_request(&id, "createfile", &root, target),
                &token
            )
            .is_err());
            engine.finish_operation(&id);
            assert!(!target.exists());
        }
        let target = root.join("cancelled");
        let token = engine.prepare_operation("cancelled-create").unwrap();
        engine.cancel_operation("cancelled-create").unwrap();
        let claimed = engine.claim_operation("cancelled-create").unwrap();
        assert!(std::sync::Arc::ptr_eq(&token, &claimed));
        assert!(run(
            &engine,
            create_request("cancelled-create", "mkdir", &root, &target),
            &claimed
        )
        .is_err());
        engine.finish_operation("cancelled-create");
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creation_reserves_only_target_and_conflicting_reservation_refuses_no_mutation() {
        let root = fixture();
        let engine = crate::engine::Engine::default();
        let protected = root.join("protected");
        engine.prepare_operation("other").unwrap();
        engine
            .reserve_operation(
                "other",
                vec![protected.clone()],
                vec![],
                String::new(),
                vec![],
                false,
            )
            .unwrap();
        let free = root.join("free");
        let token = engine.claim_operation("free-create").unwrap();
        run(
            &engine,
            create_request("free-create", "mkdir", &root, &free),
            &token,
        )
        .unwrap();
        engine.finish_operation("free-create");
        let token = engine.claim_operation("blocked-create").unwrap();
        assert!(run(
            &engine,
            create_request("blocked-create", "createfile", &root, &protected),
            &token
        )
        .is_err());
        engine.finish_operation("blocked-create");
        engine.finish_operation("other");
        assert!(!protected.exists());
        assert!(free.is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn generated_local_tree_copy_move_and_collision_preserve_source() {
        let root = fixture();
        let source = root.join("source");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("nested")).unwrap();
        fs::write(source.join("nested/data"), vec![42; 150000]).unwrap();
        let target = root.join("copy");
        let stop = AtomicBool::new(false);
        let copied = local(Action::Copy, &source, Some(&target), &stop).unwrap();
        assert_eq!(copied.completed, 3);
        assert_eq!(
            fs::read(target.join("nested/data")).unwrap(),
            vec![42; 150000]
        );
        assert!(local(Action::Copy, &source, Some(&target), &stop).is_err());
        assert!(source.join("nested/data").is_file());
        let moved = root.join("moved");
        local(Action::Move, &target, Some(&moved), &stop).unwrap();
        assert!(!target.exists());
        assert!(moved.join("nested/data").exists());
        assert!(local(Action::Move, &source, Some(&moved), &stop).is_err());
        assert!(source.exists());
        stop.store(true, Ordering::SeqCst);
        assert!(local(Action::Copy, &source, Some(&root.join("cancelled")), &stop).is_err());
        assert!(!root.join("cancelled").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn atomic_rename_refuses_target_even_without_preflight() {
        let root = fixture();
        let source = root.join("source");
        let target = root.join("target");
        fs::write(&source, b"source").unwrap();
        fs::write(&target, b"existing").unwrap();
        assert!(rename_without_replace(&source, &target).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&target).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn local_device_stream_and_ambiguous_paths_are_refused() {
        for path in [
            "C:\\NUL",
            "C:\\folder\\COM1.txt",
            "C:\\folder\\file:stream",
            "C:\\folder\\trailing. ",
            "\\\\server\\share\\file",
            "\\\\?\\C:\\file",
            "C:\\folder\\..\\file",
        ] {
            assert!(local_path(path, false).is_err(), "{path}");
        }
    }
    #[cfg(windows)]
    #[test]
    fn local_reservations_match_canonical_verbatim_prefix_and_case() {
        assert!(local_contains(
            Path::new("C:\\Generated"),
            Path::new("\\\\?\\c:\\generated\\Root")
        ));
        assert!(local_contains(
            Path::new("\\\\?\\C:\\Generated"),
            Path::new("c:\\generated\\Root")
        ));
        assert!(!local_contains(
            Path::new("C:\\Generated"),
            Path::new("C:\\Generated-other")
        ));
    }
    #[cfg(windows)]
    #[test]
    fn junction_in_tree_or_parent_refused_before_any_target_creation() {
        let root = fixture();
        let source = root.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("safe.txt"), b"safe").unwrap();
        let external = root.join("external");
        fs::create_dir(&external).unwrap();
        // No OS privilege change: creating a directory junction is supported by
        // the generated fixture integration test; std's directory symlink may
        // require Developer Mode, so test a symlink only when already permitted.
        if std::os::windows::fs::symlink_dir(&external, source.join("link")).is_ok() {
            assert!(local_path(source.join("link").to_str().unwrap(), true).is_err());
            let target = root.join("target");
            assert!(local(
                Action::Copy,
                &source,
                Some(&target),
                &AtomicBool::new(false)
            )
            .is_err());
            assert!(!target.exists());
            assert!(source.join("safe.txt").exists());
            fs::remove_dir(source.join("link")).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn generated_tree_depth_limit_fails_before_target_creation() {
        let root = fixture();
        let source = root.join("source");
        fs::create_dir(&source).unwrap();
        let mut current = source.clone();
        for _ in 0..65 {
            current = current.join("d");
            fs::create_dir(&current).unwrap();
        }
        let target = root.join("target");
        assert!(local(
            Action::Copy,
            &source,
            Some(&target),
            &AtomicBool::new(false)
        )
        .is_err());
        assert!(!target.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn generated_local_file_is_recycled_without_permanent_delete_api() {
        let root = fixture();
        let source = root.join("recycle-fixture.txt");
        fs::write(&source, b"generated recycle fixture").unwrap();
        let result = recycle(&source, &AtomicBool::new(false));
        assert!(result.is_ok(), "Recycle-only API: {result:?}");
        assert!(!source.exists());
        fs::remove_dir(root).unwrap();
    }
}
