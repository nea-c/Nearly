use super::*;
#[test]fn held_source_blocks_ordinary_replacement_until_joined_stop(){
 let f=Fixture::start("compare-held-write");let local=f.root.join("local");fs::write(local.join("a.txt"),b"oldbytes").unwrap();let e=Engine::default();f.start_job(&e,"held-red",local.clone(),"/upload/job",true);
 let end=Instant::now()+Duration::from_secs(15);while !f.root.join("server/held-input-write").exists(){assert!(Instant::now()<end,"write gate not reached");thread::sleep(Duration::from_millis(5));}
 let replacement=local.join("replacement-generated");fs::write(&replacement,b"newbytes").unwrap();let changed=fs::rename(&replacement,local.join("a.txt"));let blocked=changed.is_err();
 fs::write(f.root.join("server/release-held-input"),b"release generated write").unwrap();e.stop("held-red").unwrap();if blocked{fs::rename(&replacement,local.join("a.txt")).unwrap();}
 if let Ok(p)=std::env::var("HELD_RED_OUTPUT"){fs::write(p,serde_json::to_vec_pretty(&serde_json::json!({"blockedDuringTransfer":blocked,"afterJoinedStopReplacementSucceeds":true})).unwrap()).unwrap();}
 assert!(blocked,"selected held-source policy must refuse ordinary atomic replacement during transfer");
}

use std::{ffi::c_void,os::windows::{fs::OpenOptionsExt,io::AsRawHandle}};
type Ptr=*mut c_void;
#[link(name="advapi32")]
extern "system" {
 fn GetKernelObjectSecurity(h:Ptr,info:u32,sd:Ptr,len:u32,needed:*mut u32)->i32;
 fn SetKernelObjectSecurity(h:Ptr,info:u32,sd:Ptr)->i32;
 fn GetSecurityDescriptorDacl(sd:Ptr,present:*mut i32,acl:*mut Ptr,defaulted:*mut i32)->i32;
 fn InitializeSecurityDescriptor(sd:Ptr,rev:u32)->i32;
 fn SetSecurityDescriptorDacl(sd:Ptr,present:i32,acl:Ptr,defaulted:i32)->i32;
 fn CreateWellKnownSid(kind:i32,domain:Ptr,sid:Ptr,size:*mut u32)->i32;
 fn InitializeAcl(acl:Ptr,len:u32,rev:u32)->i32;
 fn AddAccessDeniedAceEx(acl:Ptr,rev:u32,flags:u32,mask:u32,sid:Ptr)->i32;
 fn GetAce(acl:Ptr,index:u32,ace:*mut Ptr)->i32;
 fn AddAce(acl:Ptr,rev:u32,index:u32,ace:Ptr,len:u32)->i32;
}
fn win(ok:i32)->std::io::Result<()> {if ok==0{Err(std::io::Error::last_os_error())}else{Ok(())}}
// Security control handle only; no inheritance, no ownership or WRITE_DAC change.
struct DenyRead {file:fs::File,old:Vec<usize>,restored:bool}
impl DenyRead {
 fn apply(p:&Path,dir:bool)->std::io::Result<Self>{
  let file=fs::OpenOptions::new().access_mode(0x60000).share_mode(7).custom_flags(0x00200000|if dir{0x02000000}else{0}).open(p)?;
  unsafe {
   let h=file.as_raw_handle();let mut needed=0;GetKernelObjectSecurity(h,4,std::ptr::null_mut(),0,&mut needed);
   let mut old=vec![0usize;(needed as usize+7)/8];win(GetKernelObjectSecurity(h,4,old.as_mut_ptr().cast(),needed,&mut needed))?;
   let mut present=0;let mut def=0;let mut orig=std::ptr::null_mut();win(GetSecurityDescriptorDacl(old.as_mut_ptr().cast(),&mut present,&mut orig,&mut def))?;
   if present==0||orig.is_null(){return Err(std::io::Error::other("fixture requires existing DACL"))}
   let size=*(orig.cast::<u8>().add(2).cast::<u16>()) as usize;let count=*(orig.cast::<u8>().add(4).cast::<u16>()) as u32;
   let mut sid=[0usize;16];let mut sidlen=128;win(CreateWellKnownSid(1,std::ptr::null_mut(),sid.as_mut_ptr().cast(),&mut sidlen))?;
   let mut acl=vec![0usize;(size+256+7)/8];win(InitializeAcl(acl.as_mut_ptr().cast(),(acl.len()*8) as u32,2))?;
   win(AddAccessDeniedAceEx(acl.as_mut_ptr().cast(),2,0,1,sid.as_mut_ptr().cast()))?;
   for i in 0..count {let mut ace=std::ptr::null_mut();win(GetAce(orig,i,&mut ace))?;let n=*(ace.cast::<u8>().add(2).cast::<u16>()) as u32;win(AddAce(acl.as_mut_ptr().cast(),2,u32::MAX,ace,n))?;}
   let mut sd=[0usize;8];win(InitializeSecurityDescriptor(sd.as_mut_ptr().cast(),1))?;win(SetSecurityDescriptorDacl(sd.as_mut_ptr().cast(),1,acl.as_mut_ptr().cast(),0))?;
   win(SetKernelObjectSecurity(h,4,sd.as_mut_ptr().cast()))?;
   Ok(Self{file,old,restored:false})
  }
 }
 fn restore(&mut self)->std::io::Result<()>{unsafe{win(SetKernelObjectSecurity(self.file.as_raw_handle(),4,self.old.as_mut_ptr().cast()))?;}self.restored=true;Ok(())}
}
impl Drop for DenyRead {fn drop(&mut self){if !self.restored{let _=self.restore();}}}

