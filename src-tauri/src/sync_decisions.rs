//! Bounded, job-local observations, never an input to sync authorization.
//! Only keyed anonymous IDs and numeric metadata leave this module. No paths,
//! file contents, endpoint names, arbitrary error strings, or persistent hashes.
use serde::{Serialize,Serializer};
use std::{collections::{BTreeMap,hash_map::RandomState},hash::{BuildHasher,Hash,Hasher},path::Path,sync::{Arc,Mutex}};
const MAX_EXAMPLES:usize=12;
#[derive(Clone,Copy)]
pub(crate) enum Reason { Size, Mtime, MissingAttributes, MissingRemote, Unchanged, SourceChanged, Watcher, ContentUnchanged, Dispatch, ListingUnavailable }
impl Reason {
    fn key(self)->&'static str { match self {
        Self::Size=>"size_mismatch",Self::Mtime=>"mtime_mismatch",Self::MissingAttributes=>"metadata_unavailable",
        Self::MissingRemote=>"remote_missing",Self::Unchanged=>"metadata_unchanged",Self::SourceChanged=>"source_changed_during_check",
        Self::Watcher=>"watcher_forced_candidate",Self::ContentUnchanged=>"uploaded_content_unchanged",Self::Dispatch=>"upload_dispatched",Self::ListingUnavailable=>"listing_fallback",
    }}
}
#[derive(Clone,Copy,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Metadata {
    pub local_size:Option<u64>,pub remote_size:Option<u64>,
    pub local_utc_seconds:Option<u32>,pub remote_utc_seconds:Option<u32>,
    pub remote_minus_local_seconds:Option<i64>,
}
impl Metadata {
    pub(crate) fn new(local_size:u64,local_time:Option<u32>,remote_size:Option<u64>,remote_time:Option<u32>)->Self {
        Self{local_size:Some(local_size),remote_size,local_utc_seconds:local_time,remote_utc_seconds:remote_time,
            remote_minus_local_seconds:remote_time.zip(local_time).map(|(r,l)|i64::from(r)-i64::from(l))}
    }
}
#[derive(Serialize)]
struct Example { id:String,reason:&'static str,#[serde(flatten)] metadata:Metadata }
#[derive(Serialize)]
struct Report {
    version:u8,precision:&'static str,
    // Counts are observations, not unique files or successful transfers.
    counts:BTreeMap<&'static str,u64>,examples:Vec<Example>,
    #[serde(skip)] salt:RandomState,
}
impl Default for Report {
    fn default()->Self{Self{version:1,precision:"UTC Unix seconds (SFTP v3), exact equality",counts:BTreeMap::new(),examples:Vec::new(),salt:RandomState::new()}}
}
#[derive(Clone,Default)]
pub(crate) struct Diagnostics(Arc<Mutex<Report>>);
impl Serialize for Diagnostics {
    fn serialize<S:Serializer>(&self,s:S)->Result<S::Ok,S::Error>{
        match self.0.lock(){Ok(report)=>report.serialize(s),Err(_)=>s.serialize_none()}
    }
}
impl Diagnostics {
    pub(crate) fn record(&self,path:&Path,reason:Reason,metadata:Metadata){
        // Diagnostics are best-effort and cannot turn a successful sync into a failure.
        let Ok(mut report)=self.0.lock()else{return;};let key=reason.key();
        let count=report.counts.entry(key).or_default();*count=count.saturating_add(1);
        // One example per reason, maximum 12. No per-file map grows with the tree.
        if report.examples.len()>=MAX_EXAMPLES||report.examples.iter().any(|e|e.reason==key){return;}
        let mut hash=report.salt.build_hasher();path.hash(&mut hash);
        let id=format!("f-{:016x}",hash.finish());report.examples.push(Example{id,reason:key,metadata});
    }
    pub(crate) fn compared(&self,path:&Path,metadata:Metadata){
        let mut mismatch=false;
        if metadata.local_size.is_none()||metadata.remote_size.is_none()||metadata.local_utc_seconds.is_none()||metadata.remote_utc_seconds.is_none(){
            self.record(path,Reason::MissingAttributes,metadata);mismatch=true;
        }
        if metadata.local_size.zip(metadata.remote_size).is_some_and(|(l,r)|l!=r){self.record(path,Reason::Size,metadata);mismatch=true;}
        if metadata.local_utc_seconds.zip(metadata.remote_utc_seconds).is_some_and(|(l,r)|l!=r){self.record(path,Reason::Mtime,metadata);mismatch=true;}
        if !mismatch{self.record(path,Reason::Unchanged,metadata);}
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn exact_reasons_precision_and_both_mismatches(){
        let d=Diagnostics::default();let p=Path::new("secret.txt");
        for m in [Metadata::new(4,Some(100),Some(4),Some(100)),Metadata::new(5,Some(100),Some(4),Some(100)),Metadata::new(4,Some(100),Some(4),Some(101)),Metadata::new(4,Some(100),None,None),Metadata::new(5,Some(100),Some(4),Some(99))]{d.compared(p,m);}
        let v=serde_json::to_value(d).unwrap();let c=&v["counts"];
        assert_eq!(c["metadata_unchanged"],1);assert_eq!(c["size_mismatch"],2);assert_eq!(c["mtime_mismatch"],2);assert_eq!(c["metadata_unavailable"],1);
        let e=v["examples"].as_array().unwrap().iter().find(|e|e["reason"]=="mtime_mismatch").unwrap();assert_eq!(e["remoteMinusLocalSeconds"],1);
    }
    #[test] fn bounded_redacted_and_new_job_unlinkable(){
        let d=Diagnostics::default();let path=Path::new("C:/private/credential-user@server/secret-key.txt");
        for _ in 0..4000 {for r in [Reason::MissingRemote,Reason::Watcher,Reason::SourceChanged,Reason::Dispatch,Reason::ContentUnchanged,Reason::ListingUnavailable]{d.record(path,r,Metadata::default());}}
        let text=serde_json::to_string(&d).unwrap();for secret in ["private","credential","server","secret-key","C:/"]{assert!(!text.contains(secret));}
        let v=serde_json::to_value(&d).unwrap();assert_eq!(v["counts"]["upload_dispatched"],4000);assert!(v["examples"].as_array().unwrap().len()<=MAX_EXAMPLES);assert!(text.len()<6000);
        let other=Diagnostics::default();other.record(path,Reason::MissingRemote,Metadata::default());let next=serde_json::to_value(other).unwrap();assert_ne!(v["examples"][0]["id"],next["examples"][0]["id"]);
        assert!(serde_json::to_value(Diagnostics::default()).unwrap()["counts"].as_object().unwrap().is_empty());
        let ids:Vec<_>=v["examples"].as_array().unwrap().iter().map(|e|e["id"].clone()).collect();assert!(ids.iter().all(|id|id==&ids[0]));
    }
}
