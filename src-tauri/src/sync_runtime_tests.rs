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
}
impl Drop for Fixture {fn drop(&mut self){self.child.stdin.take();let _=self.child.kill();let _=self.child.wait();}}

#[test]
fn source_change_stops_subsequent_upload_delete_other_job_stays_independent_and_manual_restart_rescans(){
 let f=Fixture::start("change");let e=Engine::default();
 f.start_job(&e,"change",f.root.join("local"),"/upload/job",true);
 let failed=f.wait_failed(&e,"change");assert_eq!(failed["failure"]["relativePath"],"a.txt");
 assert_eq!(failed["failure"]["commitState"],"not_committed");assert_eq!(failed["errorCount"],1);
 assert!(failed["failure"]["reason"].as_str().unwrap().contains("changed during upload"));
 thread::sleep(Duration::from_millis(1000));assert!(!f.remote.join("upload/job/a.txt").exists());assert!(!f.remote.join("upload/job/nested/b.txt").exists());assert!(f.remote.join("upload/job/later/delete.txt").exists());
 let stages:Vec<_>=fs::read_dir(f.remote.join("upload/job")).unwrap().filter_map(Result::ok).filter(|p|p.file_name().to_string_lossy().ends_with(".part")).collect();
 assert_eq!(stages.len(),1,"owned interrupted stage is retained, never presented as completed target");
 #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;let closed=fs::OpenOptions::new().read(true).write(true).share_mode(0).open(stages[0].path());assert!(closed.is_ok(),"retained stage has no live transfer handle");}
 let other=f.root.join("other");fs::create_dir_all(&other).unwrap();fs::write(other.join("ok.txt"),b"independent").unwrap();
 f.start_job(&e,"other",other,"/other",false);let start=Instant::now();while !f.remote.join("other/ok.txt").exists(){assert!(start.elapsed()<Duration::from_secs(10));thread::sleep(Duration::from_millis(50));}
 assert_eq!(e.status("change").unwrap().status,"failed");assert!(e.retry("change").is_err());e.stop("other").unwrap();e.stop("change").unwrap();
 f.start_job(&e,"resumed",f.root.join("local"),"/upload/job",false);let start=Instant::now();loop{if fs::read(f.remote.join("upload/job/a.txt")).is_ok_and(|b|b==vec![66;1024*1024])&&f.remote.join("upload/job/nested/b.txt").exists(){break}assert!(start.elapsed()<Duration::from_secs(15));thread::sleep(Duration::from_millis(50));}e.stop("resumed").unwrap();
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
