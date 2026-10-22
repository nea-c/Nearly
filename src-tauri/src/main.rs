#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod bookmark_tree;
mod input_policy;
mod browse_preferences;
mod browse_transport;
mod connection_tree;
mod drives;
mod engine;
mod initial_scan;
#[cfg(test)]
mod sync_runtime_tests;
mod local_watch;
mod taskbar_status;
#[cfg(windows)]
mod taskbar_adapter;
mod exclusion;
mod explorer_preferences;
mod side_bookmarks;
mod file_ops;
mod upload;
mod transfer_choices;
mod transfer_io;
#[cfg(windows)]
mod virtual_files;
#[cfg(windows)]
mod native_download_drag;
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
mod split_settings;
mod window_ownership;
mod window_size;
mod tab_drag;
mod startup_update;
#[cfg(any(test, feature="installer-qa"))]
mod installer_qa;
mod version;
mod update_package;
mod update_handoff;
mod install_root;
#[cfg(any(test, feature="installer-qa"))]
mod install_prepare;
mod update_cleanup;
mod update_transaction;
mod update_restart;
mod update_runtime;
mod update_recovery;
#[cfg(windows)]
mod update_recovery_windows;
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
    transfer_choices: Arc<transfer_choices::Broker>,
    local_watch: Arc<local_watch::LocalWatchRegistry>,
    local_watch_visibility: Arc<Mutex<()>>,
    engine: Arc<engine::Engine>,
    sessions: Arc<sessions::Sessions>,
    settings: Mutex<()>, 
    settings_clients: Mutex<settings_clients::SettingsClients>,
    window_size: Mutex<window_size::Session>,
    ownership: Arc<Mutex<window_ownership::Registry>>,
    tab_drag: Arc<tab_drag::Controller>,
    startup_update: startup_update::StartupUpdate,
    update_restart: update_runtime::Runtime,
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
    #[serde(rename = "lastSelectedProfileId", default)]
    last_selected_profile_id: Option<String>,
    #[serde(rename = "lastSelectedProfileChanged", default)]
    last_selected_profile_changed: bool,
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
    #[serde(rename = "localTreeWidth", default, skip_serializing_if = "Option::is_none")]
    local_tree_width: Option<f64>,
    #[serde(rename = "remoteTreeWidth", default, skip_serializing_if = "Option::is_none")]
    remote_tree_width: Option<f64>,
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
    #[serde(rename = "localBookmarks", default)]
    local_bookmarks: Vec<side_bookmarks::LocalBookmark>,
    #[serde(rename = "remoteBookmarks", default)]
    remote_bookmarks: Vec<side_bookmarks::RemoteBookmark>,
    #[serde(rename="localBookmarkTree",default,skip_serializing_if="Option::is_none")]
    local_bookmark_tree: Option<side_bookmarks::Tree>,
    #[serde(rename="remoteBookmarkTree",default,skip_serializing_if="Option::is_none")]
    remote_bookmark_tree: Option<side_bookmarks::Tree>,
    #[serde(rename="localFolderHistory",default)]
    local_folder_history: Vec<side_bookmarks::History>,
    #[serde(rename="remoteFolderHistory",default)]
    remote_folder_history: Vec<side_bookmarks::History>,
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
            last_selected_profile_id: None,
            last_selected_profile_changed: false,
            history: HashMap::new(),
            theme: Theme::System,
            language: Language::Ja,
            compact_explorer: false,
            local_pane_ratio: default_pane_ratio(),
            local_tree_ratio: default_tree_ratio(),
            remote_tree_ratio: default_tree_ratio(),
            local_tree_width: None,
            remote_tree_width: None,
            exclusions: HashMap::new(),
            sync_options: HashMap::new(),
            sync_presets: vec![],
            retained_syncs: vec![],
            folder_bookmarks: vec![],
            local_bookmarks: vec![],
            remote_bookmarks: vec![],
            local_bookmark_tree:None,remote_bookmark_tree:None,local_folder_history:vec![],remote_folder_history:vec![],
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_tree_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_tree_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_size: Option<window_size::SavedSize>,
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
fn ensure_settings_window_open(state:&AppState,label:&str)->Result<(),String>{state.ownership.lock().map_err(|_|"Ownership lock failed")?.settings_registered(label)}
#[tauri::command]
fn load_settings(window: tauri::WebviewWindow, app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<Settings, String> {
    let _lock = state.settings.lock().map_err(|_| "Settings lock failed")?;
    ensure_settings_window_open(&state,window.label())?;
    let data = load_saved_settings(&settings_path(&app)?)?;
    state.settings_clients.lock().map_err(|_| "Settings client lock failed")?
        .remember_loaded(window.label(), serde_json::to_value(&data).map_err(|e| e.to_string())?)?;
    if window.label()=="main" {state.window_size.lock().map_err(|_|"Window size lock failed")?.activate();}
    if window.label()=="main" {state.update_restart.settings_loaded();}
    Ok(data)
}
fn restore_main_window_size(app:&tauri::AppHandle){
    let Some(window)=app.get_webview_window("main") else{return};
    let saved=(||->Result<_,String>{
        let state=app.state::<AppState>();let _lock=state.settings.lock().map_err(|_|"Settings lock failed")?;
        Ok(unified_settings::Document::read(&settings_path(app)?)?.window_size())
    })();
    let saved=match saved{Ok(saved)=>saved,Err(error)=>{eprintln!("Window size restore settings unavailable: {error}");None}};
    if let Ok(mut session)=app.state::<AppState>().window_size.lock(){session.begin_restore();}
    match window_size::restore(&window,saved){
        Ok(restored)=>{if let Ok(mut session)=app.state::<AppState>().window_size.lock(){session.seed(restored);}},
        Err(error)=>{eprintln!("Window size restore unavailable: {error}");},
    }
    if let Ok(mut session)=app.state::<AppState>().window_size.lock(){session.finish_restore();}
    // The generated main window starts hidden; even a corrupt preference never
    // prevents the ordinary renderer from presenting its settings-load error.
    if let Err(error)=window.show(){eprintln!("Main window display failed: {error}");}
}
fn persist_main_window_size(app:&tauri::AppHandle,quiet:bool)->Result<(),String>{
    let state=app.state::<AppState>();
    let revision=persist_window_size_transaction(&state,&settings_path(app)?,quiet,
        ||state.settings.lock().map_err(|_|"Settings lock failed".into()))?;
    if let Some(revision)=revision{let _=app.emit("settings-changed",serde_json::json!({"settingsRevision":revision}));}
    Ok(())
}
fn persist_window_size_transaction<'a,L>(state:&'a AppState,path:&Path,quiet:bool,lock_settings:L)->Result<Option<u64>,String>
where L:FnOnce()->Result<std::sync::MutexGuard<'a,()>,String>{
    let _lock=lock_settings()?;
    // Select the generation only after serialization. A delayed worker must
    // observe a newer close flush's acknowledgement instead of writing its old
    // pre-lock size after that flush has already cleared the dirty flag.
    let pending=state.window_size.lock().map_err(|_|"Window size lock failed")?.pending(quiet);
    let Some((size,generation))=pending else{return Ok(None)};
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.settings_mutable("main")?;
    ensure_settings_window_open(state,"main")?;
    let revision=unified_settings::save_window_size(path,size)?;
    state.window_size.lock().map_err(|_|"Window size lock failed")?.acknowledge(generation);
    Ok(revision)
}
fn observe_main_window_size(app:&tauri::AppHandle,label:&str){
    if label!="main"{return}
    let Some(window)=app.get_webview_window("main") else{return};
    let Ok((width,height,maximized,minimized,fullscreen))=window_size::capture(&window) else{return};
    let state=app.state::<AppState>();
    let Ok(position)=window.outer_position() else{return};
    let start=state.window_size.lock().map(|mut session|session.observe_placement(label,window_size::Placement{x:position.x,y:position.y},width,height,maximized,minimized,fullscreen)).unwrap_or(false);
    if !start{return}
    let app=app.clone();
    tauri::async_runtime::spawn(async move{
        loop {
            tokio::time::sleep(window_size::SAVE_DELAY).await;
            if let Err(error)=persist_main_window_size(&app,true){
                eprintln!("Window size save unavailable: {error}");
                if let Ok(mut session)=app.state::<AppState>().window_size.lock(){session.stop_worker();}return
            }
            let state=app.state::<AppState>();
            let Ok(mut session)=state.window_size.lock() else{return};
            if !session.is_dirty(){session.stop_worker();return}
        }
    });
}
fn flush_main_window_size(app:&tauri::AppHandle,label:&str){
    if label!="main"{return}
    observe_main_window_size(app,label);
    if let Err(error)=persist_main_window_size(app,false){eprintln!("Window size final save unavailable: {error}");}
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
    if data.last_selected_profile_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)) {
        return Err("Invalid last selected profile ID".into());
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
    for width in [data.local_tree_width, data.remote_tree_width].into_iter().flatten() {
        if !width.is_finite() || !(100.0..=4096.0).contains(&width) {
            return Err("Invalid tree pixel width".into());
        }
    }
    validate_sync_preferences(&data.exclusions, &data.sync_options, &data.sync_presets)?;
    validate_retained_syncs(&data.retained_syncs)?;
    side_bookmarks::validate(&data.local_bookmarks,&data.remote_bookmarks)?;
    if let Some(tree)=&data.local_bookmark_tree{side_bookmarks::validate_tree(tree,&data.local_bookmarks,&data.remote_bookmarks,false)?;}
    if let Some(tree)=&data.remote_bookmark_tree{side_bookmarks::validate_tree(tree,&data.local_bookmarks,&data.remote_bookmarks,true)?;}
    side_bookmarks::validate_history(&data.local_folder_history,false)?;
    side_bookmarks::validate_history(&data.remote_folder_history,true)?;
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
    ensure_settings_window_open(&state,window.label())?;
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.settings_mutable(window.label())?;
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
    ensure_settings_window_open(&state,window.label())?;
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.settings_mutable(window.label())?;
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
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.registered(window.label())?;
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
fn file_transfer_prompt(window:tauri::WebviewWindow,state:tauri::State<'_,AppState>,id:String)->Result<Option<transfer_choices::Prompt>,String>{
 state.ownership.lock().map_err(|_|"Ownership lock failed")?.registered(window.label())?;
 state.transfer_choices.pending(&id,window.label())
}
#[tauri::command]
fn choose_file_transfer(window:tauri::WebviewWindow,state:tauri::State<'_,AppState>,id:String,decision:transfer_choices::Decision)->Result<(),String>{
 state.ownership.lock().map_err(|_|"Ownership lock failed")?.registered(window.label())?;
 state.transfer_choices.choose(&id,window.label(),decision)
}

fn claim_upload_dispatch(state:&AppState,label:&str,id:&str,session_id:&str)->Result<(NativeOperation,Arc<AtomicBool>),String>{
    let operation=NativeOperation::claim(state,label,id,Some(session_id))?;
    let stop=match state.engine.claim_prepared_upload(id){
        Ok(stop)=>stop,
        Err(error)=>{
            // A rejected claim never owns a worker; release only its unclaimed
            // preparation before NativeOperation drops the window ownership.
            state.engine.discard_prepared_operation(id);
            return Err(error);
        }
    };
    Ok((operation,stop))
}
#[tauri::command]
async fn run_upload(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,AppState>,request:upload::UploadRequest)->Result<upload::UploadOutcome,String>{
    let (operation,stop)=claim_upload_dispatch(&state,window.label(),&request.id,&request.session_id)?;
    let engine=state.engine.clone();
    struct Release{engine:Arc<engine::Engine>,id:String}
    impl Drop for Release{fn drop(&mut self){self.engine.finish_operation(&self.id);}}
    let release=Release{engine:engine.clone(),id:request.id.clone()};
    let choices=if request.interactive{Some(state.transfer_choices.begin(&request.id,window.label())?)}else{None};
    let lease=state.sessions.resolve(&request.session_id)?;
    guard_connection_pin(&app,&state,lease.profile())?;
    lease.link_stop(&stop)?;
    tauri::async_runtime::spawn_blocking(move||{let _operation=operation;let _release=release;match choices {Some(choices)=>upload::run_interactive(&engine,request,lease.profile(),lease.secret(),&stop,&choices.exchange),None=>upload::run(&engine,request,lease.profile(),lease.secret(),&stop)}}).await.map_err(|_|"Upload worker failed; partial targets may remain; refresh before retrying")?
}

#[tauri::command]
async fn run_remote_drag(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,AppState>,request:native_download_drag::Request)->Result<native_download_drag::DragOutcome,String>{
 let (operation,stop)=claim_upload_dispatch(&state,window.label(),&request.id,&request.session_id)?;
 let engine=state.engine.clone();struct Release{engine:Arc<engine::Engine>,id:String}impl Drop for Release{fn drop(&mut self){self.engine.finish_operation(&self.id);}}
 let release=Release{engine:engine.clone(),id:request.id.clone()};let lease=state.sessions.resolve(&request.session_id)?;guard_connection_pin(&app,&state,lease.profile())?;lease.link_stop(&stop)?;
 let source_label=window.label().to_owned();
 tauri::async_runtime::spawn_blocking(move||{let _operation=operation;let _release=release;native_download_drag::run(app,source_label,engine,request,lease,stop)}).await.map_err(|_|"Windows download drag worker failed; sources retained")?
}

#[tauri::command]
async fn run_download(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<'_,AppState>,request:transfer_io::DownloadRequest)->Result<upload::UploadOutcome,String>{
 let (operation,stop)=claim_upload_dispatch(&state,window.label(),&request.id,&request.session_id)?;
 let engine=state.engine.clone();
 struct Release{engine:Arc<engine::Engine>,id:String}
 impl Drop for Release{fn drop(&mut self){self.engine.finish_operation(&self.id);}}
 let release=Release{engine:engine.clone(),id:request.id.clone()};
 let choices=state.transfer_choices.begin(&request.id,window.label())?;
 let lease=state.sessions.resolve(&request.session_id)?;guard_connection_pin(&app,&state,lease.profile())?;lease.link_stop(&stop)?;
 tauri::async_runtime::spawn_blocking(move||{let _operation=operation;let _release=release;transfer_io::download(&engine,request,lease.profile(),lease.secret(),&stop,&choices.exchange)}).await.map_err(|_|"Download worker failed; refresh destination before retrying")?
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
fn cancel_file_operation(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, id: String, abandon: Option<bool>) -> Result<(), String> {
    if abandon.unwrap_or(false){abandon_native_preparation(&state,window.label(),&id)}else{cancel_native_operation(&state,window.label(),&id)}
}
// Only for acknowledged preparations that the caller has never dispatched.
fn abandon_native_preparation(state:&AppState,label:&str,id:&str)->Result<(),String>{
    let mut ownership=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    ownership.registered(label)?;
    let owner=ownership.operations.get(id).or_else(||ownership.cancelled_preparations.get(id)).ok_or("Operation is not prepared")?;
    if owner!=label{return Err("Operation belongs to another window".into());}
    if ownership.active_operations.contains(id) || state.engine.operation_claimed(id)? {return Err("Operation has already been dispatched".into());}
    state.engine.cancel_operation(id)?;
    state.engine.discard_prepared_operation(id);
    ownership.operations.remove(id);ownership.cancelled_preparations.remove(id);
    Ok(())
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
    state.startup_update.cancel(label,true);
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
        local_zip::local_drive(Path::new(&request.destination))?;
        let mut sources=Vec::new();
        for input in request.inputs(){
            local_zip::local_drive(Path::new(input))?;
            sources.push(file_ops::local_path(input,true).map_err(|_|ArchiveError::new("invalid_request"))?);budget.check()?;
        }
        let target=file_ops::local_path(&request.destination,false).map_err(|_|ArchiveError::new("collision"))?;budget.check()?;
        let leaf=target.file_name().and_then(|x|x.to_str()).ok_or_else(||ArchiveError::new("invalid_request"))?;
        zip_preflight::validate_entry_name(leaf.as_bytes(),true,false)?;
        let parent=target.parent().ok_or_else(||ArchiveError::new("invalid_request"))?;
        engine.reserve_archive_sources(&request.id,sources.clone(),target.clone(),parent.to_owned()).map_err(|_|ArchiveError::new("sync_overlap"))?;
        local_zip::execute_sources(request.action,&sources,&target,&budget)
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
    #[test]
    fn abandoned_acknowledged_preparations_reclaim_full_capacity_and_check_ownership(){
        let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.bootstrap("other").unwrap();}
        for n in 0..20 {let id=format!("abandon-{n}");state.engine.prepare_operation(&id).unwrap();state.ownership.lock().unwrap().operations.insert(id.clone(),"main".into());assert!(abandon_native_preparation(&state,"other",&id).is_err());if n%2==0{cancel_native_operation(&state,"main",&id).unwrap();}abandon_native_preparation(&state,"main",&id).unwrap();assert!(state.engine.cancel_operation(&id).is_err());}
        for n in 0..8{state.engine.prepare_operation(&format!("capacity-{n}")).unwrap();}assert!(state.engine.prepare_operation("ninth").is_err());
    }
    #[test]
    fn abandoning_active_or_claimed_dispatch_is_refused(){
        let state=AppState::default();state.ownership.lock().unwrap().bootstrap("main").unwrap();
        state.engine.prepare_operation("active").unwrap();let dispatch=NativeOperation::claim(&state,"main","active",None).unwrap();assert!(abandon_native_preparation(&state,"main","active").is_err());assert!(!state.engine.operation_claimed("active").unwrap());drop(dispatch);state.engine.finish_operation("active");
        state.engine.prepare_operation("claimed").unwrap();state.ownership.lock().unwrap().operations.insert("claimed".into(),"main".into());state.engine.claim_operation("claimed").unwrap();assert!(abandon_native_preparation(&state,"main","claimed").is_err());assert!(state.engine.operation_claimed("claimed").unwrap());state.engine.finish_operation("claimed");
    }
    #[test]
    fn upload_failed_dispatch_releases_preparation_without_exhausting_capacity(){
        let state=AppState::default();
        {let mut registry=state.ownership.lock().unwrap();registry.bootstrap("main").unwrap();registry.claim("main","upload-tab").unwrap();}
        state.engine.prepare_operation("worker-one").unwrap();
        let one=claim_upload_dispatch(&state,"main","worker-one","upload-tab").unwrap();
        state.engine.prepare_operation("worker-two").unwrap();
        let two=claim_upload_dispatch(&state,"main","worker-two","upload-tab").unwrap();
        for attempt in 0..10{
            let id=format!("failed-{attempt}");state.engine.prepare_operation(&id).unwrap();
            assert!(claim_upload_dispatch(&state,"main",&id,"upload-tab").is_err());
            assert!(!state.ownership.lock().unwrap().operations.contains_key(&id));
            assert!(state.engine.cancel_operation(&id).is_err(),"Failed dispatch left an orphan engine preparation");
        }
        assert!(state.engine.operation_claimed("worker-one").unwrap());
        assert!(state.engine.operation_claimed("worker-two").unwrap());
        state.engine.finish_operation("worker-one");state.engine.finish_operation("worker-two");drop(one);drop(two);
        for n in 0..8{state.engine.prepare_operation(&format!("fresh-{n}")).unwrap();}
        assert!(state.engine.prepare_operation("ninth").is_err());
    }
    #[test]
    fn upload_failed_claim_does_not_finish_an_existing_claimed_operation(){
        let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.claim("main","upload-tab").unwrap();}
        state.engine.prepare_operation("claimed").unwrap();state.engine.claim_operation("claimed").unwrap();
        assert!(claim_upload_dispatch(&state,"main","claimed","upload-tab").is_err());
        assert!(state.engine.operation_claimed("claimed").unwrap());state.engine.finish_operation("claimed");
    }
    #[test]fn upload_refuses_foreign_disconnected_and_transferring_workspace(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.bootstrap("other").unwrap();r.claim("main","upload-tab").unwrap();}assert!(NativeOperation::claim(&state,"other","upload",Some("upload-tab")).is_err());assert!(state.sessions.resolve("upload-tab").is_err());{let mut r=state.ownership.lock().unwrap();r.begin_drag("main","upload-tab",serde_json::json!({"version":1,"workspace":{"id":"upload-tab"}})).unwrap();}assert!(NativeOperation::claim(&state,"main","upload",Some("upload-tab")).is_err());}    #[test]fn dispatch_reservation_blocks_close_before_engine_claim_and_drops_cleanly(){let state=AppState::default();state.ownership.lock().unwrap().bootstrap("main").unwrap();let dispatch=NativeOperation::claim(&state,"main","op",None).unwrap();assert!(!state.engine.operation_claimed("op").unwrap());{let mut r=state.ownership.lock().unwrap();assert!(r.active_operations.contains("op"));assert!(r.seal_close("main").is_err());}assert!(NativeOperation::claim(&state,"main","op",None).is_err());drop(dispatch);assert!(state.ownership.lock().unwrap().seal_close("main").is_ok());}
    #[test]fn cancelled_preparations_are_released_after_each_owner_closes(){let state=AppState::default();for n in 0..8{let label=format!("window-{n}");let id=format!("op-{n}");{let mut r=state.ownership.lock().unwrap();r.bootstrap(&label).unwrap();r.operations.insert(id.clone(),label.clone());}state.engine.prepare_operation(&id).unwrap();cancel_native_operation(&state,&label,&id).unwrap();state.ownership.lock().unwrap().seal_close(&label).unwrap();release_closed_window_registry(&state,&label);}for n in 0..8{state.engine.prepare_operation(&format!("fresh-{n}")).unwrap();}assert!(state.engine.prepare_operation("ninth").is_err());}
    #[test]fn queued_dispatch_still_observes_early_cancellation(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.operations.insert("early".into(),"main".into());}state.engine.prepare_operation("early").unwrap();cancel_native_operation(&state,"main","early").unwrap();let _dispatch=NativeOperation::claim(&state,"main","early",None).unwrap();assert!(state.engine.claim_operation("early").unwrap().load(Ordering::SeqCst));state.engine.finish_operation("early");}
    #[test]fn empty_window_close_ignores_other_windows_pending_sync_without_stopping_it(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.bootstrap("other").unwrap();r.claim("other","other-tab").unwrap();r.prepare_job("other","other-job",Some("other-tab")).unwrap();}state.engine.prepare("other-job".into()).unwrap();assert!(seal_native_window_close(&state,"main",true).unwrap().is_empty());assert!(state.engine.window_busy(&["other-job".into()],&[]).unwrap());assert!(seal_native_window_close(&state,"other",false).is_err());assert!(state.ownership.lock().unwrap().registered("other").is_ok());}
    #[test]fn committed_job_moves_before_empty_source_close_guard_is_evaluated(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.bootstrap("other").unwrap();r.claim("main","moving").unwrap();r.prepare_job("main","moving-job",Some("moving")).unwrap();let t=r.begin_drag("main","moving",serde_json::json!({"version":1,"workspace":{"id":"moving"}})).unwrap();let t=r.activate_drag("main",&t.token,Some(("other",0,None))).unwrap();r.commit("other",&t.token).unwrap();}state.engine.prepare("moving-job".into()).unwrap();assert!(seal_native_window_close(&state,"main",true).unwrap().is_empty());assert!(state.ownership.lock().unwrap().job_owner("other","moving-job").is_ok());assert!(state.engine.window_busy(&["moving-job".into()],&[]).unwrap());assert!(seal_native_window_close(&state,"other",false).is_err());}
    #[test]fn empty_window_with_own_prepared_legacy_job_is_not_closed_and_is_unsealed(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.prepare_job("main","own-job",None).unwrap();}state.engine.prepare("own-job".into()).unwrap();assert!(seal_native_window_close(&state,"main",true).is_err());assert!(state.ownership.lock().unwrap().registered("main").is_ok());assert!(state.engine.window_busy(&["own-job".into()],&[]).unwrap());}
    struct CloseFixture(PathBuf);
    impl CloseFixture{fn new()->Self{let path=std::env::temp_dir().join(format!("nearly-close-generated-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir(&path).unwrap();Self(path)}fn path(&self)->PathBuf{self.0.join("settings.json")}}
    impl Drop for CloseFixture{fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}
    fn close_fixture()->(AppState,CloseFixture,Vec<String>){let fixture=CloseFixture::new();let mut data=Settings{version:1,..Default::default()};data.retained_syncs.push(serde_json::from_value(serde_json::json!({"id":"owned-context","ownerTabId":"own-tab","ownerTabClosed":false,"profile":{"id":"generated","name":"Generated","host":"never-contacted.invalid","port":22,"user":"fixture","auth":"key","mode":"mock","keyFile":"","hostKey":""},"local":"C:\\generated\\close","remote":"/close","exclusionRules":"*.tmp","deleteRemoved":false,"recursive":true,"pendingState":"unreflected"})).unwrap());unified_settings::save(&fixture.path(),&data).unwrap();let state=AppState::default();{let mut registry=state.ownership.lock().unwrap();registry.bootstrap("main").unwrap();registry.claim("main","own-tab").unwrap();}let ids=seal_native_window_close(&state,"main",false).unwrap();(state,fixture,ids)}
    #[test]fn closing_settings_client_is_blocked_until_failed_destroy_rollback_restores_and_unseals(){let(state,fixture,ids)=close_fixture();let path=fixture.path();let before=unified_settings::Document::read(&path).unwrap().settings();let mut notices=Vec::new();assert!(ensure_settings_window_open(&state,"main").is_err());let error=destroy_with_retained_cleanup(&state,"main",Some(&path),&ids,||{assert!(ensure_settings_window_open(&state,"main").is_err());let _lock=state.settings.lock().unwrap();let mut foreign=unified_settings::Document::read(&path).unwrap().settings();assert!(foreign.retained_syncs.is_empty());foreign.theme=Theme::Mint;unified_settings::save(&path,&foreign).unwrap();Err("Injected native destroy failure".into())},|revision|notices.push(revision)).unwrap_err();assert!(error.contains("Injected native destroy failure"));assert!(!error.contains("could not be restored"));assert!(ensure_settings_window_open(&state,"main").is_ok());assert!(state.ownership.lock().unwrap().owner("main","own-tab").is_ok());let after=unified_settings::Document::read(&path).unwrap().settings();assert!(matches!(after.theme,Theme::Mint));assert_eq!(serde_json::to_value(after.retained_syncs).unwrap(),serde_json::to_value(before.retained_syncs).unwrap());assert_eq!(notices.len(),2);}
    #[test]fn retained_cleanup_failure_never_destroys_and_unseals_original_window(){let(state,fixture,ids)=close_fixture();let path=fixture.path();let bytes=std::fs::read(&path).unwrap();std::fs::create_dir(path.with_extension("backup.json")).unwrap();let mut destroyed=false;let error=destroy_with_retained_cleanup(&state,"main",Some(&path),&ids,||{destroyed=true;Ok(())},|_|panic!("Failed cleanup cannot publish a revision")).unwrap_err();assert!(error.contains("this window remains open"));assert!(!destroyed);assert!(ensure_settings_window_open(&state,"main").is_ok());assert_eq!(std::fs::read(&path).unwrap(),bytes);}
    #[test]fn failed_native_destroy_and_failed_restore_report_both_and_leave_window_usable(){let(state,fixture,ids)=close_fixture();let path=fixture.path();let error=destroy_with_retained_cleanup(&state,"main",Some(&path),&ids,||{let backup=path.with_extension("backup.json");std::fs::remove_file(&backup).unwrap();std::fs::create_dir(&backup).unwrap();Err("Injected destroy failure".into())},|_|{}).unwrap_err();assert!(error.contains("Injected destroy failure"));assert!(error.contains("context could not be restored"));assert!(error.contains("This window remains open"));assert!(ensure_settings_window_open(&state,"main").is_ok());assert!(state.ownership.lock().unwrap().owner("main","own-tab").is_ok());assert!(unified_settings::Document::read(&path).unwrap().settings().retained_syncs.is_empty());}
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
    state.tab_drag.cancel_named(token);
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
    config.general_autofill_enabled=false;
    let w=tauri::WebviewWindowBuilder::from_config(app,&config).and_then(|b|b.build()).map_err(|e|format!("Window creation failed: {e}"))?;
    input_policy::configure(&w);
    // Register before releasing a spawn reservation: the renderer may not have
    // bootstrapped yet when the last previous window finishes closing.
    let result=app.state::<AppState>().ownership.lock().map_err(|_|"Ownership lock failed".to_owned())?.bootstrap(label);
    if let Err(e)=result{let _=w.destroy();return Err(e);}Ok(w)
}
// A provisional detached app renders real workspace DOM while the source remains
// its sole native owner. Only the native mouse-up activates ordinary transfer.
fn create_drag_preview(app:&tauri::AppHandle,source:&str,token:&str,x:i32,y:i32,grab_x:f64,grab_y:f64)->Result<tauri::WebviewWindow,String>{
    let transfer=app.state::<AppState>().ownership.lock().map_err(|_|"Ownership lock failed")?.preview_drag(source,token)?;
    let result=(||{let w=create_workspace_window(app,&transfer.target_label)?;w.set_ignore_cursor_events(true).map_err(|e|e.to_string())?;
        #[cfg(windows)]tab_drag::place(&w,x,y,grab_x,grab_y)?;
        #[cfg(not(windows))]let _=(x,y,grab_x,grab_y);
        Ok(w)})();
    if result.is_err(){discard_drag_preview(app,&transfer.target_label);}
    result
}
fn discard_drag_preview(app:&tauri::AppHandle,label:&str){
    let state=app.state::<AppState>();
    if !state.ownership.lock().map(|r|r.owned(label).is_empty()).unwrap_or(false){return;}
    if let Some(w)=app.get_webview_window(label){let _=w.destroy();}
    state.tab_drag.forget(label);if let Ok(mut r)=state.ownership.lock(){r.closed(label);};
}
fn cancel_drag_preview_close(app:&tauri::AppHandle,label:&str)->Result<bool,String>{
    let transfer=app.state::<AppState>().ownership.lock().map_err(|_|"Ownership lock failed")?.preview_for_window(label);
    if let Some(t)=transfer{abort_native_transfer(app,label,&t.token)?;return Ok(true);}Ok(false)
}
#[tauri::command]
fn workspace_drag_preview_ready(window:tauri::WebviewWindow,app:tauri::AppHandle,token:String)->Result<window_ownership::Transfer,String>{
    let t={let state=app.state::<AppState>();let r=state.ownership.lock().map_err(|_|"Ownership lock failed")?;r.registered(window.label())?;let t=r.status(window.label(),&token)?;
        if t.target_label!=window.label()||t.target_kind!="new"||!["dragging","pending","committed"].contains(&t.phase.as_str()){return Err("Window is not a detached preview".into());}t};
    if t.phase=="dragging"{app.state::<AppState>().tab_drag.preview_ready(&t.token);window.show().map_err(|e|e.to_string())?;if let Some(source)=app.get_webview_window(&t.source_label){let _=source.emit("tab-drag-preview-ready",serde_json::json!({"workspaceId":t.workspace_id,"dragId":t.token}));}}
    Ok(t)
}
fn transfer_timeout(app:&tauri::AppHandle,t:&window_ownership::Transfer){let app=app.clone();let token=t.token.clone();let source=t.source_label.clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_secs(30)).await;let _=abort_native_transfer(&app,&source,&token);});}
fn stage_drag_transfer(app:&tauri::AppHandle,source:&str,token:&str,target:Option<(String,usize,Option<String>)>,x:i32,y:i32,grab_x:f64,grab_y:f64)->Result<window_ownership::Transfer,String>{
    let state=app.state::<AppState>();
    let transfer={let mut r=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
        if let Some((label,_,_))=target.as_ref(){let ids=r.owned(label);if state.sessions.window_busy(&ids)?||state.engine.starts_pending(&r.job_ids(label))?||r.probes.iter().any(|(id,owner)|owner==label&&state.host_verification.request_pending(id).unwrap_or(true)){return Err("Target window is busy".into());}}
        r.activate_drag(source,token,target.as_ref().map(|(label,index,before)|(label.as_str(),*index,before.clone())))?};
    if transfer.target_kind=="new"{
        let result=(||->Result<(),String>{let w=if let Some(w)=app.get_webview_window(&transfer.target_label){w}else{create_workspace_window(app,&transfer.target_label)?};
            w.set_ignore_cursor_events(false).map_err(|e|e.to_string())?;
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
fn seal_native_window_close(state:&AppState,label:&str,require_empty:bool)->Result<Vec<String>,String>{
    let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    if registry.probes.iter().any(|(id,owner)|owner==label&&state.host_verification.request_pending(id).unwrap_or(true)){return Err("Finish host verification before closing".into());}
    let ids=if require_empty{registry.seal_empty_close(label)?}else{registry.seal_close(label)?};
    let jobs=registry.job_ids(label);
    match(state.sessions.window_busy(&ids),state.engine.window_busy(&jobs,&[])){
        (Ok(false),Ok(false))=>Ok(ids),
        _=>{registry.unseal(label);Err("Stop this window's syncs and finish connecting before closing".into())}
    }
}
fn complete_native_window_close(app:&tauri::AppHandle,label:&str,ids:Vec<String>)->Result<(),String>{
    let state=app.state::<AppState>();
    let path=if ids.is_empty(){None}else{match settings_path(app){Ok(path)=>Some(path),Err(error)=>{unseal_failed_close(&state,label);return Err(error);}}};
    destroy_with_retained_cleanup(&state,label,path.as_deref(),&ids,||{
        if let Some(window)=app.get_webview_window(label){window.destroy().map_err(|error|format!("Unable to close this window: {error}"))?;}Ok(())
    },|revision|{let payload=serde_json::json!({"settingsRevision":revision});for(other_label,window)in app.webview_windows(){if other_label!=label&&other_label!="tab-drag-preview"{let _=window.emit("settings-changed",&payload);}}})?;
    // Only IDs captured under this label's close seal may be disconnected. A
    // committed transfer has already moved its IDs/jobs to the destination.
    for id in ids{if let Ok(watch)=state.local_watch.status(&id){let _=state.local_watch.unwatch(&id,watch.token);}let _=state.sessions.disconnect(&id);}
    if let Ok(mut clients)=state.settings_clients.lock(){clients.forget(label);}
    release_closed_window_registry(&state,label);shutdown_if_idle(app);Ok(())
}
fn unseal_failed_close(state:&AppState,label:&str){if let Ok(mut registry)=state.ownership.lock(){registry.unseal(label);}}
/// Serialize just the settings transactions, never native window destruction.
/// This allows a foreign save between removal and rollback without losing it.
fn destroy_with_retained_cleanup<D,N>(state:&AppState,label:&str,path:Option<&Path>,ids:&[String],destroy:D,mut notify:N)->Result<(),String>
where D:FnOnce()->Result<(),String>,N:FnMut(u64){
    let cleanup=(||->Result<unified_settings::RetainedCloseCleanup,String>{
        if ids.is_empty(){return Ok(Default::default());}
        let path=path.ok_or("Settings path unavailable while closing")?;
        let _lock=state.settings.lock().map_err(|_|"Settings lock failed")?;
        unified_settings::prune_owned_retained_syncs(path,ids)
    })();
    let cleanup=match cleanup{Ok(cleanup)=>cleanup,Err(error)=>{unseal_failed_close(state,label);return Err(format!("Unable to save closing tab context; this window remains open: {error}"));}};
    if let Some(revision)=cleanup.revision{notify(revision);}
    if let Err(error)=destroy(){
        let restored=(||->Result<Option<u64>,String>{
            if cleanup.revision.is_none(){return Ok(None);}
            let _lock=state.settings.lock().map_err(|_|"Settings lock failed")?;
            unified_settings::restore_owned_retained_syncs(path.ok_or("Settings path unavailable during close rollback")?,&cleanup)
        })();
        unseal_failed_close(state,label);
        match restored{Ok(revision)=>{if let Some(revision)=revision{notify(revision);}return Err(error);},Err(restore_error)=>return Err(format!("{error}. Closing tab context could not be restored: {restore_error}. This window remains open; its tab context is still visible but could not be saved."))}
    }
    Ok(())
}
fn close_empty_native_window(app:&tauri::AppHandle,label:&str)->Result<(),String>{flush_main_window_size(app,label);let ids=seal_native_window_close(&app.state::<AppState>(),label,true)?;complete_native_window_close(app,label,ids)}
#[tauri::command]
async fn close_empty_window(window:tauri::WebviewWindow,app:tauri::AppHandle)->Result<(),String>{close_empty_native_window(&app,window.label())}
#[tauri::command]
async fn check_startup_update(window:tauri::WebviewWindow,state:tauri::State<'_,AppState>)->Result<startup_update::Report,String>{
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.registered(window.label())?;
    Ok(state.startup_update.check(window.label()).await)
}
#[tauri::command]
fn startup_update_status(window:tauri::WebviewWindow,state:tauri::State<AppState>)->startup_update::Report {state.startup_update.status(window.label())}
#[tauri::command]
fn prepare_startup_update(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<AppState>)->Result<startup_update::Report,String>{
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.registered(window.label())?;
    let label=window.label().to_string();
    let outcome=state.startup_update.begin_prepare(&label).map_err(str::to_string)?;
    if outcome.state=="downloading"{tauri::async_runtime::spawn(async move{app.state::<AppState>().startup_update.download().await;});}
    Ok(outcome)
}
#[tauri::command]
fn cancel_startup_update(window:tauri::WebviewWindow,state:tauri::State<AppState>)->startup_update::Report{state.startup_update.cancel(window.label(),false)}
#[tauri::command]
fn dismiss_startup_update(window:tauri::WebviewWindow,state:tauri::State<AppState>)->startup_update::Report{state.startup_update.cancel(window.label(),true)}
#[tauri::command]
fn ack_startup_update(window:tauri::WebviewWindow,state:tauri::State<AppState>,token:String,ready:bool)->Result<(),String>{state.startup_update.acknowledge(window.label(),&token,ready).map_err(str::to_string)}
fn begin_native_update(state:&AppState)->Result<Vec<String>,String>{
    let mut r=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    if r.probes.keys().any(|id|state.host_verification.request_pending(id).unwrap_or(true)){return Err("updateBusy".into())}
    for label in r.window_labels(){if state.sessions.window_busy(&r.owned(&label))?||state.engine.window_busy(&r.job_ids(&label),&[])?{return Err("updateBusy".into())}}
    r.begin_update()
}
fn cancel_native_update(app:&tauri::AppHandle){let state=app.state::<AppState>();if let Ok(mut r)=state.ownership.lock(){r.cancel_update();}let _=app.emit("startup-update-unseal",());}
/// Caller owns settings lock and global seal. Rollback changes only the captured
/// transient records against the latest document, preserving profiles and maps.
fn update_settings_transaction<T,F>(path:&Path,ids:&[String],launch:F)->Result<T,String> where F:FnOnce()->Result<T,String>{
    let cleanup=unified_settings::prune_owned_retained_syncs(path,ids).map_err(|_|"settingsNotSettled")?;
    match launch(){Ok(value)=>Ok(value),Err(error)=>{if unified_settings::restore_owned_retained_syncs(path,&cleanup).is_err(){return Err("settingsRollbackFailed".into())}Err(error)}}
}
fn perform_update_handoff(app:&tauri::AppHandle,label:&str)->Result<(),String>{
    let state=app.state::<AppState>();
    let (mut stage,candidate,key)=state.startup_update.take_verified(label).map_err(str::to_string)?;
    flush_main_window_size(app,"main");
    let path=settings_path(app)?;
    let _settings=state.settings.lock().map_err(|_|"settingsNotSettled")?;
    let ids={let mut r=state.ownership.lock().map_err(|_|"updateUnavailable")?;r.seal_update()?;r.update_owned_ids()};
    stage.reverify(&candidate,&key).map_err(|_|"invalidSignature")?;
    let _child=update_settings_transaction(&path,&ids,||{
        #[cfg(windows)] {
            let snapshot=stage.transaction_snapshot(&candidate,&key).map_err(|_|"invalidSignature")?;
            let mut prepared=update_recovery_windows::prepare_recovery(&snapshot,&path).map_err(|_|"installerLaunchFailed")?;
            let launched=match update_handoff::launch_verified_recovery(&prepared){
                Ok(launched)=>launched,
                Err(failure)=>{let _=prepared.abandon_never_spawned(&failure);return Err("installerLaunchFailed".into());}
            };
            update_recovery_windows::bind_recovery(&mut prepared,&launched).map_err(|_|"installerLaunchFailed")?;
            launched.commit().map_err(|_|"installerLaunchFailed".into())
        }
        #[cfg(not(windows))] {Err::<std::process::Child,String>("installerLaunchFailed".into())}
    })?;
    // The verified NSIS child has acknowledged the exact-parent waiting phase.
    // Keep its source image locked until OS process teardown; Drop would mark
    // it delete-pending while NSIS can still need to read its own package.
    std::mem::forget(stage);
    let _=state.local_watch.clear();state.sessions.begin_shutdown();state.sessions.shutdown();state.host_verification.shutdown();
    app.exit(0);Ok(())
}
#[tauri::command]
async fn install_startup_update(window:tauri::WebviewWindow,app:tauri::AppHandle)->startup_update::Report{
    let label=window.label().to_string();let state=app.state::<AppState>();
    // Missing trust must fail before any seal, settings cleanup or child launch.
    if update_package::runtime_key().is_none(){return state.startup_update.fail(&label,"signingNotConfigured")}
    if !startup_update::handoff_validated(){return state.startup_update.fail(&label,"installationNotValidated")}
    let labels=match begin_native_update(&state){Ok(labels)=>labels,Err(_)=>return state.startup_update.fail(&label,"workInProgress")};
    let token=match state.startup_update.begin_settle(&label,labels){Ok(token)=>token,Err(code)=>{cancel_native_update(&app);return state.startup_update.fail(&label,code)}};
    if app.emit("startup-update-settle",serde_json::json!({"token":token})).is_err(){cancel_native_update(&app);return state.startup_update.fail(&label,"settingsNotSettled")}
    if let Err(code)=state.startup_update.wait_settled(&token).await{cancel_native_update(&app);return state.startup_update.fail(&label,code)}
    let worker_app=app.clone();let worker_label=label.clone();
    let result=tauri::async_runtime::spawn_blocking(move||perform_update_handoff(&worker_app,&worker_label)).await;
    match result{Ok(Ok(()))=>state.startup_update.status(&label),other=>{cancel_native_update(&app);let code=match other{Ok(Err(ref code)) if code=="invalidSignature"=>"invalidSignature",Ok(Err(ref code))if code=="settingsRollbackFailed"=>"settingsRollbackFailed",Ok(Err(ref code))if code=="settingsNotSettled"=>"settingsNotSettled",_=>"installerLaunchFailed"};state.startup_update.fail(&label,code)}}
}

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
    drop(registry);transfer_event(&app,&t);
    // Ownership commit is the irreversible boundary. Empty-source teardown is
    // best-effort afterward and must never roll back the target's live job.
    if let Err(message)=close_empty_native_window(&app,&t.source_label){
        if let Some(source)=app.get_webview_window(&t.source_label){
            // A source which kept another tab is expected to remain open.
            if state.ownership.lock().map(|r|r.owned(&t.source_label).is_empty()).unwrap_or(false){let _=source.emit("sync-close-blocked",message);}
        }
    }
    Ok(t)
}
#[tauri::command]
fn workspace_transfer_status(window:tauri::WebviewWindow,state:tauri::State<AppState>,token:String)->Result<window_ownership::Transfer,String>{state.ownership.lock().map_err(|_|"Ownership lock failed")?.status(window.label(),&token)}
#[tauri::command]
fn abort_workspace_transfer(window:tauri::WebviewWindow,app:tauri::AppHandle,token:String)->Result<window_ownership::Transfer,String>{abort_native_transfer(&app,window.label(),&token)}
#[tauri::command]
fn window_taskbar_status(window:tauri::WebviewWindow,state:tauri::State<AppState>)->Result<String,String>{let ids=state.ownership.lock().map_err(|_|"Ownership lock failed")?.job_ids(window.label());Ok(format!("{:?}",state.engine.taskbar_state_for(&ids)?).to_lowercase())}
#[tauri::command]
fn update_restart_status(window:tauri::WebviewWindow,state:tauri::State<AppState>)->Result<serde_json::Value,String>{
    if window.label()!="main"{return Err("Update restart status is main-window only".into());}
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.settings_registered(window.label())?;
    let value=serde_json::to_value(state.update_restart.status()).map_err(|_|"Update status unavailable")?;
    #[cfg(all(feature="installer-qa",windows))]
    {let mut value=value;value["installerQa"]=true.into();return Ok(value)}
    #[cfg(not(all(feature="installer-qa",windows)))]
    Ok(value)
}
#[tauri::command]
fn ack_update_restart_ready(window:tauri::WebviewWindow,app:tauri::AppHandle,state:tauri::State<AppState>,bootstrap:Option<bool>)->Result<update_runtime::Report,String>{
    if window.label()!="main"{return Err("Update restart health is main-window only".into());}
    state.ownership.lock().map_err(|_|"Ownership lock failed")?.settings_registered(window.label())?;
    #[cfg(all(feature="installer-qa",windows))]
    {if !installer_qa::suppress_health(){state.update_restart.ack_ready();}installer_qa::on_ready(window,app,bootstrap==Some(true));}
    #[cfg(not(all(feature="installer-qa",windows)))]
    {let _=(app,bootstrap);state.update_restart.ack_ready();}
    Ok(state.update_restart.status())
}
/// Native-only proof created after admission sealing and global idle/settings
/// drain checks. Renderer commands cannot obtain the private Idle authority.
pub(crate) struct HealthExitSeal { _private: () }
pub(crate) struct HealthIdleProof { _private: () }
fn attest_health_idle(state:&AppState)->Result<HealthIdleProof,String>{
    let registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    registry.attest_health_idle()?;
    let _settings=state.settings.try_lock().map_err(|_|"Settings writer is busy")?;
    if !state.sessions.probation_idle()?||!state.engine.probation_idle()?{return Err("Native user work escaped probation".into());}
    Ok(HealthIdleProof{_private:()})
}
#[cfg(test)]
mod health_shutdown_tests {
    use super::*;
    fn probation()->AppState{let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.register_native_window("main").unwrap();r.enter_health_probation();}state}
    #[test]fn health_shutdown_requires_probation_and_preserves_ordinary_work(){
        let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.claim("main","tab").unwrap();}
        assert!(seal_health_shutdown(&state).is_err());assert!(state.ownership.lock().unwrap().mutable("main","tab").is_ok());
    }
    #[test]fn health_shutdown_busy_settings_writer_refuses_without_waiting_or_closing(){
        let state=probation();let writer=state.settings.lock().unwrap();
        assert!(seal_health_shutdown(&state).is_err());drop(writer);
        assert!(state.ownership.lock().unwrap().settings_registered("main").is_err());
        assert!(state.sessions.prepare("evidence-retained").is_ok());
    }
    #[test]fn health_shutdown_detects_orphan_native_job_and_preserves_it(){
        let state=probation();state.engine.prepare("escaped-gate-job".into()).unwrap();
        assert!(seal_health_shutdown(&state).is_err());
        assert!(state.engine.window_busy(&["escaped-gate-job".into()],&[]).unwrap());
        assert!(state.ownership.lock().unwrap().release_health_probation().is_err());
    }
    #[test]fn health_shutdown_idle_drains_settings_and_permanently_seals_work(){
        let state=probation();{let _settled_writer=state.settings.lock().unwrap();}
        let _proof=seal_health_shutdown(&state).unwrap();
        assert!(state.sessions.prepare("late-session").is_err());assert!(state.engine.prepare("late-job".into()).is_err());
        assert!(state.ownership.lock().unwrap().reserve_spawn("late-window").is_err());
        assert!(state.ownership.lock().unwrap().release_health_probation().is_err());
    }
    #[test]fn health_initial_idle_attestation_keeps_readiness_alive_without_closing_engines(){
        let state=probation();let _proof=attest_health_idle(&state).unwrap();
        assert!(state.ownership.lock().unwrap().settings_registered("main").is_ok());
        assert!(state.ownership.lock().unwrap().bootstrap("main").is_ok());
        assert!(state.ownership.lock().unwrap().claim("main","late").is_err());
        assert!(state.sessions.probation_idle().unwrap()&&state.engine.probation_idle().unwrap());
        state.ownership.lock().unwrap().release_health_probation().unwrap();
        state.sessions.prepare("after-native-success").unwrap();state.engine.prepare("after-native-success".into()).unwrap();
    }
    #[test]fn health_initial_idle_attestation_refuses_contended_settings_and_orphan_native_work(){
        let state=probation();{let _writer=state.settings.lock().unwrap();assert!(attest_health_idle(&state).is_err());}
        state.sessions.prepare("escaped-session").unwrap();assert!(attest_health_idle(&state).is_err());
        let state=probation();state.engine.prepare("escaped-job".into()).unwrap();assert!(attest_health_idle(&state).is_err());
        let state=AppState::default();assert!(attest_health_idle(&state).is_err());
    }
}
fn seal_health_shutdown(state:&AppState)->Result<HealthExitSeal,String>{
    let mut registry=state.ownership.lock().map_err(|_|"Ownership lock failed")?;
    let labels=registry.seal_health_exit()?;
    // Never wait ownership -> settings: ordinary writers use the inverse lock
    // order. A live writer means user editing may have escaped probation; retain
    // the sealed app for manual repair. A settled writer is drained by this lock.
    let _settings=state.settings.try_lock().map_err(|_|"Settings writer is busy; automatic health shutdown refused")?;
    let ids=registry.update_owned_ids();
    let jobs:Vec<_>=labels.iter().flat_map(|label|registry.job_ids(label)).collect();
    let operations:Vec<_>=registry.operations.keys().cloned().collect();
    if !state.sessions.probation_idle()?||!state.engine.probation_idle()?||state.sessions.window_busy(&ids)?||state.engine.window_busy(&jobs,&operations)?{
        return Err("Native work is busy; automatic health shutdown refused".into());
    }
    state.sessions.try_begin_close(||state.engine.try_begin_close())?;
    Ok(HealthExitSeal{_private:()})
}
fn main() {
    #[cfg(feature="installer-qa")]
    {#[cfg(windows)] if !installer_qa::authorized()&&!installer_qa::authorized_install_policy(std::env::args_os()){std::process::exit(78);}
     #[cfg(not(windows))] std::process::exit(78);}
    // Legacy preparation protocol is confined to disposable QA fixtures.
    // Production installation uses NSIS/Windows access checks directly.
    #[cfg(feature="installer-qa")]
    if let Some(code)=install_prepare::dispatch(std::env::args_os()){std::process::exit(code);}
    #[cfg(all(feature="installer-qa",windows))]
    installer_qa::trace("startup",if std::env::current_exe().ok().is_some_and(|p|p.file_name().is_some_and(|n|n=="previous-image.exe")){"helper"}else if env!("CARGO_PKG_VERSION")=="1.9.0"{"source"}else{"target"});
    #[cfg(windows)]
    if let update_recovery_windows::HelperDispatch::Terminal(code)=update_recovery_windows::dispatch_helper(std::env::args_os()){std::process::exit(code);}
    // Parse native argv before the single-instance plugin can route a launch.
    let startup=update_runtime::parse_args(std::env::args_os());
    // Reserved malformed/disabled health routes never become normal windows or
    // get forwarded to a normal instance's renderer.
    if startup==update_runtime::Startup::Invalid{return;}
    let probation=matches!(startup,update_runtime::Startup::Health(_));
    if probation&&(!startup_update::handoff_validated()||update_package::runtime_key().is_none()){return;}
    #[cfg(windows)]
    if !probation&&startup_update::handoff_validated()&&update_package::runtime_key().is_some()
        &&update_recovery_windows::ordinary_startup_allowed().is_err(){
            #[cfg(feature="installer-qa")] installer_qa::trace_runtime("recoveryRequired",Some("transactionUnavailable"));return;
        }
    #[cfg(windows)]
    if let update_runtime::Startup::Health(nonce)=&startup{
        // Helper binds the exact CreateProcess child immediately after spawn.
        // Authenticate before single-instance routing; a nonce cannot forward a
        // privileged health launch into an unrelated ordinary application.
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(2);
        loop{
            if update_recovery_windows::authenticate_health(nonce).ok().and_then(|snapshot|update_restart::LiveRecoverySupervisor::open(snapshot).ok()).is_some(){break;}
            if std::time::Instant::now()>=deadline{return;}
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    let restart=update_runtime::Runtime::new(startup);
    let native_state=AppState{update_restart:restart,..Default::default()};
    if probation{let mut r=native_state.ownership.lock().expect("Ownership lock failed");r.register_native_window("main").expect("Native main registration failed");r.enter_health_probation();}
    let mut context=tauri::generate_context!();
    for window in &mut context.config_mut().app.windows{if window.label=="main"{window.visible=false;}}
    let closing = Arc::new(AtomicBool::new(false));
    let lifecycle_closing=closing.clone();
    #[cfg(windows)]
    let taskbar_closing=closing.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if app.state::<AppState>().update_restart.route_second(update_runtime::parse_args(args)){return;}
            open_blank_window(app.clone());
        }))
        .manage(native_state)
        .setup(move |app| {
            // Native lifetime starts before renderer bootstrap. An early second
            // launch closing again must not make the still-loading main vanish
            // from the shutdown decision or consume its fresh-process startup.
            if !probation{app.state::<AppState>().ownership.lock().map_err(|_|"Ownership lock failed")?.register_native_window("main")?;}
            let status_app=app.handle().clone();
            let release_app=app.handle().clone();let seal_app=app.handle().clone();let exit_app=app.handle().clone();let idle_app=app.handle().clone();
            app.state::<AppState>().update_restart.start(Arc::new(move|report|{let _=status_app.emit("update-restart-status",report);}),update_runtime::HealthActions{
                release:Arc::new(move||release_app.state::<AppState>().ownership.lock().map_err(|_|"Ownership lock failed")?.release_health_probation()),
                seal_exit:Arc::new(move||seal_health_shutdown(&seal_app.state::<AppState>())),
                attest_idle:Arc::new(move||attest_health_idle(&idle_app.state::<AppState>())),
                exit:Arc::new(move||exit_app.exit(0)),
            });
            if let Some(window)=app.get_webview_window("main"){input_policy::configure(&window);}
            restore_main_window_size(app.handle());
            #[cfg(windows)]
            taskbar_adapter::start(app.handle().clone(), app.state::<AppState>().engine.clone(), app.state::<AppState>().ownership.clone(), taskbar_closing.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_window, register_workspace, unregister_workspace, workspace_transfer_ready, workspace_drag_preview_ready, close_empty_window, check_startup_update, startup_update_status, prepare_startup_update, cancel_startup_update, dismiss_startup_update, ack_startup_update, install_startup_update,
            tab_drag::register_tab_strip, tab_drag::begin_tab_drag, tab_drag::cancel_tab_drag, tab_drag::tab_drag_status,
            workspace_transfer_status, abort_workspace_transfer, window_taskbar_status,
            load_settings, update_restart_status, ack_update_restart_ready,
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
            run_upload,
            run_download,
            run_remote_drag,
            file_transfer_prompt,
            choose_file_transfer,
            run_local_archive,
            prepare_file_operation,
            cancel_file_operation
        ])
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(event) = event {
                // Snapshot before renderer dispatch. Runtime events may already
                // be queued: source exclusion also requires the native HWND
                // release guard and the virtual source's refusal of CF_HDROP.
                let Some(payload) = native_download_drag::tagged_drop(event) else { return; };
                let _ = webview.emit_to(webview.label(), "native-file-drop", payload);
            }
        })
        .on_window_event(move |window, event| {
            // A window-content WebView is surfaced as a synthesized window event.
            if let tauri::WindowEvent::DragDrop(event) = event {
                if let Some(payload) = native_download_drag::tagged_drop(event) {
                    let _ = window.emit_to(window.label(), "native-file-drop", payload);
                }
            }
            if matches!(event,tauri::WindowEvent::Resized(_)|tauri::WindowEvent::Moved(_)|tauri::WindowEvent::ScaleFactorChanged{..}) {
                observe_main_window_size(window.app_handle(),window.label());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if closing.load(Ordering::SeqCst) {
                    return;
                }
                let app = window.app_handle().clone();
                let state=app.state::<AppState>();
                let label=window.label().to_owned();
                if cancel_drag_preview_close(&app,&label).unwrap_or(false){return;}
                flush_main_window_size(&app,&label);
                let result=seal_native_window_close(&state,&label,false)
                    .and_then(|ids|complete_native_window_close(&app,&label,ids));
                if let Err(message)=result{let _=window.emit("sync-close-blocked",message);}
            }
        })
        .build(context)
        .expect("Unable to launch SyncFiles")
        .run(move|_,event|{
            if let tauri::RunEvent::ExitRequested{code,api,..}=event{
                // Last-native-window exit can race a reserved second-launch
                // spawn. Our registry cleanup requests explicit exit only once
                // every user window and pending spawn has gone.
                if code.is_none(){api.prevent_exit();}else{lifecycle_closing.store(true,Ordering::SeqCst);}
            }
        });
}
#[cfg(test)]
mod update_lifecycle_tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {fn new()->Self{let p=std::env::temp_dir().join(format!("nearly-update-state-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir(&p).unwrap();Self(p)}fn path(&self)->PathBuf{self.0.join("settings.json")}}
    impl Drop for Fixture{fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}
    fn fixture()->Fixture{let f=Fixture::new();let mut data=Settings{version:1,..Default::default()};for(id,owner)in[("owned","own-tab"),("foreign","foreign-tab")]{data.retained_syncs.push(serde_json::from_value(serde_json::json!({"id":id,"ownerTabId":owner,"ownerTabClosed":false,"profile":{"id":"generated","name":"Generated","host":"never-contacted.invalid","port":22,"user":"fixture","auth":"key","mode":"mock","keyFile":"","hostKey":""},"local":"C:\\generated\\update","remote":"/update","exclusionRules":"*.tmp","deleteRemoved":false,"recursive":true,"pendingState":"unreflected"})).unwrap());}unified_settings::save(&f.path(),&data).unwrap();f}
    #[test]fn failed_handoff_restores_only_session_context_and_preserves_latest_preferences(){let f=fixture();let result=update_settings_transaction(&f.path(),&["own-tab".into()],||->Result<(),String>{let mut data=unified_settings::Document::read(&f.path()).unwrap().settings();assert_eq!(data.retained_syncs.len(),1);assert_eq!(data.retained_syncs[0].id,"foreign");data.theme=Theme::Mint;unified_settings::save(&f.path(),&data).unwrap();Err("fake installer rejected readiness".into())});assert_eq!(result,Err("fake installer rejected readiness".into()));let data=unified_settings::Document::read(&f.path()).unwrap().settings();assert_eq!(data.retained_syncs.len(),2);assert!(matches!(data.theme,Theme::Mint));}
    #[test]fn successful_fake_handoff_prunes_only_owned_stopped_context(){let f=fixture();let outcome=update_settings_transaction(&f.path(),&["own-tab".into()],||Ok::<_,String>("fake child ready")).unwrap();assert_eq!(outcome,"fake child ready");let data=unified_settings::Document::read(&f.path()).unwrap().settings();assert_eq!(data.retained_syncs.len(),1);assert_eq!(data.retained_syncs[0].id,"foreign");}
    #[test]fn settings_failure_never_launches_even_fake_child(){let f=fixture();let backup=f.path().with_extension("backup.json");if backup.exists(){std::fs::remove_file(&backup).unwrap();}std::fs::create_dir(&backup).unwrap();let mut launched=false;assert!(update_settings_transaction(&f.path(),&["own-tab".into()],||{launched=true;Ok(())}).is_err());assert!(!launched);}
    #[test]fn active_background_start_blocks_update_without_stopping_job(){let state=AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("main").unwrap();r.bootstrap("background").unwrap();r.claim("background","other-tab").unwrap();r.prepare_job("background","other-job",Some("other-tab")).unwrap();}state.engine.prepare("other-job".into()).unwrap();assert!(begin_native_update(&state).is_err());assert!(state.engine.window_busy(&["other-job".into()],&[]).unwrap());assert!(state.ownership.lock().unwrap().registered("main").is_ok());}
}

#[cfg(test)]
mod input_policy_config_tests {
    #[test]
    fn input_policy_main_disables_general_autofill() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(window["generalAutofillEnabled"], false, "Every configured WebView must disable general autofill");
        }
    }
}

