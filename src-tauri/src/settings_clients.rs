//! Per-native-window settings baselines. No file IO, trust ledger, or window ownership lives here.
//!
//! Call under the existing settings/file mutex: remember_loaded after a successful load;
//! prepare_save before strict Settings deserialization/validation and the existing CAS writer;
//! remember_saved only after that writer succeeds. Pass the native window label, never a DTO label.
//! The acknowledgement stores the PROPOSED DTO, because the client has not seen the merged DTO.
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_CLIENTS: usize = 32;
const MAX_HISTORY: usize = 4;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;
const MAX_RECORDS: usize = 1024;
const MAX_DEPTH: usize = 64;
// These are per-request writer gates. Document::settings() resets them; they
// describe intent for this transaction rather than any persisted user value.
const SAVE_INTENT_FIELDS: [&str; 4] = ["browseLocationsChanged", "connectionTreeChanged", "bookmarkTreeChanged", "lastSelectedProfileChanged"];

fn persistent_snapshot(mut value: Value) -> Value {
    let object = value.as_object_mut().unwrap();
    object.remove("settingsRevision");
    // Selection has explicit last-commit semantics rather than snapshot merge
    // semantics: periodic writes from another window cannot reselect its tab.
    object.remove("lastSelectedProfileId");
    for key in SAVE_INTENT_FIELDS { object.remove(key); }
    value
}

#[derive(Default)]
pub struct SettingsClients {
    clients: BTreeMap<String, VecDeque<Value>>,
}

fn revision(value: &Value) -> Result<u64, String> {
    value.get("settingsRevision").and_then(Value::as_u64)
        .ok_or_else(|| "Settings revision is missing or invalid".into())
}

fn check_snapshot(value: &Value) -> Result<(), String> {
    revision(value)?;
    if !value.is_object() || serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_SNAPSHOT_BYTES {
        return Err("Settings snapshot exceeds the client baseline limit".into());
    }
    Ok(())
}

impl SettingsClients {
    pub fn remember_loaded(&mut self, label: &str, snapshot: Value) -> Result<(), String> {
        check_snapshot(&snapshot)?;
        if !self.clients.contains_key(label) && self.clients.len() >= MAX_CLIENTS {
            return Err("Too many settings clients".into());
        }
        self.remember(label, snapshot);
        Ok(())
    }

    fn remember(&mut self, label: &str, snapshot: Value) {
        let history = self.clients.entry(label.into()).or_default();
        if history.back() == Some(&snapshot) { return; }
        history.push_back(snapshot);
        while history.len() > MAX_HISTORY { history.pop_front(); }
    }

    pub fn forget(&mut self, label: &str) { self.clients.remove(label); }

