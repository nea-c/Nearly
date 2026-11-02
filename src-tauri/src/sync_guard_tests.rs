//! Generated loopback coverage for consolidating the no-create parent walk.
use super::*;
use crate::sftp::{self,SourceOutcome,BatchCommit};
use std::sync::atomic::AtomicBool;
fn files()->Vec<PathBuf>{(0..4).map(|i|PathBuf::from(format!("nested/file{i}.txt"))).collect()}

#[test]
fn serial_upload_existing_parent_does_not_repeat_creation_walk_before_strict_guard(){
 let f=Fixture::start("compare-guard-good");stable_comparison_candidates(&f);let root=f.root.join("local").canonicalize().unwrap();let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let p=Path::new("nested/file0.txt");fs::write(root.join(p),b"generated serial upload").unwrap();
 assert!(matches!(sftp::upload(&mut c,&root,p,"/upload/job",&stop,"serial-existing").unwrap(),SourceOutcome::Complete(_)));
 assert_eq!(fs::read(f.remote.join("upload/job").join(p)).unwrap(),b"generated serial upload");let m=f.metrics();
 assert_eq!(m["counts"]["LSTAT"],9,"4 strict ancestors +1 target +4 fresh commit ancestors; no redundant create walk");assert_eq!(m["counts"]["REALPATH"],1);assert!(m["counts"]["MKDIR"].is_null());
}

#[test]
fn serial_upload_still_creates_only_missing_parents_and_refuses_invalid_existing_ancestors(){
 for kind in ["missing","file","junction","unknown-mode","server-error","target-type"]{
  let f=Fixture::start(&format!("compare-guard-{kind}"));stable_comparison_candidates(&f);let parent=f.remote.join("upload/job/nested");
  if ["missing","file","junction"].contains(&kind){fs::rename(&parent,f.remote.join("upload/job/nested-saved")).unwrap();if kind=="file"{fs::write(&parent,b"not directory").unwrap();}if kind=="junction"{let outside=f.remote.join("other/serial-outside");fs::create_dir(&outside).unwrap();fs::write(outside.join("sentinel"),b"untouched").unwrap();assert!(Command::new("node").args(["-e","require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')"]).arg(outside).arg(&parent).output().unwrap().status.success());}}
  let root=f.root.join("local").canonicalize().unwrap();let p=Path::new("nested/file0.txt");fs::write(root.join(p),b"generated serial").unwrap();let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();let r=sftp::upload(&mut c,&root,p,"/upload/job",&stop,"serial-refuse");let m=f.metrics();
  if kind=="missing"{assert!(r.is_ok(),"{r:?}");assert_eq!(fs::read(parent.join("file0.txt")).unwrap(),b"generated serial");assert_eq!(m["counts"]["MKDIR"],1);}else{assert!(r.is_err(),"{kind}");for op in ["OPEN","WRITE","MKDIR","EXTENDED"]{assert!(m["counts"][op].is_null(),"{kind}/{op}");}if kind=="junction"{assert_eq!(fs::read(f.remote.join("other/serial-outside/sentinel")).unwrap(),b"untouched");assert_eq!(fs::read_dir(f.remote.join("other/serial-outside")).unwrap().count(),1);}}
 }
}

#[test]
fn serial_upload_parent_replacement_after_guard_and_after_write_never_commits(){
 for mode in ["compare-guard-parent-at-open","compare-guard-postwrite"]{
  let f=Fixture::start(mode);stable_comparison_candidates(&f);let root=f.root.join("local").canonicalize().unwrap();let p=Path::new("nested/file0.txt");fs::write(root.join(p),b"generated serial race").unwrap();let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
  assert!(sftp::upload(&mut c,&root,p,"/upload/job",&stop,"serial-race").is_err());let m=f.metrics();assert!(m["counts"]["EXTENDED"].is_null());assert!(m["counts"]["RENAME"].is_null());
  let original=if mode.ends_with("-open"){f.remote.join("upload/job/nested-saved/file0.txt")}else{f.remote.join("upload/job/nested/file0.txt")};assert_eq!(fs::read(original).unwrap(),b"stable");
 }
}

#[test]
fn serial_upload_cancel_during_existing_parent_inspection_never_creates_or_writes(){
 use std::sync::{Arc,atomic::Ordering};
 let f=Fixture::start("compare-guard-cancel");stable_comparison_candidates(&f);let root=f.root.join("local").canonicalize().unwrap();let p=Path::new("nested/file0.txt");fs::write(root.join(p),b"generated serial cancel").unwrap();let stop=Arc::new(AtomicBool::new(false));let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();let signal=stop.clone();let held=f.root.join("server/guard-held");
 let cancel=thread::spawn(move||{let deadline=Instant::now()+Duration::from_secs(10);while !held.exists()&&Instant::now()<deadline{thread::sleep(Duration::from_millis(2));}let observed=held.exists();signal.store(true,Ordering::SeqCst);observed});
 assert!(sftp::upload(&mut c,&root,p,"/upload/job",&stop,"serial-stop").is_err());assert!(cancel.join().unwrap());let m=f.metrics();for op in ["MKDIR","OPEN","WRITE","RENAME","EXTENDED"]{assert!(m["counts"][op].is_null(),"{op}");}assert_eq!(fs::read(f.remote.join("upload/job").join(p)).unwrap(),b"stable");
}

