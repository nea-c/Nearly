use crate::explorer_preferences::{clean_text, identity, pair, trim_client};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
const LOCAL_SCOPE: &str = r#"["side","sftp","example.invalid",22,"u",""]"#;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tree { pub version: u32, pub nodes: Vec<serde_json::Value> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct History {
    pub path: String,
    pub opened_at: u64,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub connection_key: Option<String>,
}
pub fn flat(local:&[LocalBookmark],remote:&[RemoteBookmark],remote_side:bool)->Tree {
    let nodes=if remote_side {remote.iter().map(|b|serde_json::json!({"id":b.id,"kind":"bookmark","bookmarkId":b.id,"parentId":null,"connectionKey":b.connection_key})).collect()}
    else {local.iter().map(|b|serde_json::json!({"id":b.id,"kind":"bookmark","bookmarkId":b.id,"parentId":null})).collect()};
    Tree{version:1,nodes}
}
pub fn validate_tree(tree:&Tree,local:&[LocalBookmark],remote:&[RemoteBookmark],remote_side:bool)->Result<(),String>{
    complete_tree(tree,local,remote,remote_side).map(|_|())
}
pub fn complete_tree(tree:&Tree,local:&[LocalBookmark],remote:&[RemoteBookmark],remote_side:bool)->Result<Tree,String>{
    if tree.nodes.len()>700{return Err("Invalid side bookmark tree".into());}
    let mut nodes=tree.nodes.clone();
    for node in &mut nodes {
        let object=node.as_object_mut().ok_or("Invalid side bookmark node")?;
        if !remote_side {
            if object.contains_key("connectionKey"){return Err("Invalid local bookmark scope".into());}
            object.insert("connectionKey".into(),LOCAL_SCOPE.into());
        }
    }
    let adapter:crate::bookmark_tree::Tree=serde_json::from_value(serde_json::json!({"version":tree.version,"nodes":nodes})).map_err(|_|"Invalid side bookmark tree")?;
    let bookmarks:Vec<crate::explorer_preferences::FolderBookmark>=if remote_side {
        remote.iter().map(|b|crate::explorer_preferences::FolderBookmark{id:b.id.clone(),name:b.name.clone(),local:"C:\\".into(),remote:b.path.clone(),connection_key:b.connection_key.clone()}).collect()
    }else{local.iter().map(|b|crate::explorer_preferences::FolderBookmark{id:b.id.clone(),name:b.name.clone(),local:b.path.clone(),remote:"/".into(),connection_key:LOCAL_SCOPE.into()}).collect()};
    let clean=crate::bookmark_tree::validate(&adapter,&bookmarks,true)?;
    let mut value=serde_json::to_value(clean).map_err(|_|"Invalid side bookmark tree")?;
    if !remote_side {for node in value["nodes"].as_array_mut().unwrap(){node.as_object_mut().unwrap().remove("connectionKey");}}
    serde_json::from_value(value).map_err(|_|"Invalid side bookmark tree".into())
}
pub fn validate_history(records:&[History],remote_side:bool)->Result<(),String>{
    if records.len()>200{return Err("Invalid side folder history".into());}
    let mut paths=HashSet::new();
    for record in records {
        if record.opened_at>9_007_199_254_740_991||remote_side!=record.connection_key.is_some(){return Err("Invalid side folder history".into());}
        let key=record.connection_key.as_deref().unwrap_or(LOCAL_SCOPE);
        let normalized=if remote_side{pair(key,"C:\\",&record.path)?}else{pair(key,&record.path,"/")?};
        if !paths.insert(normalized){return Err("Duplicate side folder history".into());}
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalBookmark {
    pub id: String,
    pub name: String,
    pub path: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteBookmark {
    pub id: String,
    pub name: String,
    pub path: String,
    pub connection_key: String,
}
pub fn validate(local: &[LocalBookmark], remote: &[RemoteBookmark]) -> Result<(), String> {
    if local.len() > 500 || remote.len() > 500 {
        return Err("Invalid side bookmark collection".into());
    }
    let dummy = r#"["side","sftp","example.invalid",22,"u",""]"#;
    for remote_side in [false, true] {
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        let mut names = HashSet::new();
        let records: Vec<(&str, &str, &str, &str)> = if remote_side {
            remote
                .iter()
                .map(|b| {
                    (
                        b.id.as_str(),
                        b.name.as_str(),
                        b.path.as_str(),
                        b.connection_key.as_str(),
                    )
                })
                .collect()
        } else {
            local
                .iter()
                .map(|b| (b.id.as_str(), b.name.as_str(), b.path.as_str(), dummy))
                .collect()
        };
        for (id, name, path, key) in records {
            if !clean_text(id, 128) || !clean_text(name, 100) || !ids.insert(id) {
                return Err("Invalid side bookmark".into());
            }
            identity(key)?;
            let normalized = if remote_side {
                pair(key, "C:\\", path)?
            } else {
                pair(dummy, path, "/")?
            };
            let scope: serde_json::Value =
                serde_json::from_str(key).map_err(|_| "Invalid side bookmark")?;
            if !paths.insert(normalized)
                || !names.insert((scope.to_string(), trim_client(name).to_owned()))
            {
                return Err("Duplicate side bookmark name or path".into());
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn side_bookmark_unicode_limits_match_frontend_utf16_units() {
        let mut record = LocalBookmark {
            id: "emoji".into(),
            name: "😀".repeat(50),
            path: format!("C:\\{}", "😀".repeat(2046)),
        };
        assert!(validate(&[record.clone()], &[]).is_ok());
        record.name = "😀".repeat(51);
        assert!(validate(&[record.clone()], &[]).is_err());
        record.name = "日".repeat(100);
        record.path = format!("D:\\{}", "日".repeat(4093));
        assert!(validate(&[record.clone()], &[]).is_ok());
        record.path.push('日');
        assert!(validate(&[record.clone()], &[]).is_err());
        record.path = format!("C:\\{}", "😀".repeat(2047));
        assert!(validate(&[record], &[]).is_err());
    }
}
