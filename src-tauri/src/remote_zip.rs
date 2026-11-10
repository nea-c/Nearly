//! Server-side ZIP requests. Shell commands never contain user paths or names.
use crate::{local_zip::{ArchiveOutcome, ZipAction}, zip_preflight::ArchiveError};
use serde::{Deserialize, Serialize};
use std::{net::ToSocketAddrs, sync::atomic::{AtomicBool, Ordering}};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub session_id: String,
    pub action: ZipAction,
    pub sources: Vec<String>,
    pub destination: String,
}
impl Request {
    pub fn validate(&self) -> Result<String, ArchiveError> {
        if self.id.is_empty() || self.id.len()>128 || self.session_id.is_empty() || self.session_id.len()>128 || self.sources.is_empty() || self.sources.len()>500 || (self.action==ZipAction::Extract && self.sources.len()!=1) {
            return Err(ArchiveError::new("invalid_request"));
        }
        fn parent(path:&str)->Result<&str,ArchiveError>{
            if path.len()>4096 || path.chars().any(char::is_control) || crate::sftp::normalize(path).ok().as_deref()!=Some(path) {
                return Err(ArchiveError::new("invalid_request"));
            }
            let (parent,leaf)=path.rsplit_once('/').ok_or_else(||ArchiveError::new("invalid_request"))?;
            if leaf.is_empty() || leaf=="." || leaf==".." || leaf.contains('\\') {return Err(ArchiveError::new("invalid_request"));}
            Ok(if parent.is_empty(){"/"}else{parent})
        }
        let directory=parent(&self.destination)?;
        let mut names=std::collections::HashSet::new();
        for source in &self.sources {
            if parent(source)?!=directory || source==&self.destination || !names.insert(source.to_lowercase()) {
                return Err(ArchiveError::new("invalid_request"));
            }
        }
        let archive=if self.action==ZipAction::Compress {&self.destination}else{&self.sources[0]};
        if !archive.to_lowercase().ends_with(".zip") {return Err(ArchiveError::new("invalid_request"));}
        Ok(directory.into())
    }
}

pub fn run(engine:&crate::engine::Engine, request:&Request, lease:&crate::sessions::Lease, stop:&AtomicBool)->Result<ArchiveOutcome,ArchiveError>{
    let parent=request.validate()?;
    if stop.load(Ordering::SeqCst){return Err(ArchiveError::new("cancelled"));}
    let profile=lease.profile();
    let endpoints=(profile.host.as_str(),profile.port).to_socket_addrs().map_err(|_|ArchiveError::new("remote_exec_unavailable"))?.collect();
    lease.with_archive(stop,|connection,identity|{
        // Reserve the entire parent: it contains the random owned stage as well
        // as every selected sibling. Identity comes only from the live lease.
        engine.reserve_operation(&request.id,vec![],vec![parent.clone()],identity,endpoints,false).map_err(|_|ArchiveError::new("sync_overlap"))?;
        let progress=engine.operation_progress(&request.id);
        connection.archive(request,&parent,stop,progress.as_deref())
    })
}

