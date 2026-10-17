#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod bookmark_tree;
mod browse_preferences;
mod browse_transport;
mod connection_tree;
mod drives;
mod engine;
mod local_watch;
mod taskbar_status;
#[cfg(windows)]
mod taskbar_adapter;
mod exclusion;
mod explorer_preferences;
mod file_ops;
mod zip_preflight;
mod local_publish;
mod local_zip;
mod host_pins;
mod host_verification;
mod sessions;
mod settings_location;
mod settings_clients;
mod sftp;
mod unified_settings;
mod window_ownership;
mod tab_drag;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};
#[derive(Default)]
struct AppState {
    local_watch: Arc<local_watch::LocalWatchRegistry>,
    local_watch_visibility: Arc<Mutex<()>>,
    engine: Arc<engine::Engine>,
    sessions: Arc<sessions::Sessions>,
    settings: Mutex<()>, 
    settings_clients: Mutex<settings_clients::SettingsClients>,
    ownership: Arc<Mutex<window_ownership::Registry>>,
    tab_drag: Arc<tab_drag::Controller>,
    host_verification: Arc<host_verification::HostVerification>,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    Light,
    Dark,
    Midnight,
    Forest,
    Mint,
    #[default]
    System,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Language {
    #[default]
    Ja,
    En,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    version: u32,
    #[serde(rename = "settingsRevision", default)]
    settings_revision: u64,
    profiles: Vec<sftp::Profile>,
    history: HashMap<String, String>,
    #[serde(default)]
    theme: Theme,
    #[serde(default)]
    language: Language,
    #[serde(rename = "compactExplorer", default)]
    compact_explorer: bool,
    #[serde(
        rename = "localPaneRatio",
        default = "default_pane_ratio",
        deserialize_with = "deserialize_pane_ratio"
    )]
    local_pane_ratio: f64,
    #[serde(
        rename = "localTreeRatio",
        default = "default_tree_ratio",
        deserialize_with = "deserialize_tree_ratio"
    )]
    local_tree_ratio: f64,
    #[serde(
        rename = "remoteTreeRatio",
        default = "default_tree_ratio",
        deserialize_with = "deserialize_tree_ratio"
    )]
    remote_tree_ratio: f64,
    #[serde(default)]
    exclusions: HashMap<String, String>,
    #[serde(rename = "syncOptions", default)]
    sync_options: HashMap<String, SavedSyncOptions>,
    #[serde(rename = "syncPresets", default)]
    sync_presets: Vec<SyncPreset>,
    #[serde(rename = "retainedSyncs", default)]
    retained_syncs: Vec<RetainedSync>,
    #[serde(rename = "folderBookmarks", default)]
    folder_bookmarks: Vec<explorer_preferences::FolderBookmark>,
    #[serde(rename = "folderPairHistory", default)]
    folder_pair_history: Vec<explorer_preferences::FolderPairHistory>,
    #[serde(rename = "paneColumns", default)]
    pane_columns: explorer_preferences::PaneColumns,
    #[serde(rename = "connectionTree", default)]
    connection_tree: Option<connection_tree::Tree>,
    #[serde(rename = "connectionTreeChanged", default)]
    connection_tree_changed: bool,
    #[serde(
        rename = "connectionTreeWarning",
        default,
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    connection_tree_warning: Option<String>,
    #[serde(rename = "bookmarkTree", default)]
    bookmark_tree: Option<bookmark_tree::Tree>,
    #[serde(rename = "bookmarkTreeChanged", default)]
    bookmark_tree_changed: bool,
    #[serde(
        rename = "bookmarkTreeWarning",
        default,
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    bookmark_tree_warning: Option<String>,
    #[serde(rename = "browseLocations", default)]
    browse_locations: browse_preferences::Locations,
    #[serde(rename = "browseLocationsChanged", default)]
    browse_locations_changed: bool,
    #[serde(
        rename = "preferenceWarnings",
        default,
        skip_deserializing,
        skip_serializing_if = "Vec::is_empty"
    )]
    preference_warnings: Vec<String>,
}
fn default_pane_ratio() -> f64 {
    0.5
}
fn default_tree_ratio() -> f64 {
    0.28
}
fn validate_tree_ratio(value: f64) -> Result<f64, String> {
    if value.is_finite() && (0.15..=0.65).contains(&value) {
        Ok(value)
    } else {
        Err("Tree ratios must be finite numbers between 0.15 and 0.65".into())
    }
}
fn deserialize_tree_ratio<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<f64, D::Error> {
    let value = Option::<f64>::deserialize(deserializer)?;
    value
        .map_or_else(|| Ok(default_tree_ratio()), validate_tree_ratio)
        .map_err(serde::de::Error::custom)
}
fn validate_pane_ratio(value: f64) -> Result<f64, String> {
    if value.is_finite() && (0.2..=0.8).contains(&value) {
        Ok(value)
    } else {
        Err("localPaneRatio must be a finite number between 0.20 and 0.80".into())
    }
}
fn deserialize_pane_ratio<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<f64, D::Error> {
    let value = Option::<f64>::deserialize(deserializer)?;
    value
        .map_or_else(|| Ok(default_pane_ratio()), validate_pane_ratio)
        .map_err(serde::de::Error::custom)
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 0,
            settings_revision: 0,
            profiles: vec![],
            history: HashMap::new(),
            theme: Theme::System,
            language: Language::Ja,
            compact_explorer: false,
            local_pane_ratio: default_pane_ratio(),
            local_tree_ratio: default_tree_ratio(),
            remote_tree_ratio: default_tree_ratio(),
            exclusions: HashMap::new(),
            sync_options: HashMap::new(),
            sync_presets: vec![],
            retained_syncs: vec![],
            folder_bookmarks: vec![],
            folder_pair_history: vec![],
            pane_columns: Default::default(),
            connection_tree: None,
            connection_tree_changed: false,
            connection_tree_warning: None,
            bookmark_tree: None,
            bookmark_tree_changed: false,
            bookmark_tree_warning: None,
            browse_locations: Default::default(),
            browse_locations_changed: false,
            preference_warnings: vec![],
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Appearance {
    theme: Theme,
    #[serde(default)]
    language: Language,
    #[serde(default)]
    compact_explorer: bool,
    local_pane_ratio: f64,
    local_tree_ratio: f64,
    remote_tree_ratio: f64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncRules {
    exclusions: HashMap<String, String>,
    sync_options: HashMap<String, SavedSyncOptions>,
    sync_presets: Vec<SyncPreset>,
    #[serde(default)]
    retained_syncs: Vec<RetainedSync>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RetainedPendingState { Unknown, Unreflected }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainedSync {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_retained_owner")]
    owner_tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_retained_owner")]
    owner_tab_closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_retained_owner")]
    preset_id: Option<String>,
    profile: sftp::Profile,
    local: String,
    remote: String,
    exclusion_rules: String,
    delete_removed: bool,
    recursive: bool,
    pending_state: RetainedPendingState,
}
// Missing fields mean a legacy unowned record. Explicit null must not masquerade as missing.
fn present_retained_owner<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: serde::Deserialize<'de> {
    T::deserialize(deserializer).map(Some)
}
fn validate_retained_syncs(values: &[RetainedSync]) -> Result<(), String> {
    if values.len() > 100 { return Err("At most 100 stopped sync registrations".into()); }
    let mut ids = std::collections::HashSet::new();
    let mut owners = std::collections::HashSet::new();
    let mut open_owners = 0;
    for value in values {
        if value.preset_id.as_ref().is_some_and(|id| id.trim().is_empty() || id.len() > 128 || id.chars().any(char::is_control)) {
            return Err("Invalid retained sync preset ID".into());
        }
        match (&value.owner_tab_id, value.owner_tab_closed) {
            (None, None) => {},
            (Some(owner), Some(closed)) => {
                if owner.is_empty() || owner.len() > 64 || !owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') || !owners.insert(owner) {
                    return Err("Invalid or duplicate retained tab owner".into());
                }
                if !closed { open_owners += 1; }
                if open_owners > 16 { return Err("At most 16 open retained tabs".into()); }
            },
            _ => return Err("Invalid retained tab ownership".into()),
        }
        if value.id.trim().is_empty() || value.id.encode_utf16().count() > 128 || value.id.chars().any(char::is_control) || !ids.insert(&value.id) {
            return Err("Invalid or duplicate stopped sync registration ID".into());
        }
        let p = &value.profile;
        if p.auth != "key" || !matches!(p.mode.as_str(), "sftp" | "mock") || p.port == 0 || p.id.trim().is_empty() || p.name.trim().is_empty() || p.host.trim().is_empty() || p.user.trim().is_empty()
            || [(&p.id,128), (&p.name,100), (&p.host,4096), (&p.user,4096), (&p.key_file,4096), (&p.host_key,4096)].iter().any(|(text,limit)| text.encode_utf16().count() > *limit || text.chars().any(char::is_control)) {
            return Err("Invalid stopped sync profile snapshot".into());
        }
        let identity = serde_json::to_string(&(p.id.as_str(), p.mode.as_str(), p.host.trim().to_lowercase(), p.port, p.user.as_str(), p.host_key.trim())).map_err(|_| "Invalid stopped sync identity")?;
        explorer_preferences::pair(&identity, &value.local, &value.remote)?;
        validate_rule_text(&value.exclusion_rules)?;
        if value.exclusion_rules.contains('\0') { return Err("Stopped sync exclusion rules contain NUL".into()); }
        exclusion::Rules::compile(&value.exclusion_rules)?;
        // An orphan snapshot is retained as data; resuming still requires a live,
        // matching profile and a new explicit start/host-key verification.
    }
    Ok(())
}
fn default_recursive() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedSyncOptions {
    #[serde(default)]
    delete_removed: bool,
    #[serde(default = "default_recursive")]
    recursive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preset_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncPreset {
    id: String,
    name: String,
    #[serde(default)]
    exclusion_rules: String,
    #[serde(default)]
    delete_removed: bool,
    #[serde(default = "default_recursive")]
    recursive: bool,
}
fn validate_rule_text(text: &str) -> Result<(), String> {
    if text.len() > 65536
        || text.lines().count() > 2048
        || text.lines().any(|line| line.len() > 4096)
    {
        Err("Saved exclusion text exceeds 64 KiB, 2048 lines, or 4096 bytes per line".into())
    } else {
        Ok(())
    }
}
fn validate_combination_key(key: &str) -> Result<(), String> {
    if key.len() > 8192 {
        return Err("Saved sync combination key exceeds supported size".into());
    }
    let parts: Vec<String> = serde_json::from_str(key)
        .map_err(|_| "Sync combination key must be JSON [profile,remote,local]")?;
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("Sync combination key must contain profile, remote, and local".into());
    }
    Ok(())
}
fn validate_sync_preferences(
    exclusions: &HashMap<String, String>,
    options: &HashMap<String, SavedSyncOptions>,
    presets: &[SyncPreset],
) -> Result<(), String> {
    validate_saved_rules(exclusions)?;
    if exclusions
        .keys()
        .chain(options.keys())
        .collect::<std::collections::HashSet<_>>()
        .len()
        > 500
        || presets.len() > 101
        || presets.iter().filter(|p| p.id != "nearly:sync-default:v1").count() > 100
    {
        return Err("At most 500 sync combinations and 100 sync presets".into());
    }
    for (key, option) in options {
        validate_combination_key(key)?;
        if option
            .preset_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Invalid sync preset reference".into());
        }
    }
    let mut ids = std::collections::HashSet::new();
    for preset in presets {
        if preset.id.is_empty()
            || preset.id.len() > 128
            || preset.name.trim().is_empty()
            || preset.name.chars().count() > 100
            || !ids.insert(&preset.id)
        {
            return Err(
                "Sync preset IDs must be unique and names must contain 1–100 characters".into(),
            );
        }
        validate_rule_text(&preset.exclusion_rules)?;
    }
    Ok(())
}
fn validate_saved_rules(rules: &HashMap<String, String>) -> Result<(), String> {
    if rules.len() > 500 {
        return Err("At most 500 saved exclusion combinations".into());
    }
    for (key, text) in rules {
        validate_combination_key(key)?;
        validate_rule_text(text)?;
    }
    Ok(())
}
fn settings_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    settings_location::resolve()
}
#[tauri::command]
fn load_settings(window: tauri::WebviewWindow, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<Settings, String> {
    let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
    let data = load_saved_settings(&settings_path(&app)?)?;
    state.settings_clients.lock().map_err(|_| "Settings client lock failed")?
        .remember_loaded(window.label(), serde_json::to_value(&data).map_err(|e| e.to_string())?)?;
    Ok(data)
}
fn load_saved_settings(path: &Path) -> Result<Settings, String> {
    Ok(unified_settings::Document::read(path)?.settings())
}
fn trusted_pin_ledger(path: &Path) -> Result<host_pins::PinLedger, String> {
    Ok(unified_settings::Document::read(path)?.trust)
}
fn guard_connection_pin(
    app: &tauri::AppHandle,
    state: &AppState,
    profile: &sftp::Profile,
) -> Result<(), String> {
    if profile.mode != "sftp" {
        return Ok(());
    }
    let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
    guard_pin_files(&settings_path(app)?, profile)
}
fn guard_pin_files(path: &Path, profile: &sftp::Profile) -> Result<(), String> {
    unified_settings::guard_pin(path, profile)
}
fn save_settings_files(path: &Path, data: &Settings) -> Result<u64, String> {
    unified_settings::save(path, data)
}
fn validate_settings(data: &Settings) -> Result<(), String> {
    if data.version != 1 || data.profiles.len() > 200 || data.history.len() > 5000 {
        return Err("Settings limit or version invalid".into());
    }
    for p in &data.profiles {
        if p.auth != "key"
            || !matches!(p.mode.as_str(), "mock" | "sftp")
            || p.port == 0
            || p.host.trim().is_empty()
            || p.user.trim().is_empty()
            || p.name.trim().is_empty()
        {
            return Err("Invalid profile".into());
        }
    }
    validate_pane_ratio(data.local_pane_ratio)?;
    validate_tree_ratio(data.local_tree_ratio)?;
    validate_tree_ratio(data.remote_tree_ratio)?;
    validate_sync_preferences(&data.exclusions, &data.sync_options, &data.sync_presets)?;
    validate_retained_syncs(&data.retained_syncs)?;
    explorer_preferences::validate(
        &data.folder_bookmarks,
        &data.folder_pair_history,
        &data.pane_columns,
    )?;
    browse_preferences::validate(
        &data.browse_locations,
        &browse_preferences::PaneSorts {
            local: data.pane_columns.local.sort.clone(),
            remote: data.pane_columns.remote.sort.clone(),
        },
    )?;
    connection_tree::validate(
        &data
            .connection_tree
            .clone()
            .unwrap_or_else(|| connection_tree::flat(&data.profiles)),
        &data.profiles,
        false,
    )?;
    bookmark_tree::validate(
        &data
            .bookmark_tree
            .clone()
            .unwrap_or_else(|| bookmark_tree::flat(&data.folder_bookmarks)),
        &data.folder_bookmarks,
        false,
    )?;
    Ok(())
}
#[cfg(test)]
mod settings_tests {
    use super::*;
    #[test]
    fn sync_preferences_default_safe_flags_and_reject_connection_fields_or_excess_presets() {
        let option: SavedSyncOptions = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!option.delete_removed);
        assert!(option.recursive);
        let preset: SyncPreset =
            serde_json::from_value(serde_json::json!({"id":"one","name":"One"})).unwrap();
        assert!(!preset.delete_removed);
        assert!(preset.recursive);
        for key in ["host", "keyFile", "passphrase", "remote", "local"] {
            let mut value = serde_json::json!({"id":"one","name":"One"});
            value[key] = serde_json::json!("must-refuse");
            assert!(serde_json::from_value::<SyncPreset>(value).is_err());
        }
        let presets: Vec<_> = (0..101)
            .map(|n| SyncPreset {
                id: format!("preset-{n}"),
                name: format!("Preset {n}"),
                exclusion_rules: String::new(),
                delete_removed: false,
                recursive: true,
            })
            .collect();
        assert!(validate_sync_preferences(&HashMap::new(), &HashMap::new(), &presets).is_err());
        let duplicate = vec![preset.clone(), preset];
        assert!(validate_sync_preferences(&HashMap::new(), &HashMap::new(), &duplicate).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn local_hidden_listing_uses_actual_attribute_not_dot_name() {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            },
        };
        let root = std::env::temp_dir().join(format!(
            "syncfiles-hidden-generated-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let hidden = root.join("attribute-only.txt");
        std::fs::write(&hidden, b"generated fixture").unwrap();
        std::fs::write(root.join(".dot-only.txt"), b"generated fixture").unwrap();
        let wide: Vec<u16> = hidden.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_ATTRIBUTE_HIDDEN).unwrap();
        }
        let entries =
            tauri::async_runtime::block_on(list_local(root.to_string_lossy().into_owned()))
                .unwrap();
        let hidden_entry = entries
            .iter()
            .find(|e| e.name == "attribute-only.txt")
            .unwrap();
        assert!(hidden_entry.hidden);
        assert!(hidden_entry.permissions.is_none() && hidden_entry.owner.is_none());
        assert!(
            !entries
                .iter()
                .find(|e| e.name == ".dot-only.txt")
                .unwrap()
                .hidden
        );
        unsafe {
            SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_ATTRIBUTE_NORMAL).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn available_local_drive_roots_are_read_only_browsable_but_drive_relative_paths_are_refused() {
        tauri::async_runtime::block_on(async {
            for root in ["C:\\", "D:\\"] {
                if check_listing_drive(root).is_ok() {
                    assert!(
                        list_local(root.into()).await.is_ok(),
                        "Available local drive root listing failed"
                    );
                }
            }
            assert!(list_local("C:".into()).await.is_err());
        });
    }
    fn profile(host: &str) -> sftp::Profile {
        serde_json::from_value(serde_json::json!({"id":"fixture","name":"Fixture","host":host,"port":22,"user":"fixture","auth":"key","mode":"sftp","keyFile":"generated.ppk","hostKey":"SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})).unwrap()
    }
    #[test]
    fn session_routing_ignores_incoming_profile_and_secret_and_legacy_route_still_works() {
        let sessions = Arc::new(sessions::Sessions::default());
        sessions.prepare("tab").unwrap();
        let mut initial = sessions
            .connect(
                "tab",
                profile("frozen"),
                zeroize::Zeroizing::new("frozen-generated-secret".into()),
            )
            .unwrap();
        initial.install().unwrap();
        drop(initial);
        let resolved = resolve_credentials(
            &sessions,
            Some("tab"),
            profile("edited"),
            zeroize::Zeroizing::new("incoming".into()),
        )
        .unwrap();
        assert_eq!(resolved.profile.host, "frozen");
        assert_eq!(resolved.secret.as_str(), "frozen-generated-secret");
        assert!(resolved.lease.is_some());
        drop(resolved);
        let legacy = resolve_credentials(
            &sessions,
            None,
            profile("legacy"),
            zeroize::Zeroizing::new("legacy-secret".into()),
        )
        .unwrap();
        assert_eq!(legacy.profile.host, "legacy");
        assert_eq!(legacy.secret.as_str(), "legacy-secret");
        assert!(legacy.lease.is_none());
        sessions.shutdown();
    }
    #[test]
    fn session_disconnect_between_resolution_and_start_cancels_exact_engine_token() {
        let sessions = Arc::new(sessions::Sessions::default());
        sessions.prepare("tab").unwrap();
        let mut p = profile("127.0.0.1");
        p.host_key = format!("SHA256:{}", "A".repeat(43));
        let mut initial = sessions
            .connect("tab", p.clone(), zeroize::Zeroizing::new(String::new()))
            .unwrap();
        initial.install().unwrap();
        drop(initial);
        let engine = engine::Engine::default();
        engine.prepare("pending-session-start".into()).unwrap();
        let resolved = resolve_credentials(
            &sessions,
            Some("tab"),
            p,
            zeroize::Zeroizing::new("ignored".into()),
        )
        .unwrap();
        let token = engine
            .prepared_start_token("pending-session-start")
            .unwrap();
        resolved.lease.as_ref().unwrap().link_stop(&token).unwrap();
        sessions.disconnect("tab").unwrap();
        assert!(token.load(Ordering::SeqCst));
        let root = std::env::temp_dir().join(format!(
            "syncfiles-session-start-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let error = engine
            .start(
                "pending-session-start".into(),
                resolved.profile,
                root.to_str().unwrap().into(),
                "/upload".into(),
                resolved.secret,
                engine::SyncOptions::default(),
            )
            .unwrap_err();
        assert!(
            error.to_lowercase().contains("stop") || error.to_lowercase().contains("cancel"),
            "{error}"
        );
        assert!(engine.status("pending-session-start").is_err());
        assert!(engine.try_begin_close().is_ok());
        drop(resolved.lease);
        std::fs::remove_dir(root).unwrap();
        sessions.shutdown();
    }
    #[test]
    fn local_listing_worker_permits_are_bounded_and_released() {
        let first = listing_permit().unwrap();
        let second = listing_permit().unwrap();
        assert!(listing_permit().is_err());
        drop(first);
        assert!(listing_permit().is_ok());
        drop(second);
    }
    #[cfg(windows)]
    #[test]
    fn unc_listing_is_refused_without_touching_a_network_path() {
        assert!(check_listing_drive("\\\\generated-invalid-host\\share").is_err());
        assert!(check_listing_drive("relative").is_err());
    }
}
#[tauri::command]
fn save_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    data: Settings,
) -> Result<u64, String> {
    let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
    let path = settings_path(&app)?;
    let current = load_saved_settings(&path)?;
    let proposed = serde_json::to_value(&data).map_err(|e| e.to_string())?;
    let mut clients = state.settings_clients.lock().map_err(|_| "Settings client lock failed")?;
    let merged = clients.prepare_save(window.label(), &proposed,
        &serde_json::to_value(&current).map_err(|e| e.to_string())?)?;
    let merged: Settings = serde_json::from_value(merged).map_err(|e| e.to_string())?;
    validate_settings(&merged)?;
    let revision = save_settings_files(&path, &merged)?;
    clients.remember_saved(window.label(), proposed, revision)?;
    let payload = serde_json::json!({"settingsRevision":revision});
    for (label, other) in app.webview_windows() {
        if label != window.label() { let _ = other.emit("settings-changed", &payload); }
    }
    Ok(revision)
}
fn approval_profile_index(settings: &Settings, profile: &sftp::Profile) -> Result<usize, String> {
    let index = settings
        .profiles
        .iter()
        .position(|p| p.id == profile.id)
        .ok_or("Save this connection profile before verifying its host key")?;
    if serde_json::to_value(&settings.profiles[index]).ok() != serde_json::to_value(profile).ok() {
        return Err("The saved connection changed; dismiss this approval and reconnect from the current profile".into());
    }
    Ok(index)
}
#[tauri::command]
async fn probe_host_key(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request_id: String,
    profile: sftp::Profile,
) -> Result<host_verification::Candidate, String> {
    let probe = {
        let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
        let path = settings_path(&app)?;
        let saved = load_saved_settings(&path)?;
        let ledger = trusted_pin_ledger(&path)?;
        if ledger.known(&profile)?.is_some() {
            return Err("This endpoint already has a remembered host key. Initial approval cannot replace it; use a separate rotation procedure".into());
        }
        approval_profile_index(&saved, &profile)?;
        let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
        ownership.registered(window.label())?;
        if ownership.pending(window.label()){return Err("Window transfer is pending".into());}
        let newly_registered=!ownership.probes.contains_key(&request_id);
        window_ownership::Registry::scoped(&mut ownership.probes, window.label(), &request_id, true)?;
        match state.host_verification.begin(&request_id, &profile){Ok(probe)=>probe,Err(error)=>{if newly_registered{ownership.probes.remove(&request_id);}return Err(error);}}
    };
    tauri::async_runtime::spawn_blocking(move || {
        let observed = sftp::probe_host_key(probe.profile(), probe.stop())?;
        let state = app.state::<AppState>();
        let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
        let path = settings_path(&app)?;
        let saved = load_saved_settings(&path)?;
        if trusted_pin_ledger(&path)?.known(probe.profile())?.is_some() {
            return Err(
                "This endpoint was pinned while probing; initial approval is no longer available"
                    .into(),
            );
        }
        approval_profile_index(&saved, probe.profile())?;
        probe.finish(observed)
    })
    .await
    .map_err(|_| "Host key probe worker failed")?
}
#[tauri::command]
fn cancel_host_key(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, request_id: String) -> Result<(), String> {
    let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    window_ownership::Registry::scoped(&mut ownership.probes, window.label(), &request_id, false)?;
    state.host_verification.cancel(&request_id)
}
#[derive(Serialize)]
struct ApprovedProfile {
    #[serde(flatten)]
    profile: sftp::Profile,
    #[serde(rename = "settingsRevision")]
    settings_revision: u64,
}
#[tauri::command]
fn approve_host_key(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request_id: String,
    token: String,
    profile: sftp::Profile,
    expected_revision: u64,
) -> Result<ApprovedProfile, String> {
    { let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?; window_ownership::Registry::scoped(&mut ownership.probes, window.label(), &request_id, false)?; }
    let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
    let path = settings_path(&app)?;
    let mut clients = state.settings_clients.lock().map_err(|_| "Settings client lock failed")?;
    let baselines = clients.profile_approval_baselines(window.label(), expected_revision, &profile.id)?;
    let approved = approve_saved_profile(
        &path,
        &state.host_verification,
        &request_id,
        &token,
        &profile,
        expected_revision,
    )?;
    let approved_value = serde_json::to_value(&approved.profile).map_err(|e| e.to_string())?;
    for mut baseline in baselines {
        if let Some(profiles) = baseline.get_mut("profiles").and_then(serde_json::Value::as_array_mut) {
            for profile in profiles {
                if profile.get("id").and_then(serde_json::Value::as_str) == Some(approved.profile.id.as_str()) {
                    *profile = approved_value.clone();
                }
            }
        }
        clients.remember_saved(window.label(), baseline, approved.settings_revision)?;
    }
    let payload = serde_json::json!({"settingsRevision":approved.settings_revision});
    for (label, other) in app.webview_windows() {
        if label != window.label() { let _ = other.emit("settings-changed", &payload); }
    }
    Ok(approved)
}
// Callers serialize this entire read/validate/commit transaction with settings.
fn approve_saved_profile(
    path: &Path,
    manager: &host_verification::HostVerification,
    request_id: &str,
    token: &str,
    profile: &sftp::Profile,
    expected_revision: u64,
) -> Result<ApprovedProfile, String> {
    let mut saved = load_saved_settings(&path)?;
    if saved.settings_revision != expected_revision {
        return Err(
            "Settings changed since loading; reload before approving (revision conflict)".into(),
        );
    }
    let ledger = trusted_pin_ledger(&path)?;
    if ledger.known(&profile)?.is_some() {
        return Err(
            "This endpoint already has a remembered key; initial approval cannot rotate it".into(),
        );
    }
    let index = approval_profile_index(&saved, &profile)?;
    let mut revision = saved.settings_revision;
    let approved = manager.approve(request_id, token, profile, |approved| {
        saved.profiles[index] = approved.clone();
        revision = unified_settings::save_approved(path, &saved, approved)?;
        Ok(())
    })?;
    Ok(ApprovedProfile {
        profile: approved,
        settings_revision: revision,
    })
}
fn picker_text(language: Language) -> (&'static str, &'static str, &'static str) {
    match language {
        Language::Ja => ("フォルダーを選択", "PPK秘密鍵を選択", "PuTTY秘密鍵"),
        Language::En => (
            "Select a folder",
            "Select PPK private key",
            "PuTTY private key",
        ),
    }
}
#[test]
fn native_picker_owned_labels_use_requested_language_without_opening_dialogs() {
    assert_eq!(
        picker_text(Language::Ja),
        ("フォルダーを選択", "PPK秘密鍵を選択", "PuTTY秘密鍵")
    );
    assert_eq!(
        picker_text(Language::En),
        (
            "Select a folder",
            "Select PPK private key",
            "PuTTY private key"
        )
    );
    assert_eq!(picker_text(Language::default()), picker_text(Language::Ja));
}
#[tauri::command]
async fn pick_folder(language: Option<Language>) -> Result<Option<String>, String> {
    let title = picker_text(language.unwrap_or_default()).0;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title(title)
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "Folder dialog failed")?
}
#[tauri::command]
fn list_drives() -> Result<Vec<drives::Drive>, String> {
    drives::list()
}
fn listing_permit() -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    static LISTINGS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    LISTINGS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Local listing workers are still busy; wait before retrying".into())
}
fn check_listing_drive(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
        let bytes = path.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
        {
            return Err(
                "Use an absolute local drive path; network share listing is unsupported".into(),
            );
        }
        let root = format!("{}:\\", bytes[0] as char);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        match unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } {
            4 => {
                return Err(
                    "Network drive browsing is unsupported; no network scan was attempted".into(),
                )
            }
            0 | 1 => return Err("This drive is unavailable".into()),
            _ => {}
        }
    }
    Ok(())
}
#[tauri::command]
async fn list_local(path: String) -> Result<Vec<sftp::Entry>, String> {
    check_listing_drive(&path)?;
    let permit = listing_permit()?;
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut out = Vec::new();
        for item in std::fs::read_dir(path).map_err(|_| "Local directory unavailable")? {
            let item = item.map_err(|_| "Local entry unavailable")?;
            let m = item.metadata().map_err(|_| "Local metadata unavailable")?;
            #[cfg(windows)]
            let hidden = {
                use std::os::windows::fs::MetadataExt;
                m.file_attributes() & 0x2 != 0
            };
            #[cfg(not(windows))]
            let hidden = false;
            out.push(sftp::Entry {
                name: item.file_name().to_string_lossy().into_owned(),
                dir: m.is_dir(),
                size: m.len(),
                permissions: None,
                owner: None,
                hidden,
                modified_at: m
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs()),
            });
            if out.len() > 20000 {
                return Err("Folder contains too many entries".into());
            }
        }
        out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.cmp(&b.name)));
        Ok(out)
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), worker)
        .await
        .map_err(|_| "Local listing timed out; the drive may be disconnected or unavailable")?
        .map_err(|_| "Local listing worker failed")?
}
#[tauri::command]
fn prepare_session(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let ownership=state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    ownership.mutable(window.label(), &id)?;
    state.sessions.prepare(&id)
}
#[tauri::command]
async fn connect_session(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    profile: sftp::Profile,
    passphrase: zeroize::Zeroizing<String>,
) -> Result<sessions::Connected, sftp::ConnectError> {
    let result: Result<sessions::Connected, String> = async {
        let mut lease = {let ownership=state.ownership.lock().map_err(|_| "Ownership lock failed")?;ownership.mutable(window.label(), &id)?;state.sessions.connect(&id, profile, passphrase)?};
        guard_connection_pin(&app, &state, lease.profile())?;
        tauri::async_runtime::spawn_blocking(move || {
            let (path, entries) = lease.browse_home()?;
            lease.install()?;
            Ok(sessions::Connected { path, entries })
        })
        .await
        .map_err(|_| "Session connection worker failed")?
    }
    .await;
    result.map_err(sftp::ConnectError::from)
}
#[tauri::command]
fn disconnect_session(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    ownership.mutable(window.label(), &id)?;
    state.sessions.disconnect(&id)?;
    if let Ok(watch) = state.local_watch.status(&id) {
        state.local_watch.unwatch(&id, watch.token)?;
    }
    Ok(())
}
#[tauri::command]
async fn watch_local_directory(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String, path: String, token: u64) -> Result<local_watch::LocalWatchSnapshot, String> {
    let owners = state.ownership.clone();
    let label = window.label().to_owned();
    let registry = state.local_watch.clone();
    let visibility = state.local_watch_visibility.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = visibility.lock().map_err(|_| "Local watch worker failed")?;
        // One visible pane per window. A fresh renderer also retires an old
        // page's watch if its best-effort pagehide IPC did not finish.
        let mut ownership = owners.lock().map_err(|_| "Ownership lock failed")?;
        ownership.mutable(&label, &id)?;
        if let Some(previous) = ownership.watches.insert(label.clone(), id.clone()) {
            if let Ok(watch) = registry.status(&previous) { let _ = registry.unwatch(&previous, watch.token); }
        }
        registry.watch(&id, &path, token)
    }).await.map_err(|_| "Local watch worker failed")?
}
#[tauri::command]
fn local_watch_status(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<local_watch::LocalWatchSnapshot, String> {
    state.ownership.lock().map_err(|_| "Ownership lock failed")?.owner(window.label(), &id)?;
    state.local_watch.status(&id)
}
#[tauri::command]
fn unwatch_local_directory(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String, token: u64) -> Result<bool, String> {
    let ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    ownership.mutable(window.label(), &id)?;
    state.local_watch.unwatch(&id, token)
}
struct ResolvedCredentials {
    profile: sftp::Profile,
    secret: zeroize::Zeroizing<String>,
    lease: Option<sessions::Lease>,
}
fn resolve_credentials(
    sessions: &Arc<sessions::Sessions>,
    session_id: Option<&str>,
    profile: sftp::Profile,
    secret: zeroize::Zeroizing<String>,
) -> Result<ResolvedCredentials, String> {
    if let Some(id) = session_id {
        let lease = sessions.resolve(id)?;
        Ok(ResolvedCredentials {
            profile: lease.profile().clone(),
            secret: zeroize::Zeroizing::new(lease.secret().to_owned()),
            lease: Some(lease),
        })
    } else {
        Ok(ResolvedCredentials {
            profile,
            secret,
            lease: None,
        })
    }
}
#[tauri::command]
async fn list_remote(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile: sftp::Profile,
    path: String,
    passphrase: zeroize::Zeroizing<String>,
    session_id: Option<String>,
) -> Result<Vec<sftp::Entry>, String> {
    if let Some(id) = session_id.as_deref() {
        state.ownership.lock().map_err(|_| "Ownership lock failed")?.mutable(window.label(), id)?;
        drop(passphrase);
        let lease = state.sessions.resolve(id)?;
        return tauri::async_runtime::spawn_blocking(move || lease.list_remote(&path))
            .await
            .map_err(|_| "Remote listing worker failed")?;
    }
    guard_connection_pin(&app, &state, &profile)?;
    let secret = passphrase;
    tauri::async_runtime::spawn_blocking(move || {
        let path = sftp::normalize(&path)?;
        let (mut connection, _) = sftp::connect(&profile, &secret, &AtomicBool::new(false))?;
        sftp::list(&mut connection, &path)
    })
    .await
    .map_err(|_| "Remote listing worker failed")?
}
#[tauri::command]
fn prepare_sync(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String, session_id: Option<String>) -> Result<(), String> {
    let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    ownership.prepare_job(window.label(), &id, session_id.as_deref())?;
    state.engine.prepare(id)
}
#[tauri::command]
async fn start_sync(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    profile: sftp::Profile,
    local: String,
    remote: String,
    passphrase: String,
    session_id: Option<String>,
    exclusion_rules: Option<String>,
    delete_removed: Option<bool>,
    recursive: Option<bool>,
) -> Result<(), String> {
    { let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
      ownership.job_owner(window.label(), &id)?;
      if let Some(workspace) = session_id.as_deref() { ownership.bind_job(window.label(), &id, workspace)?; }
    }
    let engine = state.engine.clone();
    let resolved = match resolve_credentials(
        &state.sessions,
        session_id.as_deref(),
        profile,
        zeroize::Zeroizing::new(passphrase),
    ) {
        Ok(resolved) => resolved,
        Err(error) => {
            engine.record_start_failure(&id);
            engine.discard_prepared_start(&id);
            return Err(error);
        }
    };
    if resolved.lease.is_none() {
        if let Err(error) = guard_connection_pin(&app, &state, &resolved.profile) {
            engine.record_start_failure(&id);
            engine.discard_prepared_start(&id);
            return Err(error);
        }
    }
    if let Some(lease) = resolved.lease.as_ref() {
        let token = engine.prepared_start_token(&id)?;
        if let Err(error) = lease.link_stop(&token) {
            engine.record_start_failure(&id);
            engine.discard_prepared_start(&id);
            return Err(error);
        }
    }
    let failure_engine = engine.clone();
    let failure_id = id.clone();
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.describe_job(&id,serde_json::json!({"id":id,"profile":resolved.profile,"local":local,"remote":remote,"status":"running","pending":0,"sent":0,"speed":0,"latency":0,"logs":[],"exclusionRules":exclusion_rules.clone().unwrap_or_default(),"deleteRemoved":delete_removed.unwrap_or(false),"recursive":recursive.unwrap_or(true)}));
    tauri::async_runtime::spawn_blocking(move || {
        let ResolvedCredentials {
            profile,
            secret,
            lease,
        } = resolved;
        let _lease = lease;
        engine.start(
            id,
            profile,
            local,
            remote,
            secret,
            engine::SyncOptions {
                exclusion_rules: exclusion_rules.unwrap_or_default(),
                delete_removed: delete_removed.unwrap_or(false),
                recursive: recursive.unwrap_or(true),
            },
        )
    })
    .await
    .map_err(|_| {
        failure_engine.record_start_failure(&failure_id);
        "Start worker failed"
    })?
}
#[tauri::command]
fn default_folder(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| "Home folder unavailable".into())
}
#[tauri::command]
async fn pick_key_file(language: Option<Language>) -> Result<Option<String>, String> {
    let (_, title, filter) = picker_text(language.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title(title)
            .add_filter(filter, &["ppk"])
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "Key dialog failed")?
}
#[tauri::command]
async fn sync_status(
    window: tauri::WebviewWindow, state: tauri::State<'_, AppState>,
    id: String,
) -> Result<engine::Status, String> {
    state.ownership.lock().map_err(|_| "Ownership lock failed")?.job_owner(window.label(), &id)?;
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.status(&id))
        .await
        .map_err(|_| "Status worker failed")?
}
#[tauri::command]
async fn retry_sync(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.ownership.lock().map_err(|_| "Ownership lock failed")?.job_mutable(window.label(), &id)?;
    let engine = state.engine.clone();
    let ownership = state.ownership.clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = ownership.lock().map_err(|_| "Ownership lock failed")?;
        registry.job_mutable(&label, &id)?;
        engine.retry(&id)
    })
        .await
        .map_err(|_| "Retry worker failed")?
}
#[tauri::command]
async fn stop_sync(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<engine::StopSummary, String> {
    state.ownership.lock().map_err(|_| "Ownership lock failed")?.job_mutable(window.label(), &id)?;
    let operation = NativeOperation::claim(&state, window.label(), &id, None)?;
    let engine = state.engine.clone();
    let ownership = state.ownership.clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        ownership.lock().map_err(|_| "Ownership lock failed")?.job_mutable(&label, &id)?;
        let summary = engine.stop_with_summary(&id)?;
        ownership.lock().map_err(|_| "Ownership lock failed")?.finish_job(&id);
        Ok(summary)
    })
        .await
        .map_err(|_| "Stop worker failed")?
}
#[tauri::command]
fn prepare_file_operation(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    ownership.registered(window.label())?;
    if ownership.pending(window.label()){return Err("Window transfer is pending".into());}
    let newly_registered=!ownership.operations.contains_key(&id);
    window_ownership::Registry::scoped(&mut ownership.operations, window.label(), &id, true)?;
    match state.engine.prepare_operation(&id){Ok(_)=>Ok(()),Err(error)=>{if newly_registered{ownership.operations.remove(&id);}Err(error)}}
}
#[tauri::command]
async fn run_file_operation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut request: file_ops::Request,
) -> Result<file_ops::Outcome, String> {
    let _operation = NativeOperation::claim(&state, window.label(), &request.id, request.session_id.as_deref())?;
    let engine = state.engine.clone();
    let lease = if let Some(id) = request
        .session_id
        .as_deref()
        .filter(|_| request.side == file_ops::Side::Remote)
    {
        let lease = match state.sessions.resolve(id) {
            Ok(lease) => lease,
            Err(error) => {
                engine.discard_prepared_operation(&request.id);
                return Err(error);
            }
        };
        request.profile = Some(lease.profile().clone());
        request.passphrase = zeroize::Zeroizing::new(lease.secret().to_owned());
        Some(lease)
    } else {
        None
    };
    if lease.is_none() && request.side == file_ops::Side::Remote {
        let checked = request
            .profile
            .as_ref()
            .ok_or_else(|| "Remote profile is required".to_owned())
            .and_then(|profile| guard_connection_pin(&app, &state, profile));
        if let Err(error) = checked {
            engine.discard_prepared_operation(&request.id);
            return Err(error);
        }
    }
    // Claim the acknowledged token without clearing an early cancellation.
    // Direct native callers may atomically auto-register and claim for compatibility.
    let stop = engine.claim_operation(&request.id)?;
    if let Some(lease) = &lease {
        if let Err(error) = lease.link_stop(&stop) {
            engine.finish_operation(&request.id);
            return Err(error);
        }
    }
    let id = request.id.clone();
    let cleanup = engine.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        struct Release {
            engine: Arc<engine::Engine>,
            id: String,
        }
        impl Drop for Release {
            fn drop(&mut self) {
                self.engine.finish_operation(&self.id);
            }
        }
        let _release = Release {
            engine: cleanup,
            id,
        };
        file_ops::run(&engine, request, &stop)
    })
    .await
    .map_err(|_| "File operation worker failed; outcome may be partial; refresh before retrying")?;
    result
}
#[tauri::command]
fn cancel_file_operation(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    cancel_native_operation(&state,window.label(),&id)
}
fn cancel_native_operation(state:&AppState,label:&str,id:&str)->Result<(),String>{
    let mut ownership = state.ownership.lock().map_err(|_| "Ownership lock failed")?;
    window_ownership::Registry::scoped(&mut ownership.operations, label, id, false)?;
    state.engine.cancel_operation(id)?;
    // Keep Engine's cancelled preparation token for a queued dispatch, while
    // releasing the window-close reservation when no worker has claimed it.
    if !state.engine.operation_claimed(id)?&&!ownership.active_operations.contains(id){ownership.operations.remove(id);ownership.cancelled_preparations.insert(id.into(),label.into());}
    Ok(())
}
fn release_closed_window_registry(state:&AppState,label:&str){
    state.tab_drag.forget(label);
    if let Ok(mut registry)=state.ownership.lock(){
        for (id,owner) in &registry.cancelled_preparations{if owner==label{state.engine.discard_prepared_operation(id);}}
        registry.cancelled_preparations.retain(|_,owner|owner!=label);
        registry.closed(label);
    }
}
#[tauri::command]
async fn run_local_archive(window: tauri::WebviewWindow, state:tauri::State<'_,AppState>,request:local_zip::ArchiveRequest)->Result<local_zip::ArchiveOutcome,zip_preflight::ArchiveError>{
    use zip_preflight::ArchiveError;
    let _operation = NativeOperation::claim(&state, window.label(), &request.id, None).map_err(|_| ArchiveError::new("busy"))?;
    if let Err(error)=request.validate(){state.engine.discard_prepared_operation(&request.id);return Err(error);}
    // Atomically claim one of two archive slots before queueing or filesystem I/O.
    let engine=state.engine.clone();
    let stop=match engine.claim_archive_operation(&request.id){Ok(token)=>token,Err(_)=>{engine.discard_prepared_operation(&request.id);return Err(ArchiveError::new("busy"));}};
    struct Release{engine:Arc<engine::Engine>,id:String}
    impl Drop for Release{fn drop(&mut self){self.engine.finish_operation(&self.id);}}
    let release=Release{engine:engine.clone(),id:request.id.clone()};
    tauri::async_runtime::spawn_blocking(move||{
        let _release=release;let budget=zip_preflight::Budget::new(&stop);budget.check()?;
        // Syntactic drive gating precedes path metadata and rejects mapped networks.
        local_zip::local_drive(Path::new(&request.source))?;local_zip::local_drive(Path::new(&request.destination))?;
        let source=file_ops::local_path(&request.source,true).map_err(|_|ArchiveError::new("invalid_request"))?;budget.check()?;
        let target=file_ops::local_path(&request.destination,false).map_err(|_|ArchiveError::new("collision"))?;budget.check()?;
        if source.parent().is_none()||file_ops::local_contains(&source,&target){return Err(ArchiveError::new("invalid_request"));}
        let leaf=target.file_name().and_then(|x|x.to_str()).ok_or_else(||ArchiveError::new("invalid_request"))?;
        zip_preflight::validate_entry_name(leaf.as_bytes(),true,false)?;
        let parent=target.parent().ok_or_else(||ArchiveError::new("invalid_request"))?;
        engine.reserve_archive_operation(&request.id,source.clone(),target.clone(),parent.to_owned()).map_err(|_|ArchiveError::new("sync_overlap"))?;
        local_zip::execute(request.action,&source,&target,&budget)
    }).await.map_err(|_|ArchiveError::new("io_error"))?
}
struct NativeOperation { registry: Arc<Mutex<window_ownership::Registry>>, id:String }
impl NativeOperation {
    fn claim(state:&AppState,label:&str,id:&str,workspace:Option<&str>)->Result<Self,String>{
        let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
        registry.registered(label)?;
        if let Some(id)=workspace {registry.mutable(label,id)?;}
        if registry.pending(label){return Err("Window transfer is pending".into());}
        if registry.cancelled_preparations.get(id).is_some_and(|owner|owner!=label){return Err("Operation belongs to another window".into());}
        window_ownership::Registry::scoped(&mut registry.operations,label,id,true)?;
        if !registry.active_operations.insert(id.into()){return Err("Operation is already being dispatched".into());}
        registry.cancelled_preparations.remove(id);
        Ok(Self{registry:state.ownership.clone(),id:id.into()})
    }
}
impl Drop for NativeOperation {fn drop(&mut self){if let Ok(mut r)=self.registry.lock(){r.active_operations.remove(&self.id);r.operations.remove(&self.id);}}}
#[cfg(test)] mod native_reservation_tests {
    use super::*;
    #[test]fn dispatch_reservation_blocks_close_before_engine_claim_and_drops_cleanly(){let state=AppState::default();state.ownership.lock().unwrap().bootstrap("main").unwrap();let dispatch=NativeOperation::claim(&state,"main","op",None).unwrap();assert!(!state.engine.operation_claimed("op").unwrap());{let mut r=state.ownership.lock().unwrap();assert!(r.active_operations.contains("op"));assert!(r.seal_close("main").is_err());}assert!(NativeOperation::claim(&state,"main","op",None).is_err());drop(dispatch);assert!(state.ownership.lock().unwrap().seal_close("main").is_ok());}
    #[test]fn cancelled_preparations_are_released_after_each_owner_closes(){let state=AppState::default();for n in 0..8{let label=format!("window-{n}");let id=format!("op-{n}");{let mut r=state.ownership.lock().unwrap();r.bootstrap(&label).unwrap();r.operations.insert(id.clone(),label.clone());}state.engine.prepare_operation(&id).unwrap();cancel_native_operation(&state,&label,&id).unwrap();state.ownership.lock().unwrap().seal_close(&label).unwrap();release_closed_window_registry(&state,&label);}for n in 0..8{state.engine.prepare_operation(&format!("fresh-{n}")).unwrap();}assert!(state.engine.prepare_operation("ninth").is_err());}
    #[test]fn queued_dispatch_still_observes_early_cancellation(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.operations.insert("early".into(),"main".into());}state.engine.prepare_operation("early").unwrap();cancel_native_operation(&state,"main","early").unwrap();let _dispatch=NativeOperation::claim(&state,"main","early",None).unwrap();assert!(state.engine.claim_operation("early").unwrap().load(Ordering::SeqCst));state.engine.finish_operation("early");}
}
#[tauri::command]
fn register_window(window:tauri::WebviewWindow,state:tauri::State<AppState>)->Result<window_ownership::Bootstrap,String>{
    let mut bootstrap=state.ownership.lock().map_err(|_|"Ownership lock failed")?.bootstrap(window.label())?;
    for id in &bootstrap.owned_workspace_ids{bootstrap.workspaces.push(serde_json::json!({"id":id,"connection":state.sessions.connected_profile(id)?}));}
    for descriptor in &mut bootstrap.jobs {if let Some(job)=descriptor.job.as_mut(){if let Ok(status)=state.engine.status(&descriptor.id){for (key,value) in serde_json::to_value(status).map_err(|_|"Job status unavailable")?.as_object().ok_or("Job status unavailable")?{if key!="remoteChanges"{job[key]=value.clone();}}}else{job["status"]="stopped".into();}}}
    Ok(bootstrap)
}
#[tauri::command]
fn register_workspace(window:tauri::WebviewWindow,state:tauri::State<AppState>,id:String)->Result<(),String>{state.ownership.lock().map_err(|_|"Ownership lock failed")?.claim(window.label(),&id)}
#[tauri::command]
fn unregister_workspace(window:tauri::WebviewWindow,state:tauri::State<AppState>,id:String)->Result<(),String>{
    let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    registry.mutable(window.label(),&id)?;
    if state.sessions.window_busy(&[id.clone()])?||state.engine.window_busy(&registry.workspace_job_ids(&id),&[])?||registry.operations.values().any(|o|o==window.label()){return Err("Workspace still has native work in progress".into());}
    state.sessions.disconnect(&id)?;
    if let Ok(watch)=state.local_watch.status(&id){state.local_watch.unwatch(&id,watch.token)?;}
    registry.release(window.label(),&id)
}
fn transfer_event(app:&tauri::AppHandle,t:&window_ownership::Transfer){for label in [&t.source_label,&t.target_label]{if let Some(w)=app.get_webview_window(label){let _=w.emit("workspace-transfer",t);}}}
fn abort_native_transfer(app:&tauri::AppHandle,label:&str,token:&str)->Result<window_ownership::Transfer,String>{
    let state=app.state::<AppState>();
    let t=state.ownership.lock().map_err(|_|"Ownership lock failed")?.abort(label,token)?;
    transfer_event(app,&t);
    if t.target_kind=="new"{if let Some(w)=app.get_webview_window(&t.target_label){let _=w.destroy();}state.ownership.lock().map_err(|_|"Ownership lock failed")?.closed(&t.target_label);}
    Ok(t)
}
fn validate_native_transfer(state:&AppState,r:&window_ownership::Registry,label:&str,workspace_id:&str,payload:&serde_json::Value)->Result<(),String>{
    r.mutable(label,workspace_id)?;
    if r.pending(label){return Err("Window transfer is pending".into());}
    if state.sessions.window_busy(&[workspace_id.to_owned()])?{return Err("Workspace is connecting".into());}
    if let Some(profile)=state.sessions.connected_profile(workspace_id)?{if payload.get("workspace").and_then(|w|w.get("connection"))!=Some(&serde_json::to_value(profile).map_err(|_|"Session profile unavailable")?){return Err("Transfer connection differs from the native session".into());}}
    if state.engine.starts_pending(&r.job_ids(label))?{return Err("Wait for sync startup before moving".into());}
    if r.probes.iter().any(|(id,owner)|owner==label&&state.host_verification.request_pending(id).unwrap_or(true)){return Err("Finish host verification before moving".into());}
    if let Some(id)=payload.get("job").and_then(|j|j.get("id")).and_then(serde_json::Value::as_str){r.job_owner(label,id)?;}Ok(())
}
fn create_workspace_window(app:&tauri::AppHandle,label:&str)->Result<tauri::WebviewWindow,String>{
    let mut config=app.config().app.windows.iter().find(|w|w.label=="main").cloned().unwrap_or_default();config.label=label.into();config.visible=false;
    let w=tauri::WebviewWindowBuilder::from_config(app,&config).and_then(|b|b.build()).map_err(|e|format!("Window creation failed: {e}"))?;
    // Register before releasing a spawn reservation: the renderer may not have
    // bootstrapped yet when the last previous window finishes closing.
    let result=app.state::<AppState>().ownership.lock().map_err(|_|"Ownership lock failed".to_owned())?.bootstrap(label);
    if let Err(e)=result{let _=w.destroy();return Err(e);}Ok(w)
}
fn transfer_timeout(app:&tauri::AppHandle,t:&window_ownership::Transfer){let app=app.clone();let token=t.token.clone();let source=t.source_label.clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_secs(30)).await;let _=abort_native_transfer(&app,&source,&token);});}
fn stage_drag_transfer(app:&tauri::AppHandle,source:&str,token:&str,target:Option<(String,usize,Option<String>)>,x:i32,y:i32,grab_x:f64,grab_y:f64)->Result<window_ownership::Transfer,String>{
    let state=app.state::<AppState>();
    let transfer={let mut r=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
        if let Some((label,_,_))=target.as_ref(){let ids=r.owned(label);if state.sessions.window_busy(&ids)?||state.engine.starts_pending(&r.job_ids(label))?||r.probes.iter().any(|(id,owner)|owner==label&&state.host_verification.request_pending(id).unwrap_or(true)){return Err("Target window is busy".into());}}
        r.activate_drag(source,token,target.as_ref().map(|(label,index,before)|(label.as_str(),*index,before.clone())))?};
    if transfer.target_kind=="new"{
        let result=(||->Result<(),String>{let w=create_workspace_window(app,&transfer.target_label)?;
            #[cfg(windows)]tab_drag::place(&w,x,y,grab_x,grab_y)?;
            #[cfg(not(windows))]let _=(x,y,grab_x,grab_y,w);
            Ok(())})();if let Err(e)=result{let _=abort_native_transfer(app,source,token);return Err(e);}
    }
    transfer_timeout(app,&transfer);transfer_event(app,&transfer);Ok(transfer)
}
fn open_blank_window(app:tauri::AppHandle){
    // The single-instance callback runs on the event loop: never build a WebView there.
    let state=app.state::<AppState>();let mut entropy=[0u8;16];if getrandom::fill(&mut entropy).is_err(){return;}let label=format!("workspace-{}",entropy.iter().map(|b|format!("{b:02x}")).collect::<String>());
    if state.ownership.lock().map(|mut r|r.reserve_spawn(&label)).unwrap_or_else(|_|Err("Ownership lock failed".into())).is_err(){return;}
    let worker_app=app.clone();let worker_label=label.clone();
    let spawn=std::thread::Builder::new().name("nearly-new-window".into()).spawn(move||{
        let result=create_workspace_window(&worker_app,&worker_label).and_then(|w|{w.show().map_err(|e|e.to_string())?;let _=w.set_focus();Ok(w)});
        if result.is_err(){if let Some(w)=worker_app.get_webview_window(&worker_label){let _=w.destroy();}if let Ok(mut r)=worker_app.state::<AppState>().ownership.lock(){r.closed(&worker_label);}}
        {let state=worker_app.state::<AppState>();if let Ok(mut r)=state.ownership.lock(){r.finish_spawn(&worker_label);};}
        shutdown_if_idle(&worker_app);
    });
    if spawn.is_err(){if let Ok(mut r)=state.ownership.lock(){r.finish_spawn(&label);}shutdown_if_idle(&app);}
}
fn shutdown_if_idle(app:&tauri::AppHandle)->bool{let state=app.state::<AppState>();let idle=state.ownership.lock().map(|mut r|r.seal_shutdown_if_idle()).unwrap_or(false);if idle{state.sessions.begin_shutdown();state.sessions.shutdown();state.host_verification.shutdown();app.exit(0);}idle}
#[tauri::command]
async fn workspace_transfer_ready(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,AppState>,token:String)->Result<window_ownership::Transfer,String>{
    {let registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;let pending=registry.status(window.label(),&token)?;if pending.target_label!=window.label()||pending.phase!="pending"{return Err("Transfer is no longer pending".into());}registry.registered(window.label())?;}
    // UI dispatch must not hold the registry: a close callback may be ahead of
    // show() on the event loop. The pending reservation still guards both ends.
    window.show().map_err(|e|format!("Unable to show incoming window: {e}"))?;
    let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    let pending=registry.status(window.label(),&token)?;
    if let Some(before)=pending.before_id.as_ref(){registry.owner(window.label(),before)?;}
    let t=registry.commit(window.label(),&token)?;
    // A transferred watch belongs to the target. Source late unwatch IPC is denied.
    if let Some(previous)=registry.watches.remove(&t.target_label){if previous!=t.workspace_id{if let Ok(watch)=state.local_watch.status(&previous){let _=state.local_watch.unwatch(&previous,watch.token);}}}
    if registry.watches.get(&t.source_label).is_some_and(|id|id==&t.workspace_id){registry.watches.remove(&t.source_label);registry.watches.insert(t.target_label.clone(),t.workspace_id.clone());}
    drop(registry);transfer_event(&app,&t);Ok(t)
}
#[tauri::command]
fn workspace_transfer_status(window:tauri::WebviewWindow,state:tauri::State<AppState>,token:String)->Result<window_ownership::Transfer,String>{state.ownership.lock().map_err(|_|"Ownership lock failed")?.status(window.label(),&token)}
#[tauri::command]
fn abort_workspace_transfer(window:tauri::WebviewWindow,app:tauri::AppHandle,token:String)->Result<window_ownership::Transfer,String>{abort_native_transfer(&app,window.label(),&token)}
#[tauri::command]
fn window_taskbar_status(window:tauri::WebviewWindow,state:tauri::State<AppState>)->Result<String,String>{let ids=state.ownership.lock().map_err(|_|"Ownership lock failed")?.job_ids(window.label());Ok(format!("{:?}",state.engine.taskbar_state_for(&ids)?).to_lowercase())}
fn main() {
    let closing = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let taskbar_closing=closing.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            open_blank_window(app.clone());
        }))
        .manage(AppState::default())
        .setup(move |app| {
            #[cfg(windows)]
            taskbar_adapter::start(app.handle().clone(), app.state::<AppState>().engine.clone(), app.state::<AppState>().ownership.clone(), taskbar_closing.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_window, register_workspace, unregister_workspace, workspace_transfer_ready,
            tab_drag::register_tab_strip, tab_drag::begin_tab_drag, tab_drag::cancel_tab_drag, tab_drag::tab_drag_status,
            workspace_transfer_status, abort_workspace_transfer, window_taskbar_status,
            load_settings,
            save_settings,
            probe_host_key,
            cancel_host_key,
            approve_host_key,
            pick_folder,
            pick_key_file,
            default_folder,
            list_local,
            list_drives,
            list_remote,
            prepare_session,
            connect_session,
            disconnect_session,
            watch_local_directory,
            local_watch_status,
            unwatch_local_directory,
            start_sync,
            prepare_sync,
            sync_status,
            retry_sync,
            stop_sync,
            run_file_operation,
            run_local_archive,
            prepare_file_operation,
            cancel_file_operation
        ])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if closing.load(Ordering::SeqCst) {
                    return;
                }
                let app = window.app_handle().clone();
                let state=app.state::<AppState>();
                let label=window.label().to_owned();
                let result=(||->Result<Vec<String>,String>{
                    let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
                    if registry.probes.iter().any(|(id,owner)|owner==&label&&state.host_verification.request_pending(id).unwrap_or(true)){
                        return Err("Finish host verification before closing".into());
                    }
                    let ids=registry.seal_close(&label)?;
                    let jobs=registry.job_ids(&label);
                    match (state.sessions.window_busy(&ids),state.engine.window_busy(&jobs,&[])) {
                        (Ok(false),Ok(false))=>Ok(ids),
                        _=>{registry.unseal(&label);Err("Stop this window's syncs and finish connecting before closing".into())}
                    }
                })();
                match result {
                    Err(message)=>{let _=window.emit("sync-close-blocked",message);}
                    Ok(ids)=>{
                        for id in ids {
                            if let Ok(watch)=state.local_watch.status(&id){let _=state.local_watch.unwatch(&id,watch.token);}
                            let _=state.sessions.disconnect(&id);
                        }
                        if let Some(w)=app.get_webview_window(&label){
                            if let Err(error)=w.destroy(){
                                if let Ok(mut registry)=state.ownership.lock(){registry.unseal(&label);}
                                let _=window.emit("sync-close-blocked",format!("Unable to close this window: {error}"));
                                return;
                            }
                        }
                        if let Ok(mut clients)=state.settings_clients.lock(){clients.forget(&label);}
                        release_closed_window_registry(&state,&label);
                        if shutdown_if_idle(&app){closing.store(true,Ordering::SeqCst);}
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to launch SyncFiles");
}