#[test]
fn noncreating_upload_batch_has_one_initial_strict_walk_and_one_fresh_commit_walk() {
    let f=Fixture::start("compare-guard-good");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let stop=AtomicBool::new(false);
    for i in 0..4{fs::write(root.join(format!("nested/file{i}.txt")),vec![65+i as u8;6]).unwrap();}
    let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    let results=sftp::upload_batch(&mut c,&root,&files(),"/upload/job",&stop,"guard-count",false,&|_|Ok(()),&|_,_|{}).unwrap();
    for(i,r)in results.iter().enumerate(){assert_eq!(r.commit,BatchCommit::Committed);assert!(matches!(r.result,Ok(SourceOutcome::Complete(_))));assert_eq!(fs::read(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap(),vec![65+i as u8;6]);}
    let m=f.metrics();assert_eq!(m["counts"]["LSTAT"],36,"four files x (4 initial ancestor +1 target +4 final ancestor)");
    assert_eq!(m["counts"]["REALPATH"],4);assert_eq!(m["counts"]["EXTENDED"],4);assert_eq!(m["counts"]["WRITE"],4);assert!(m["counts"]["MKDIR"].is_null());
}

#[test]
fn noncreating_upload_refuses_missing_file_junction_and_unknown_ancestor_without_staging() {
    for kind in ["missing","file","junction","unknown-mode","server-error","target-type"] {
        let f=Fixture::start(&format!("compare-guard-{kind}"));stable_comparison_candidates(&f);
        let parent=f.remote.join("upload/job/nested");
        if ["missing","file","junction"].contains(&kind) {
            fs::rename(&parent,f.remote.join("upload/job/nested-saved")).unwrap();
            if kind=="file" {fs::write(&parent,b"generated non-directory").unwrap();}
            if kind=="junction" {
                let outside=f.remote.join("other/generated-outside");fs::create_dir(&outside).unwrap();fs::write(outside.join("sentinel.txt"),b"generated untouched").unwrap();
                let result=Command::new("node").args(["-e","require('fs').symlinkSync(process.argv[1],process.argv[2],'junction')"]).arg(&outside).arg(&parent).output().unwrap();assert!(result.status.success());
            }
        }
        let root=f.root.join("local").canonicalize().unwrap();let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
        let results=sftp::upload_batch(&mut c,&root,&files(),"/upload/job",&stop,"guard-refuse",false,&|_|Ok(()),&|_,_|{}).unwrap();
        for r in results{assert!(r.result.is_err(),"{kind}");assert_eq!(r.commit,BatchCommit::NotCommitted);}
        let m=f.metrics();for op in ["OPEN","WRITE","EXTENDED","MKDIR"]{assert!(m["counts"][op].is_null(),"{kind}/{op}");}
        if kind=="junction"{assert_eq!(fs::read(f.remote.join("other/generated-outside/sentinel.txt")).unwrap(),b"generated untouched");assert_eq!(fs::read_dir(f.remote.join("other/generated-outside")).unwrap().count(),1);}
    }
}

#[test]
fn replacement_between_parent_guard_and_stage_open_cannot_write_or_commit() {
    let f=Fixture::start("compare-guard-parent-at-open");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    let results=sftp::upload_batch(&mut c,&root,&files(),"/upload/job",&stop,"guard-open-race",false,&|_|Ok(()),&|_,_|{}).unwrap();
    for r in results{assert!(r.result.is_err());assert_eq!(r.commit,BatchCommit::NotCommitted);}
    let m=f.metrics();assert!(m["counts"]["WRITE"].is_null());assert!(m["counts"]["EXTENDED"].is_null());
    for i in 0..4{assert_eq!(fs::read(f.remote.join(format!("upload/job/nested-saved/file{i}.txt"))).unwrap(),b"stable");}
}

#[test]
fn parent_change_after_staging_write_still_fails_fresh_commit_guard() {
    let f=Fixture::start("compare-guard-postwrite");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    let results=sftp::upload_batch(&mut c,&root,&files(),"/upload/job",&stop,"guard-commit-race",false,&|_|Ok(()),&|_,_|{}).unwrap();
    for r in results{assert!(r.result.is_err());assert_eq!(r.commit,BatchCommit::NotCommitted);}
    let m=f.metrics();assert_eq!(m["counts"]["WRITE"],4);assert!(m["counts"]["EXTENDED"].is_null());
    for i in 0..4{assert_eq!(fs::read(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap(),b"stable");}
}

#[test]
fn cancellation_while_strict_parent_guard_is_pending_dispatches_no_writes() {
    use std::sync::{Arc,atomic::Ordering};
    let f=Fixture::start("compare-guard-cancel");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let stop=Arc::new(AtomicBool::new(false));let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    let signal=stop.clone();let held=f.root.join("server/guard-held");let cancel=thread::spawn(move||{let deadline=Instant::now()+Duration::from_secs(10);while !held.exists()&&Instant::now()<deadline{thread::sleep(Duration::from_millis(2));}let seen=held.exists();signal.store(true,Ordering::SeqCst);seen});
    let results=sftp::upload_batch(&mut c,&root,&files(),"/upload/job",&stop,"guard-cancel",false,&|_|Ok(()),&|_,_|{}).unwrap();assert!(cancel.join().unwrap());
    for r in results{assert!(r.result.is_err());assert_eq!(r.commit,BatchCommit::NotCommitted);}
    let m=f.metrics();assert!(m["counts"]["WRITE"].is_null());assert!(m["counts"]["OPEN"].is_null());assert!(m["counts"]["EXTENDED"].is_null());
}