/// Bounded line decoder: SSH data frames need not align with JSON lines.
pub(crate) struct Decoder { pending:Vec<u8>, received:usize }
impl Decoder {
    pub fn new()->Self { Self{pending:vec![],received:0} }
    pub fn feed(&mut self,data:&[u8])->Result<Vec<serde_json::Value>,ArchiveError>{
        self.received=self.received.saturating_add(data.len());
        if self.received>1024*1024 {return Err(ArchiveError::new("remote_outcome_unknown"));}
        self.pending.extend_from_slice(data);
        let mut frames=vec![];
        while let Some(end)=self.pending.iter().position(|b|*b==b'\n') {
            if end>16*1024 {return Err(ArchiveError::new("remote_outcome_unknown"));}
            let line=self.pending.drain(..=end).collect::<Vec<_>>();
            let line=std::str::from_utf8(&line).map_err(|_|ArchiveError::new("remote_outcome_unknown"))?.trim_end_matches(['\r','\n']);
            if let Some(json)=line.strip_prefix("NEARLY_ZIP ") {
                frames.push(serde_json::from_str(json).map_err(|_|ArchiveError::new("remote_outcome_unknown"))?);
            }
        }
        if self.pending.len()>16*1024 {return Err(ArchiveError::new("remote_outcome_unknown"));}
        Ok(frames)
    }
}
pub(crate) fn namespace<'a>(frame:&'a serde_json::Value,parent:&str)->Result<(&'a str,&'a str,&'a str),ArchiveError>{
    let bad=||ArchiveError::new("remote_outcome_unknown");
    let stage=frame["stagePath"].as_str().ok_or_else(bad)?;
    let token=frame["token"].as_str().ok_or_else(bad)?;
    let path=frame["path"].as_str().ok_or_else(bad)?;
    let prefix=format!("{}/.nearly-zip-",parent.trim_end_matches('/'));
    let suffix=stage.strip_prefix(&prefix).ok_or_else(bad)?;
    if suffix.len()!=32 || !suffix.bytes().all(|b|b.is_ascii_hexdigit()) || token.len()<32 || token.len()>128 || !token.bytes().all(|b|b.is_ascii_hexdigit()) || path!=format!("{stage}/namespace") {return Err(bad());}
    Ok((stage,path,token))
}
pub(crate) fn counts(frame:&serde_json::Value)->Result<(usize,u64),ArchiveError>{
    let entries=frame["entries"].as_u64().filter(|n|*n<=10_000).ok_or_else(||ArchiveError::new("remote_outcome_unknown"))?;
    let bytes=frame["bytes"].as_u64().filter(|n|*n<=2*1024*1024*1024).ok_or_else(||ArchiveError::new("remote_outcome_unknown"))?;
    Ok((entries as usize,bytes))
}
pub(crate) fn remote_error(frame:&serde_json::Value,stage:Option<&str>)->ArchiveError {
    let code=frame["code"].as_str().unwrap_or("");
    let code=if matches!(code,"invalid_request"|"unsafe_entry"|"limit_exceeded"|"cancelled"|"io_error"|"collision"|"source_changed"|"integrity_error"|"publish_refused"|"unsupported_zip"|"remote_path_mismatch"){code}else{"remote_outcome_unknown"};
    ArchiveError{code:code.into(),stage_path:frame["stagePath"].as_str().filter(|p|Some(*p)==stage).map(str::to_owned),committed:frame["committed"].as_bool().unwrap_or(false)}
}

#[cfg(test)] mod tests {
    use super::*;use serde_json::json;
    fn request()->Request {serde_json::from_value(json!({"id":"test","sessionId":"session","action":"compress","sources":["/odd '$(x)&-日/a"],"destination":"/odd '$(x)&-日/out.zip"})).unwrap()}
    #[test]fn posix_output_leaf_is_not_a_windows_archive_member(){let mut r=request();r.destination="/odd '$(x)&-日/name:with-colon.zip".into();assert!(r.validate().is_ok());}
    #[test]fn siblings_are_data_and_paths_never_enter_commands(){assert_eq!(request().validate().unwrap(),"/odd '$(x)&-日");}
    #[test]fn refuse_traversal_cross_parent_duplicates_and_output_source(){let base=request();for paths in [vec!["/x/../a"],vec!["/else/a"],vec!["/odd '$(x)&-日/a","/odd '$(x)&-日/A"],vec!["/odd '$(x)&-日/out.zip"]]{let mut r=request();r.sources=paths.into_iter().map(str::to_owned).collect();assert!(r.validate().is_err());}let mut r=base;r.action=ZipAction::Extract;assert!(r.validate().is_err());}
    #[test]fn decoder_handles_split_lines_and_bounds_untrusted_output(){let mut d=Decoder::new();assert!(d.feed(b"banner\nNEARLY_ZIP {\"type\":").unwrap().is_empty());assert_eq!(d.feed(b"\"progress\",\"entries\":0,\"bytes\":9}\n").unwrap()[0]["bytes"],9);assert!(d.feed(&vec![b'x';16385]).is_err());}
    #[test]fn namespace_requires_owned_direct_child_and_ascii_nonce(){let stage=format!("/bench/.nearly-zip-{}","a".repeat(32));let frame=json!({"stagePath":stage,"path":format!("{stage}/namespace"),"token":"b".repeat(64)});assert!(namespace(&frame,"/bench").is_ok());assert!(namespace(&frame,"/else").is_err());let mut bad=frame.clone();bad["path"]=json!("/bench/target");assert!(namespace(&bad,"/bench").is_err());}
    #[test]fn control_frames_cannot_exceed_archive_limits_or_inject_error_paths(){assert!(counts(&json!({"entries":10001,"bytes":1})).is_err());assert!(counts(&json!({"entries":1,"bytes":2147483649u64})).is_err());let error=remote_error(&json!({"code":"invented","stagePath":"/outside"}),Some("/owned"));assert_eq!(error.code,"remote_outcome_unknown");assert!(error.stage_path.is_none());}
}
