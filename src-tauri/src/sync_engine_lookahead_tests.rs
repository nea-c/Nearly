use super::*;
use std::sync::atomic::Ordering;
fn setup(mode:&str)->Fixture{
 let f=Fixture::start(mode);
 fs::write(f.root.join("local/a.txt"),vec![65;512]).unwrap();
 fs::write(f.root.join("local/b.txt"),vec![66;512]).unwrap();
 f
}
fn until(mut check:impl FnMut()->bool){let end=Instant::now()+Duration::from_secs(30);while !check(){assert!(Instant::now()<end,"generated lookahead condition timeout");thread::sleep(Duration::from_millis(5));}}
fn held(f:&Fixture){until(||f.root.join("server/lookahead-current-held").exists());}
fn released(f:&Fixture){fs::write(f.root.join("server/release-lookahead"),b"generated").unwrap();}
#[test]fn engine_lookahead_live_next_leaf_replacement_uses_fresh_bytes(){
 let f=setup("lookahead-hold");let local=f.root.join("local");let before=crate::parent_lookahead::USED.load(Ordering::SeqCst);let e=Engine::default();
 f.start_job(&e,"next-fresh",local.clone(),"/upload/job",true);held(&f);
 assert!(crate::parent_lookahead::PREPARED.load(Ordering::SeqCst)>before,"must exercise actual queued parent slot");
 let old_time=fs::metadata(local.join("b.txt")).unwrap().modified().unwrap();
 fs::write(local.join("replacement-generated"),vec![90;512]).unwrap();
 fs::File::options().write(true).open(local.join("replacement-generated")).unwrap().set_times(fs::FileTimes::new().set_modified(old_time)).unwrap();
 fs::rename(local.join("replacement-generated"),local.join("b.txt")).unwrap();released(&f);
 until(||{let s=e.status("next-fresh").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);s.sent>=3&&serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"});
 assert_eq!(fs::read(f.remote.join("upload/job/b.txt")).unwrap(),vec![90;512]);
 assert!(crate::parent_lookahead::USED.load(Ordering::SeqCst)>before);
 e.stop("next-fresh").unwrap();assert_eq!(f.metrics()["openFileHandles"],0);
}
#[test]fn engine_lookahead_live_cancel_settles_current_and_discards_next(){
 let f=setup("lookahead-hold");let prepared=crate::parent_lookahead::PREPARED.load(Ordering::SeqCst);let used=crate::parent_lookahead::USED.load(Ordering::SeqCst);let e=Engine::default();
 f.start_job(&e,"next-cancel",f.root.join("local"),"/upload/job",true);held(&f);
 assert!(crate::parent_lookahead::PREPARED.load(Ordering::SeqCst)>prepared);
 let release=f.root.join("server/release-lookahead");let wake=thread::spawn(move||{thread::sleep(Duration::from_millis(100));fs::write(release,b"generated").unwrap();});
 let summary=e.stop_with_summary("next-cancel").unwrap();wake.join().unwrap();assert!(summary.known_unreflected);assert!(e.status("next-cancel").is_err());
 assert_eq!(crate::parent_lookahead::USED.load(Ordering::SeqCst),used);
 assert!(!f.remote.join("upload/job/a.txt").exists());assert!(!f.remote.join("upload/job/b.txt").exists());assert!(f.remote.join("upload/job/later/delete.txt").exists());
 assert_eq!(f.metrics()["openFileHandles"],0);
}
#[test]fn engine_lookahead_live_failed_current_never_uploads_or_deletes_next(){
 let f=setup("lookahead-fail");let prepared=crate::parent_lookahead::PREPARED.load(Ordering::SeqCst);let used=crate::parent_lookahead::USED.load(Ordering::SeqCst);let e=Engine::default();
 f.start_job(&e,"next-error",f.root.join("local"),"/upload/job",true);held(&f);assert!(crate::parent_lookahead::PREPARED.load(Ordering::SeqCst)>prepared);released(&f);
 let failure=f.wait_failed(&e,"next-error");assert_eq!(failure["sent"],0);assert_eq!(crate::parent_lookahead::USED.load(Ordering::SeqCst),used);
 assert!(!f.remote.join("upload/job/a.txt").exists());assert!(!f.remote.join("upload/job/b.txt").exists());assert!(f.remote.join("upload/job/later/delete.txt").exists());
 e.stop("next-error").unwrap();assert_eq!(f.metrics()["openFileHandles"],0);
}