    /// Capture client-known DTOs before the separate trust approval transaction.
    /// The caller replaces only the acknowledged approved profile, then remembers each
    /// DTO with the new revision; loading the full disk here would invent client knowledge.
    pub fn profile_approval_baselines(&self, label: &str, rev: u64, profile_id: &str) -> Result<Vec<Value>, String> {
        let history = self.clients.get(label).ok_or("Load settings before approving a profile")?;
        let baselines: Vec<_> = history.iter().filter(|value| revision(value).ok() == Some(rev)).cloned().collect();
        if baselines.is_empty() || baselines.iter().any(|value| !value.get("profiles").and_then(Value::as_array)
            .is_some_and(|profiles| profiles.iter().any(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id)))) {
            return Err("Settings baseline expired; reload before approving this profile".into());
        }
        Ok(baselines)
    }

    pub fn prepare_save(&self, label: &str, proposed: &Value, current: &Value) -> Result<Value, String> {
        check_snapshot(proposed)?;
        check_snapshot(current)?;
        let current_revision = revision(current)?;
        let rev = revision(proposed)?;
        let history = self.clients.get(label).ok_or("Load settings before saving (unknown client)")?;
        let candidates: Vec<_> = history.iter().filter(|v| revision(v).ok() == Some(rev)).collect();
        if candidates.is_empty() { return Err("Settings baseline expired; reload before saving".into()); }
        if rev > revision(current)? { return Err("Settings revision is ahead of storage".into()); }
        let intents: Vec<_> = SAVE_INTENT_FIELDS.iter().filter_map(|key|
            proposed.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
        let selection_changed = proposed.get("lastSelectedProfileChanged").and_then(Value::as_bool) == Some(true);
        let selection_present = current.get("lastSelectedProfileId").is_some() || selection_changed;
        let selection = if selection_changed {
            proposed.get("lastSelectedProfileId").cloned().unwrap_or(Value::Null)
        } else { current.get("lastSelectedProfileId").cloned().unwrap_or(Value::Null) };
        if !selection.is_null() && !selection.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 128) {
            return Err("Invalid last selected profile ID".into());
        }
        let proposed = persistent_snapshot(proposed.clone());
        let current = persistent_snapshot(current.clone());
        let mut result = None;
        for base in candidates {
            let base = persistent_snapshot(base.clone());
            let merged = merge(Some(&base), Some(&proposed), Some(&current), "", 0)?
                .ok_or("Settings root cannot be deleted")?;
            // A merged acknowledgement and a subsequent refresh can share a revision.
            // Accept only when every possible baseline gives exactly the same write.
            // A queued pre-refresh request therefore cannot silently undo unseen fields.
            if result.as_ref().is_some_and(|previous| previous != &merged) {
                return Err("Settings baseline is ambiguous; reload or reopen this window before saving".into());
            }
            result = Some(merged);
        }
        let mut merged = result.unwrap();
        // Profile deletion takes precedence over a selection from a stale window.
        // Startup uses its deterministic first-profile fallback for null.
        let selection = if selection.as_str().is_some_and(|id| merged.get("profiles")
            .and_then(Value::as_array).is_some_and(|profiles| profiles.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(id)))) {
            selection
        } else { Value::Null };
        if selection_present {
            merged.as_object_mut().unwrap().insert("lastSelectedProfileId".into(), selection);
        }
        merged.as_object_mut().ok_or("Settings root must be an object")?
            .insert("settingsRevision".into(), current_revision.into());
        // Restore only this caller's gates after comparing persistent results.
        // An old true acknowledgement must never open a later request's gate.
        for (key, value) in intents { merged.as_object_mut().unwrap().insert(key, value); }
        check_snapshot(&merged)?;
        Ok(merged)
    }

    pub fn remember_saved(&mut self, label: &str, mut proposed: Value, new_revision: u64) -> Result<(), String> {
        check_snapshot(&proposed)?;
        if !self.clients.contains_key(label) { return Err("Unknown settings client".into()); }
        proposed.as_object_mut().unwrap().insert("settingsRevision".into(), new_revision.into());
        self.remember(label, proposed);
        Ok(())
    }
}

fn conflict(path: &str) -> String { format!("Settings changed concurrently at {path}; reload before saving") }

fn merge(base: Option<&Value>, proposed: Option<&Value>, current: Option<&Value>, path: &str, depth: usize) -> Result<Option<Value>, String> {
    if depth > MAX_DEPTH { return Err("Settings nesting limit exceeded".into()); }
    if proposed == base { return Ok(current.cloned()); }
    if current == base || proposed == current { return Ok(proposed.cloned()); }
    match (base, proposed, current) {
        (Some(Value::Object(b)), Some(Value::Object(p)), Some(Value::Object(c))) => {
            let keys: BTreeSet<_> = b.keys().chain(p.keys()).chain(c.keys()).collect();
            let mut out = Map::new();
            for key in keys {
                if let Some(value) = merge(b.get(key), p.get(key), c.get(key), &format!("{path}/{key}"), depth + 1)? {
                    out.insert(key.clone(), value);
                }
            }
            Ok(Some(Value::Object(out)))
        }
        (Some(Value::Array(b)), Some(Value::Array(p)), Some(Value::Array(c))) if keyed_path(path) => {
            Ok(Some(Value::Array(merge_records(b, p, c, path, depth + 1)?)))
        }
        (Some(Value::Array(b)), Some(Value::Array(p)), Some(Value::Array(c))) if matches!(path,"/localFolderHistory"|"/remoteFolderHistory") => {
            Ok(Some(Value::Array(merge_side_history(b,p,c,path)?)))
        }
        _ => Err(conflict(path)), // includes delete versus edit, unknown arrays, and shape changes
    }
}

