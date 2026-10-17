use crate::explorer_preferences::{self, FolderBookmark};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Node {
    Group {
        id: String,
        name: String,
        #[serde(rename = "connectionKey")]
        connection_key: String,
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
    },
    Bookmark {
        id: String,
        #[serde(rename = "bookmarkId")]
        bookmark_id: String,
        #[serde(rename = "connectionKey")]
        connection_key: String,
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
    },
}
impl Node {
    fn id(&self) -> &str {
        match self {
            Self::Group { id, .. } | Self::Bookmark { id, .. } => id,
        }
    }
    fn key(&self) -> &str {
        match self {
            Self::Group { connection_key, .. } | Self::Bookmark { connection_key, .. } => {
                connection_key
            }
        }
    }
    fn parent(&self) -> Option<&str> {
        match self {
            Self::Group { parent_id, .. } | Self::Bookmark { parent_id, .. } => {
                parent_id.as_deref()
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tree {
    pub version: u32,
    pub nodes: Vec<Node>,
}
pub fn flat(bookmarks: &[FolderBookmark]) -> Tree {
    Tree {
        version: 1,
        nodes: bookmarks
            .iter()
            .map(|b| Node::Bookmark {
                id: b.id.clone(),
                bookmark_id: b.id.clone(),
                connection_key: b.connection_key.clone(),
                parent_id: None,
            })
            .collect(),
    }
}
fn text(s: &str, max: usize) -> bool {
    !s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .is_empty()
        && s.encode_utf16().count() <= max
        && !s
            .chars()
            .any(|c| matches!(c,'\u{0000}'..='\u{001f}'|'\u{007f}'..='\u{009f}'))
}
fn key(s: &str) -> Result<String, String> {
    explorer_preferences::identity(s)?;
    let value: serde_json::Value =
        serde_json::from_str(s).map_err(|_| "Invalid bookmark connection identity")?;
    Ok(value.to_string())
}
pub fn validate(
    tree: &Tree,
    bookmarks: &[FolderBookmark],
    allow_missing: bool,
) -> Result<Tree, String> {
    if tree.version != 1 || tree.nodes.len() > 700 || bookmarks.len() > 500 {
        return Err("Bookmark tree version/count invalid".into());
    }
    let mut saved = HashMap::new();
    for b in bookmarks {
        if !text(&b.id, 128)
            || saved
                .insert(b.id.as_str(), key(&b.connection_key)?)
                .is_some()
        {
            return Err("Invalid/duplicate bookmarks".into());
        }
    }
    let mut ids = HashMap::new();
    let mut keys = HashMap::new();
    let mut refs = HashSet::new();
    let mut groups = 0;
    for n in &tree.nodes {
        if !text(n.id(), 128)
            || ids.insert(n.id(), n).is_some()
            || n.parent().is_some_and(|p| !text(p, 128))
        {
            return Err("Invalid/duplicate bookmark node ID".into());
        }
        let scope = key(n.key())?;
        keys.insert(n.id(), scope.clone());
        match n {
            Node::Group { id, name, .. } => {
                groups += 1;
                if groups > 200 || saved.contains_key(id.as_str()) || !text(name, 100) {
                    return Err("Invalid bookmark group".into());
                }
            }
            Node::Bookmark {
                id, bookmark_id, ..
            } => {
                if id != bookmark_id
                    || saved.get(id.as_str()) != Some(&scope)
                    || !refs.insert(id.as_str())
                {
                    return Err("Invalid bookmark reference/connection scope".into());
                }
            }
        }
    }
    for n in &tree.nodes {
        let mut at = n;
        let mut seen = HashSet::new();
        let mut depth = 0;
        loop {
            depth += 1;
            if depth > 8 || !seen.insert(at.id()) {
                return Err("Bookmark tree cycle or depth exceeds 8".into());
            }
            let Some(parent) = at.parent() else {
                break;
            };
            match ids.get(parent) {
                Some(group @ Node::Group { .. }) if keys.get(group.id()) == keys.get(at.id()) => {
                    at = group
                }
                _ => return Err("Bookmark parent must be a group on the same connection".into()),
            }
        }
    }
    let mut result = tree.clone();
    if refs.len() != bookmarks.len() {
        if !allow_missing {
            return Err("Bookmark missing from tree".into());
        }
        for b in bookmarks {
            if !refs.contains(b.id.as_str()) {
                result.nodes.push(Node::Bookmark {
                    id: b.id.clone(),
                    bookmark_id: b.id.clone(),
                    connection_key: b.connection_key.clone(),
                    parent_id: None,
                });
            }
        }
    }
    if result.nodes.len() > 700 {
        return Err("Bookmark tree exceeds 700 nodes".into());
    }
    Ok(result)
}
#[cfg(test)]
pub fn decode(bytes: &[u8], bookmarks: &[FolderBookmark]) -> Option<Tree> {
    if bytes.len() > 2_000_000 {
        return None;
    }
    let tree: Tree = serde_json::from_slice(bytes).ok()?;
    validate(&tree, bookmarks, true).ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn b(id: &str, host: &str) -> FolderBookmark {
        FolderBookmark {
            id: id.into(),
            name: id.into(),
            connection_key: serde_json::json!(["p", "sftp", host, 22, "me", ""]).to_string(),
            local: "C:\\site".into(),
            remote: "/www".into(),
        }
    }
    #[test]
    fn scoped_missing_leaf_repair_preserves_bookmarks_and_rejects_cross_endpoint_moves() {
        let bookmarks = vec![b("a", "a.invalid"), b("b", "b.invalid")];
        let mut tree = Tree {
            version: 1,
            nodes: vec![
                Node::Group {
                    id: "g".into(),
                    name: "Group".into(),
                    connection_key: bookmarks[0].connection_key.clone(),
                    parent_id: None,
                },
                Node::Bookmark {
                    id: "a".into(),
                    bookmark_id: "a".into(),
                    connection_key: bookmarks[0].connection_key.clone(),
                    parent_id: Some("g".into()),
                },
            ],
        };
        assert!(validate(&tree, &bookmarks, false).is_err());
        let fixed = validate(&tree, &bookmarks, true).unwrap();
        assert_eq!(fixed.nodes.len(), 3);
        assert_eq!(fixed.nodes[2].id(), "b");
        if let Node::Bookmark { connection_key, .. } = &mut tree.nodes[1] {
            *connection_key = bookmarks[1].connection_key.clone();
        }
        assert!(validate(&tree, &bookmarks, true).is_err());
    }
    #[test]
    fn malformed_duplicate_cycles_unicode_and_depth_fail_closed() {
        let bookmarks = vec![b("a", "a.invalid")];
        let mut tree = flat(&bookmarks);
        tree.nodes.push(tree.nodes[0].clone());
        assert!(validate(&tree, &bookmarks, false).is_err());
        assert!(decode(br#"{"version":1,"nodes":[],"secret":"no"}"#, &bookmarks).is_none());
        let key = bookmarks[0].connection_key.clone();
        let cyclic = Tree {
            version: 1,
            nodes: vec![Node::Group {
                id: "g".into(),
                name: "G".into(),
                connection_key: key.clone(),
                parent_id: Some("g".into()),
            }],
        };
        assert!(validate(&cyclic, &bookmarks, true).is_err());
        let mut deep = Tree {
            version: 1,
            nodes: vec![],
        };
        let mut parent = None;
        for i in 0..9 {
            let id = format!("g{i}");
            deep.nodes.push(Node::Group {
                id: id.clone(),
                name: "G".into(),
                connection_key: key.clone(),
                parent_id: parent,
            });
            parent = Some(id);
        }
        assert!(validate(&deep, &[], false).is_err());
        let unicode = Tree {
            version: 1,
            nodes: vec![Node::Group {
                id: "g".into(),
                name: "😀".repeat(51),
                connection_key: key,
                parent_id: None,
            }],
        };
        assert!(validate(&unicode, &[], false).is_err());
    }
}
