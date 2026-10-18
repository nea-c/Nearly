//! Five EXE-adjacent documents. No legacy reader, migration or automatic recovery.
//! Root manifest commits last; interrupted multi-file publication fails closed.
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(crate) const NAMES: [&str; 5] = [
    "settings.json",
    "history.json",
    "bookmarks.json",
    "sync-profiles.json",
    "connections.json",
];
const KINDS: [&str; 5] = [
    "settings",
    "history",
    "bookmarks",
    "sync-profiles",
    "connections",
];
const LIMIT: usize = 16_000_000;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Default, Clone)]
pub(crate) struct Snapshot {
    bytes: [Option<Vec<u8>>; 5],
}
fn digest(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn failure(name: &str, reason: &str) -> String {
    format!("{name}: {reason}; no defaults or automatic recovery. Restore explicitly with Nearly stopped")
}
fn location(anchor: &Path, index: usize) -> Result<PathBuf, String> {
    if anchor.file_name().and_then(|s| s.to_str()) != Some("settings.json") {
        return Err("Storage anchor must be settings.json".into());
    }
    Ok(anchor.with_file_name(NAMES[index]))
}
fn regular(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if m.file_attributes() & 0x400 != 0 {
                    return Err(failure(
                        &path.display().to_string(),
                        "reparse point refused",
                    ));
                }
            }
            if !m.is_file() || m.file_type().is_symlink() {
                return Err(failure(&path.display().to_string(), "not a regular file"));
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(failure(
            &path.display().to_string(),
            "file status unavailable",
        )),
    }
}
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !regular(path)? {
        return Ok(None);
    }
    let file =
        fs::File::open(path).map_err(|_| failure(&path.display().to_string(), "unavailable"))?;
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure(&path.display().to_string(), "read failed"))?;
    if bytes.len() > LIMIT {
        return Err(failure(&path.display().to_string(), "size exceeds 16 MB"));
    }
    Ok(Some(bytes))
}
fn capture(anchor: &Path) -> Result<Snapshot, String> {
    let mut snapshot = Snapshot::default();
    let mut total = 0;
    for i in 0..5 {
        snapshot.bytes[i] = read_bytes(&location(anchor, i)?)?;
        total += snapshot.bytes[i].as_ref().map_or(0, Vec::len);
    }
    if total > LIMIT {
        return Err("Combined settings exceed 16 MB".into());
    }
    Ok(snapshot)
}
fn parse(bytes: &[u8], i: usize) -> Result<Value, String> {
    serde_json::from_slice::<super::unified_settings::UniqueJson>(bytes)
        .map_err(|_| failure(NAMES[i], "invalid JSON or duplicate key"))?;
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| failure(NAMES[i], "invalid JSON"))?;
    let Some(object) = value.as_object() else {
        return Err(failure(NAMES[i], "object required"));
    };
    if value["schemaVersion"] != 1 || value["kind"] != KINDS[i] {
        return Err(failure(
            NAMES[i],
            "unsupported format; legacy files require the separate external one-time conversion",
        ));
    }
    if !value["revision"]
        .as_u64()
        .is_some_and(|v| v > 0 && v <= MAX_REVISION)
    {
        return Err(failure(NAMES[i], "invalid revision"));
    }
    let allowed: &[&str] = match i {
        0 => &["appearance", "paneColumns", "paneSorts", "manifest"],
        1 => &["folderMappings", "browseLocations", "folderPairHistory", "localFolderHistory", "remoteFolderHistory"],
        2 => &["local", "remote", "pair", "localTree", "remoteTree"],
        3 => &["exclusions", "syncOptions", "syncPresets", "retainedSyncs"],
        _ => &["profiles", "lastSelectedProfileId", "tree", "trust"],
    };
    if object.keys().any(|k| {
        !allowed.contains(&k.as_str())
            && !["schemaVersion", "kind", "revision", "metadata"].contains(&k.as_str())
    }) {
        return Err(failure(NAMES[i], "unsupported field"));
    }
    if object.get("metadata").is_some_and(|m| !m.is_object()) {
        return Err(failure(NAMES[i], "metadata must be an object"));
    }
    Ok(value)
}
fn assemble(files: &[Value; 5]) -> Value {
    let [s, h, b, y, c] = files;
    let mut connection =
        json!({"profiles":c["profiles"],"history":h["folderMappings"],"tree":c["tree"]});
    if let Some(id) = c.get("lastSelectedProfileId") {
        connection["lastSelectedProfileId"] = id.clone();
    }
    json!({"schemaVersion":1,"revision":s["revision"],"connections":connection,
        "appearance":s["appearance"],"explorer":{"localBookmarks":b["local"],"remoteBookmarks":b["remote"],"localBookmarkTree":b.get("localTree").cloned().unwrap_or(Value::Null),"remoteBookmarkTree":b.get("remoteTree").cloned().unwrap_or(Value::Null),"localFolderHistory":h.get("localFolderHistory").cloned().unwrap_or(json!([])),"remoteFolderHistory":h.get("remoteFolderHistory").cloned().unwrap_or(json!([])),"folderBookmarks":b["pair"]["items"],"bookmarkTree":b["pair"]["tree"],"folderPairHistory":h["folderPairHistory"],"paneColumns":s["paneColumns"]},
        "browse":{"browseLocations":h["browseLocations"],"paneSorts":s["paneSorts"]},
        "sync":{"exclusions":y["exclusions"],"syncOptions":y["syncOptions"],"syncPresets":y["syncPresets"],"retainedSyncs":y.get("retainedSyncs").cloned().unwrap_or(json!([]))},"trust":c["trust"]})
}
pub(crate) fn read(anchor: &Path) -> Result<Option<(Value, Snapshot)>, String> {
    let snapshot = capture(anchor)?;
    if snapshot.bytes.iter().all(Option::is_none) {
        for i in 0..5 {
            if regular(&location(anchor, i)?.with_extension("backup.json"))? {
                return Err(failure(NAMES[i], "primary missing but backup exists"));
            }
        }
        return Ok(None);
    }
    let mut files: [Value; 5] = std::array::from_fn(|_| Value::Null);
    for i in 0..5 {
        files[i] = parse(
            snapshot.bytes[i]
                .as_deref()
                .ok_or_else(|| failure(NAMES[i], "primary missing; partial store"))?,
            i,
        )?;
    }
    let revision = files[0]["revision"].as_u64().unwrap();
    let manifest = files[0]["manifest"]
        .as_object()
        .ok_or_else(|| failure(NAMES[0], "manifest missing"))?;
    if manifest.len() != 4 {
        return Err(failure(NAMES[0], "manifest entries invalid"));
    }
    for i in 1..5 {
        let reference = &files[0]["manifest"][NAMES[i]];
        if reference.as_object().is_none_or(|m| {
            m.len() != 2 || !m.contains_key("revision") || !m.contains_key("sha256")
        }) || reference["revision"] != files[i]["revision"]
            || files[i]["revision"].as_u64().unwrap() > revision
            || reference["sha256"] != digest(snapshot.bytes[i].as_ref().unwrap())
        {
            return Err(failure(NAMES[i], "manifest mismatch or interrupted save"));
        }
    }
    if files[2]["pair"]
        .as_object()
        .is_none_or(|p| p.len() != 2 || !p.contains_key("items") || !p.contains_key("tree"))
    {
        return Err(failure(NAMES[2], "invalid pair section"));
    }
    Ok(Some((assemble(&files), snapshot)))
}
fn project(a: &Value) -> [Value; 5] {
    let e = &a["explorer"];
    let c = &a["connections"];
    let b = &a["browse"];
    let mut connections = json!({"profiles":c["profiles"],"tree":c["tree"],"trust":a["trust"]});
    if let Some(id) = c.get("lastSelectedProfileId") {
        connections["lastSelectedProfileId"] = id.clone();
    }
    [
        json!({"appearance":a["appearance"],"paneColumns":e["paneColumns"],"paneSorts":b["paneSorts"]}),
        json!({"folderMappings":c["history"],"browseLocations":b["browseLocations"],"folderPairHistory":e["folderPairHistory"],"localFolderHistory":e.get("localFolderHistory").cloned().unwrap_or(json!([])),"remoteFolderHistory":e.get("remoteFolderHistory").cloned().unwrap_or(json!([]))}),
        json!({"local":e.get("localBookmarks").cloned().unwrap_or(json!([])),"remote":e.get("remoteBookmarks").cloned().unwrap_or(json!([])),"localTree":e.get("localBookmarkTree").cloned().unwrap_or(Value::Null),"remoteTree":e.get("remoteBookmarkTree").cloned().unwrap_or(Value::Null),"pair":{"items":e["folderBookmarks"],"tree":e["bookmarkTree"]}}),
        a["sync"].clone(),
        connections,
    ]
}
fn encode(a: &Value, snapshot: &Snapshot) -> Result<[Vec<u8>; 5], String> {
    let mut files = project(a);
    let revision = a["revision"].as_u64().ok_or("Invalid aggregate revision")?;
    let mut bytes: [Vec<u8>; 5] = std::array::from_fn(|_| Vec::new());
    for i in (0..5).rev() {
        let old = snapshot.bytes[i]
            .as_deref()
            .map(|b| parse(b, i))
            .transpose()?;
        if let Some(metadata) = old.as_ref().and_then(|v| v.get("metadata")) {
            files[i]["metadata"] = metadata.clone();
        }
        if i > 0 {
            if let Some(mut old_content) = old.clone() {
                for key in ["schemaVersion", "kind", "revision"] {
                    old_content.as_object_mut().unwrap().remove(key);
                }
                if old_content == files[i] {
                    bytes[i] = snapshot.bytes[i].clone().unwrap();
                    continue;
                }
            }
        }
        files[i]["schemaVersion"] = 1.into();
        files[i]["kind"] = KINDS[i].into();
        files[i]["revision"] = revision.into();
        if i == 0 {
            files[0]["manifest"] = json!({});
            for j in 1..5 {
                let part: Value =
                    serde_json::from_slice(&bytes[j]).map_err(|_| "Part serialization invalid")?;
                files[0]["manifest"][NAMES[j]] =
                    json!({"revision":part["revision"],"sha256":digest(&bytes[j])});
            }
        }
        bytes[i] =
            serde_json::to_vec_pretty(&files[i]).map_err(|_| "Settings serialization failed")?;
    }
    if bytes.iter().map(Vec::len).sum::<usize>() > LIMIT {
        return Err("Combined settings exceed 16 MB".into());
    }
    Ok(bytes)
}
struct OwnedFile(PathBuf);
impl Drop for OwnedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn stage(path: &Path, bytes: &[u8]) -> Result<OwnedFile, String> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let path = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|_| failure(&path.display().to_string(), "temporary create failed"))?;
    let owned = OwnedFile(path);
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| failure(&owned.0.display().to_string(), "temporary flush failed"))?;
    Ok(owned)
}
pub(crate) fn write(anchor: &Path, a: &Value, snapshot: &Snapshot) -> Result<(), String> {
    write_with_hook(anchor, a, snapshot, |_, _| Ok(()))
}
fn write_with_hook(
    anchor: &Path,
    a: &Value,
    snapshot: &Snapshot,
    mut hook: impl FnMut(&str, usize) -> Result<(), String>,
) -> Result<(), String> {
    let lock_path = anchor.with_file_name(".nearly-settings.lock");
    let mut lock=fs::OpenOptions::new().create_new(true).write(true).open(&lock_path).map_err(|_|"Settings writer is active or its lock requires explicit inspection while Nearly is stopped")?;
    let _owned_lock = OwnedFile(lock_path);
    writeln!(lock, "Nearly settings writer {}", std::process::id())
        .and_then(|_| lock.sync_all())
        .map_err(|_| "Settings lock write failed")?;
    let actual = capture(anchor)?;
    if actual.bytes != snapshot.bytes {
        return Err(
            "Settings changed since loading (exact-byte conflict); reload before saving".into(),
        );
    }
    if actual.bytes.iter().all(Option::is_none) {
        for i in 0..5 {
            if regular(&location(anchor, i)?.with_extension("backup.json"))? {
                return Err(failure(NAMES[i], "primary missing but backup exists"));
            }
        }
    }
    let old_revision = snapshot.bytes[0]
        .as_deref()
        .map(|b| parse(b, 0))
        .transpose()?
        .map_or(0, |v| v["revision"].as_u64().unwrap());
    if a["revision"].as_u64() != old_revision.checked_add(1)
        || a["revision"].as_u64().is_none_or(|n| n > MAX_REVISION)
    {
        return Err("Settings revision conflict".into());
    }
    // Existing aggregate validation is also the gate for maintenance callers.
    super::unified_settings::Document::parse(
        &serde_json::to_vec(a).map_err(|_| "Aggregate serialization failed")?,
    )?;
    let bytes = encode(a, snapshot)?;
    let changed: Vec<usize> = (0..5)
        .filter(|i| snapshot.bytes[*i].as_ref() != Some(&bytes[*i]))
        .collect();
    let mut primary = Vec::new();
    let mut backups = Vec::new();
    for &i in &changed {
        let target = location(anchor, i)?;
        primary.push((i, stage(&target, &bytes[i])?));
        if let Some(old) = &snapshot.bytes[i] {
            let backup = target.with_extension("backup.json");
            regular(&backup)?;
            backups.push((i, stage(&backup, old)?));
        }
    }
    // Nothing is published until all bytes (including backups) have been flushed.
    hook("prepared", 0)?;
    if capture(anchor)?.bytes != snapshot.bytes {
        return Err("Settings changed while staging; no primary was replaced".into());
    }
    for (i, file) in &backups {
        hook("backup", *i)?;
        let target = location(anchor, *i)?.with_extension("backup.json");
        regular(&target)?;
        fs::rename(&file.0, &target)
            .map_err(|_| failure(NAMES[*i], "backup publication failed; primaries unchanged"))?;
    }
    for (i, file) in primary
        .iter()
        .filter(|(i, _)| *i != 0)
        .chain(primary.iter().filter(|(i, _)| *i == 0))
    {
        hook("primary", *i)?;
        let target = location(anchor, *i)?;
        regular(&target)?;
        fs::rename(&file.0, &target).map_err(|_| {
            failure(
                NAMES[*i],
                "primary publication failed; preserve all files for explicit recovery",
            )
        })?;
    }
    drop(lock);
    Ok(())
}

