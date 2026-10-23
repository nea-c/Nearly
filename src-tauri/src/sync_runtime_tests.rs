// Explicit opt-in only: real Engine against disposable loopback SFTP, no GUI.
use crate::{engine::{Engine,SyncOptions},sftp::Profile};
use std::{fs,io::{BufRead,BufReader},path::{Path,PathBuf},process::{Child,Command,Stdio},thread,time::{Duration,Instant}};
struct Fixture { child:Child, root:PathBuf, remote:PathBuf, profile:Profile, secret:String }
impl Fixture {
 fn start(mode:&str)->Self {
  let root=std::env::temp_dir().join(format!("nearly-sync-runtime-{}-{}",std::process::id(),mode));
  fs::create_dir_all(root.join("local/nested")).unwrap();
  fs::write(root.join("local/a.txt"),vec![65;1024*1024]).unwrap();
  fs::write(root.join("local/nested/b.txt"),b"later upload").unwrap();
  let mut child=Command::new("node").arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/sync-runtime-fixture.mjs"))
   .arg(root.join("server")).arg(mode).arg(root.join("local"))
   .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
  let mut line=String::new();BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
  let info:serde_json::Value=serde_json::from_str(&line).expect("fixture startup JSON");
  let profile=Profile{id:"synthetic".into(),name:"synthetic".into(),host:"127.0.0.1".into(),port:info["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:info["keyFile"].as_str().unwrap().into(),host_key:info["hostKey"].as_str().unwrap().into()};
  Self{child,root,remote:PathBuf::from(info["remote"].as_str().unwrap()),profile,secret:info["passphrase"].as_str().unwrap().into()}
 }
 fn start_job(&self,e:&Engine,id:&str,local:PathBuf,remote:&str,mirror:bool){e.start(id.into(),self.profile.clone(),local.to_string_lossy().into(),remote.into(),zeroize::Zeroizing::new(self.secret.clone()),SyncOptions{exclusion_rules:String::new(),delete_removed:mirror,recursive:true}).unwrap();}
 fn wait_failed(&self,e:&Engine,id:&str)->serde_json::Value {let start=Instant::now();loop{let s=serde_json::to_value(e.status(id).unwrap()).unwrap();if s["status"]=="failed"&&s["stopComplete"]==true{return s}assert!(start.elapsed()<Duration::from_secs(20),"worker failed/stop timeout: {s}");thread::sleep(Duration::from_millis(50));}}
 fn metrics(&self)->serde_json::Value {self.metrics_for("once")}
 fn metrics_for(&self,label:&str)->serde_json::Value {fs::write(self.root.join(format!("server/metrics-request-{label}")),b"").unwrap();let start=Instant::now();let target=self.root.join(format!("server/metrics-{label}.json"));while !target.exists(){assert!(start.elapsed()<Duration::from_secs(2));thread::sleep(Duration::from_millis(5));}serde_json::from_slice(&fs::read(target).unwrap()).unwrap()}
}
impl Drop for Fixture {fn drop(&mut self){self.child.stdin.take();let _=self.child.kill();let _=self.child.wait();}}
fn stable_comparison_candidates(f:&Fixture){
 let root=f.root.join("local");fs::remove_file(root.join("a.txt")).unwrap();fs::remove_file(root.join("nested/b.txt")).unwrap();fs::create_dir_all(f.remote.join("upload/job/nested")).unwrap();
 // The common fixture's remote-only sentinel would occupy a candidate slot
 // before local-action filtering, producing legal batches of three uploads.
 // This fixture specifically needs four comparable files, not a deletion.
 fs::remove_file(f.remote.join("upload/job/later/delete.txt")).unwrap();fs::remove_dir(f.remote.join("upload/job/later")).unwrap();
 let t=std::time::UNIX_EPOCH+Duration::from_secs(1_700_000_000);
 for i in 0..8{let p=format!("nested/file{i}.txt");for base in [&root,&f.remote.join("upload/job")]{fs::write(base.join(&p),b"stable").unwrap();fs::File::options().write(true).open(base.join(&p)).unwrap().set_times(fs::FileTimes::new().set_modified(t)).unwrap();}}
}
fn changed_worker_comparison_candidates(f:&Fixture){
 stable_comparison_candidates(f);
 // These tests target fresh-comparison failure/cancel, not listing equality.
 for i in 0..8{fs::write(f.root.join(format!("local/nested/file{i}.txt")),b"changed local requires fresh comparison").unwrap();}
}

#[test]
fn listing_unchanged_intentionally_does_not_lookup_later_denied_child(){
 let f=Fixture::start("compare-error-listed");stable_comparison_candidates(&f);
 let e=Engine::default();f.start_job(&e,"listed",f.root.join("local"),"/upload/job",true);
 let deadline=Instant::now()+Duration::from_secs(15);
 loop{let s=e.status("listed").unwrap();assert_eq!(s.error_count,0);if s.pending==0&&s.logs.iter().filter(|line|line.contains("Skipped listed unchanged")).count()==8{break;}assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
 assert!(!f.root.join("server/denied-child-lookup").exists());
 assert!(f.metrics()["counts"]["WRITE"].is_null());e.stop("listed").unwrap();
}

#[test]
fn independent_comparison_pipeline_preserves_results_and_request_count_on_one_session(){
 use crate::sftp::{self,FileComparison};use std::sync::atomic::AtomicBool;
 for trial in 0..3 {
 let mut timings=Vec::new();let mut counts=Vec::new();let mut maxima=Vec::new();
 for batch in [1,4] {
  let f=Fixture::start(&format!("compare-{trial}-{batch}"));let root=f.root.join("local").canonicalize().unwrap();
  fs::create_dir_all(f.remote.join("upload/job/nested")).unwrap();
  let mut paths=Vec::new();
  for i in 0..8 {let p=PathBuf::from(format!("nested/file{i}.txt"));fs::write(root.join(&p),vec![65+i as u8;i+1]).unwrap();fs::copy(root.join(&p),f.remote.join("upload/job").join(&p)).unwrap();let t=fs::metadata(root.join(&p)).unwrap().modified().unwrap();fs::File::options().write(true).open(f.remote.join("upload/job").join(&p)).unwrap().set_times(fs::FileTimes::new().set_modified(t)).unwrap();paths.push(p);}
  let stop=AtomicBool::new(false);let(mut s,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
  let start=Instant::now();
  for chunk in paths.chunks(batch){let result=if batch==1{vec![sftp::compare_file(&mut s,&root,&chunk[0],"/upload/job",&stop).unwrap()]}else{sftp::compare_files(&mut s,&root,chunk,"/upload/job",&stop).map_err(|e|e.1).unwrap()};assert_eq!(result.len(),chunk.len());for (p,r) in chunk.iter().zip(result){match r {FileComparison::Unchanged(stamp)=>assert_eq!(stamp.size,fs::metadata(root.join(p)).unwrap().len(),"response/result path correspondence"),_=>panic!("stable fixture was not unchanged")}}}
  timings.push(start.elapsed().as_millis());
  let metrics=f.metrics();
  assert_eq!(metrics["authenticated"],1);assert_eq!(metrics["connections"],1);let observed=metrics["maxInflight"].as_u64().unwrap();assert!((1..=batch as u64).contains(&observed));maxima.push(observed);counts.push(metrics["counts"].clone());
 }
 assert_eq!(counts[0],counts[1],"all guards and requests must remain");assert!(timings[1]<timings[0],"{timings:?}");
 assert_eq!(counts[0]["LSTAT"],64);assert_eq!(counts[0]["REALPATH"],8);
 println!("comparison fixture trial{trial}: 8 files, depth3, 20ms per LSTAT, serial={}ms batch4={}ms counts={:?} observed_max={maxima:?}",timings[0],timings[1],counts[0]);
 }
}
#[test]
fn comparison_batch_error_prevents_any_upload_and_reports_the_failing_file(){
 for mirror in [false,true]{
 let f=Fixture::start(if mirror{"compare-error-mirror"}else{"compare-error"});let root=f.root.join("local");changed_worker_comparison_candidates(&f);if mirror{fs::create_dir(root.join("owned")).unwrap();}
 let e=Engine::default();f.start_job(&e,"batch-error",root.clone(),"/upload/job",mirror);
 let failed=f.wait_failed(&e,"batch-error");let path=PathBuf::from(failed["failure"]["relativePath"].as_str().unwrap());assert_eq!(path.parent(),Some(Path::new("nested")));assert!(path.file_name().unwrap().to_string_lossy().starts_with("file"));
 assert!(!f.remote.join("upload/job/a.txt").exists());
 let metrics=f.metrics();assert!(metrics["counts"]["WRITE"].is_null());assert_eq!(metrics["authenticated"],1);assert_eq!(metrics["maxInflight"],4);assert!(failed["pending"].as_u64().unwrap()>0);
 if mirror{assert!(f.remote.join("upload/job/owned").is_dir());fs::remove_dir(root.join("owned")).unwrap();}fs::write(root.join("later.txt"),b"after failure").unwrap();thread::sleep(Duration::from_millis(700));assert!(!f.remote.join("upload/job/later.txt").exists());if mirror{assert!(f.remote.join("upload/job/owned").is_dir());}
 let after=f.metrics_for("after");for op in ["WRITE","REMOVE","RMDIR","RENAME","EXTENDED"]{assert_eq!(metrics["counts"][op],after["counts"][op],"{op} advanced after failure stopComplete");}e.stop("batch-error").unwrap();
 }
}
#[test]
fn comparison_batch_cancel_discards_all_results_promptly(){
 use crate::sftp;use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
 let f=Fixture::start("compare-cancel");let root=f.root.join("local").canonicalize().unwrap();
 let paths:Vec<_>=(0..4).map(|i|{let p=PathBuf::from(format!("file{i}.txt"));fs::write(root.join(&p),b"local").unwrap();p}).collect();
 let stop=Arc::new(AtomicBool::new(false));let(mut s,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let signal=stop.clone();let cancel=thread::spawn(move||{thread::sleep(Duration::from_millis(30));signal.store(true,Ordering::SeqCst);});
 let start=Instant::now();assert!(sftp::compare_files(&mut s,&root,&paths,"/upload/job",&stop).is_err());cancel.join().unwrap();assert!(start.elapsed()<Duration::from_secs(1));
 assert!(!f.remote.join("upload/job/file0.txt").exists());
}
#[test]
fn worker_cancel_during_comparison_batch_never_dispatches_followup_mutations(){
 let f=Fixture::start("compare-worker-cancel");let root=f.root.join("local");changed_worker_comparison_candidates(&f);fs::create_dir(root.join("owned")).unwrap();
 let e=Engine::default();f.start_job(&e,"batch-cancel",root.clone(),"/upload/job",true);
 let start=Instant::now();while !f.root.join("server/compare-observed").exists(){if start.elapsed()>=Duration::from_secs(20){panic!("batch marker missing: status={}, metrics={}",serde_json::to_value(e.status("batch-cancel").unwrap()).unwrap(),f.metrics());}thread::sleep(Duration::from_millis(5));}
 e.stop("batch-cancel").unwrap();let before=f.metrics();assert!(!f.remote.join("upload/job/a.txt").exists());assert!(f.remote.join("upload/job/owned").is_dir());fs::remove_dir(root.join("owned")).unwrap();fs::write(root.join("later.txt"),b"after stop").unwrap();thread::sleep(Duration::from_millis(700));assert!(!f.remote.join("upload/job/later.txt").exists());assert!(f.remote.join("upload/job/owned").is_dir());let after=f.metrics_for("after");for op in ["WRITE","REMOVE","RMDIR","RENAME","EXTENDED"]{assert_eq!(before["counts"][op],after["counts"][op],"{op} advanced after manual stop");}
}
#[test]
fn out_of_order_sftp_replies_remain_associated_with_each_file(){
 use crate::sftp::{self,FileComparison};use std::sync::atomic::AtomicBool;
 let f=Fixture::start("compare-reorder");let root=f.root.join("local").canonicalize().unwrap();let mut paths=Vec::new();
 for i in 0..4{let p=PathBuf::from(format!("file{i}.txt"));fs::write(root.join(&p),vec![65;i+1]).unwrap();fs::copy(root.join(&p),f.remote.join("upload/job").join(&p)).unwrap();let t=fs::metadata(root.join(&p)).unwrap().modified().unwrap();fs::File::options().write(true).open(f.remote.join("upload/job").join(&p)).unwrap().set_times(fs::FileTimes::new().set_modified(t)).unwrap();paths.push(p);}
 let stop=AtomicBool::new(false);let(mut s,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let result=sftp::compare_files(&mut s,&root,&paths,"/upload/job",&stop).map_err(|e|e.1).unwrap();
 for(i,result)in result.into_iter().enumerate(){match result{FileComparison::Unchanged(stamp)=>assert_eq!(stamp.size,i as u64+1),_=>panic!("response associated with wrong file")}}
 let metrics=f.metrics();let replies=metrics["replyPaths"].as_array().unwrap();assert!(replies[0].as_str().unwrap().ends_with("file3.txt"),"fixture must actually reorder replies: {replies:?}");assert!(replies[3].as_str().unwrap().ends_with("file0.txt"));assert_eq!(metrics["maxInflight"],4);
}

#[test]
fn source_change_resends_latest_without_error_and_reclaims_its_own_staging(){
 let f=Fixture::start("change");let e=Engine::default();
 f.start_job(&e,"change",f.root.join("local"),"/upload/job",true);
 let start=Instant::now();loop{let s=e.status("change").unwrap();assert_eq!(s.error_count,0,"{:?}",s.logs);if fs::read(f.remote.join("upload/job/a.txt")).is_ok_and(|b|b==vec![66;1024*1024])&&f.remote.join("upload/job/nested/b.txt").exists()&&s.pending==0{break}assert!(start.elapsed()<Duration::from_secs(25),"{:?}",s.logs);thread::sleep(Duration::from_millis(50));}
 assert!(!fs::read_dir(f.remote.join("upload/job")).unwrap().filter_map(Result::ok).any(|p|p.file_name().to_string_lossy().ends_with(".part")));
 assert!(e.status("change").unwrap().failure.is_none());e.stop("change").unwrap();
}

#[test]
fn repeated_source_saves_converge_and_another_file_progresses(){
 let f=Fixture::start("burst");let e=Engine::default();f.start_job(&e,"burst",f.root.join("local"),"/upload/job",false);
 let start=Instant::now();loop{let s=e.status("burst").unwrap();assert_eq!(s.error_count,0,"{:?}",s.logs);if fs::read(f.remote.join("upload/job/a.txt")).is_ok_and(|b|b==vec![70;1024*1024])&&s.pending==0{break}assert!(start.elapsed()<Duration::from_secs(30),"{:?}",s.logs);thread::sleep(Duration::from_millis(30));}
 assert!(f.remote.join("upload/job/nested/b.txt").exists());
 let commits:serde_json::Value=serde_json::from_slice(&fs::read(f.root.join("server/commits.json")).unwrap()).unwrap();
 assert!(commits.as_array().unwrap().iter().any(|c|c["target"]=="/upload/job/nested/b.txt"&&c["edits"].as_u64().unwrap()<5),"another file must commit while a is still changing: {commits}");
 assert!(start.elapsed()>=Duration::from_secs(2),"retries must debounce, never spin");e.stop("burst").unwrap();
}

#[test]
fn atomic_replace_and_post_commit_save_both_resend_without_hiding_remote_errors(){
 for mode in ["atomic","postchange","postsame"] {
  let f=Fixture::start(mode);let e=Engine::default();f.start_job(&e,mode,f.root.join("local"),"/upload/job",true);
  let start=Instant::now();loop{
   if mode=="atomic"&&f.root.join("server/replace-request").exists()&&!f.root.join("server/replace-done").exists(){fs::rename(f.root.join("local/a.txt.next"),f.root.join("local/a.txt")).expect("native atomic replacement with upload handles open");fs::write(f.root.join("server/replace-done"),b"").unwrap();}
   let s=e.status(mode).unwrap();assert_eq!(s.error_count,0,"{mode}: {:?}",s.logs);if fs::read(f.remote.join("upload/job/a.txt")).is_ok_and(|b|b==vec![66;1024*1024])&&s.pending==0{break}assert!(start.elapsed()<Duration::from_secs(25),"{mode}: {:?}",s.logs);thread::sleep(Duration::from_millis(30));}
  assert!(e.status(mode).unwrap().logs.iter().any(|line|line.contains("waiting to resend")));assert!(!e.status(mode).unwrap().remote_changes.records.is_empty());e.stop(mode).unwrap();
 }
}

#[test]
fn permission_error_still_stops_and_manual_stop_never_requeues_changes(){
 let f=Fixture::start("permission");let e=Engine::default();f.start_job(&e,"permission",f.root.join("local"),"/upload/job",true);let failed=f.wait_failed(&e,"permission");assert_eq!(failed["errorCount"],1);assert_eq!(failed["failure"]["commitState"],"not_committed");assert!(!f.remote.join("upload/job/a.txt").exists());assert!(f.remote.join("upload/job/later/delete.txt").exists());e.stop("permission").unwrap();
 let f=Fixture::start("continuous");f.start_job(&e,"continuous",f.root.join("local"),"/upload/job",false);let start=Instant::now();while !e.status("continuous").unwrap().logs.iter().any(|s|s.contains("waiting to resend")){assert!(start.elapsed()<Duration::from_secs(20));thread::sleep(Duration::from_millis(20));}e.stop("continuous").unwrap();let stages=fs::read_dir(f.remote.join("upload/job")).unwrap().count();thread::sleep(Duration::from_millis(900));assert_eq!(fs::read_dir(f.remote.join("upload/job")).unwrap().count(),stages);assert!(!f.remote.join("upload/job/a.txt").exists());
}
#[test]
fn simultaneous_source_change_never_hides_permission_error_or_stops_other_job(){
 let f=Fixture::start("change-permission");let e=Engine::default();f.start_job(&e,"bad",f.root.join("local"),"/upload/job",true);
 let other=f.root.join("other-local");fs::create_dir(&other).unwrap();fs::write(other.join("ok.txt"),b"independent").unwrap();fs::create_dir_all(f.remote.join("upload/independent")).unwrap();f.start_job(&e,"good",other,"/upload/independent",false);
 let failed=f.wait_failed(&e,"bad");assert_eq!(failed["errorCount"],1);assert!(!f.remote.join("upload/job/a.txt").exists());
 let start=Instant::now();while !f.remote.join("upload/independent/ok.txt").exists(){assert!(start.elapsed()<Duration::from_secs(20));thread::sleep(Duration::from_millis(20));}
 assert_eq!(e.status("good").unwrap().error_count,0);e.stop("bad").unwrap();e.stop("good").unwrap();
}
#[test]
fn simultaneous_source_change_and_disconnect_is_a_real_error(){
 let f=Fixture::start("change-network");let e=Engine::default();f.start_job(&e,"network",f.root.join("local"),"/upload/job",false);
 let failed=f.wait_failed(&e,"network");assert_eq!(failed["errorCount"],1);assert!(!f.remote.join("upload/job/a.txt").exists());assert!(!e.status("network").unwrap().logs.iter().any(|s|s.contains("waiting to resend")));e.stop("network").unwrap();
}
#[test]
fn post_commit_metadata_error_is_reported_committed_and_refreshes_target(){
 let f=Fixture::start("committed");let e=Engine::default();f.start_job(&e,"committed",f.root.join("local"),"/upload/job",true);
 let failed=f.wait_failed(&e,"committed");assert_eq!(failed["failure"]["commitState"],"committed");
 assert_eq!(fs::read(f.remote.join("upload/job/a.txt")).unwrap(),vec![65;1024*1024]);
 assert_eq!(failed["sent"],1);assert!(!failed["remoteChanges"]["records"].as_array().unwrap().is_empty());
 assert!(!f.remote.join("upload/job/nested/b.txt").exists());assert!(f.remote.join("upload/job/later/delete.txt").exists());e.stop("committed").unwrap();
}
#[test]
fn lost_final_rename_result_is_unknown_never_claimed_unsent(){
 let f=Fixture::start("uncertain");let e=Engine::default();f.start_job(&e,"uncertain",f.root.join("local"),"/upload/job",true);
 let failed=f.wait_failed(&e,"uncertain");assert_eq!(failed["failure"]["commitState"],"unknown");
 assert_eq!(fs::read(f.remote.join("upload/job/a.txt")).unwrap(),vec![65;1024*1024]);
 assert_eq!(failed["sent"],0);assert!(!f.remote.join("upload/job/nested/b.txt").exists());assert!(f.remote.join("upload/job/later/delete.txt").exists());e.stop("uncertain").unwrap();
}
