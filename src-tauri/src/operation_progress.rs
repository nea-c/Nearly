//! Bounded, operation-owned snapshots. Renderer polls; workers never emit per-packet IPC.
use serde::Serialize;
use std::sync::Mutex;
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot {
    pub phase: &'static str,
    pub unit: &'static str,
    pub done: u64,
    pub total: Option<u64>,
    pub entries: usize,
    pub item: usize,
    pub item_count: usize,
}
/// Largest integer exactly represented by the renderer's JavaScript number type.
pub const MAX_EXACT_BYTE_TOTAL:u64=9_007_199_254_740_991;
pub const BYTE_TOTAL_LIMIT_ERROR:&str="Transfer total exceeds 9,007,199,254,740,991 bytes; smaller batches are required";
/// Validate the entire inventory before any destination mutation or virtual descriptor publication.
/// Directories are excluded by callers; empty inventories and zero-byte regular files are valid.
pub fn checked_byte_total(sizes:impl IntoIterator<Item=Option<u64>>)->Result<u64,String>{
    let total=sizes.into_iter().try_fold(0u64,|total,size| {
        total.checked_add(size.ok_or("Source size/timestamp unavailable")?)
            .ok_or_else(||BYTE_TOTAL_LIMIT_ERROR.to_owned())
    })?;
    if total>MAX_EXACT_BYTE_TOTAL {return Err(BYTE_TOTAL_LIMIT_ERROR.into());}
    Ok(total)
}
pub struct Progress(Mutex<Snapshot>);
impl Default for Progress {
    fn default()->Self { Self(Mutex::new(Snapshot{phase:"connecting",unit:"bytes",done:0,total:None,entries:0,item:1,item_count:1})) }
}
impl Progress {
    pub fn snapshot(&self)->Snapshot {self.0.lock().unwrap_or_else(|e|e.into_inner()).clone()}
    pub fn item(&self,item:usize,count:usize){let mut s=self.0.lock().unwrap_or_else(|e|e.into_inner());s.item=item;s.item_count=count;s.phase="scanning";s.done=0;s.total=None;s.entries=0;}
    pub fn phase(&self,phase:&'static str){self.0.lock().unwrap_or_else(|e|e.into_inner()).phase=phase;}
    pub fn plan(&self,unit:&'static str,total:u64){let mut s=self.0.lock().unwrap_or_else(|e|e.into_inner());s.unit=unit;s.total=Some(total);s.done=0;s.entries=0;s.phase=if unit=="entries"{"deleting"}else{"copying"};}
    /// Transfer batches retain their byte counter while the current entry changes.
    pub fn position(&self,item:usize,count:usize){let mut s=self.0.lock().unwrap_or_else(|e|e.into_inner());s.item=item;s.item_count=count;}
    pub fn skip_bytes(&self,bytes:u64){let mut s=self.0.lock().unwrap_or_else(|e|e.into_inner());s.total=s.total.map(|total|total.saturating_sub(bytes).max(s.done));}
    pub fn bytes(&self,bytes:u64){let mut s=self.0.lock().unwrap_or_else(|e|e.into_inner());s.done=s.done.saturating_add(bytes);}
    pub fn committed(&self){let mut s=self.0.lock().unwrap_or_else(|e|e.into_inner());s.entries+=1;if s.unit=="entries"{s.done+=1;}}
}
#[cfg(test)] mod tests {
 use super::*;
 #[test]fn byte_total_rejects_missing_file_sizes(){assert!(checked_byte_total([Some(123),None]).is_err());}
 #[test]fn byte_total_rejects_u64_overflow(){assert!(checked_byte_total([Some(u64::MAX),Some(1)]).is_err());}
 #[test]fn byte_total_rejects_imprecise_javascript_numbers(){assert!(checked_byte_total([Some(9_007_199_254_740_991),Some(1)]).is_err());}
 #[test]fn byte_total_preserves_empty_zero_and_exact_boundary(){assert_eq!(checked_byte_total([]).unwrap(),0);assert_eq!(checked_byte_total([Some(0),Some(0)]).unwrap(),0);assert_eq!(checked_byte_total([Some(100_000),Some(70_000)]).unwrap(),170_000);assert_eq!(checked_byte_total([Some(9_007_199_254_740_990),Some(1)]).unwrap(),9_007_199_254_740_991);}
 #[test]fn acknowledged_bytes_and_committed_entries_are_separate(){let p=Progress::default();assert!(p.snapshot().total.is_none());p.item(2,3);p.plan("bytes",100);p.bytes(64);let s=p.snapshot();assert_eq!((s.done,s.entries,s.item,s.item_count),(64,0,2,3));p.phase("finalizing");assert_eq!(p.snapshot().phase,"finalizing");p.committed();assert_eq!(p.snapshot().entries,1);p.item(3,3);assert_eq!(p.snapshot().done,0);assert_eq!(p.snapshot().total,None);}
 #[test]fn transfer_position_preserves_acknowledged_batch_and_skips_reduce_only_total(){let p=Progress::default();p.plan("bytes",170000);p.bytes(32768);p.position(2,3);assert_eq!((p.snapshot().done,p.snapshot().total,p.snapshot().item),(32768,Some(170000),2));p.skip_bytes(70000);assert_eq!((p.snapshot().done,p.snapshot().total),(32768,Some(100000)));p.phase("finalizing");assert_eq!(p.snapshot().entries,0);}
 #[test]fn delete_counts_only_successful_mutations(){let p=Progress::default();p.plan("entries",5);p.committed();p.committed();assert_eq!((p.snapshot().done,p.snapshot().total),(2,Some(5)));p.phase("finalizing");assert_eq!(p.snapshot().done,2);}
}