fn keyed_path(path: &str) -> bool {
    matches!(path, "/profiles" | "/folderBookmarks" | "/localBookmarks" | "/remoteBookmarks" | "/syncPresets" | "/retainedSyncs" | "/connectionTree/nodes" | "/bookmarkTree/nodes" | "/localBookmarkTree/nodes" | "/remoteBookmarkTree/nodes")
}
fn merge_side_history(base:&[Value],proposed:&[Value],current:&[Value],path:&str)->Result<Vec<Value>,String>{
    let index_history=|records:&[Value]|->Result<BTreeMap<String,Value>,String>{
        if records.len()>200{return Err(conflict(path));}
        let mut out=BTreeMap::new();
        for record in records{
            let raw=record.get("path").and_then(Value::as_str).ok_or_else(||conflict(path))?;
            let folder=if path=="/localFolderHistory"{raw.replace('/',"\\").trim_end_matches('\\').to_lowercase()}else{raw.to_owned()};
            let key=serde_json::to_string(&(record.get("connectionKey"),folder)).map_err(|_|conflict(path))?;
            if record.get("openedAt").and_then(Value::as_u64).is_none()||out.insert(key,record.clone()).is_some(){return Err(conflict(path));}
        }Ok(out)
    };
    let (b,p,c)=(index_history(base)?,index_history(proposed)?,index_history(current)?);
    let keys:BTreeSet<_>=b.keys().chain(p.keys()).chain(c.keys()).collect();let mut out=Vec::new();
    for key in keys{
        let (bv,pv,cv)=(b.get(key),p.get(key),c.get(key));
        // Omission of an acknowledged entry is a deletion, including bounded-history eviction.
        if bv.is_some()&&(pv.is_none()||cv.is_none()){continue;}
        let record=match(pv,cv){(Some(p),Some(c))=>if p["openedAt"].as_u64()>=c["openedAt"].as_u64(){p}else{c},(Some(p),None)=>p,(None,Some(c))=>c,_=>continue};
        out.push(record.clone());
    }
    out.sort_by(|a,b|b["openedAt"].as_u64().cmp(&a["openedAt"].as_u64()).then_with(||a["path"].as_str().cmp(&b["path"].as_str())));out.truncate(200);Ok(out)
}

