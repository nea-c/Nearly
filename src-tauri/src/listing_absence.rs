//! Read-only candidate evidence. Never a deletion stamp or mutation permit.
use std::{collections::HashMap,path::{Path,PathBuf,Component}};
#[derive(Default)]
pub(crate) struct ListingCoverage { directories:HashMap<PathBuf,Option<HashMap<String,PathBuf>>> }
pub(crate) struct ListedAbsence { session:u64 }
const MAX_CANDIDATE_BYTES:usize=16*1024*1024;
pub(crate) fn reserve_candidate(used:&mut usize,path_units:usize)->bool {
    let Some(next)=path_units.checked_mul(2).and_then(|n|n.checked_add(128)).and_then(|n|used.checked_add(n)) else{return false;};
    if next>MAX_CANDIDATE_BYTES {return false;}*used=next;true
}
impl ListedAbsence { pub(crate) fn matches(&self,session:u64)->bool {self.session==session} }
pub(crate) fn invalidate_path(candidates:&mut HashMap<PathBuf,ListedAbsence>,path:&Path,directory:bool,structural:bool) {
    if path.as_os_str().is_empty() {if structural {candidates.clear();}}
    else if directory {if structural {candidates.retain(|p,_|!p.starts_with(path));}}
    else {candidates.remove(path);}
}
impl ListingCoverage {
    pub(crate) fn record_complete_directory(&mut self,path:PathBuf,entries:HashMap<String,PathBuf>,opaque:bool) {
        self.directories.insert(path,if opaque {None}else{Some(entries)});
    }
    pub(crate) fn append(&mut self,other:Self) {self.directories.extend(other.directories);}
    pub(crate) fn candidate(&self,path:&Path,session:u64)->Option<ListedAbsence> {
        if path.as_os_str().is_empty() || path.components().any(|c|!matches!(c,Component::Normal(_))) {return None;}
        let mut parent=PathBuf::new();
        for component in path.components() {
            let entries=self.directories.get(&parent)?.as_ref()?;
            let name=component.as_os_str().to_str()?.to_lowercase();
            match entries.get(&name) {
                Some(actual)=>parent=actual.clone(),
                None=>return Some(ListedAbsence{session}),
            }
        }
        None
    }
}
#[cfg(test)] mod tests {
    use super::*;
    fn entries(names:&[&str],parent:&str)->HashMap<String,PathBuf>{names.iter().map(|n|(n.to_lowercase(),Path::new(parent).join(n))).collect()}
    #[test] fn candidate_budget_falls_back_without_mutating_existing_usage() {
        let mut used=MAX_CANDIDATE_BYTES-130;assert!(reserve_candidate(&mut used,1));assert_eq!(used,MAX_CANDIDATE_BYTES);
        assert!(!reserve_candidate(&mut used,0));assert_eq!(used,MAX_CANDIDATE_BYTES);
        let mut empty=0;assert!(!reserve_candidate(&mut empty,MAX_CANDIDATE_BYTES));assert_eq!(empty,0);
        assert!(!reserve_candidate(&mut empty,usize::MAX));assert_eq!(empty,0);
        assert!(reserve_candidate(&mut empty,4));assert_eq!(empty,136);
    }
    #[test] fn complete_absence_covers_missing_subtrees_but_never_present_entries() {
        let mut c=ListingCoverage::default();c.record_complete_directory(PathBuf::new(),entries(&["Known","excluded","file.txt"],""),false);
        c.record_complete_directory("Known".into(),entries(&["a.txt"],"Known"),false);
        assert!(c.candidate(Path::new("new/deep/file.txt"),1).unwrap().matches(1));
        assert!(c.candidate(Path::new("known/new.txt"),1).is_some());
        assert!(c.candidate(Path::new("KNOWN/a.txt"),1).is_none());
        for p in ["file.txt","file.txt/child","excluded/child","../outside","/absolute",""] {assert!(c.candidate(Path::new(p),1).is_none(),"{p}");}
        assert!(!c.candidate(Path::new("new.txt"),1).unwrap().matches(2));
    }
    #[test] fn unlisted_and_opaque_directories_cannot_prove_absence() {
        let mut c=ListingCoverage::default();assert!(c.candidate(Path::new("a.txt"),1).is_none());
        c.record_complete_directory(PathBuf::new(),HashMap::new(),true);assert!(c.candidate(Path::new("a.txt"),1).is_none());
    }
    #[test] fn directory_metadata_does_not_discard_candidates_but_real_structure_and_file_events_do() {
        let mut coverage=ListingCoverage::default();coverage.record_complete_directory(PathBuf::new(),HashMap::new(),false);
        let mut candidates=HashMap::new();for p in ["parent/a.txt","peer.txt"] {candidates.insert(PathBuf::from(p),coverage.candidate(Path::new(p),1).unwrap());}
        invalidate_path(&mut candidates,Path::new("parent"),true,false);assert_eq!(candidates.len(),2);
        invalidate_path(&mut candidates,Path::new("parent"),true,true);assert!(!candidates.contains_key(Path::new("parent/a.txt")));assert_eq!(candidates.len(),1);
        invalidate_path(&mut candidates,Path::new("peer.txt"),false,false);assert!(candidates.is_empty());
        candidates.insert("a.txt".into(),coverage.candidate(Path::new("a.txt"),1).unwrap());
        invalidate_path(&mut candidates,Path::new(""),true,false);assert_eq!(candidates.len(),1);
        invalidate_path(&mut candidates,Path::new(""),true,true);assert!(candidates.is_empty());
    }
}
