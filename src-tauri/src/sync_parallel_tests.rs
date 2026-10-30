use super::*;
use std::sync::atomic::AtomicBool;
use crate::sftp::{self,BatchCommit};
fn seed(f:&Fixture,n:usize,missing:bool)->(PathBuf,Vec<PathBuf>){stable_comparison_candidates(f);let root=f.root.join("local").canonicalize().unwrap();let paths=(0..n).map(|i|{let p=PathBuf::from(format!("nested/file{i}.txt"));fs::write(root.join(&p),vec![65+i as u8;65536+i*131]).unwrap();p}).collect();if missing{for i in 0..8{fs::remove_file(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap();}}(root,paths)}
fn caught(e:&Engine,id:&str,sent:u64){let start=Instant::now();loop{let s=e.status(id).unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if s.sent>=sent&&serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"{return;}assert!(start.elapsed()<Duration::from_secs(30),"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}}
fn wait_file(path:&Path){let start=Instant::now();while !path.exists(){assert!(start.elapsed()<Duration::from_secs(15),"{}",path.display());thread::sleep(Duration::from_millis(2));}}
#[test]
fn independent_upload_batch_overlaps_files_on_one_session_and_preserves_distinct_hashes(){
 use crate::sftp::{self,SourceOutcome,BatchCommit};use sha2::{Digest,Sha256};
 for width in [2,4,8]{
 let f=Fixture::start("compare-parallel-normal");stable_comparison_candidates(&f);let root=f.root.join("local").canonicalize().unwrap();
 let paths:Vec<_>=(0..width).map(|i|{let p=PathBuf::from(format!("nested/file{i}.txt"));fs::write(root.join(&p),vec![65+i as u8;65536+i*131]).unwrap();p}).collect();
 let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();let callbacks=std::sync::Mutex::new(Vec::new());
 let results=sftp::upload_batch(&mut c,&root,&paths,"/upload/job",&stop,"generated-parallel",false,&|_|Ok(()),&|i,r|{callbacks.lock().unwrap().push((i,r.commit));}).unwrap();
 assert_eq!(callbacks.lock().unwrap().len(),width);for(path,result)in paths.iter().zip(results){assert_eq!(result.commit,BatchCommit::Committed);assert!(matches!(result.result,Ok(SourceOutcome::Complete(_))));assert_eq!(Sha256::digest(fs::read(root.join(path)).unwrap()),Sha256::digest(fs::read(f.remote.join("upload/job").join(path)).unwrap()));}
 let m=f.metrics();assert_eq!(m["connections"],1);assert!(m["maxWritingFiles"].as_u64().unwrap()>=2,"independent files must actually overlap: {m}");assert!(m["maxWrites"].as_u64().unwrap()<=8);
 assert!(m["maxOpenFileHandles"].as_u64().unwrap()<=width as u64);
 println!("parallel width{width} batch evidence {m}");
 }
}
#[test]
fn batch_permission_failure_settles_peers_once_without_discarding_commits(){
 let f=Fixture::start("compare-parallel-fail");let(root,paths)=seed(&f,4,false);let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();let seen=std::sync::Mutex::new(Vec::new());
 let rs=sftp::upload_batch(&mut c,&root,&paths,"/upload/job",&stop,"partial",false,&|_|Ok(()),&|i,r|seen.lock().unwrap().push((i,r.commit))).unwrap();
 assert_eq!(rs.iter().filter(|r|r.result.is_ok()).count(),3);assert_eq!(seen.lock().unwrap().len(),4);
 for(p,r)in paths.iter().zip(&rs){if r.result.is_ok(){assert_eq!(r.commit,BatchCommit::Committed);assert_eq!(fs::read(root.join(p)).unwrap(),fs::read(f.remote.join("upload/job").join(p)).unwrap());}else{assert_eq!(r.commit,BatchCommit::NotCommitted);assert_eq!(fs::read(f.remote.join("upload/job").join(p)).unwrap(),b"stable");}}
 assert_eq!(f.metrics()["counts"]["EXTENDED"],3);
}
#[test]
fn lost_rename_ack_is_unknown_and_restart_does_not_rewrite_committed_files(){
 let f=Fixture::start("compare-parallel-acklost");let(root,paths)=seed(&f,4,false);let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let rs=sftp::upload_batch(&mut c,&root,&paths,"/upload/job",&stop,"acklost",false,&|_|Ok(()),&|_,_|{}).unwrap();assert_eq!(rs.iter().filter(|r|r.commit==BatchCommit::Unknown).count(),1);assert_eq!(rs.iter().filter(|r|r.committed_bytes.is_some()).count(),3);for p in &paths{assert_eq!(fs::read(root.join(p)).unwrap(),fs::read(f.remote.join("upload/job").join(p)).unwrap());}
 let e=Engine::default();f.start_job(&e,"restart",root,"/upload/job",false);caught(&e,"restart",0);assert_eq!(e.status("restart").unwrap().sent,0);e.stop("restart").unwrap();assert_eq!(f.metrics()["counts"]["EXTENDED"],4);
}
#[test]
fn cancelling_batch_preserves_completed_acks_and_marks_only_issued_renames_uncertain(){
 for recorded in [false,true]{let f=Fixture::start(if recorded{"compare-parallel-postcancel"}else{"compare-parallel-cancel"});let(root,paths)=seed(&f,4,false);let stop=std::sync::Arc::new(AtomicBool::new(false));let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();let signal=stop.clone();let marker=f.root.join(if recorded{"server/post-held"}else{"server/batch-held"});let cancel=thread::spawn(move||{wait_file(&marker);signal.store(true,std::sync::atomic::Ordering::SeqCst);});let callbacks=std::sync::Mutex::new(Vec::new());
 let rs=sftp::upload_batch(&mut c,&root,&paths,"/upload/job",&stop,"cancelled",recorded,&|_|Ok(()),&|i,r|callbacks.lock().unwrap().push((i,r.commit))).unwrap();cancel.join().unwrap();assert_eq!(callbacks.lock().unwrap().len(),4);
 if recorded{assert!(rs.iter().any(|r|r.cancelled&&r.commit==BatchCommit::Committed&&r.committed_bytes.is_some()));}else{assert!(rs.iter().all(|r|r.cancelled&&r.commit==BatchCommit::NotCommitted));assert!(f.metrics()["counts"]["EXTENDED"].is_null());}
 for(p,r)in paths.iter().zip(&rs){let remote=fs::read(f.remote.join("upload/job").join(p)).unwrap();if r.commit==BatchCommit::Committed{assert_eq!(remote,fs::read(root.join(p)).unwrap());}else if r.commit==BatchCommit::NotCommitted{assert_eq!(remote,b"stable");}}
 }
}
#[test]
fn server_handle_pressure_returns_partial_results_without_retrying(){
 let f=Fixture::start("compare-parallel-handles");let(root,paths)=seed(&f,4,false);let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();let rs=sftp::upload_batch(&mut c,&root,&paths,"/upload/job",&stop,"handles",false,&|_|Ok(()),&|_,_|{}).unwrap();assert_eq!(rs.iter().filter(|r|r.result.is_ok()).count(),2);assert_eq!(rs.iter().filter(|r|r.result.is_err()&&r.commit==BatchCommit::NotCommitted).count(),2);let m=f.metrics();assert_eq!(m["maxOpenFileHandles"],2);assert_eq!(m["counts"]["OPEN"],4);assert_eq!(m["counts"]["EXTENDED"],2);
}
#[test]
fn server_advertised_or_unavailable_limits_select_serial_before_any_batch_write(){
 for mode in ["compare-parallel-advertised-one","compare-parallel-limits-unavailable"]{let f=Fixture::start(mode);let(root,_)=seed(&f,8,true);let stop=AtomicBool::new(false);let(c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();assert_eq!(c.upload_cap,1);drop(c);let e=Engine::default();f.start_job(&e,"limited",root,"/upload/job",false);caught(&e,"limited",8);e.stop("limited").unwrap();assert_eq!(f.metrics()["maxOpenFileHandles"],1);}
}
#[test]
fn duplicate_case_aliased_overlapping_or_escaping_targets_are_refused_before_writes(){
 let f=Fixture::start("compare-parallel-alias");let(root,_)=seed(&f,4,false);let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();for paths in [vec!["nested/file0.txt","nested/file0.txt"],vec!["nested/file0.txt","nested/FILE0.txt"],vec!["nested/file0.txt","nested/file0.txt/child"],vec!["../escape0","../escape1"]]{assert!(sftp::upload_batch(&mut c,&root,&paths.into_iter().map(PathBuf::from).collect::<Vec<_>>(),"/upload/job",&stop,"aliases",false,&|_|Ok(()),&|_,_|{}).is_err());}let m=f.metrics();assert!(m["counts"]["OPEN"].is_null());assert!(m["counts"]["WRITE"].is_null());
}
#[test]
fn engine_records_successful_peer_and_stops_dispatch_after_partial_failure(){
 let f=Fixture::start("compare-parallel-fail");let(root,_)=seed(&f,8,true);let e=Engine::default();f.start_job(&e,"partial",root,"/upload/job",false);let status=f.wait_failed(&e,"partial");assert_eq!(status["sent"],3);assert_eq!(status["pending"],5);assert_eq!(status["remoteChanges"]["revision"],3);assert_eq!(status["failure"]["commitState"],"not_committed");thread::sleep(Duration::from_millis(200));let m=f.metrics();assert_eq!(m["counts"]["OPEN"],4);assert_eq!(m["counts"]["RENAME"],3);assert!(m["counts"]["EXTENDED"].is_null(),"new targets use no-clobber rename");e.stop("partial").unwrap();
}
#[test]
fn engine_cancel_holds_reservations_and_restart_reads_new_source_without_duplicate_commits(){
 let f=Fixture::start("compare-parallel-cancel");let(root,_)=seed(&f,8,true);let e=Engine::default();let broker=crate::text_editor::Broker::default();let op=e.claim_operation("editor-before").unwrap();let doc=broker.open(&e,"editor","workspace","editor-before",crate::text_editor::Target::Local(dunce::canonicalize(root.join("nested/file0.txt")).unwrap()),&op).unwrap();e.finish_operation("editor-before");assert!(e.start("blocked".into(),f.profile.clone(),root.to_string_lossy().into_owned(),"/upload/job".into(),zeroize::Zeroizing::new(f.secret.clone()),SyncOptions::default()).is_err());e.discard_prepared_start("blocked");broker.close("editor",&doc.token).unwrap();
 f.start_job(&e,"held",root.clone(),"/upload/job",false);wait_file(&f.root.join("server/batch-held"));let op=e.claim_operation("editor-during").unwrap();assert!(broker.open(&e,"editor","workspace","editor-during",crate::text_editor::Target::Local(dunce::canonicalize(root.join("nested/file0.txt")).unwrap()),&op).is_err());e.finish_operation("editor-during");fs::write(root.join("later.txt"),b"new while in flight").unwrap();thread::sleep(Duration::from_millis(30));let start=Instant::now();let summary=e.stop_with_summary("held").unwrap();assert!(start.elapsed()<Duration::from_secs(1));assert!(summary.known_unreflected);let stopped=f.metrics_for("stopped");assert!(stopped["counts"]["EXTENDED"].is_null());assert!(stopped["counts"]["RENAME"].is_null(),"stop must prevent either commit protocol");fs::write(f.root.join("server/release-batch"),b"generated").unwrap();
 f.start_job(&e,"held",root.clone(),"/upload/job",false);caught(&e,"held",9);for i in 0..8{assert_eq!(fs::read(root.join(format!("nested/file{i}.txt"))).unwrap(),fs::read(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap());}e.stop("held").unwrap();let counts=f.metrics_for("restarted");assert_eq!(counts["counts"]["RENAME"],9);assert!(counts["counts"]["EXTENDED"].is_null());
}
#[test]
fn mirrored_parallel_uploads_finish_before_serial_file_and_directory_deletions(){
 let f=Fixture::start("compare-parallel-mirror");let(root,_)=seed(&f,8,true);let e=Engine::default();f.start_job(&e,"mirror",root.clone(),"/upload/job",true);caught(&e,"mirror",8);for i in 0..8{fs::remove_file(root.join(format!("nested/file{i}.txt"))).unwrap();}fs::remove_dir(root.join("nested")).unwrap();let start=Instant::now();while f.remote.join("upload/job/nested").exists(){let s=e.status("mirror").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert!(start.elapsed()<Duration::from_secs(20));thread::sleep(Duration::from_millis(5));}caught(&e,"mirror",8);assert!(!f.root.join("server/delete-with-open-handles").exists());e.stop("mirror").unwrap();let m=f.metrics();assert_eq!(m["counts"]["REMOVE"],8);assert_eq!(m["counts"]["RMDIR"],1);assert!(m["maxOpenFileHandles"].as_u64().unwrap()>=2);
}
#[test]
fn transport_disconnect_in_batch_stops_without_successful_or_duplicate_target_writes(){
 let f=Fixture::start("compare-parallel-disconnect");let(root,_)=seed(&f,8,true);let e=Engine::default();f.start_job(&e,"disconnect",root,"/upload/job",false);let s=f.wait_failed(&e,"disconnect");assert_eq!(s["sent"],0);assert!(s["pending"].as_u64().unwrap()>=8);e.stop("disconnect").unwrap();let m=f.metrics();assert_eq!(m["connections"],1);assert!(m["counts"]["EXTENDED"].is_null());
}
