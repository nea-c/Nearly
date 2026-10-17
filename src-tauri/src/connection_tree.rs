use crate::sftp::Profile;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Node {
    Group {
        id: String,
        name: String,
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
        expanded: bool,
    },
    Profile {
        id: String,
        #[serde(rename = "profileId")]
        profile_id: String,
        #[serde(rename = "parentId")]
        parent_id: Option<String>,
    },
}
impl Node {
    fn id(&self) -> &str {
        match self {
            Self::Group { id, .. } | Self::Profile { id, .. } => id,
        }
    }
    fn parent(&self) -> Option<&str> {
        match self {
            Self::Group { parent_id, .. } | Self::Profile { parent_id, .. } => parent_id.as_deref(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tree {
    pub version: u32,
    pub nodes: Vec<Node>,
}
pub fn flat(profiles: &[Profile]) -> Tree {
    Tree {
        version: 1,
        nodes: profiles
            .iter()
            .map(|p| Node::Profile {
                id: p.id.clone(),
                profile_id: p.id.clone(),
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
pub fn validate(tree: &Tree, profiles: &[Profile], allow_missing: bool) -> Result<Tree, String> {
    if tree.version != 1 || tree.nodes.len() > 400 || profiles.len() > 200 {
        return Err("Connection tree version/count invalid".into());
    }
    let mut profile_ids = HashSet::new();
    for p in profiles {
        if !text(&p.id, 128) || !profile_ids.insert(p.id.as_str()) {
            return Err("Invalid/duplicate profile ID in connection tree".into());
        }
    }
    let mut ids = HashMap::new();
    let mut refs = HashSet::new();
    let mut groups = 0;
    for n in &tree.nodes {
        if !text(n.id(), 128)
            || ids.insert(n.id(), n).is_some()
            || n.parent().is_some_and(|p| !text(p, 128))
        {
            return Err("Invalid/duplicate connection node ID".into());
        }
        match n {
            Node::Group { id, name, .. } => {
                groups += 1;
                if groups > 200 || profile_ids.contains(id.as_str()) || !text(name, 100) {
                    return Err("Invalid connection group".into());
                }
            }
            Node::Profile { id, profile_id, .. } => {
                if id != profile_id
                    || !profile_ids.contains(profile_id.as_str())
                    || !refs.insert(profile_id.as_str())
                {
                    return Err("Invalid/duplicate connection profile reference".into());
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
                return Err("Connection tree cycle or depth exceeds 8".into());
            }
            let Some(parent) = at.parent() else {
                break;
            };
            match ids.get(parent) {
                Some(group @ Node::Group { .. }) => at = group,
                _ => return Err("Connection parent must reference a group".into()),
            }
        }
    }
    let mut result = tree.clone();
    if refs.len() != profile_ids.len() {
        if !allow_missing {
            return Err("Connection profile missing from tree".into());
        }
        for p in profiles {
            if !refs.contains(p.id.as_str()) {
                result.nodes.push(Node::Profile {
                    id: p.id.clone(),
                    profile_id: p.id.clone(),
                    parent_id: None,
                });
            }
        }
    }
    if result.nodes.len() > 400 {
        return Err("Connection tree exceeds 400 nodes".into());
    }
    Ok(result)
}
#[cfg(test)]
pub fn decode(bytes: &[u8], profiles: &[Profile]) -> Option<Tree> {
    if bytes.len() > 524288 {
        return None;
    }
    let tree: Tree = serde_json::from_slice(bytes).ok()?;
    validate(&tree, profiles, true).ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn p(id: &str) -> Profile {
        serde_json::from_value(serde_json::json!({"id":id,"name":id,"host":"example.invalid","port":22,"user":"me","auth":"key","mode":"sftp","keyFile":"fixture.ppk","hostKey":"fixture"})).unwrap()
    }
    #[test]
    fn migration_and_append_preserve_every_profile_and_existing_hierarchy() {
        let profiles = vec![p("a"), p("b")];
        let flat = flat(&profiles);
        assert_eq!(flat.nodes[0].id(), "a");
        assert!(validate(&flat, &profiles, false).is_ok());
        let tree = Tree {
            version: 1,
            nodes: vec![
                Node::Group {
                    id: "g".into(),
                    name: "G".into(),
                    parent_id: None,
                    expanded: false,
                },
                Node::Profile {
                    id: "a".into(),
                    profile_id: "a".into(),
                    parent_id: Some("g".into()),
                },
            ],
        };
        assert!(validate(&tree, &profiles, false).is_err());
        let repaired = validate(&tree, &profiles, true).unwrap();
        assert_eq!(repaired.nodes[1].parent(), Some("g"));
        assert_eq!(repaired.nodes[2].id(), "b");
        assert!(repaired.nodes[2].parent().is_none());
    }
    #[test]
    fn invalid_tree_shapes_cycles_refs_and_unicode_bounds_are_refused() {
        let profiles = vec![p("a")];
        for nodes in [
            serde_json::json!([{"kind":"group","id":"g","name":"G","parentId":"g","expanded":true}]),
            serde_json::json!([{"kind":"profile","id":"x","profileId":"unknown","parentId":null}]),
            serde_json::json!([{"kind":"profile","id":"a","profileId":"a","parentId":null},{"kind":"profile","id":"a","profileId":"a","parentId":null}]),
            serde_json::json!([{"kind":"group","id":"g","name":"😀".repeat(51),"parentId":null,"expanded":true}]),
            serde_json::json!([{"kind":"group","id":"g","name":"bad\u{0085}","parentId":null,"expanded":true}]),
        ] {
            assert!(decode(
                &serde_json::to_vec(&serde_json::json!({"version":1,"nodes":nodes})).unwrap(),
                &profiles
            )
            .is_none());
        }
        assert!(decode(br#"{"version":1,"nodes":[],"secret":"refused"}"#, &profiles).is_none());
    }
    #[test]
    fn depth_and_group_counts_are_bounded_before_recursive_work() {
        let mut tree = Tree {
            version: 1,
            nodes: vec![],
        };
        let mut parent = None;
        for i in 0..8 {
            let id = format!("g{i}");
            tree.nodes.push(Node::Group {
                id: id.clone(),
                name: "G".into(),
                parent_id: parent,
                expanded: true,
            });
            parent = Some(id);
        }
        assert!(validate(&tree, &[], false).is_ok());
        tree.nodes.push(Node::Group {
            id: "too-deep".into(),
            name: "G".into(),
            parent_id: parent,
            expanded: true,
        });
        assert!(validate(&tree, &[], false).is_err());
        let over = Tree {
            version: 1,
            nodes: (0..201)
                .map(|i| Node::Group {
                    id: format!("g{i}"),
                    name: "G".into(),
                    parent_id: None,
                    expanded: true,
                })
                .collect(),
        };
        assert!(validate(&over, &[], false).is_err());
    }
}