#[cfg(test)]
pub(crate) fn seed_fixture(anchor: &Path, a: &Value) {
    // Test fixture serializer only: permits intentionally invalid model values.
    let mut encodable = a.clone();
    if encodable["revision"].as_u64().is_none() {
        encodable["revision"] = 1.into();
    }
    let bytes = encode(&encodable, &Snapshot::default()).unwrap();
    let mut files: [Value; 5] = std::array::from_fn(|i| serde_json::from_slice(&bytes[i]).unwrap());
    // Preserve invalid/unknown source fields in the corresponding disk envelope;
    // otherwise a corruption fixture could be silently repaired by projection.
    for (section, index, known) in [
        (
            None,
            0,
            &[
                "schemaVersion",
                "revision",
                "connections",
                "appearance",
                "explorer",
                "browse",
                "sync",
                "trust",
            ][..],
        ),
        (
            Some("connections"),
            4,
            &["profiles", "lastSelectedProfileId", "history", "tree"][..],
        ),
        (
            Some("explorer"),
            2,
            &[
                "localBookmarks",
                "localBookmarkTree",
                "remoteBookmarkTree",
                "localFolderHistory",
                "remoteFolderHistory",
                "remoteBookmarks",
                "folderBookmarks",
                "folderPairHistory",
                "paneColumns",
                "bookmarkTree",
            ][..],
        ),
        (Some("browse"), 1, &["browseLocations", "paneSorts"][..]),
    ] {
        let value = section.map_or(a, |key| &a[key]);
        if let Some(object) = value.as_object() {
            for (key, value) in object {
                if !known.contains(&key.as_str()) {
                    files[index][key] = value.clone();
                }
            }
        }
    }
    for key in ["schemaVersion", "revision"] {
        if let Some(value) = a.get(key) {
            files[0][key] = value.clone();
        } else {
            files[0].as_object_mut().unwrap().remove(key);
        }
    }
    let mut bytes: [Vec<u8>; 5] = std::array::from_fn(|_| Vec::new());
    for i in 1..5 {
        bytes[i] = serde_json::to_vec_pretty(&files[i]).unwrap();
        files[0]["manifest"][NAMES[i]]["sha256"] = digest(&bytes[i]).into();
    }
    bytes[0] = serde_json::to_vec_pretty(&files[0]).unwrap();
    for i in 0..5 {
        fs::write(location(anchor, i).unwrap(), &bytes[i]).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut random = [0; 16];
            getrandom::fill(&mut random).unwrap();
            let suffix = digest(&random);
            let p = std::env::temp_dir().join(format!("nearly-split-generated-{}", &suffix[..24]));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> PathBuf {
            self.0.join("settings.json")
        }
        fn aggregate(&self) -> Value {
            let mut a = serde_json::to_value(
                super::super::unified_settings::Document::read(&self.path()).unwrap(),
            )
            .unwrap();
            a["revision"] = 1.into();
            a
        }
        fn initial(&self) -> (Value, Snapshot) {
            let a = self.aggregate();
            write(&self.path(), &a, &Snapshot::default()).unwrap();
            read(&self.path()).unwrap().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn changed(mut a: Value) -> Value {
        a["revision"] = 2.into();
        a["appearance"]["theme"] = "dark".into();
        a["connections"]["history"]["generated"] = "C:\\generated".into();
        a["explorer"]["localBookmarks"] =
            json!([{"id":"generated-local","name":"Generated","path":"C:\\generated"}]);
        a["sync"]["syncPresets"] = json!([{"id":"generated-preset","name":"Generated","exclusionRules":"*.tmp","deleteRemoved":false,"recursive":true}]);
        a["trust"]["pins"][r#"["generated.invalid",22]"#] =
            format!("SHA256:{}", "A".repeat(43)).into();
        a
    }
    fn no_temporary_files(f: &Fixture) {
        for entry in fs::read_dir(&f.0).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                !name.ends_with(".tmp") && !name.ends_with(".lock"),
                "owned temporary remains: {name}"
            );
        }
    }
    fn reconstruct_previous(f: &Fixture) -> [Vec<u8>; 5] {
        let root = fs::read(f.path().with_extension("backup.json")).unwrap();
        let manifest: Value = serde_json::from_slice(&root).unwrap();
        let mut bytes: [Vec<u8>; 5] = std::array::from_fn(|_| Vec::new());
        bytes[0] = root.clone();
        for i in 1..5 {
            bytes[i] = [
                f.0.join(NAMES[i]),
                f.0.join(NAMES[i]).with_extension("backup.json"),
            ]
            .iter()
            .filter_map(|p| fs::read(p).ok())
            .find(|b| manifest["manifest"][NAMES[i]]["sha256"] == digest(b))
            .expect("one coherent prior part must remain");
        }
        bytes
    }
    #[test]
    fn every_publication_failure_preserves_a_coherent_prior_snapshot() {
        for phase in ["prepared", "backup", "primary"] {
            for index in 0..5 {
                if phase == "prepared" && index != 0 {
                    continue;
                }
                let f = Fixture::new();
                let (a, snapshot) = f.initial();
                let next = changed(a.clone());
                let result = write_with_hook(&f.path(), &next, &snapshot, |p, i| {
                    if p == phase && i == index {
                        Err("generated publication fault".into())
                    } else {
                        Ok(())
                    }
                });
                assert!(result.is_err(), "{phase}/{index}");
                no_temporary_files(&f);
                let current = capture(&f.path()).unwrap();
                if phase != "primary" || index == 1 {
                    assert_eq!(
                        current.bytes, snapshot.bytes,
                        "backups cannot change any primary"
                    );
                    assert_eq!(read(&f.path()).unwrap().unwrap().0, a);
                } else {
                    assert!(
                        read(&f.path()).is_err(),
                        "mixed generations must fail closed"
                    );
                }
                if phase == "primary" {
                    let recovered = reconstruct_previous(&f);
                    for i in 0..5 {
                        assert_eq!(Some(&recovered[i]), snapshot.bytes[i].as_ref());
                    }
                }
            }
        }
    }
    #[test]
    fn first_save_interruption_never_loads_partial_defaults() {
        for index in 0..5 {
            let f = Fixture::new();
            let a = f.aggregate();
            assert!(
                write_with_hook(&f.path(), &a, &Snapshot::default(), |p, i| {
                    if p == "primary" && i == index {
                        Err("generated interruption".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err()
            );
            no_temporary_files(&f);
            if index == 1 {
                assert!(read(&f.path()).unwrap().is_none());
            } else {
                assert!(read(&f.path()).is_err());
            }
        }
    }
    #[test]
    fn same_revision_external_edit_is_not_overwritten() {
        let f = Fixture::new();
        let (a, snapshot) = f.initial();
        let path = f.0.join("history.json");
        let mut changed_bytes = fs::read(&path).unwrap();
        changed_bytes.push(b'\n');
        fs::write(&path, &changed_bytes).unwrap();
        let result = write(&f.path(), &changed(a), &snapshot).unwrap_err();
        assert!(result.contains("exact-byte conflict"));
        assert_eq!(fs::read(&path).unwrap(), changed_bytes);
        no_temporary_files(&f);
    }
    #[test]
    fn unsupported_fields_and_duplicate_keys_in_each_file_fail_closed() {
        for index in 0..5 {
            for duplicate in [false, true] {
                let f = Fixture::new();
                f.initial();
                let p = f.0.join(NAMES[index]);
                let original = fs::read_to_string(&p).unwrap();
                let poison = if duplicate {
                    original.replacen('{', "{\"revision\":1,", 1)
                } else {
                    original.replacen('{', "{\"password\":\"forbidden-generated\",", 1)
                };
                fs::write(&p, poison.as_bytes()).unwrap();
                assert!(read(&f.path()).is_err());
                assert_eq!(fs::read(&p).unwrap(), poison.as_bytes());
            }
        }
    }
    #[test]
    fn metadata_is_preserved_and_unchanged_parts_keep_exact_bytes() {
        let f = Fixture::new();
        f.initial();
        let mut files: [Value; 5] = std::array::from_fn(|i| {
            serde_json::from_slice(&fs::read(f.0.join(NAMES[i])).unwrap()).unwrap()
        });
        for i in 0..5 {
            files[i]["metadata"] = json!({"future":{"retain":[1,2,{"id":"unchanged"}]}});
        }
        for i in 1..5 {
            let bytes = serde_json::to_vec(&files[i]).unwrap();
            fs::write(f.0.join(NAMES[i]), &bytes).unwrap();
            files[0]["manifest"][NAMES[i]]["sha256"] = digest(&bytes).into();
        }
        fs::write(f.path(), serde_json::to_vec(&files[0]).unwrap()).unwrap();
        let (a, snapshot) = read(&f.path()).unwrap().unwrap();
        write(&f.path(), &changed(a), &snapshot).unwrap();
        let (_, after) = read(&f.path()).unwrap().unwrap();
        for i in 0..5 {
            let v: Value = serde_json::from_slice(after.bytes[i].as_ref().unwrap()).unwrap();
            assert_eq!(v["metadata"], files[i]["metadata"]);
        }
        assert_eq!(reconstruct_previous(&f), snapshot.bytes.map(Option::unwrap));
        no_temporary_files(&f);
    }
    #[test]
    fn missing_primary_and_backup_only_never_reset_trust() {
        for index in 0..5 {
            let f = Fixture::new();
            let (a, s) = f.initial();
            write(&f.path(), &changed(a), &s).unwrap();
            fs::remove_file(f.0.join(NAMES[index])).unwrap();
            assert!(read(&f.path()).is_err());
        }
        let f = Fixture::new();
        fs::write(f.0.join("connections.backup.json"), b"generated backup").unwrap();
        assert!(read(&f.path()).is_err());
    }
    #[test]
    fn existing_writer_lock_is_preserved_and_staging_edit_is_detected() {
        let f = Fixture::new();
        let (a, s) = f.initial();
        let lock = f.0.join(".nearly-settings.lock");
        fs::write(&lock, b"another writer").unwrap();
        assert!(write(&f.path(), &changed(a.clone()), &s).is_err());
        assert_eq!(fs::read(&lock).unwrap(), b"another writer");
        fs::remove_file(lock).unwrap();
        assert!(write_with_hook(&f.path(), &changed(a), &s, |phase, _| {
            if phase == "prepared" {
                fs::write(f.0.join("history.json"), b"generated external edit").unwrap();
            }
            Ok(())
        })
        .unwrap_err()
        .contains("changed while staging"));
        assert_eq!(
            fs::read(f.path()).unwrap(),
            s.bytes[0].as_ref().unwrap().clone()
        );
        no_temporary_files(&f);
    }
    #[test]
    fn any_part_backup_failure_leaves_all_primaries_unchanged() {
        for index in 0..5 {
            let f = Fixture::new();
            let (a, s) = f.initial();
            let backup = f.0.join(NAMES[index]).with_extension("backup.json");
            fs::create_dir(&backup).unwrap();
            assert!(write(&f.path(), &changed(a), &s).is_err());
            assert_eq!(capture(&f.path()).unwrap().bytes, s.bytes);
            no_temporary_files(&f);
        }
    }
}
