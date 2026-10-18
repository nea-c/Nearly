use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderBookmark {
    pub id: String,
    pub name: String,
    pub connection_key: String,
    pub local: String,
    pub remote: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderPairHistory {
    pub connection_key: String,
    pub local: String,
    pub remote: String,
    pub opened_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SortSpec {
    pub column: String,
    pub direction: String,
}
impl Default for SortSpec {
    fn default() -> Self {
        Self {
            column: "name".into(),
            direction: "ascending".into(),
        }
    }
}
fn deserialize_widths<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<String, f64>, D::Error> {
    let widths = HashMap::<String, Option<f64>>::deserialize(deserializer)?;
    let allowed = ["name", "size", "type", "modified", "permissions", "owner"];
    if widths.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(serde::de::Error::custom("Unknown column width field"));
    }
    Ok(widths
        .into_iter()
        .filter_map(|(key, value)| value.map(|n| (key, n)))
        .collect())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnSettings {
    pub order: Vec<String>,
    pub hidden: Vec<String>,
    #[serde(deserialize_with = "deserialize_widths")]
    pub widths: HashMap<String, f64>,
    #[serde(default)]
    pub sort: SortSpec,
}
impl Default for ColumnSettings {
    fn default() -> Self {
        Self {
            order: ["name", "size", "type", "modified", "permissions", "owner"]
                .map(String::from)
                .into(),
            hidden: vec!["permissions".into(), "owner".into()],
            widths: [
                ("name".into(), 280.0),
                ("size".into(), 100.0),
                ("type".into(), 100.0),
                ("modified".into(), 170.0),
                ("permissions".into(), 120.0),
                ("owner".into(), 120.0),
            ]
            .into(),
            sort: SortSpec::default(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaneColumns {
    pub local: ColumnSettings,
    pub remote: ColumnSettings,
}
fn local_columns(pane: &mut ColumnSettings) {
    pane.order.retain(|id| id != "permissions" && id != "owner");
    pane.hidden
        .retain(|id| id != "permissions" && id != "owner");
    pane.widths
        .retain(|id, _| id != "permissions" && id != "owner");
}
impl Default for PaneColumns {
    fn default() -> Self {
        let mut local = ColumnSettings::default();
        local_columns(&mut local);
        Self {
            local,
            remote: ColumnSettings::default(),
        }
    }
}
#[cfg(test)]
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplorerPreferences {
    #[serde(default)]
    pub folder_bookmarks: Vec<FolderBookmark>,
    #[serde(default)]
    pub folder_pair_history: Vec<FolderPairHistory>,
    #[serde(default)]
    pub pane_columns: PaneColumns,
}
pub(crate) fn trim_client(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
fn is_control(c: char) -> bool {
    matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}')
}
pub(crate) fn clean_text(value: &str, max: usize) -> bool {
    !trim_client(value).is_empty()
        && value.encode_utf16().count() <= max
        && !value.chars().any(is_control)
}
pub(crate) fn identity(value: &str) -> Result<(), String> {
    let v: Vec<serde_json::Value> =
        serde_json::from_str(value).map_err(|_| "Invalid explorer connection identity")?;
    if value.len() > 8192
        || v.len() != 6
        || !v[0].as_str().is_some_and(|s| clean_text(s, 8192))
        || !matches!(v[1].as_str(), Some("mock" | "sftp"))
        || !v[2]
            .as_str()
            .is_some_and(|s| clean_text(s, 8192) && s == trim_client(s).to_lowercase())
        || !v[3].as_u64().is_some_and(|n| (1..=65535).contains(&n))
        || !v[4].as_str().is_some_and(|s| clean_text(s, 8192))
        || !v[5]
            .as_str()
            .is_some_and(|s| s == trim_client(s) && !s.chars().any(is_control))
    {
        return Err("Invalid explorer connection identity".into());
    }
    Ok(())
}
pub(crate) fn pair(identity_key: &str, local: &str, remote: &str) -> Result<String, String> {
    identity(identity_key)?;
    let bytes = local.as_bytes();
    if !clean_text(local, 4096)
        || bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || local[2..].contains(':')
        || local.chars().any(|c| "<>\"|?*".contains(c))
        || local
            .replace('\\', "/")
            .split('/')
            .any(|s| matches!(s, "." | ".."))
        || !clean_text(remote, 4096)
        || !remote.starts_with('/')
        || remote.contains('\\')
        || remote.split('/').any(|s| matches!(s, "." | ".."))
    {
        return Err("Invalid explorer folder pair".into());
    }
    let local = local
        .replace('/', "\\")
        .split('\\')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\\")
        .to_lowercase();
    let remote = format!(
        "/{}",
        remote
            .split('/')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    );
    let identity: serde_json::Value =
        serde_json::from_str(identity_key).map_err(|_| "Invalid explorer identity")?;
    Ok(serde_json::json!([identity, local, remote]).to_string())
}
fn columns(v: &ColumnSettings) -> Result<(), String> {
    let allowed = ["name", "size", "type", "modified", "permissions", "owner"];
    if !matches!(v.order.len(), 4 | 6)
        || v.order.iter().collect::<HashSet<_>>().len() != v.order.len()
        || (v.order.len() == 4 && v.order.iter().any(|k| k == "permissions" || k == "owner"))
        || v.order.iter().any(|k| !allowed.contains(&k.as_str()))
        || v.hidden.len() > 5
        || v.hidden.iter().collect::<HashSet<_>>().len() != v.hidden.len()
        || v.hidden
            .iter()
            .any(|k| k == "name" || !allowed.contains(&k.as_str()))
        || v.widths.len() > 6
        || v.widths.iter().any(|(k, n)| {
            !allowed.contains(&k.as_str()) || !n.is_finite() || !(40.0..=1200.0).contains(n)
        })
        || !allowed.contains(&v.sort.column.as_str())
        || !matches!(v.sort.direction.as_str(), "ascending" | "descending")
    {
        return Err(
            "Invalid explorer columns; name is required and widths must be 40 to 1200".into(),
        );
    }
    Ok(())
}
pub fn validate(
    bookmarks: &[FolderBookmark],
    history: &[FolderPairHistory],
    panes: &PaneColumns,
) -> Result<(), String> {
    if bookmarks.len() > 500 || history.len() > 200 {
        return Err("Explorer bookmarks exceed 500 or history exceeds 200 entries".into());
    }
    let mut ids = HashSet::new();
    let mut pairs = HashSet::new();
    for b in bookmarks {
        if !clean_text(&b.id, 128)
            || !clean_text(&b.name, 100)
            || !ids.insert(&b.id)
            || !pairs.insert(pair(&b.connection_key, &b.local, &b.remote)?)
        {
            return Err("Invalid or duplicate explorer bookmark".into());
        }
    }
    pairs.clear();
    for h in history {
        if h.opened_at > 9_007_199_254_740_991
            || !pairs.insert(pair(&h.connection_key, &h.local, &h.remote)?)
        {
            return Err("Invalid or duplicate explorer history".into());
        }
    }
    columns(&panes.local)?;
    if matches!(panes.local.sort.column.as_str(), "permissions" | "owner") {
        return Err("Local sorting column is unsupported".into());
    }
    columns(&panes.remote)
}
#[cfg(test)]
pub fn decode_saved(bytes: &[u8]) -> Option<ExplorerPreferences> {
    if bytes.len() > 2_000_000 {
        return None;
    }
    let mut value: ExplorerPreferences = serde_json::from_slice(bytes).ok()?;
    validate(
        &value.folder_bookmarks,
        &value.folder_pair_history,
        &value.pane_columns,
    )
    .ok()?;
    for pane in [
        &mut value.pane_columns.local,
        &mut value.pane_columns.remote,
    ] {
        if pane.order.len() == 4 {
            for id in ["permissions", "owner"] {
                pane.order.push(id.into());
                if !pane.hidden.iter().any(|k| k == id) {
                    pane.hidden.push(id.into());
                }
            }
        }
    }
    local_columns(&mut value.pane_columns.local);
    Some(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_columns_append_remote_metadata_preserving_local_layout() {
        let old = serde_json::json!({"order":["size","name","modified","type"],"hidden":["size"],"widths":{"name":333}});
        let data = serde_json::json!({"paneColumns":{"local":old,"remote":old}});
        let loaded = decode_saved(&serde_json::to_vec(&data).unwrap()).unwrap();
        assert_eq!(
            loaded.pane_columns.local.order,
            ["size", "name", "modified", "type"]
        );
        assert_eq!(loaded.pane_columns.local.hidden, ["size"]);
        assert_eq!(loaded.pane_columns.local.widths["name"], 333.0);
        assert_eq!(
            loaded.pane_columns.remote.order,
            ["size", "name", "modified", "type", "permissions", "owner"]
        );
        assert_eq!(
            loaded.pane_columns.remote.hidden,
            ["size", "permissions", "owner"]
        );
        let mut current = PaneColumns::default();
        current.local.order = vec![
            "size".into(),
            "name".into(),
            "type".into(),
            "modified".into(),
        ];
        current.local.hidden.push("size".into());
        assert!(validate(&[], &[], &current).is_ok());
        current.local.hidden.push("name".into());
        assert!(validate(&[], &[], &current).is_err());
        let interim = serde_json::json!({"paneColumns":{"local":{"order":["name","size","type","modified","permissions","owner"],"hidden":["permissions"],"widths":{"owner":200}},"remote":old}});
        let normalized = decode_saved(&serde_json::to_vec(&interim).unwrap()).unwrap();
        assert_eq!(normalized.pane_columns.local.order.len(), 4);
        assert!(!normalized.pane_columns.local.widths.contains_key("owner"));
    }
    #[test]
    fn utf16_limits_controls_and_whitespace_match_client_validation() {
        let key = serde_json::json!(["p", "sftp", "example.invalid", 22, "me", "SHA256:fixture"])
            .to_string();
        let mut bookmark = FolderBookmark {
            id: "b".into(),
            name: "😀".repeat(50),
            connection_key: key,
            local: "C:\\site".into(),
            remote: "/www".into(),
        };
        assert!(validate(&[bookmark.clone()], &[], &PaneColumns::default()).is_ok());
        for name in [
            "😀".repeat(51),
            "😀".repeat(100),
            "\u{feff}".into(),
            "name\u{007f}".into(),
            "name\u{0085}".into(),
            "name\u{009f}".into(),
        ] {
            bookmark.name = name;
            let data = ExplorerPreferences {
                folder_bookmarks: vec![bookmark.clone()],
                ..Default::default()
            };
            assert!(decode_saved(&serde_json::to_vec(&data).unwrap()).is_none());
        }
        assert!(decode_saved(br#"{"folderBookmarks":[{"id":"b","name":"\ud800","connectionKey":"unused","local":"C:\\site","remote":"/www"}]}"#).is_none());
        assert!(clean_text(&"日".repeat(100), 100));
        assert!(clean_text("prefix\u{feff}suffix", 100));
    }
    #[test]
    fn strict_columns_and_identity_bounds_refuse_invalid_persistence() {
        let good = PaneColumns::default();
        assert!(validate(&[], &[], &good).is_ok());
        for key in ["name", "password"] {
            let mut bad = good.clone();
            bad.local.hidden.push(key.into());
            assert!(validate(&[], &[], &bad).is_err());
        }
        let mut bad = good.clone();
        bad.remote.widths.insert("size".into(), f64::NAN);
        assert!(validate(&[], &[], &bad).is_err());
        assert!(decode_saved(br#"{"secret":"refuse"}"#).is_none());
        let key = serde_json::json!(["p", "sftp", "example.invalid", 22, "me", "SHA256:fixture"])
            .to_string();
        assert!(pair(&key, "C:\\site", "/www").is_ok());
        assert!(pair(&key, "C:\\site\\..\\x", "/www").is_err());
        assert_ne!(
            pair(&key, "C:\\site", "/www").unwrap(),
            pair(
                &key.replace("example.invalid", "other.invalid"),
                "C:\\site",
                "/www"
            )
            .unwrap()
        );
    }
}