fn file_state(p:&Path)->serde_json::Value{match fs::read(p){Ok(b)=>{use sha2::{Digest,Sha256};serde_json::json!({"size":b.len(),"sha256":Sha256::digest(&b).iter().map(|x|format!("{x:02x}")).collect::<String>(),"mtime":fs::metadata(p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()})},Err(e)=>serde_json::json!({"unavailable":e.raw_os_error()})}}
fn set_time(p:&Path,t:u64){fs::File::options().write(true).open(p).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(t))).unwrap();}
#[test]fn held_source_generated_behavior_matrix(){
 use std::io::Write;use serde_json::json;
 let held=true;let output=std::env::var_os("HELD_SOURCE_RESULTS").map(PathBuf::from).unwrap_or_else(||std::env::temp_dir().join(format!("nearly-held-behavior-{}-{}.json",std::process::id(),getrandom::u64().unwrap())));let mut rows:Vec<serde_json::Value>=Vec::new();
 let cases:Vec<_>=["control","replace","delete","dirname","dirdelete","inplace","append","truncate","parent-acl","leaf-acl","unstamped"].into_iter().flat_map(|op|[512usize,131072].into_iter().map(move|size|(op,size,"finish"))).chain([("control",512,"fail"),("control",131072,"fail"),("control",512,"cancel"),("control",131072,"cancel")]).collect();
 for(op,size,ending)in cases{
  let f=Fixture::start(if ending=="fail"{"compare-held-fail"}else{"compare-held-write"});let local=f.root.join("local");let parent=local.join("nested");let leaf=parent.join("a.bin");fs::remove_file(local.join("a.txt")).unwrap();fs::remove_file(parent.join("b.txt")).unwrap();let original=vec![65u8;size];fs::write(&leaf,&original).unwrap();set_time(&leaf,1700000040);
  let remote=f.remote.join("upload/job/nested/a.bin");fs::create_dir_all(remote.parent().unwrap()).unwrap();fs::write(&remote,b"old generated final").unwrap();set_time(&remote,1700000000);let sentinel=f.remote.join("upload/job/later/delete.txt");
  let counts_before=[crate::source_hold::OPENS.load(std::sync::atomic::Ordering::Relaxed),crate::source_hold::OBSERVATIONS.load(std::sync::atomic::Ordering::Relaxed),crate::source_hold::DELETE_BARRIERS.load(std::sync::atomic::Ordering::Relaxed)];let e=Engine::default();f.start_job(&e,"held-matrix",local.clone(),"/upload/job",true);let deadline=Instant::now()+Duration::from_secs(15);while !f.root.join("server/held-input-write").exists(){assert!(Instant::now()<deadline,"write gate missing {op}/{size}/{ending}");thread::sleep(Duration::from_millis(5));}
  let initial_counts=f.metrics_for("held");let replacement=f.root.join("replacement-generated");let mut expected=original.clone();let mut expected_time=1700000040;let mut acl=None;let mut action_error=None;let mut action_succeeded=true;
  match op{
   "replace"=>{fs::write(&replacement,vec![66u8;size]).unwrap();set_time(&replacement,1700000080);if let Err(err)=fs::rename(&replacement,&leaf){action_succeeded=false;action_error=err.raw_os_error();}else{expected=vec![66;size];expected_time=1700000080;}},
   "delete"=>if let Err(err)=fs::remove_file(&leaf){action_succeeded=false;action_error=err.raw_os_error();}else{expected.clear();},
   "dirdelete"=>{assert!(parent.canonicalize().unwrap().starts_with(f.root.canonicalize().unwrap()));assert!(f.root.join("generated-held-source-prototype.marker").is_file());if let Err(err)=fs::remove_dir_all(&parent){action_succeeded=false;action_error=err.raw_os_error();}else{expected.clear();}},
   "dirname"=>if let Err(err)=fs::rename(&parent,local.join("moved")){action_succeeded=false;action_error=err.raw_os_error();},
   "inplace"|"unstamped"=>{expected=vec![66;size];fs::write(&leaf,&expected).unwrap();expected_time=if op=="unstamped"{1700000040}else{1700000080};set_time(&leaf,expected_time);},
   "append"=>{fs::File::options().append(true).open(&leaf).unwrap().write_all(b"generated append").unwrap();expected=fs::read(&leaf).unwrap();expected_time=1700000080;set_time(&leaf,expected_time);},
   "truncate"=>{expected=vec![67;128];fs::write(&leaf,&expected).unwrap();expected_time=1700000080;set_time(&leaf,expected_time);},
   "parent-acl"=>acl=Some(DenyRead::apply(&parent,true).unwrap()),"leaf-acl"=>acl=Some(DenyRead::apply(&leaf,false).unwrap()),_=>()
  }
  let mut pending_replacement=serde_json::Value::Null;let terminal;
  if ending=="cancel"{
   let gate=f.root.join("server/release-held-input");let from=f.root.join("pending-cancel-replacement");fs::write(&from,b"new after cancellation").unwrap();let to=leaf.clone();let wake=thread::spawn(move||{thread::sleep(Duration::from_millis(100));let result=fs::rename(&from,&to);let blocked=result.is_err();let code=result.err().and_then(|e|e.raw_os_error());fs::write(gate,b"release generated ACK").unwrap();(blocked,code,from)});let summary=e.stop_with_summary("held-matrix").unwrap();let(blocked,code,from)=wake.join().unwrap();pending_replacement=json!({"blockedBeforeAckRelease":blocked,"os":code});if from.exists(){fs::rename(&from,&leaf).unwrap();}terminal=json!({"status":"cancelled_after_join","knownUnreflected":summary.known_unreflected});assert!(summary.known_unreflected);assert_eq!(blocked,held,"pending source handle sharing did not match policy");
  }else{
   fs::write(f.root.join("server/release-held-input"),b"release generated ACK").unwrap();
   if ending=="fail"||op.ends_with("acl"){terminal=f.wait_failed(&e,"held-matrix");}
   else{let deadline=Instant::now()+Duration::from_secs(20);loop{let s=serde_json::to_value(e.status("held-matrix").unwrap()).unwrap();assert!(s["failure"].is_null(),"{op}/{size}/{held}: {s}");let wanted=if op=="unstamped"{Some(&original)}else if expected.is_empty(){None}else{Some(&expected)};let matches=match wanted{Some(b)=>fs::read(&remote).is_ok_and(|r|r==*b),None=>!remote.exists()};if s["syncPhase"]=="caught_up"&&matches{terminal=s;break;}assert!(Instant::now()<deadline,"{op}/{size}/{held} convergence timeout: {s}");thread::sleep(Duration::from_millis(10));}}
  }
  let policy_counts=[crate::source_hold::OPENS.load(std::sync::atomic::Ordering::Relaxed)-counts_before[0],crate::source_hold::OBSERVATIONS.load(std::sync::atomic::Ordering::Relaxed)-counts_before[1],crate::source_hold::DELETE_BARRIERS.load(std::sync::atomic::Ordering::Relaxed)-counts_before[2]];
  let outcome=json!({"remote":file_state(&remote),"sentinelPreserved":sentinel.exists(),"remainingNames":fs::read_dir(remote.parent().unwrap()).map(|it|it.filter_map(Result::ok).map(|x|x.file_name().to_string_lossy().to_string()).collect::<Vec<_>>()).unwrap_or_default(),"localLeafExists":leaf.exists(),"localParentExists":parent.exists()});
  if held&&op.ends_with("acl"){assert!(terminal["failure"]["reason"].as_str().unwrap().contains("Pre-delete local verification failed"));}// Process-global counts are diagnostic only: concurrent tests also increment them.
  // The per-fixture sharing, content, permission, deletion and release assertions below are authoritative.
  if let Some(a)=acl.as_mut(){a.restore().unwrap();}drop(acl);let completed_release=op=="control"&&ending=="finish";if completed_release{let moved=f.root.join("completed-input-generated");fs::rename(&leaf,&moved).expect("source input must be released before normal completion display");fs::rename(&moved,&leaf).unwrap();}if ending!="cancel"{e.stop("held-matrix").unwrap();}
  if op=="replace"&&!action_succeeded{fs::rename(&replacement,&leaf).unwrap();}if op=="delete"&&!action_succeeded{fs::remove_file(&leaf).unwrap();}if op=="dirdelete"&&!action_succeeded{assert!(parent.canonicalize().unwrap().starts_with(f.root.canonicalize().unwrap()));fs::remove_dir_all(&parent).unwrap();}
  if op.ends_with("acl")||ending=="fail"||ending=="cancel"{
   // Recovery is a separate explicit restart with all generated rights restored.
   if !leaf.exists(){fs::create_dir_all(&parent).unwrap();fs::write(&leaf,&original).unwrap();set_time(&leaf,1700000040);}
   f.start_job(&e,"held-matrix",local.clone(),"/upload/job",true);let deadline=Instant::now()+Duration::from_secs(20);loop{let s=serde_json::to_value(e.status("held-matrix").unwrap()).unwrap();assert!(s["failure"].is_null(),"restart {op}/{size}: {s}");if s["syncPhase"]=="caught_up"&&fs::read(&remote).ok()==fs::read(&leaf).ok(){break}assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(10));}assert_eq!(fs::metadata(&remote).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),fs::metadata(&leaf).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());e.stop("held-matrix").unwrap();assert!(!sentinel.exists());
  }
  let settled=f.metrics_for("settled");assert_eq!(settled["openFileHandles"],0);
  if matches!(op,"replace"|"delete"|"dirdelete"){assert_eq!(action_succeeded,!held,"ordinary mutation policy {op}/{size}");}if op=="dirname"{assert!(!action_succeeded);fs::rename(&parent,local.join("after-stop")).unwrap();fs::rename(local.join("after-stop"),&parent).unwrap();}
  if ending!="finish"||op.ends_with("acl"){assert_eq!(outcome["sentinelPreserved"],true,"failed/cancelled/denied cycle deleted sentinel");if size>=102400{assert_eq!(outcome["remote"]["size"],if ending=="finish"&&held{size}else{19});}}
  else{assert_eq!(outcome["sentinelPreserved"],false);if let Some(n)=outcome["remote"]["size"].as_u64(){assert_eq!(outcome["remote"]["mtime"],expected_time);if op!="unstamped"{assert_eq!(n,expected.len() as u64);}}}
  rows.push(json!({"heldPolicy":held,"completedInputReleasedBeforeStop":completed_release,"processCounterDeltaDiagnostic":policy_counts,"operation":op,"size":size,"ending":ending,"actionSucceeded":action_succeeded,"actionOsError":action_error,"pendingCancel":pending_replacement,"terminal":terminal,"outcome":outcome,"initialMetrics":initial_counts,"settledMetrics":settled,"restoredAndRestarted":op.ends_with("acl")||ending!="finish","afterStopMutationRetrySucceeded":matches!(op,"replace"|"delete"|"dirdelete"|"dirname")}));fs::write(&output,serde_json::to_vec_pretty(&json!({"status":"running","rows":rows})).unwrap()).unwrap();
 }
 assert_eq!(rows.len(),26,"every selected-policy case must execute freshly");
 fs::write(&output,serde_json::to_vec_pretty(&json!({"status":"complete","rows":rows})).unwrap()).unwrap();
}
