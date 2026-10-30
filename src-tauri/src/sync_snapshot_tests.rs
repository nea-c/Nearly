use super::*;
use std::sync::atomic::AtomicBool;
fn caught(e:&Engine,id:&str,sent:u64){let start=Instant::now();loop{let s=e.status(id).unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if s.sent>=sent&&serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"{return;}assert!(start.elapsed()<Duration::from_secs(20),"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}}
fn paths()->Vec<PathBuf>{(0..8).map(|i|PathBuf::from(format!("nested/file{i}.txt"))).collect()}
#[test]
fn initial_comparison_lists_only_requested_parent_once_without_mutation_authority(){
 let f=Fixture::start("compare-snapshot-good");stable_comparison_candidates(&f);let stop=AtomicBool::new(false);
 let(mut connection,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let snapshot=crate::sftp::comparison_snapshot(&mut connection,"/upload/job",&paths(),1,&stop).unwrap().unwrap();
 assert_eq!(snapshot.directories,1);assert_eq!(snapshot.hints.len(),8);assert!(snapshot.missing.is_empty());
 let root=f.root.join("local").canonicalize().unwrap();for(path,hint)in snapshot.hints{assert_eq!(crate::sftp::listing_candidate(&root,&path,&hint,1,&stop).unwrap(),crate::listing_hint::Candidate::ListedUnchanged);assert_eq!(crate::sftp::listing_candidate(&root,&path,&hint,2,&stop).unwrap(),crate::listing_hint::Candidate::FreshComparison);}
 let m=f.metrics();assert_eq!(m["counts"]["OPENDIR"],1);assert!(m["counts"]["LSTAT"].as_u64().unwrap()<20);
 for op in ["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(m["counts"][op].is_null());}
 assert!(crate::sftp::comparison_snapshot(&mut connection,"/upload/job",&vec![PathBuf::from("nested/file0.txt");10001],1,&stop).unwrap().is_none());
 assert!(crate::sftp::comparison_snapshot(&mut connection,"/upload/job",&["../escape".into()],1,&stop).is_err());
}
#[test]
fn comparison_pass_is_not_reused_after_restart_or_remote_file_change_and_absence(){
 let f=Fixture::start("compare-snapshot-restart");stable_comparison_candidates(&f);let e=Engine::default();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);caught(&e,"listing",0);assert_eq!(e.status("listing").unwrap().sent,0);e.stop("listing").unwrap();
 fs::write(f.remote.join("upload/job/nested/file0.txt"),b"external different metadata").unwrap();fs::remove_file(f.remote.join("upload/job/nested/file1.txt")).unwrap();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);caught(&e,"listing",2);assert_eq!(e.status("listing").unwrap().sent,2);for i in 0..8{assert_eq!(fs::read(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap(),b"stable");}e.stop("listing").unwrap();
 // A new same-name file/directory type cannot inherit the previous pass's hint.
 fs::remove_file(f.remote.join("upload/job/nested/file2.txt")).unwrap();fs::create_dir(f.remote.join("upload/job/nested/file2.txt")).unwrap();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);let s=f.wait_failed(&e,"listing");assert_eq!(s["sent"],0);assert!(f.remote.join("upload/job/nested/file2.txt").is_dir());e.stop("listing").unwrap();
}
#[test]
fn incomplete_listing_and_changed_parent_or_entry_type_publish_no_skip_or_write(){
 for mode in ["compare-snapshot-partial","compare-snapshot-parent","compare-snapshot-entry-type"]{
  let f=Fixture::start(mode);stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"bad-list",f.root.join("local"),"/upload/job",false);
  let s=f.wait_failed(&e,"bad-list");assert_eq!(s["sent"],0);assert!(!s["logs"].as_array().unwrap().iter().any(|s|s.as_str().unwrap().starts_with("Skipped unchanged")));
  let m=f.metrics();for op in ["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(m["counts"][op].is_null(),"{mode}: {op}");}e.stop("bad-list").unwrap();
 }
}
#[test]
fn comparison_listing_cancel_does_not_publish_cached_skips_or_mutate(){
 let f=Fixture::start("compare-snapshot-cancel");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"cancel-list",f.root.join("local"),"/upload/job",false);
 let start=Instant::now();while !f.root.join("server/listing-held").exists(){assert!(start.elapsed()<Duration::from_secs(10));thread::sleep(Duration::from_millis(5));}
 let start=Instant::now();e.stop("cancel-list").unwrap();assert!(start.elapsed()<Duration::from_secs(1));
 let m=f.metrics();for op in ["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(m["counts"][op].is_null());}
}
#[test]
fn ambiguous_listing_discards_the_entire_pass_and_uses_fresh_comparison(){
 let f=Fixture::start("compare-snapshot-duplicate");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"duplicate",f.root.join("local"),"/upload/job",false);caught(&e,"duplicate",0);
 let m=f.metrics();assert!(m["counts"]["LSTAT"].as_u64().unwrap()>=64,"fallback must actually recompare files");assert!(m["counts"]["WRITE"].is_null());e.stop("duplicate").unwrap();
}
#[test]
fn external_target_type_change_after_comparison_is_checked_before_staging(){
 let f=Fixture::start("compare-snapshot-target-race");changed_worker_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"target-race",f.root.join("local"),"/upload/job",false);
 let s=f.wait_failed(&e,"target-race");assert_eq!(s["failure"]["operation"],"upload");assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(),b"stable");e.stop("target-race").unwrap();
}
#[test]
fn actual_junction_ancestor_is_refused_without_listing_or_querying_its_descendants(){
 let f=Fixture::start("compare-snapshot-junction");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"junction",f.root.join("local"),"/upload/job",false);let s=f.wait_failed(&e,"junction");assert_eq!(s["sent"],0);
 assert!(f.root.join("server/junction-ready").exists());assert!(!f.root.join("server/escape-query").exists());assert_eq!(fs::read(f.remote.join("other/escape/sentinel.txt")).unwrap(),b"generated outside-selected-root sentinel");let m=f.metrics();assert!(m["counts"]["OPENDIR"].is_null());assert!(m["counts"]["WRITE"].is_null());e.stop("junction").unwrap();
}
#[test]
fn optional_listing_denial_falls_back_to_original_file_access_without_inventing_absence(){
 let f=Fixture::start("compare-snapshot-unavailable");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"no-list",f.root.join("local"),"/upload/job",false);caught(&e,"no-list",0);
 assert!(e.status("no-list").unwrap().logs.iter().any(|l|l.contains("using fresh per-file comparison")));assert!(f.metrics()["counts"]["WRITE"].is_null());e.stop("no-list").unwrap();
 fs::write(f.root.join("local/nested/file0.txt"),b"new local content with listing denied").unwrap();f.start_job(&e,"no-list",f.root.join("local"),"/upload/job",false);caught(&e,"no-list",1);assert_eq!(e.status("no-list").unwrap().sent,1);assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(),b"new local content with listing denied");e.stop("no-list").unwrap();
}
#[test]
fn optional_snapshot_depth_bound_falls_back_without_rejecting_64_directory_source_paths(){
 let f=Fixture::start("compare-snapshot-depth");let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let mut deep=PathBuf::new();for _ in 0..64{deep.push("d");}deep.push("file.txt");
 assert!(crate::sftp::comparison_snapshot(&mut c,"/upload/job",&[deep],1,&stop).unwrap().is_none(),"optional listing limit must fall back; initial_scan permits64 directories plus a filename");
}
#[test]
fn omitted_readdir_attributes_require_fresh_file_checks_and_cannot_hide_a_directory(){
 let f=Fixture::start("compare-snapshot-attrs-unknown");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"unknown-attrs",f.root.join("local"),"/upload/job",false);caught(&e,"unknown-attrs",0);
 let m=f.metrics();assert!(m["counts"]["LSTAT"].as_u64().unwrap()>=64);assert!(m["counts"]["WRITE"].is_null());e.stop("unknown-attrs").unwrap();
 fs::remove_file(f.remote.join("upload/job/nested/file0.txt")).unwrap();fs::create_dir(f.remote.join("upload/job/nested/file0.txt")).unwrap();f.start_job(&e,"unknown-attrs",f.root.join("local"),"/upload/job",false);let s=f.wait_failed(&e,"unknown-attrs");assert_eq!(s["sent"],0);assert!(f.remote.join("upload/job/nested/file0.txt").is_dir());e.stop("unknown-attrs").unwrap();
}
