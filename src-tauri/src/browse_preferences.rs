use crate::explorer_preferences::{self, SortSpec};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
fn optional_path<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_path"
    )]
    pub local: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_path"
    )]
    pub remote: Option<String>,
}
pub type Locations = BTreeMap<String, Location>;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaneSorts {
    #[serde(default)]
    pub local: SortSpec,
    #[serde(default)]
    pub remote: SortSpec,
}
#[cfg(test)]
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    #[serde(default)]
    pub browse_locations: Locations,
    #[serde(default)]
    pub pane_sorts: PaneSorts,
}
fn location(key: &str, value: &Location) -> Result<(), String> {
    explorer_preferences::identity(key)?;
    let canonical: serde_json::Value =
        serde_json::from_str(key).map_err(|_| "Invalid browse connection key")?;
    if canonical.to_string() != key {
        return Err("Browse connection identity must be canonical".into());
    }
    if value.local.is_none() && value.remote.is_none() {
        return Err("A successful browse path is required".into());
    }
    explorer_preferences::pair(
        key,
        value.local.as_deref().unwrap_or("C:\\"),
        value.remote.as_deref().unwrap_or("/"),
    )?;
    Ok(())
}
pub fn validate(locations: &Locations, sorts: &PaneSorts) -> Result<(), String> {
    if locations.len() > 500 {
        return Err("Browse locations exceed 500 connection identities".into());
    }
    for (key, value) in locations {
        location(key, value)?;
    }
    let mut columns = explorer_preferences::PaneColumns::default();
    columns.local.sort = sorts.local.clone();
    columns.remote.sort = sorts.remote.clone();
    explorer_preferences::validate(&[], &[], &columns)
}
#[cfg(test)]
pub fn decode_saved(bytes: &[u8]) -> (Preferences, bool) {
    if bytes.len() > 2_000_000 {
        return (Preferences::default(), true);
    }
    let Ok(serde_json::Value::Object(raw)) = serde_json::from_slice(bytes) else {
        return (Preferences::default(), true);
    };
    if raw
        .keys()
        .any(|k| k != "browseLocations" && k != "paneSorts")
    {
        return (Preferences::default(), true);
    }
    let mut result = Preferences::default();
    let mut repaired = false;
    if let Some(value) = raw.get("browseLocations") {
        match value.as_object() {
            Some(items) if items.len() <= 500 => {
                for (key, value) in items {
                    match serde_json::from_value::<Location>(value.clone()) {
                        Ok(value) if location(key, &value).is_ok() => {
                            result.browse_locations.insert(key.clone(), value);
                        }
                        _ => repaired = true,
                    }
                }
            }
            _ => repaired = true,
        }
    }
    if let Some(value) = raw.get("paneSorts") {
        if let Some(items) = value
            .as_object()
            .filter(|o| o.keys().all(|k| k == "local" || k == "remote"))
        {
            for side in ["local", "remote"] {
                if let Some(value) = items.get(side) {
                    match serde_json::from_value::<SortSpec>(value.clone()) {
                        Ok(sort) => {
                            let mut candidate = result.pane_sorts.clone();
                            if side == "local" {
                                candidate.local = sort;
                            } else {
                                candidate.remote = sort;
                            }
                            if validate(&Locations::new(), &candidate).is_ok() {
                                result.pane_sorts = candidate;
                            } else {
                                repaired = true;
                            }
                        }
                        Err(_) => repaired = true,
                    }
                }
            }
        } else {
            repaired = true;
        }
    }
    (result, repaired)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn key(host: &str) -> String {
        serde_json::json!(["p", "sftp", host, 22, "me", ""]).to_string()
    }
    #[test]
    fn browse_scope_paths_and_sort_defaults_are_strict() {
        let mut locations = Locations::new();
        locations.insert(
            key("a.invalid"),
            Location {
                local: Some("D:\\".into()),
                remote: Some("/www".into()),
            },
        );
        assert!(validate(&locations, &PaneSorts::default()).is_ok());
        assert!(!locations.contains_key(&key("other.invalid")));
        locations.get_mut(&key("a.invalid")).unwrap().local = Some("D:".into());
        assert!(validate(&locations, &PaneSorts::default()).is_err());
        let mut sort = PaneSorts::default();
        sort.remote.column = "owner".into();
        sort.remote.direction = "descending".into();
        assert!(validate(&Locations::new(), &sort).is_ok());
        sort.local.column = "owner".into();
        assert!(validate(&Locations::new(), &sort).is_err());
    }
    #[test]
    fn saved_invalid_path_recovers_only_that_identity_and_preserves_valid_sort() {
        let good = key("good.invalid");
        let bad = key("bad.invalid");
        let raw = serde_json::json!({"browseLocations":{(good.clone()):{"local":"C:\\ok","remote":"/ok"},(bad):{"local":null}},"paneSorts":{"local":{"column":"size","direction":"descending"},"remote":{"column":"unknown","direction":"ascending"}}});
        let (loaded, repaired) = decode_saved(&serde_json::to_vec(&raw).unwrap());
        assert!(repaired);
        assert_eq!(loaded.browse_locations.len(), 1);
        assert_eq!(
            loaded.browse_locations[&good].remote.as_deref(),
            Some("/ok")
        );
        assert_eq!(loaded.pane_sorts.local.column, "size");
        assert_eq!(loaded.pane_sorts.remote.column, "name");
    }
}
