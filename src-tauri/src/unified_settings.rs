//! The only on-disk settings format. No legacy readers or automatic migration.
use super::*;
use std::io::{Read, Write};

const MAX_BYTES: usize = 16_000_000;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    schema_version: u32,
    pub(crate) revision: u64,
    connections: Connections,
    appearance: Appearance,
    explorer: Explorer,
    browse: Browse,
    sync: SyncRules,
    pub(crate) trust: host_pins::PinLedger,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Connections {
    profiles: Vec<sftp::Profile>,
    history: HashMap<String, String>,
    tree: connection_tree::Tree,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Explorer {
    folder_bookmarks: Vec<explorer_preferences::FolderBookmark>,
    folder_pair_history: Vec<explorer_preferences::FolderPairHistory>,
    pane_columns: Columns,
    bookmark_tree: bookmark_tree::Tree,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Columns {
    local: Column,
    remote: Column,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Column {
    order: Vec<String>,
    hidden: Vec<String>,
    widths: HashMap<String, f64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Browse {
    browse_locations: browse_preferences::Locations,
    pane_sorts: Sorts,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sorts {
    local: explorer_preferences::SortSpec,
    remote: explorer_preferences::SortSpec,
}
impl Column {
    fn from(p: &explorer_preferences::ColumnSettings) -> Self {
        Self {
            order: p.order.clone(),
            hidden: p.hidden.clone(),
            widths: p.widths.clone(),
        }
    }
    fn to(&self, sort: &explorer_preferences::SortSpec) -> explorer_preferences::ColumnSettings {
        explorer_preferences::ColumnSettings {
            order: self.order.clone(),
            hidden: self.hidden.clone(),
            widths: self.widths.clone(),
            sort: sort.clone(),
        }
    }
}

// Validate duplicate keys before typed decoding. This prevents HashMap and enum
// decoders from silently replacing earlier values, including trust and schema.
struct UniqueJson;
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut m: M,
            ) -> Result<Self::Value, M::Error> {
                let mut keys = std::collections::HashSet::new();
                while let Some(key) = m.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(serde::de::Error::custom("Duplicate JSON key"));
                    }
                    m.next_value::<UniqueJson>()?;
                }
                Ok(UniqueJson)
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut s: S,
            ) -> Result<Self::Value, S::Error> {
                while s.next_element::<UniqueJson>()?.is_some() {}
                Ok(UniqueJson)
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson)
            }
        }
        d.deserialize_any(Visitor)
    }
}
impl Document {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_BYTES {
            return Err("Unified settings exceed 16 MB".into());
        }
        serde_json::from_slice::<UniqueJson>(bytes).map_err(|_| {
            "Settings JSON is invalid or contains duplicate keys; original file is unchanged"
        })?;
        let doc:Self=serde_json::from_slice(bytes).map_err(|_| "Unified settings are invalid or use an unsupported format. Existing split settings require the separate one-time conversion; the app does not migrate them")?;
        if doc.schema_version != 1 || doc.revision == 0 || doc.revision > MAX_REVISION {
            return Err(
                "Unsupported settings schema or revision; settings were not changed".into(),
            );
        }
        doc.validate()?;
        Ok(doc)
    }
    pub(crate) fn read(path: &Path) -> Result<Self, String> {
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if path
                    .with_extension("backup.json")
                    .try_exists()
                    .map_err(|_| "Settings backup status unavailable")?
                {
                    return Err("Settings primary is missing but its backup exists; restore it explicitly before opening or saving".into());
                }
                return Self::from_settings(
                    &Settings {
                        version: 1,
                        ..Default::default()
                    },
                    host_pins::PinLedger::default(),
                    0,
                );
            }
            Err(_) => return Err("Settings unavailable; no defaults were loaded or saved".into()),
        };
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Settings read failed; no defaults were loaded")?;
        Self::parse(&bytes)
    }
    fn validate(&self) -> Result<(), String> {
        self.trust.validate()?;
        let data = self.settings();
        validate_settings(&data)?;
        // Every stored profile pin must be represented by the authoritative
        // ledger. An empty pin for an already remembered endpoint is corrupt.
        let mut pins = self.trust.clone();
        pins.accept_incoming(&data.profiles)?;
        if pins.pins != self.trust.pins {
            return Err("Saved profile pin is absent from authoritative trust".into());
        }
        Ok(())
    }
    fn from_settings(
        data: &Settings,
        trust: host_pins::PinLedger,
        revision: u64,
    ) -> Result<Self, String> {
        validate_settings(data)?;
        let doc = Self {
            schema_version: 1,
            revision,
            connections: Connections {
                profiles: data.profiles.clone(),
                history: data.history.clone(),
                tree: data
                    .connection_tree
                    .clone()
                    .unwrap_or_else(|| connection_tree::flat(&data.profiles)),
            },
            appearance: Appearance {
                theme: data.theme,
                language: data.language,
                compact_explorer: data.compact_explorer,
                local_pane_ratio: data.local_pane_ratio,
                local_tree_ratio: data.local_tree_ratio,
                remote_tree_ratio: data.remote_tree_ratio,
            },
            explorer: Explorer {
                folder_bookmarks: data.folder_bookmarks.clone(),
                folder_pair_history: data.folder_pair_history.clone(),
                pane_columns: Columns {
                    local: Column::from(&data.pane_columns.local),
                    remote: Column::from(&data.pane_columns.remote),
                },
                bookmark_tree: data
                    .bookmark_tree
                    .clone()
                    .unwrap_or_else(|| bookmark_tree::flat(&data.folder_bookmarks)),
            },
            browse: Browse {
                browse_locations: data.browse_locations.clone(),
                pane_sorts: Sorts {
                    local: data.pane_columns.local.sort.clone(),
                    remote: data.pane_columns.remote.sort.clone(),
                },
            },
            sync: SyncRules {
                exclusions: data.exclusions.clone(),
                sync_options: data.sync_options.clone(),
                sync_presets: data.sync_presets.clone(),
                retained_syncs: data.retained_syncs.clone(),
            },
            trust,
        };
        doc.validate()?;
        Ok(doc)
    }
    pub(crate) fn settings(&self) -> Settings {
        Settings {
            version: 1,
            settings_revision: self.revision,
            profiles: self.connections.profiles.clone(),
            history: self.connections.history.clone(),
            theme: self.appearance.theme,
            language: self.appearance.language,
            compact_explorer: self.appearance.compact_explorer,
            local_pane_ratio: self.appearance.local_pane_ratio,
            local_tree_ratio: self.appearance.local_tree_ratio,
            remote_tree_ratio: self.appearance.remote_tree_ratio,
            exclusions: self.sync.exclusions.clone(),
            sync_options: self.sync.sync_options.clone(),
            sync_presets: self.sync.sync_presets.clone(),
            retained_syncs: self.sync.retained_syncs.clone(),
            folder_bookmarks: self.explorer.folder_bookmarks.clone(),
            folder_pair_history: self.explorer.folder_pair_history.clone(),
            pane_columns: explorer_preferences::PaneColumns {
                local: self
                    .explorer
                    .pane_columns
                    .local
                    .to(&self.browse.pane_sorts.local),
                remote: self
                    .explorer
                    .pane_columns
                    .remote
                    .to(&self.browse.pane_sorts.remote),
            },
            connection_tree: Some(self.connections.tree.clone()),
            bookmark_tree: Some(self.explorer.bookmark_tree.clone()),
            browse_locations: self.browse.browse_locations.clone(),
            ..Default::default()
        }
    }
    fn write(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "Settings serialization failed")?;
        if bytes.len() > MAX_BYTES {
            return Err("Unified settings exceed 16 MB".into());
        }
        let staged = Staged::new(path, &bytes)?;
        // Back up the exact authoritative primary and flush it before replacing
        // either file. An unavailable/invalid primary never reaches this point.
        if self.revision > 1 {
            let old = std::fs::read(path).map_err(|e| {
                settings_location::write_error(path, "バックアップ前の読み取り", &e)
            })?;
            Document::parse(&old)?;
            let backup = path.with_extension("backup.json");
            let backup_stage = Staged::new(&backup, &old)?;
            std::fs::rename(&backup_stage.0, &backup).map_err(|e| {
                settings_location::write_error(&backup, "バックアップの置き換え", &e)
            })?;
        }
        std::fs::rename(&staged.0, path)
            .map_err(|e| settings_location::write_error(path, "保存", &e))?;
        Ok(())
    }
}
struct Staged(PathBuf);
impl Staged {
    fn new(path: &Path, bytes: &[u8]) -> Result<Self, String> {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tmp = path.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| settings_location::write_error(path, "一時保存ファイルの作成", &e))?;
        let staged = Self(tmp);
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| settings_location::write_error(path, "保存データの書き込み", &e))?;
        Ok(staged)
    }
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) fn save(path: &Path, data: &Settings) -> Result<u64, String> {
    save_impl(path, data, None)
}
// Only called inside HostVerification::approve's one-use token callback.
pub(crate) fn save_approved(
    path: &Path,
    data: &Settings,
    approved: &sftp::Profile,
) -> Result<u64, String> {
    save_impl(path, data, Some(approved))
}
fn save_impl(
    path: &Path,
    data: &Settings,
    approved: Option<&sftp::Profile>,
) -> Result<u64, String> {
    let current = Document::read(path)?;
    if current.revision != data.settings_revision {
        return Err(
            "Settings changed since loading; reload before saving (revision conflict)".into(),
        );
    }
    let revision = current
        .revision
        .checked_add(1)
        .filter(|v| *v <= MAX_REVISION)
        .ok_or("Settings revision exhausted")?;
    let mut trust = current.trust;
    if let Some(profile) = approved {
        trust.accept_incoming(std::slice::from_ref(profile))?;
    }
    let allowed = trust.pins.clone();
    trust.accept_incoming(&data.profiles)?;
    if trust.pins != allowed {
        return Err("A new endpoint pin requires explicit host key approval".into());
    }
    // Omitted DTO trees preserve existing structure, but cannot silently repair
    // additions/removals. A current editor sends explicit validated trees.
    let mut data = data.clone();
    if data.connection_tree.is_none() && current.revision != 0 {
        data.connection_tree = Some(current.connections.tree);
    }
    if data.bookmark_tree.is_none() && current.revision != 0 {
        data.bookmark_tree = Some(current.explorer.bookmark_tree);
    }
    Document::from_settings(&data, trust, revision)?.write(path)?;
    Ok(revision)
}
pub(crate) fn guard_pin(path: &Path, profile: &sftp::Profile) -> Result<(), String> {
    let doc = Document::read(path)?;
    let known = doc
        .trust
        .known(profile)?
        .ok_or("Endpoint has no approved host key; explicitly verify it before connecting")?;
    if sftp::canonical_fingerprint(&profile.host_key)? != known {
        return Err("Connection host key differs from authoritative trust".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_syncs_default_to_empty_in_settings_dto() {
        assert_eq!(serde_json::to_value(Settings::default()).unwrap()["retainedSyncs"], serde_json::json!([]));
    }
    fn retained() -> RetainedSync {
        serde_json::from_value(serde_json::json!({"id":"retained-one","profile":profile(),"local":"C:\\generated\\stopped","remote":"/stopped","exclusionRules":"*.tmp","deleteRemoved":true,"recursive":false,"pendingState":"unreflected"})).unwrap()
    }
    #[test]
    fn retained_syncs_roundtrip_orphan_snapshot_preserve_other_sections_and_cas() {
        let f=Fixture::new(); let p=f.path();
        let initial=save_reload(&p,&settings());
        let before=value(&p);
        let mut updated=initial.clone();updated.retained_syncs=vec![retained()];
        let saved=save_reload(&p,&updated);
        assert_eq!(saved.retained_syncs.len(),1);
        assert!(saved.profiles.is_empty(),"Orphan snapshot remains data without creating a live connection");
        let after=value(&p);
        for section in ["connections","appearance","explorer","browse","trust"] {assert_eq!(before[section],after[section]);}
        assert_eq!(after["sync"]["retainedSyncs"][0]["pendingState"],"unreflected");
        assert!(after["sync"]["retainedSyncs"][0].get("status").is_none());
        let mut appearance=saved.clone();appearance.theme=Theme::Midnight;
        let appearance=save_reload(&p,&appearance);
        assert_eq!(appearance.retained_syncs[0].local,"C:\\generated\\stopped");
        assert!(save(&p,&saved).unwrap_err().contains("revision conflict"));
        assert_eq!(value(&p)["sync"]["retainedSyncs"],after["sync"]["retainedSyncs"]);
    }
    #[test]
    fn retained_syncs_missing_in_old_document_load_without_writes() {
        let f=Fixture::new();let p=f.path();save_reload(&p,&settings());
        let mut old=value(&p);old["sync"].as_object_mut().unwrap().remove("retainedSyncs");
        let bytes=serde_json::to_vec(&old).unwrap();std::fs::write(&p,&bytes).unwrap();
        let loaded=Document::read(&p).unwrap().settings();assert!(loaded.retained_syncs.is_empty());
        assert_eq!(std::fs::read(&p).unwrap(),bytes);
        assert!(!p.with_extension("backup.json").exists());
    }
    #[test]
    fn retained_syncs_reject_secrets_runtime_status_bad_paths_and_excess_entries() {
        let good=serde_json::to_value(retained()).unwrap();
        for field in ["passphrase","password","secret","status","pending","active"] {
            let mut bad=good.clone();bad[field]=serde_json::json!("must refuse");
            assert!(serde_json::from_value::<RetainedSync>(bad).is_err());
            let mut nested=good.clone();nested["profile"][field]=serde_json::json!("must refuse");
            assert!(serde_json::from_value::<RetainedSync>(nested).is_err());
        }
        for state in ["complete","running","stopped",""] {let mut bad=good.clone();bad["pendingState"]=state.into();assert!(serde_json::from_value::<RetainedSync>(bad).is_err());}
        for (field,value) in [("local","relative"),("remote","/unsafe/../path"),("exclusionRules","[broken")] {
            let mut bad=good.clone();bad[field]=value.into();let bad:RetainedSync=serde_json::from_value(bad).unwrap();assert!(validate_retained_syncs(&[bad]).is_err());
        }
        assert!(validate_retained_syncs(&vec![retained();101]).is_err());
        assert!(validate_retained_syncs(&[retained(),retained()]).is_err());
    }
    #[test]
    fn retained_tab_ownership_roundtrip_preserves_legacy_data_and_other_sections() {
        let f=Fixture::new();let p=f.path();let initial=save_reload(&p,&settings());let before=value(&p);
        let legacy=retained();let mut owned=legacy.clone();owned.id="owned".into();owned.owner_tab_id=Some("stable-tab".into());owned.owner_tab_closed=Some(false);
        let mut updated=initial.clone();updated.retained_syncs=vec![legacy,owned];let saved=save_reload(&p,&updated);
        let after=value(&p);for section in ["connections","appearance","explorer","browse","trust"] {assert_eq!(before[section],after[section]);}
        assert!(after["sync"]["retainedSyncs"][0].get("ownerTabId").is_none());
        assert_eq!(saved.retained_syncs[1].owner_tab_id.as_deref(),Some("stable-tab"));assert_eq!(saved.retained_syncs[1].owner_tab_closed,Some(false));
        let mut closed=saved.clone();closed.retained_syncs[1].owner_tab_closed=Some(true);let closed=save_reload(&p,&closed);
        assert_eq!(closed.retained_syncs[1].owner_tab_closed,Some(true));assert!(save(&p,&saved).unwrap_err().contains("revision conflict"));
    }
    #[test]
    fn retained_tab_ownership_rejects_partial_null_duplicate_invalid_and_excess_open_owners() {
        let good=serde_json::to_value(retained()).unwrap();
        for field in ["ownerTabId","ownerTabClosed"] {
            let mut bad=good.clone();bad[field]=serde_json::Value::Null;assert!(serde_json::from_value::<RetainedSync>(bad).is_err());
        }
        let mut owner=retained();owner.owner_tab_id=Some("tab".into());assert!(validate_retained_syncs(&[owner.clone()]).is_err());owner.owner_tab_closed=Some(false);
        assert!(validate_retained_syncs(&[owner.clone()]).is_ok());
        for id in ["".to_string(),"x".repeat(65),"bad\nowner".into(),"tab\"quote".into(),"<tab>".into(),"日本語".into(),"tab space".into()] {let mut bad=owner.clone();bad.owner_tab_id=Some(id);assert!(validate_retained_syncs(&[bad]).is_err());}
        for id in ["a".to_string(),"A_z-09".into(),"x".repeat(64)] {let mut valid=owner.clone();valid.owner_tab_id=Some(id);assert!(validate_retained_syncs(&[valid]).is_ok());}
        let mut other=owner.clone();other.id="other".into();other.owner_tab_closed=Some(true);assert!(validate_retained_syncs(&[owner.clone(),other]).is_err());
        let mut owners:Vec<_>=(0..17).map(|i|{let mut r=owner.clone();r.id=format!("record-{i}");r.owner_tab_id=Some(format!("tab-{i}"));r}).collect();
        assert!(validate_retained_syncs(&owners).is_err());owners[16].owner_tab_closed=Some(true);assert!(validate_retained_syncs(&owners).is_ok());
    }
    #[test]
    fn green_themes_roundtrip_without_affecting_legacy_sync_identity_or_trust() {
        let f=Fixture::new();let p=f.path();let mut saved=save_reload(&p,&settings());let before=value(&p);
        for theme in ["forest","mint"] {saved.theme=serde_json::from_value(theme.into()).unwrap();saved=save_reload(&p,&saved);assert_eq!(value(&p)["appearance"]["theme"],theme);for section in ["sync","connections","explorer","browse","trust"]{assert_eq!(value(&p)[section],before[section]);}}
    }
    #[test]
    fn retained_preset_identity_roundtrips_without_changing_saved_options() {
        let f=Fixture::new();let p=f.path();let mut initial=save_reload(&p,&settings());let mut record=retained();record.preset_id=Some("custom-preset".into());initial.retained_syncs=vec![record];let saved=save_reload(&p,&initial);
        assert_eq!(saved.retained_syncs[0].preset_id.as_deref(),Some("custom-preset"));assert!(saved.retained_syncs[0].delete_removed);assert!(!saved.retained_syncs[0].recursive);assert_eq!(saved.retained_syncs[0].exclusion_rules,"*.tmp");assert!(serde_json::to_value(retained()).unwrap().get("presetId").is_none());
    }
    #[test]
    fn retained_preset_identity_rejects_invalid_values_and_unknown_fields() {
        let good=serde_json::to_value(retained()).unwrap();
        for invalid in [serde_json::Value::Null,serde_json::json!(42),serde_json::json!(false)] {let mut bad=good.clone();bad["presetId"]=invalid;assert!(serde_json::from_value::<RetainedSync>(bad).is_err());}
        for id in ["".to_string(),"x".repeat(129),"界".repeat(43),"bad\nvalue".into()] {let mut bad=retained();bad.preset_id=Some(id);assert!(validate_retained_syncs(&[bad]).is_err());}
        for id in ["x".repeat(128),"界".repeat(42)] {let mut valid=retained();valid.preset_id=Some(id);assert!(validate_retained_syncs(&[valid]).is_ok());}
        let mut bad=good;bad["presetId"]="custom".into();bad["secret"]="bad".into();assert!(serde_json::from_value::<RetainedSync>(bad).is_err());
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "nearly-unified-generated-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> PathBuf {
            self.0.join("settings.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn profile() -> sftp::Profile {
        serde_json::from_value(serde_json::json!({"id":"generated","name":"Generated","host":"example.invalid","port":22,"user":"fixture","auth":"key","mode":"sftp","keyFile":"never-read-generated.ppk","hostKey":format!("SHA256:{}","A".repeat(43))})).unwrap()
    }
    fn settings() -> Settings {
        Settings {
            version: 1,
            ..Default::default()
        }
    }
    fn save_reload(path: &Path, data: &Settings) -> Settings {
        if !path.exists() && data.profiles.iter().any(|p| !p.host_key.is_empty()) {
            // Generated pre-approved fixture, equivalent to an externally
            // converted document; never an ordinary save trust bypass.
            let mut trust = host_pins::PinLedger::default();
            trust.seed(&data.profiles).unwrap();
            Document::from_settings(data, trust, 1)
                .unwrap()
                .write(path)
                .unwrap();
        } else {
            save(path, data).unwrap();
        }
        Document::read(path).unwrap().settings()
    }
    fn value(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }
    fn assert_refused_unchanged(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
        assert!(Document::read(path).is_err());
        assert!(save(path, &settings()).is_err());
        assert!(guard_pin(path, &profile()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn sync_profile_defaults_roundtrip_and_revision_safety() {
        let f=Fixture::new();let p=f.path();
        let mut data=save_reload(&p,&settings());
        data.sync_presets=vec![serde_json::from_value(serde_json::json!({"id":"nearly:sync-default:v1","name":"Default","exclusionRules":"default/"})).unwrap(),serde_json::from_value(serde_json::json!({"id":"custom","name":"Custom","deleteRemoved":true,"recursive":false})).unwrap()];
        let saved=save_reload(&p,&data);assert!(!saved.sync_presets[0].delete_removed);assert!(saved.sync_presets[0].recursive);assert!(saved.sync_presets[1].delete_removed);assert!(!saved.sync_presets[1].recursive);
        let mut edited=saved.clone();edited.sync_presets[0].delete_removed=true;edited.sync_presets[0].recursive=false;
        let edited=save_reload(&p,&edited);assert!(edited.sync_presets[0].delete_removed);assert!(!edited.sync_presets[0].recursive);
        assert!(save(&p,&saved).is_err());assert_eq!(value(&p)["revision"],edited.settings_revision);
        let before=std::fs::read(&p).unwrap();let mut old=value(&p);old["sync"]["syncPresets"][0].as_object_mut().unwrap().remove("deleteRemoved");old["sync"]["syncPresets"][0].as_object_mut().unwrap().remove("recursive");std::fs::write(&p,serde_json::to_vec(&old).unwrap()).unwrap();
        let bytes=std::fs::read(&p).unwrap();let loaded=Document::read(&p).unwrap().settings();assert!(!loaded.sync_presets[0].delete_removed);assert!(loaded.sync_presets[0].recursive);assert_eq!(bytes,std::fs::read(&p).unwrap());
        assert!(!before.is_empty());
        assert!(serde_json::from_value::<SyncPreset>(serde_json::json!({"id":"bad","name":"Bad","deleteRemoved":null})).is_err());
    }
    #[test]
    fn hundred_custom_profiles_allow_one_editable_default_without_expanding_user_limit() {
        let mut presets:Vec<SyncPreset>=(0..100).map(|n|serde_json::from_value(serde_json::json!({"id":format!("p{n}"),"name":format!("P{n}")})).unwrap()).collect();
        presets.push(serde_json::from_value(serde_json::json!({"id":"nearly:sync-default:v1","name":"Default"})).unwrap());
        assert!(validate_sync_preferences(&HashMap::new(),&HashMap::new(),&presets).is_ok());
        presets.push(serde_json::from_value(serde_json::json!({"id":"extra","name":"Extra"})).unwrap());assert!(validate_sync_preferences(&HashMap::new(),&HashMap::new(),&presets).is_err());
    }
    #[test]
    fn unified_only_writes_one_authoritative_document() {
        let f = Fixture::new();
        let p = f.path();
        let data = save_reload(&p, &settings());
        assert_eq!(data.settings_revision, 1);
        assert_eq!(value(&p)["schemaVersion"], 1);
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
        assert!(value(&p).get("version").is_none());
    }
    #[test]
    fn locale_density_missing_fields_load_defaults_without_writing() {
        let f = Fixture::new();
        let p = f.path();
        save_reload(&p, &settings());
        let mut old = value(&p);
        old["appearance"]
            .as_object_mut()
            .unwrap()
            .remove("language");
        old["appearance"]
            .as_object_mut()
            .unwrap()
            .remove("compactExplorer");
        std::fs::write(&p, serde_json::to_vec(&old).unwrap()).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let dto = serde_json::to_value(Document::read(&p).unwrap().settings()).unwrap();
        assert_eq!(dto["language"], "ja");
        assert_eq!(dto["compactExplorer"], false);
        assert_eq!(dto["settingsRevision"], 1);
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        let omitted: Settings =
            serde_json::from_value(serde_json::json!({"version":1,"profiles":[],"history":{}}))
                .unwrap();
        let omitted = serde_json::to_value(omitted).unwrap();
        assert_eq!(omitted["language"], "ja");
        assert_eq!(omitted["compactExplorer"], false);
    }
    #[test]
    fn locale_density_round_trip_preserves_document_and_cas() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles.push(profile());
        let mut loaded = save_reload(&p, &data);
        for (language, compact) in [("en", true), ("ja", false)] {
            let before = value(&p);
            let stale = loaded.clone();
            let mut dto = serde_json::to_value(loaded).unwrap();
            dto["language"] = language.into();
            dto["compactExplorer"] = compact.into();
            loaded = save_reload(
                &p,
                &serde_json::from_value(dto).expect("new preferences accepted"),
            );
            let mut expected = before;
            expected["revision"] = loaded.settings_revision.into();
            expected["appearance"]["language"] = language.into();
            expected["appearance"]["compactExplorer"] = compact.into();
            assert_eq!(value(&p), expected);
            let bytes = std::fs::read(&p).unwrap();
            assert!(save(&p, &stale).unwrap_err().contains("revision conflict"));
            assert_eq!(std::fs::read(&p).unwrap(), bytes);
        }
    }
    #[test]
    fn locale_density_explicit_invalid_values_fail_closed() {
        let f = Fixture::new();
        let p = f.path();
        let loaded = save_reload(&p, &settings());
        let valid = value(&p);
        for (key, invalid) in [
            ("language", serde_json::json!("fr")),
            ("language", serde_json::json!("JA")),
            ("language", serde_json::Value::Null),
            ("compactExplorer", serde_json::json!("false")),
            ("compactExplorer", serde_json::json!(1)),
            ("compactExplorer", serde_json::Value::Null),
        ] {
            let mut dto = serde_json::to_value(&loaded).unwrap();
            dto[key] = invalid.clone();
            assert!(serde_json::from_value::<Settings>(dto).is_err());
            let mut bad = valid.clone();
            bad["appearance"][key] = invalid;
            let bytes = serde_json::to_vec(&bad).unwrap();
            std::fs::write(&p, &bytes).unwrap();
            assert!(Document::read(&p).is_err());
            assert!(save(&p, &loaded).is_err());
            assert_eq!(std::fs::read(&p).unwrap(), bytes);
        }
    }
    #[test]
    fn theme_midnight_round_trip_preserves_other_sections_revision_and_trust() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles.push(profile());
        let mut loaded = save_reload(&p, &data);
        let before = value(&p);
        loaded.theme =
            serde_json::from_str("\"midnight\"").expect("midnight is a supported explicit theme");
        let after = save_reload(&p, &loaded);
        assert_eq!(after.settings_revision, 2);
        assert_eq!(serde_json::to_value(after.theme).unwrap(), "midnight");
        let mut expected = before;
        expected["revision"] = 2.into();
        expected["appearance"]["theme"] = "midnight".into();
        assert_eq!(value(&p), expected);
        let dto: Settings = serde_json::from_value(
            serde_json::json!({"version":1,"profiles":[],"history":{},"theme":"midnight"}),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(dto.theme).unwrap(), "midnight");
    }
    #[test]
    fn theme_system_remains_readable_without_native_os_resolution_or_load_writes() {
        let f = Fixture::new();
        let p = f.path();
        let fresh = Document::read(&p).unwrap().settings();
        assert_eq!(fresh.settings_revision, 0);
        assert!(matches!(fresh.theme, Theme::System));
        assert!(!p.exists());
        let omitted: Settings =
            serde_json::from_value(serde_json::json!({"version":1,"profiles":[],"history":{}}))
                .unwrap();
        assert!(matches!(omitted.theme, Theme::System));
        let mut saved = save_reload(&p, &fresh);
        let bytes = std::fs::read(&p).unwrap();
        assert!(matches!(
            Document::read(&p).unwrap().settings().theme,
            Theme::System
        ));
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
        // The frontend supplies its one-time OS resolution as an explicit value.
        saved.theme = Theme::Dark;
        let explicit = save_reload(&p, &saved);
        assert_eq!(explicit.settings_revision, 2);
        assert_eq!(value(&p)["appearance"]["theme"], "dark");
    }
    #[test]
    fn theme_unknown_values_and_missing_disk_field_fail_closed() {
        let f = Fixture::new();
        let p = f.path();
        save(&p, &settings()).unwrap();
        let good = value(&p);
        for theme in [
            serde_json::json!("unknown"),
            serde_json::json!("Midnight"),
            serde_json::json!(""),
            serde_json::Value::Null,
            serde_json::json!(true),
        ] {
            let mut bad = good.clone();
            bad["appearance"]["theme"] = theme;
            assert_refused_unchanged(&p, &serde_json::to_vec(&bad).unwrap());
        }
        let mut missing = good;
        missing["appearance"]
            .as_object_mut()
            .unwrap()
            .remove("theme");
        assert_refused_unchanged(&p, &serde_json::to_vec(&missing).unwrap());
    }
    #[test]
    fn unified_only_refuses_legacy_without_mutating_or_falling_back() {
        let f = Fixture::new();
        assert_refused_unchanged(&f.path(), br#"{"version":1,"profiles":[],"history":{}}"#);
    }
    #[test]
    fn sections_round_trip_and_only_primary_plus_backup_exist() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles = vec![profile()];
        let key = serde_json::to_string(&(
            "generated",
            "sftp",
            "example.invalid",
            22,
            "fixture",
            profile().host_key,
        ))
        .unwrap();
        data.history
            .insert("verified-history".into(), "C:\\generated".into());
        data.theme = Theme::Dark;
        data.local_pane_ratio = 0.62;
        data.local_tree_ratio = 0.34;
        data.remote_tree_ratio = 0.43;
        data.exclusions.insert(
            r#"["generated","/upload","c:\\generated"]"#.into(),
            "sample/\n!sample.txt".into(),
        );
        data.sync_options.insert(
            r#"["generated","/upload","c:\\generated"]"#.into(),
            SavedSyncOptions {
                delete_removed: true,
                recursive: false,
                preset_id: Some("preset".into()),
            },
        );
        data.sync_presets.push(SyncPreset {
            id: "preset".into(),
            name: "Preset".into(),
            exclusion_rules: "*.tmp".into(),
            delete_removed: true,
            recursive: false,
        });
        data.folder_bookmarks
            .push(explorer_preferences::FolderBookmark {
                id: "bookmark".into(),
                name: "Pair".into(),
                connection_key: key.clone(),
                local: "C:\\generated".into(),
                remote: "/upload".into(),
            });
        data.folder_pair_history
            .push(explorer_preferences::FolderPairHistory {
                connection_key: key.clone(),
                local: "C:\\generated".into(),
                remote: "/upload".into(),
                opened_at: 123,
            });
        data.browse_locations.insert(
            key,
            browse_preferences::Location {
                local: Some("C:\\generated".into()),
                remote: Some("/upload".into()),
            },
        );
        data.pane_columns.remote.sort = explorer_preferences::SortSpec {
            column: "size".into(),
            direction: "descending".into(),
        };
        let loaded = save_reload(&p, &data);
        let before = std::fs::read(&p).unwrap();
        assert_eq!(loaded.profiles[0].id, "generated");
        assert_eq!(loaded.folder_bookmarks[0].id, "bookmark");
        assert_eq!(loaded.sync_presets[0].exclusion_rules, "*.tmp");
        assert_eq!(loaded.local_tree_ratio, 0.34);
        assert_eq!(loaded.pane_columns.remote.sort.column, "size");
        assert_eq!(loaded.browse_locations.len(), 1);
        assert!(value(&p)["explorer"]["paneColumns"]["remote"]
            .get("sort")
            .is_none());
        let again = save_reload(&p, &loaded);
        assert_eq!(again.settings_revision, 2);
        assert_eq!(
            std::fs::read(p.with_extension("backup.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 2);
    }
    #[test]
    fn future_missing_unknown_corrupt_and_duplicate_fields_fail_closed() {
        let f = Fixture::new();
        let p = f.path();
        save(&p, &settings()).unwrap();
        let good = value(&p);
        for section in [
            "connections",
            "appearance",
            "explorer",
            "browse",
            "sync",
            "trust",
        ] {
            let mut bad = good.clone();
            bad.as_object_mut().unwrap().remove(section);
            assert_refused_unchanged(&p, &serde_json::to_vec(&bad).unwrap());
        }
        let mut future = good.clone();
        future["schemaVersion"] = 2.into();
        assert_refused_unchanged(&p, &serde_json::to_vec(&future).unwrap());
        let mut extra = good.clone();
        extra["password"] = "must-not-save".into();
        assert_refused_unchanged(&p, &serde_json::to_vec(&extra).unwrap());
        assert_refused_unchanged(&p, b"{broken");
        let json = serde_json::to_string(&good).unwrap();
        assert_refused_unchanged(
            &p,
            json.replacen(
                "\"schemaVersion\":1",
                "\"schemaVersion\":1,\"schemaVersion\":2",
                1,
            )
            .as_bytes(),
        );
        let endpoint = serde_json::to_string("[\"example.invalid\",22]").unwrap();
        let pin = serde_json::to_string(&profile().host_key).unwrap();
        let dup = json.replacen(
            "\"pins\":{}",
            &format!("\"pins\":{{{endpoint}:{pin},{endpoint}:{pin}}}"),
            1,
        );
        assert_ne!(dup, json);
        assert_refused_unchanged(&p, dup.as_bytes());
    }
    #[test]
    fn stale_full_dto_cannot_overwrite_any_section_or_approved_trust() {
        let f = Fixture::new();
        let p = f.path();
        let stale = save_reload(&p, &settings());
        let mut fresh = stale.clone();
        fresh.theme = Theme::Dark;
        fresh.history.insert("new".into(), "C:\\new".into());
        save(&p, &fresh).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert!(save(&p, &stale).unwrap_err().contains("revision conflict"));
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
    }
    #[test]
    fn deleted_profile_pin_cannot_be_cleared_rotated_or_recreated_blank() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles.push(profile());
        let mut loaded = save_reload(&p, &data);
        loaded.profiles.clear();
        loaded.connection_tree = Some(connection_tree::flat(&[]));
        let mut deleted = save_reload(&p, &loaded);
        assert_eq!(
            Document::read(&p).unwrap().trust.known(&profile()).unwrap(),
            Some(profile().host_key.as_str())
        );
        let bytes = std::fs::read(&p).unwrap();
        let mut cleared = profile();
        cleared.id = "new-id".into();
        cleared.host_key.clear();
        deleted.profiles = vec![cleared.clone()];
        deleted.connection_tree = Some(connection_tree::flat(&deleted.profiles));
        assert!(save(&p, &deleted).is_err());
        assert!(guard_pin(&p, &cleared).is_err());
        let mut changed = profile();
        changed.host_key = format!("SHA256:{}A", "B".repeat(42));
        assert!(guard_pin(&p, &changed).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
    }
    #[test]
    fn valid_unified_ignores_poisoned_unrelated_legacy_sidecars() {
        let f = Fixture::new();
        let p = f.path();
        let data = save_reload(&p, &settings());
        for name in [
            "host-pins.json",
            "appearance.json",
            "connection-tree.json",
            "browse-preferences.json",
        ] {
            std::fs::write(f.0.join(name), b"{poison").unwrap();
        }
        assert_eq!(Document::read(&p).unwrap().revision, 1);
        save(&p, &data).unwrap();
        for name in [
            "host-pins.json",
            "appearance.json",
            "connection-tree.json",
            "browse-preferences.json",
        ] {
            assert_eq!(std::fs::read(f.0.join(name)).unwrap(), b"{poison");
        }
    }
    #[test]
    fn missing_primary_with_backup_refuses_trust_reset_and_never_autorestores() {
        let f = Fixture::new();
        let p = f.path();
        let data = save_reload(&p, &settings());
        save(&p, &data).unwrap();
        std::fs::remove_file(&p).unwrap();
        assert!(Document::read(&p).is_err());
        assert!(save(&p, &settings()).is_err());
        assert!(guard_pin(&p, &profile()).is_err());
        assert!(!p.exists());
    }
    #[test]
    fn backup_failure_preserves_primary_and_removes_owned_temporary_files() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = save_reload(&p, &settings());
        let bytes = std::fs::read(&p).unwrap();
        std::fs::create_dir(p.with_extension("backup.json")).unwrap();
        data.theme = Theme::Dark;
        assert!(save(&p, &data).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 2);
    }
    #[test]
    fn reads_and_known_pin_guards_do_not_write_or_increment_revision() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles.push(profile());
        save_reload(&p, &data);
        let bytes = std::fs::read(&p).unwrap();
        for _ in 0..3 {
            Document::read(&p).unwrap();
            guard_pin(&p, &profile()).unwrap();
        }
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 1);
    }
    #[test]
    fn profile_pin_missing_from_trust_or_conflicting_fails_closed() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles.push(profile());
        save_reload(&p, &data);
        let mut bad = value(&p);
        bad["trust"]["pins"] = serde_json::json!({});
        assert_refused_unchanged(&p, &serde_json::to_vec(&bad).unwrap());
    }
    #[test]
    fn strict_persisted_appearance_and_tree_validation_prevents_silent_repair() {
        let f = Fixture::new();
        let p = f.path();
        save(&p, &settings()).unwrap();
        let good = value(&p);
        for ratio in [
            serde_json::Value::Null,
            serde_json::json!("0.5"),
            serde_json::json!(0.9),
        ] {
            let mut bad = good.clone();
            bad["appearance"]["localPaneRatio"] = ratio;
            assert_refused_unchanged(&p, &serde_json::to_vec(&bad).unwrap());
        }
        let mut bad = good;
        bad["connections"]["tree"]["nodes"] = serde_json::json!([{"id":"cycle","kind":"group","name":"Cycle","parentId":"cycle","expanded":true}]);
        assert_refused_unchanged(&p, &serde_json::to_vec(&bad).unwrap());
    }
    #[test]
    fn explicit_approval_atomically_commits_pin_profile_and_revision_once() {
        let f = Fixture::new();
        let p = f.path();
        let mut blank = profile();
        let pin = blank.host_key.clone();
        blank.host_key.clear();
        let mut data = settings();
        data.profiles.push(blank.clone());
        let loaded = save_reload(&p, &data);
        let manager = Arc::new(host_verification::HostVerification::default());
        let candidate = manager
            .begin("generated", &blank)
            .unwrap()
            .finish(sftp::ObservedHostKey {
                algorithm: "ssh-ed25519".into(),
                fingerprint: pin.clone(),
            })
            .unwrap();
        let approved = approve_saved_profile(
            &p,
            &manager,
            "generated",
            &candidate.token,
            &blank,
            loaded.settings_revision,
        )
        .unwrap();
        assert_eq!(approved.settings_revision, 2);
        let disk = Document::read(&p).unwrap();
        assert_eq!(disk.settings().profiles[0].host_key, pin);
        assert_eq!(disk.trust.known(&blank).unwrap(), Some(pin.as_str()));
        assert!(
            approve_saved_profile(&p, &manager, "generated", &candidate.token, &blank, 2).is_err()
        );
        assert!(save(&p, &loaded).is_err());
    }
    #[test]
    fn stale_approval_refuses_without_consuming_candidate_or_clobbering_new_section() {
        let f = Fixture::new();
        let p = f.path();
        let mut blank = profile();
        let pin = blank.host_key.clone();
        blank.host_key.clear();
        let mut data = settings();
        data.profiles.push(blank.clone());
        let mut loaded = save_reload(&p, &data);
        let manager = Arc::new(host_verification::HostVerification::default());
        let candidate = manager
            .begin("generated", &blank)
            .unwrap()
            .finish(sftp::ObservedHostKey {
                algorithm: "ssh-ed25519".into(),
                fingerprint: pin,
            })
            .unwrap();
        loaded.theme = Theme::Dark;
        save(&p, &loaded).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert!(
            approve_saved_profile(&p, &manager, "generated", &candidate.token, &blank, 1).is_err()
        );
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert!(
            approve_saved_profile(&p, &manager, "generated", &candidate.token, &blank, 2).is_ok()
        );
        assert!(matches!(
            Document::read(&p).unwrap().settings().theme,
            Theme::Dark
        ));
    }
    #[test]
    fn failed_approval_retains_no_partial_pin_and_consumes_token() {
        let f = Fixture::new();
        let p = f.path();
        let mut blank = profile();
        let pin = blank.host_key.clone();
        blank.host_key.clear();
        let mut data = settings();
        data.profiles.push(blank.clone());
        save(&p, &data).unwrap();
        let manager = Arc::new(host_verification::HostVerification::default());
        let candidate = manager
            .begin("generated", &blank)
            .unwrap()
            .finish(sftp::ObservedHostKey {
                algorithm: "ssh-ed25519".into(),
                fingerprint: pin,
            })
            .unwrap();
        std::fs::create_dir(p.with_extension("backup.json")).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert!(
            approve_saved_profile(&p, &manager, "generated", &candidate.token, &blank, 1).is_err()
        );
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        std::fs::remove_dir(p.with_extension("backup.json")).unwrap();
        assert!(
            approve_saved_profile(&p, &manager, "generated", &candidate.token, &blank, 1).is_err()
        );
        assert!(Document::read(&p).unwrap().trust.pins.is_empty());
    }
    #[test]
    fn invalid_dto_rejected_without_creating_primary() {
        let f = Fixture::new();
        let p = f.path();
        for ratio in [f64::NAN, f64::INFINITY, 0.19, 0.81] {
            let mut data = settings();
            data.local_pane_ratio = ratio;
            assert!(save(&p, &data).is_err());
        }
        assert!(!p.exists());
        assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 0);
    }
    #[test]
    fn unapproved_pin_cannot_enter_through_save_or_connection_guard() {
        let f = Fixture::new();
        let p = f.path();
        let mut data = settings();
        data.profiles.push(profile());
        assert!(save(&p, &data).is_err());
        assert!(guard_pin(&p, &profile()).is_err());
        assert!(!p.exists());
        let mut blank = profile();
        blank.host_key.clear();
        data.profiles = vec![blank.clone()];
        save(&p, &data).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert!(guard_pin(&p, &blank).is_err());
        assert!(guard_pin(&p, &profile()).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
    }
    #[test]
    #[ignore = "Explicit external converter validation only; requires a designated generated/staged fixture path"]
    fn unified_external_fixture() {
        let path = std::env::var_os("NEARLY_VALIDATE_SETTINGS_FIXTURE")
            .expect("Set exact staged fixture path");
        let bytes = std::fs::read(path).unwrap();
        let doc =
            Document::parse(&bytes).expect("Unified fixture must pass full native validation");
        println!(
            "Validated unified schema=1 revision={} profiles={} bookmarks={} pins={}",
            doc.revision,
            doc.connections.profiles.len(),
            doc.explorer.folder_bookmarks.len(),
            doc.trust.pins.len()
        );
    }
}