fn index<'a>(values: &'a [Value], path: &str) -> Result<BTreeMap<&'a str, (usize, &'a Value)>, String> {
    if values.len() > MAX_RECORDS { return Err(format!("Too many settings records at {path}")); }
    let mut out = BTreeMap::new();
    for (position, value) in values.iter().enumerate() {
        let id = value.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or_else(|| conflict(path))?;
        if out.insert(id, (position, value)).is_some() { return Err(format!("Duplicate settings record at {path}")); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn initial() -> Value {
        json!({"settingsRevision":0,"theme":"system","language":"ja","history":{},"exclusions":{},
            "syncOptions":{},"browseLocations":{},"profiles":[],"retainedSyncs":[],"folderBookmarks":[],
            "syncPresets":[],"localBookmarks":[],"remoteBookmarks":[],"connectionTree":{"version":1,"nodes":[]},"unknownArray":[1,2]})
    }
    #[test]
    fn side_history_merges_recent_paths_and_does_not_resurrect_removed_entries() {
        let b=vec![json!({"path":"C:\\old","openedAt":1})];
        let p=vec![json!({"path":"C:\\a","openedAt":2})];
        let c=vec![json!({"path":"C:\\b","openedAt":3}),b[0].clone()];
        let out=merge_side_history(&b,&p,&c,"/localFolderHistory").unwrap();
        assert_eq!(out,vec![c[0].clone(),p[0].clone()]);
        let a=vec![json!({"path":"C:\\A","openedAt":4})];
        let z=vec![json!({"path":"c:/a/","openedAt":5})];
        assert_eq!(merge_side_history(&[],&a,&z,"/localFolderHistory").unwrap(),z);
    }
    #[test]
    fn side_bookmark_records_merge_additions_and_refuse_delete_edit_conflicts() {
        for field in ["localBookmarks", "remoteBookmarks"] {
            let mut base=initial();base[field]=json!([]);
            let mut clients=setup_clients(&base);let mut disk=base.clone();
            let mut a=base.clone();a[field]=json!([{"id":"a","name":"A","path":"/a"}]);
            save(&mut clients,"a",&a,&mut disk);
            let mut b=base.clone();b[field]=json!([{"id":"b","name":"B","path":"/b"}]);
            save(&mut clients,"b",&b,&mut disk);
            assert_eq!(disk[field].as_array().unwrap().len(),2);
            clients.remember_loaded("a",disk.clone()).unwrap();clients.remember_loaded("b",disk.clone()).unwrap();
            let mut edit=disk.clone();edit[field][0]["name"]=json!("Edited");
            let mut delete=disk.clone();delete[field].as_array_mut().unwrap().remove(0);
            save(&mut clients,"a",&edit,&mut disk);
            assert!(clients.prepare_save("b",&delete,&disk).is_err());
        }
    }
    fn setup_clients(base: &Value) -> SettingsClients {
        let mut clients = SettingsClients::default();
        clients.remember_loaded("a", base.clone()).unwrap();
        clients.remember_loaded("b", base.clone()).unwrap();
        clients
    }
    fn save(clients: &mut SettingsClients, label: &str, proposed: &Value, disk: &mut Value) {
        let mut merged = clients.prepare_save(label, proposed, disk).unwrap();
        let rev = revision(disk).unwrap() + 1;
        merged["settingsRevision"] = rev.into();
        *disk = merged;
        clients.remember_saved(label, proposed.clone(), rev).unwrap();
    }
    fn with_revision(mut value: Value, rev: u64) -> Value {
        value["settingsRevision"] = rev.into(); value
    }

    #[test]
    fn explicit_selection_is_last_committed_and_unrelated_stale_writes_preserve_it() {
        let mut base = initial(); base["profiles"] = json!([{"id":"first"},{"id":"last"}]);
        base["lastSelectedProfileId"] = json!("first");
        let mut clients=setup_clients(&base); let mut disk=base.clone();
        let mut a=base.clone();a["lastSelectedProfileId"]=json!("last");a["lastSelectedProfileChanged"]=json!(true);
        save(&mut clients,"a",&a,&mut disk);assert_eq!(disk["lastSelectedProfileId"],"last");
        let mut b=base.clone();b["theme"]=json!("mint");
        save(&mut clients,"b",&b,&mut disk);assert_eq!(disk["lastSelectedProfileId"],"last");
        b=with_revision(b,2);b["lastSelectedProfileChanged"]=json!(true);
        save(&mut clients,"b",&b,&mut disk);assert_eq!(disk["lastSelectedProfileId"],"first");
        a=with_revision(a,1);a["lastSelectedProfileChanged"]=json!(false);a["language"]=json!("en");
        save(&mut clients,"a",&a,&mut disk);assert_eq!(disk["lastSelectedProfileId"],"first");
        assert_eq!(disk["theme"],"mint");assert_eq!(disk["language"],"en");
    }

    #[test]
    fn deleting_selected_profile_and_stale_selection_never_resurrect_deleted_id() {
        let mut base=initial();base["profiles"]=json!([{"id":"first"},{"id":"last"}]);
        base["lastSelectedProfileId"]=json!("last");
        let mut clients=setup_clients(&base);let mut disk=base.clone();
        let mut a=base.clone();a["profiles"]=json!([{"id":"first"}]);save(&mut clients,"a",&a,&mut disk);
        assert!(disk["lastSelectedProfileId"].is_null());
        let mut b=base.clone();b["lastSelectedProfileChanged"]=json!(true);save(&mut clients,"b",&b,&mut disk);
        assert!(disk["lastSelectedProfileId"].is_null());assert_eq!(disk["profiles"],json!([{"id":"first"}]));
    }

    #[test]
    fn disjoint_globals_and_maps_survive_multiple_save_rounds_without_unseen_ack_reverts() {
        let base = initial(); let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["theme"] = json!("dark"); a["history"]["a"] = json!("/a");
        save(&mut clients, "a", &a, &mut disk); a = with_revision(a, 1);
        let mut b = base.clone(); b["language"] = json!("en"); b["history"]["b"] = json!("/b");
        save(&mut clients, "b", &b, &mut disk); b = with_revision(b, 2);
        a["exclusions"]["a"] = json!("*.tmp"); save(&mut clients, "a", &a, &mut disk);
        b["syncOptions"]["b"] = json!({"recursive":true}); save(&mut clients, "b", &b, &mut disk);
        assert_eq!(disk["theme"], "dark"); assert_eq!(disk["language"], "en");
        assert_eq!(disk["history"], json!({"a":"/a","b":"/b"}));
        assert_eq!(disk["exclusions"]["a"], "*.tmp"); assert_eq!(disk["syncOptions"]["b"]["recursive"], true);
        assert_eq!(disk["settingsRevision"], 4);
    }

    #[test]
    fn same_field_conflict_and_delete_versus_edit_never_prepare_a_write() {
        let mut base = initial(); base["profiles"] = json!([{"id":"p","name":"old"}]);
        let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["theme"] = json!("dark"); a["profiles"][0]["name"] = json!("new");
        save(&mut clients, "a", &a, &mut disk);
        let before = disk.clone(); let mut b = base.clone(); b["theme"] = json!("light");
        assert!(clients.prepare_save("b", &b, &disk).unwrap_err().contains("/theme"));
        b["theme"] = base["theme"].clone(); b["profiles"] = json!([]);
        assert!(clients.prepare_save("b", &b, &disk).unwrap_err().contains("/profiles/p"));
        assert_eq!(disk, before);
    }

    #[test]
    fn optional_tree_widths_merge_per_side_and_stale_omissions_preserve_unseen_widths() {
        let base = initial(); let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["localTreeWidth"] = json!(330);
        save(&mut clients, "a", &a, &mut disk);
        let mut b = base.clone(); b["remoteTreeWidth"] = json!(240);
        save(&mut clients, "b", &b, &mut disk);
        assert_eq!(disk["localTreeWidth"], 330); assert_eq!(disk["remoteTreeWidth"], 240);
        a = with_revision(a, 1); a["theme"] = json!("mint");
        save(&mut clients, "a", &a, &mut disk);
        assert_eq!(disk["remoteTreeWidth"], 240);
        b = with_revision(b, 2); b["localTreeWidth"] = json!(450);
        assert!(clients.prepare_save("b", &b, &disk).unwrap_err().contains("/localTreeWidth"));
    }

    #[test]
    fn keyed_record_fields_additions_and_deletions_compose_without_resurrection() {
        let mut base = initial();
        base["retainedSyncs"] = json!([{"id":"a","ownerTabId":"ta","local":"/a","closed":false},
            {"id":"b","ownerTabId":"tb","local":"/b","closed":false},{"id":"old","local":"/old"}]);
        let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["retainedSyncs"] = json!([
            {"id":"a","ownerTabId":"ta","local":"/new-a","closed":true},
            {"id":"b","ownerTabId":"tb","local":"/b","closed":false},{"id":"new-a","local":"/na"}]);
        save(&mut clients, "a", &a, &mut disk);
        let mut b = base.clone(); b["retainedSyncs"][1]["local"] = json!("/new-b");
        b["retainedSyncs"].as_array_mut().unwrap().push(json!({"id":"new-b","local":"/nb"}));
        save(&mut clients, "b", &b, &mut disk);
        let records = index(disk["retainedSyncs"].as_array().unwrap(), "test").unwrap();
        assert!(!records.contains_key("old")); assert_eq!(records.len(), 4);
        assert_eq!(records["a"].1["closed"], true); assert_eq!(records["a"].1["local"], "/new-a");
        assert_eq!(records["b"].1["local"], "/new-b");
        // The unchanged deleted record remains present in b's acknowledged local snapshot.
        // A later unrelated save must still not bring it back.
        b = with_revision(b, 2); b["language"] = json!("en"); save(&mut clients, "b", &b, &mut disk);
        assert!(!disk["retainedSyncs"].as_array().unwrap().iter().any(|v| v["id"] == "old"));
    }

    #[test]
    fn different_fields_of_same_record_merge() {
        let mut base = initial(); base["profiles"] = json!([{"id":"a","name":"old","host":"old"}]);
        let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["profiles"][0]["name"] = json!("new"); save(&mut clients,"a",&a,&mut disk);
        let mut b = base.clone(); b["profiles"][0]["host"] = json!("new-host"); save(&mut clients,"b",&b,&mut disk);
        assert_eq!(disk["profiles"][0], json!({"id":"a","name":"new","host":"new-host"}));
    }

    #[test]
    fn disjoint_order_edits_compose_and_cycles_reject() {
        let rows = |ids: &[&str]| Value::Array(ids.iter().map(|id| json!({"id":id})).collect());
        let mut base = initial(); base["profiles"] = rows(&["a","b","c","d"]);
        let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["profiles"] = rows(&["b","a","c","d"]); save(&mut clients,"a",&a,&mut disk);
        let mut b = base.clone(); b["profiles"] = rows(&["a","b","d","c"]); save(&mut clients,"b",&b,&mut disk);
        assert_eq!(disk["profiles"], rows(&["b","a","d","c"]));
        let clients = setup_clients(&base); let mut proposed = base.clone(); let mut current = base.clone();
        proposed["profiles"] = rows(&["b","a","c","d"]); current["profiles"] = rows(&["a","c","b","d"]);
        assert!(clients.prepare_save("a", &proposed, &current).unwrap_err().contains("/order"));
    }

    #[test]
    fn nested_tree_records_merge_and_unknown_arrays_remain_atomic() {
        let mut base = initial(); base["connectionTree"]["nodes"] = json!([{"id":"a","parentId":null},{"id":"b","parentId":null}]);
        let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["connectionTree"]["nodes"][0]["parentId"] = json!("x"); save(&mut clients,"a",&a,&mut disk);
        let mut b = base.clone(); b["connectionTree"]["nodes"][1]["parentId"] = json!("y"); save(&mut clients,"b",&b,&mut disk);
        assert_eq!(disk["connectionTree"]["nodes"][0]["parentId"], "x");
        assert_eq!(disk["connectionTree"]["nodes"][1]["parentId"], "y");
        let clients = setup_clients(&base); let mut p = base.clone(); let mut c = base.clone();
        p["unknownArray"] = json!([1,3]); c["unknownArray"] = json!([1,4]);
        assert!(clients.prepare_save("a", &p, &c).is_err());
    }

    #[test]
    fn shape_changes_duplicate_ids_and_simultaneous_different_additions_reject() {
        let base = initial(); let clients = setup_clients(&base);
        let mut p = base.clone(); let mut c = base.clone();
        p["history"] = json!([]); c["history"] = json!({"x":"y"});
        assert!(clients.prepare_save("a", &p, &c).is_err());
        p = base.clone(); c = base.clone();
        p["profiles"] = json!([{"id":"a","name":"a"},{"id":"a","name":"b"}]);
        c["profiles"] = json!([{"id":"b"}]);
        assert!(clients.prepare_save("a", &p, &c).is_err());
        p["profiles"] = json!([{"id":"same","name":"a"}]); c["profiles"] = json!([{"id":"same","name":"b"}]);
        assert!(clients.prepare_save("a", &p, &c).is_err());
    }

    #[test]
    fn transient_save_intent_and_loaded_defaults_do_not_make_same_revision_ambiguous() {
        for (flag, section) in [("browseLocationsChanged", "browseLocations"),
            ("connectionTreeChanged", "connectionTree"), ("bookmarkTreeChanged", "bookmarkTree")] {
            let mut base = initial();
            base[flag] = json!(false);
            base[section] = json!({"version":1,"nodes":[]});
            let mut clients = setup_clients(&base); let mut disk = base.clone();
            let mut proposed = base.clone();
            proposed[flag] = json!(true);
            proposed[section] = json!({"version":1,"nodes":[{"id":"first","name":"one"}]});
            save(&mut clients, "a", &proposed, &mut disk);
            // The unified document persists the content; loading Settings resets
            // transaction-only writer gates, while the save ack knew true.
            disk[flag] = json!(false);
            clients.remember_loaded("a", disk.clone()).unwrap();
            let mut next = disk.clone();
            next[flag] = json!(true);
            next[section]["nodes"][0]["name"] = json!("two");
            let merged = clients.prepare_save("a", &next, &disk).unwrap();
            assert_eq!(merged[section]["nodes"][0]["name"], "two", "{flag}");
            assert_eq!(merged[flag], true, "the current request must still open the writer gate");
            // A request with no intent must not inherit an older true gate.
            next[flag] = json!(false);
            assert_eq!(clients.prepare_save("a", &next, &disk).unwrap()[flag], false);
        }
    }

    #[test]
    fn native_client_identity_cleanup_bounds_and_ambiguous_revisions_fail_closed() {
        let base = initial(); let mut clients = setup_clients(&base);
        assert!(clients.prepare_save("unloaded", &base, &base).is_err());
        clients.forget("a"); assert!(clients.prepare_save("a", &base, &base).is_err());
        let mut other = base.clone(); other["theme"] = json!("dark");
        clients.remember_loaded("b", other.clone()).unwrap();
        assert!(clients.prepare_save("b", &base, &other).unwrap_err().contains("ambiguous"));
        let mut refreshed = other.clone(); refreshed["language"] = json!("en");
        assert_eq!(clients.prepare_save("b", &refreshed, &other).unwrap(), refreshed);
        for rev in 1..=5 { clients.remember_loaded("b", with_revision(base.clone(), rev)).unwrap(); }
        assert!(clients.prepare_save("b", &base, &base).unwrap_err().contains("expired"));
        let mut oversized = base.clone(); oversized["large"] = Value::String("x".repeat(MAX_SNAPSHOT_BYTES));
        assert!(clients.remember_loaded("big", oversized).is_err());
        let mut clients = SettingsClients::default();
        for n in 0..MAX_CLIENTS { clients.remember_loaded(&format!("w{n}"), base.clone()).unwrap(); }
        assert!(clients.remember_loaded("overflow", base.clone()).is_err());
    }

    #[test]
    fn profile_approval_ack_preserves_client_knowledge_after_merged_save() {
        let mut base = initial(); base["profiles"] = json!([{"id":"p","name":"profile"}]);
        let mut clients = setup_clients(&base); let mut disk = base.clone();
        let mut a = base.clone(); a["theme"] = json!("dark"); save(&mut clients,"a",&a,&mut disk);
        let mut b = base.clone(); b["language"] = json!("en"); save(&mut clients,"b",&b,&mut disk);
        let baselines = clients.profile_approval_baselines("b", 2, "p").unwrap();
        assert_eq!(baselines[0]["theme"], "system");
        assert!(clients.profile_approval_baselines("b", 2, "missing").is_err());
        disk["profiles"][0]["hostKey"] = json!("approved"); disk["settingsRevision"] = json!(3);
        for mut snapshot in baselines {
            snapshot["profiles"][0]["hostKey"] = json!("approved");
            clients.remember_saved("b", snapshot.clone(), 3).unwrap();
            b = with_revision(snapshot,3);
        }
        b["history"]["next"] = json!("/next"); save(&mut clients,"b",&b,&mut disk);
        assert_eq!(disk["theme"], "dark"); assert_eq!(disk["profiles"][0]["hostKey"], "approved");
    }
}

fn relation(index: &BTreeMap<&str, (usize, &Value)>, a: &str, b: &str) -> Option<bool> {
    Some(index.get(a)?.0 < index.get(b)?.0)
}

fn merge_records(base: &[Value], proposed: &[Value], current: &[Value], path: &str, depth: usize) -> Result<Vec<Value>, String> {
    let (b, p, c) = (index(base, path)?, index(proposed, path)?, index(current, path)?);
    let ids: BTreeSet<_> = b.keys().chain(p.keys()).chain(c.keys()).copied().collect();
    let mut records = BTreeMap::new();
    for id in ids {
        if let Some(value) = merge(b.get(id).map(|x| x.1), p.get(id).map(|x| x.1), c.get(id).map(|x| x.1), &format!("{path}/{id}"), depth)? {
            records.insert(id, value);
        }
    }
    let ids: Vec<_> = records.keys().copied().collect();
    let mut edges: BTreeMap<&str, BTreeSet<&str>> = ids.iter().map(|&id| (id, BTreeSet::new())).collect();
    let mut incoming: BTreeMap<&str, usize> = ids.iter().map(|&id| (id, 0)).collect();
    for (i, &a) in ids.iter().enumerate() {
        for &z in &ids[i + 1..] {
            let (br, pr, cr) = (relation(&b, a, z), relation(&p, a, z), relation(&c, a, z));
            let order = if pr == br { cr } else if cr == br || pr == cr { pr }
                else if br.is_none() && pr.is_none() { cr }
                else if br.is_none() && cr.is_none() { pr }
                else { return Err(conflict(&format!("{path}/order"))); };
            if let Some(before) = order {
                let (from, to) = if before { (a, z) } else { (z, a) };
                edges.get_mut(from).unwrap().insert(to);
                *incoming.get_mut(to).unwrap() += 1;
            }
        }
    }
    // Topological order composes pairwise edits. Unrelated concurrent insertions use stable ID order.
    let mut ready: BTreeSet<_> = incoming.iter().filter(|(_, n)| **n == 0).map(|(&id, _)| id).collect();
    let mut out = Vec::new();
    while let Some(id) = ready.pop_first() {
        out.push(records.remove(id).unwrap());
        for &next in &edges[id] {
            let n = incoming.get_mut(next).unwrap();
            *n -= 1;
            if *n == 0 { ready.insert(next); }
        }
    }
    if !records.is_empty() { return Err(conflict(&format!("{path}/order"))); }
    Ok(out)
}
