//! Diagnostic-only generated loopback cases for reports of same-file uploads.
//! These describe current decisions, not proof that user files are identical.
use super::*;
use std::sync::atomic::AtomicBool;
// Investigation-only regression matrix for the actual anonymous pre.3 report.
// No product policy change. The WinSCP column is a source-derived model for
// keep-up-to-date's known whole-second timestamps, not execution of WinSCP.
#[test]
#[ignore = "generated localhost remote-newer policy diagnosis"]
fn pre3_remote_newer_policy_matrix_matches_actual_diagnostic_samples() {
    let f=Fixture::start("compare-snapshot-policy-matrix");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let relative=Path::new("nested/file0.txt");
    let local=root.join(relative);let remote=f.remote.join("upload/job").join(relative);
    let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    let cases=[
        ("remote_older",469,469,1793174017u64,1793173977u64,true,true),
        ("equal_metadata_different_bytes",469,469,1793174017,1793174017,false,false),
        ("actual_sample_remote_newer40",469,469,1793174017,1793174057,true,false),
        ("size_mismatch_equal_time",351,353,1793154129,1793154129,true,false),
        ("actual_sample_size_remote_newer13078",351,353,1793154129,1793167207,true,false),
        ("size_mismatch_local_newer",351,353,1793154129,1793154089,true,true),
        ("one_second_precision_difference",469,469,1793174017,1793174018,true,false),
    ];
    for(name,ls,rs,lt,rt,nearly_upload,winscp_model_upload)in cases {
        fs::write(&local,vec![b'L';ls]).unwrap();fs::write(&remote,vec![b'R';rs]).unwrap();
        for(path,time)in[(&local,lt),(&remote,rt)]{fs::File::options().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(time))).unwrap();}
        let result=crate::sftp::compare_file(&mut c,&root,relative,"/upload/job",&stop).unwrap();
        assert_eq!(matches!(result,crate::sftp::FileComparison::Upload{..}),nearly_upload,"{name}");
        if let crate::sftp::FileComparison::Upload{remote_newer}=result {assert_eq!(remote_newer,rt>lt,"{name}");}
        assert_eq!(lt>=rt+2,winscp_model_upload,"known timestamp keep-up-to-date source model: {name}");
        println!("{name}: local={ls}B@{lt} remote={rs}B@{rt} nearly_upload={nearly_upload} winscp_source_model_upload={winscp_model_upload}");
    }
    fs::remove_file(&remote).unwrap();
    assert!(matches!(crate::sftp::compare_file(&mut c,&root,relative,"/upload/job",&stop).unwrap(),crate::sftp::FileComparison::Upload{remote_newer:false}));
    assert!(f.metrics()["counts"]["WRITE"].is_null(),"comparisons must not upload fixture content");
}

#[test]
#[ignore = "generated localhost remote-newer policy diagnosis"]
fn watch_real_edit_with_old_mtime_conflicts_if_remote_changed() {
    let f=Fixture::start("compare-snapshot-policy-watch");stable_comparison_candidates(&f);
    let e=Engine::default();f.start_job(&e,"policy-watch",f.root.join("local"),"/upload/job",false);caught(&e,"policy-watch",0);
    let local=f.root.join("local/nested/file0.txt");let remote=f.remote.join("upload/job/nested/file0.txt");
    let original=fs::metadata(&local).unwrap().modified().unwrap();
    fs::write(&remote,b"remote").unwrap();fs::File::options().write(true).open(&remote).unwrap().set_times(fs::FileTimes::new().set_modified(original+Duration::from_secs(40))).unwrap();
    // Real edit with identical size and a deliberately preserved old timestamp.
    fs::write(&local,b"edited").unwrap();fs::File::options().write(true).open(&local).unwrap().set_times(fs::FileTimes::new().set_modified(original)).unwrap();
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{let s=e.status("policy-watch").unwrap();if let Some(failure)=s.failure{assert_eq!(failure.operation,"conflict");assert_eq!(s.sent,0);break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
    assert_eq!(fs::read(&remote).unwrap(),b"remote");
    assert_eq!(fs::read(&local).unwrap(),b"edited");
    let status=serde_json::to_value(e.status("policy-watch").unwrap()).unwrap();
    assert!(status["syncDecisions"]["counts"]["watcher_forced_candidate"].as_u64().unwrap()>0);
    assert_eq!(status["syncDecisions"]["counts"]["sync_conflict"],1);
    e.stop("policy-watch").unwrap();
}
fn caught(e: &Engine, id: &str, sent: u64) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let s = e.status(id).unwrap();
        assert!(s.failure.is_none(), "{:?}", s.logs);
        if s.sent >= sent && serde_json::to_value(&s).unwrap()["syncPhase"] == "caught_up" { return; }
        assert!(Instant::now() < deadline, "{:?}", s.logs);
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn initial_policy_retains_remote_newer_same_size_and_sends_local_newer() {
    for(remote_delta,expected_sent)in[(40i64,0u64),(-40,1),(0,0)]{
        let f=Fixture::start("compare-snapshot-initial-policy");stable_comparison_candidates(&f);
        let local=f.root.join("local/nested/file0.txt");let remote=f.remote.join("upload/job/nested/file0.txt");
        fs::write(&local,vec![b'L';469]).unwrap();fs::write(&remote,vec![b'R';469]).unwrap();
        for(path,time)in[(&local,1793174017u64),(&remote,(1793174017i64+remote_delta)as u64)]{fs::File::options().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(time))).unwrap();}
        let e=Engine::default();f.start_job(&e,"initial-policy",f.root.join("local"),"/upload/job",false);caught(&e,"initial-policy",expected_sent);
        assert_eq!(e.status("initial-policy").unwrap().sent,expected_sent,"remote-minus-local {remote_delta}s");
        assert_eq!(fs::read(remote).unwrap(),vec![if expected_sent==1{b'L'}else{b'R'};469]);e.stop("initial-policy").unwrap();
    }
}

#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn initial_policy_equal_time_or_remote_newer_size_difference_is_conflict() {
    for(remote_delta,mirror)in[(0i64,false),(13078,false),(13078,true)]{
        let f=Fixture::start("compare-snapshot-initial-conflict");stable_comparison_candidates(&f);
        let local=f.root.join("local/nested/file0.txt");let remote=f.remote.join("upload/job/nested/file0.txt");
        fs::write(&local,vec![b'L';351]).unwrap();fs::write(&remote,vec![b'R';353]).unwrap();
        for(path,time)in[(&local,1793154129u64),(&remote,(1793154129i64+remote_delta)as u64)]{fs::File::options().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(time))).unwrap();}
        let e=Engine::default();f.start_job(&e,"initial-conflict",f.root.join("local"),"/upload/job",mirror);
        let deadline=Instant::now()+Duration::from_secs(15);loop{let s=e.status("initial-conflict").unwrap();if s.failure.is_some(){let failure=s.failure.unwrap();assert_eq!(failure.operation,"conflict");assert_eq!(failure.relative_path.unwrap().replace('\\',"/"),"nested/file0.txt");break;}assert!(Instant::now()<deadline,"must surface conflict, sent={}",s.sent);thread::sleep(Duration::from_millis(5));}
        assert_eq!(fs::read(remote).unwrap(),vec![b'R';353]);assert_eq!(fs::read(local).unwrap(),vec![b'L';351]);e.stop("initial-conflict").unwrap();
    }
}

#[test]
#[ignore="generated localhost approved policy benchmark"]
fn initial_remote_newer_4000_generated_benchmark() {
    let expected=std::env::var("NEARLY_POLICY_EXPECT_SENT").unwrap().parse::<u64>().unwrap();
    assert!(expected==0||expected==4000);
    let f=Fixture::start("compare-snapshot-policy-bulk");let root=f.root.join("bulk-local");fs::create_dir_all(&root).unwrap();
    let remote=f.remote.join("policy-bulk/a/b");fs::create_dir_all(&remote).unwrap();
    for index in 0..4000{let relative=format!("g{}/s{}/file{index:04}.txt",index/400,(index/100)%4);for(base,seconds)in[(&root,1700000000),(&remote,1700000040)]{let file=base.join(&relative);fs::create_dir_all(file.parent().unwrap()).unwrap();fs::write(&file,vec![(index%251)as u8;512]).unwrap();fs::File::options().write(true).open(file).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(seconds))).unwrap();}}
    let start=Instant::now();let e=Engine::default();f.start_job(&e,"policy-bulk",root.clone(),"/policy-bulk/a/b",false);
    let deadline=Instant::now()+Duration::from_secs(240);loop{let s=e.status("policy-bulk").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"{assert_eq!(s.sent,expected);break;}assert!(Instant::now()<deadline,"bulk did not finish: sent{} pending{}",s.sent,s.pending);thread::sleep(Duration::from_millis(5));}
    let elapsed=start.elapsed().as_millis();let status=serde_json::to_value(e.status("policy-bulk").unwrap()).unwrap();let metrics=f.metrics();e.stop("policy-bulk").unwrap();
    for index in 0..4000{let relative=format!("g{}/s{}/file{index:04}.txt",index/400,(index/100)%4);assert_eq!(fs::read(remote.join(&relative)).unwrap(),fs::read(root.join(&relative)).unwrap());}
    if let Ok(count)=std::env::var("NEARLY_POLICY_EXPECT_LSTAT"){assert_eq!(metrics["counts"]["LSTAT"].as_u64().unwrap(),count.parse::<u64>().unwrap());}
    let delay=std::env::var("NEARLY_POLICY_LSTAT_DELAY_MS").unwrap_or_else(|_|"20".into()).parse::<u64>().unwrap();
    let result=serde_json::json!({"generatedOnly":true,"files":4000,"bytes":2048000,"directories":50,"generatedDirectoriesBelowRoot":50,"listedFileParentDirectories":40,"remoteRoot":"/policy-bulk/a/b","deleteRemoved":false,"lstatResponseDelayMs":delay,"remoteNewerSeconds":40,"elapsedMs":elapsed,"expectedSent":expected,"sent":status["sent"],"counts":metrics["counts"],"diagnostics":status["syncDecisions"]});
    let output=std::env::var("NEARLY_POLICY_RESULT").unwrap();fs::write(output,serde_json::to_vec_pretty(&result).unwrap()).unwrap();println!("POLICY_BULK {}",result);
}

#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn retained_remote_baseline_sends_real_old_timestamp_edits_but_not_attribute_notices() {
    for mirror in [false,true]{
        let f=Fixture::start("compare-snapshot-policy-watching");stable_comparison_candidates(&f);
        let local=f.root.join("local/nested/file0.txt");let remote=f.remote.join("upload/job/nested/file0.txt");
        let original=fs::metadata(&local).unwrap().modified().unwrap();
        fs::File::options().write(true).open(&remote).unwrap().set_times(fs::FileTimes::new().set_modified(original+Duration::from_secs(40))).unwrap();
        let e=Engine::default();f.start_job(&e,"retained-watch",f.root.join("local"),"/upload/job",mirror);caught(&e,"retained-watch",0);
        assert_eq!(serde_json::to_value(e.status("retained-watch").unwrap()).unwrap()["syncDecisions"]["counts"]["remote_newer_retained"],1);
        // Same size and timestamp, but real new bytes: never treat metadata as a no-op.
        fs::write(&local,b"edited").unwrap();fs::File::options().write(true).open(&local).unwrap().set_times(fs::FileTimes::new().set_modified(original)).unwrap();
        caught(&e,"retained-watch",1);assert_eq!(fs::read(&remote).unwrap(),b"edited");
        fs::write(&local,b"second").unwrap();fs::File::options().write(true).open(&local).unwrap().set_times(fs::FileTimes::new().set_modified(original-Duration::from_secs(100))).unwrap();
        caught(&e,"retained-watch",2);assert_eq!(fs::read(&remote).unwrap(),b"second");
        e.stop("retained-watch").unwrap();
        // Fresh restart resamples both sides; no stale baseline from the last run.
        f.start_job(&e,"retained-watch",f.root.join("local"),"/upload/job",mirror);caught(&e,"retained-watch",0);assert_eq!(e.status("retained-watch").unwrap().sent,0);e.stop("retained-watch").unwrap();
    }
}

#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn policy_checks_before_stage_and_before_commit_and_new_file_no_clobber() {
    use crate::sftp::{self,SyncPolicy};
    for mode in ["compare-snapshot-policy-prewrite","compare-snapshot-policy-postwrite","compare-snapshot-policy-create-race","compare-snapshot-policy-final-create-race"]{
        let f=Fixture::start(mode);stable_comparison_candidates(&f);
        let root=f.root.join("local").canonicalize().unwrap();let relative=Path::new("nested/file0.txt");let target=f.remote.join("upload/job").join(relative);
        let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();c.sync_policy=Some(SyncPolicy::default());
        c.sync_mark_initial("/upload/job",relative).unwrap();
        if mode.ends_with("create-race"){fs::remove_file(&target).unwrap();}
        // Establish initial evidence from a fresh comparison, then stage a genuine local edit.
        sftp::compare_file(&mut c,&root,relative,"/upload/job",&stop).unwrap();fs::write(root.join(relative),b"edited").unwrap();
        if mode.ends_with("prewrite"){fs::write(&target,b"external-before-write").unwrap();}
        let result=sftp::upload(&mut c,&root,relative,"/upload/job",&stop,"policy-race");assert!(result.is_err(),"{mode} must not overwrite");
        assert_eq!(fs::read(&target).unwrap(),if mode.ends_with("prewrite"){b"external-before-write".as_slice()}else{b"external-during-write".as_slice()},"{mode}");
        let metrics=f.metrics();if mode.ends_with("prewrite"){assert!(metrics["counts"]["WRITE"].is_null());}else{assert!(metrics["counts"]["WRITE"].as_u64().unwrap()>0);}
        assert!(metrics["counts"]["EXTENDED"].is_null(),"{mode}");
        // Reconnect retains the job's comparison evidence and still refuses stale saves.
        let policy=c.sync_policy.clone();drop(c);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();c.sync_policy=policy;
        assert!(sftp::upload(&mut c,&root,relative,"/upload/job",&stop,"policy-reconnect").is_err());
    }
}

#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn modify_then_delete_preserves_guarded_mirror_delete_and_nonmirror_skip() {
    for mirror in [false,true]{
        let f=Fixture::start("compare-snapshot-policy-delete");stable_comparison_candidates(&f);
        let root=f.root.join("local");let local=root.join("nested/file0.txt");let remote=f.remote.join("upload/job/nested/file0.txt");
        let e=Engine::default();f.start_job(&e,"policy-delete",root,"/upload/job",mirror);caught(&e,"policy-delete",0);
        let changed=Instant::now();fs::write(&local,b"edited").unwrap();fs::remove_file(&local).unwrap();
        let deadline=Instant::now()+Duration::from_secs(15);
        loop{let s=e.status("policy-delete").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if changed.elapsed()>=Duration::from_secs(1)&&s.pending==0&&(!mirror||!remote.exists()){break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
        assert_eq!(remote.exists(),!mirror);assert_eq!(e.status("policy-delete").unwrap().sent,0);
        if mirror{fs::write(&local,b"recreated").unwrap();caught(&e,"policy-delete",1);assert_eq!(fs::read(&remote).unwrap(),b"recreated");}
        e.stop("policy-delete").unwrap();
    }
}

#[cfg(windows)]
#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn real_edit_cannot_batch_unchanged_attribute_peers_over_retained_remote() {
    let f=Fixture::start("compare-snapshot-policy-peer-notices");stable_comparison_candidates(&f);
    let root=f.root.join("local");let remote=f.remote.join("upload/job/nested");
    for i in 0..8{let target=remote.join(format!("file{i}.txt"));fs::write(&target,b"remote").unwrap();fs::File::options().write(true).open(target).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000040))).unwrap();}
    let e=Engine::default();f.start_job(&e,"policy-peers",root.clone(),"/upload/job",false);caught(&e,"policy-peers",0);
    fs::write(root.join("nested/file0.txt"),b"edited").unwrap();
    struct Restore(Vec<(PathBuf,fs::Permissions)>);impl Drop for Restore{fn drop(&mut self){for(p,perm)in &self.0{let _=fs::set_permissions(p,perm.clone());}}}
    let mut restore=Restore(Vec::new());
    for i in 1..8{let source=root.join(format!("nested/file{i}.txt"));let mut permissions=fs::metadata(&source).unwrap().permissions();restore.0.push((source.clone(),permissions.clone()));permissions.set_readonly(true);fs::set_permissions(source,permissions).unwrap();}
    let deadline=Instant::now()+Duration::from_secs(20);
    loop{let s=e.status("policy-peers").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert!(s.sent<=1,"unchanged peers must not upload: {:?}",s.logs);if s.sent==1&&s.logs.iter().filter(|l|l.contains("Skipped unchanged content after local notice")).count()>=7{break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
    assert_eq!(fs::read(remote.join("file0.txt")).unwrap(),b"edited");for i in 1..8{assert_eq!(fs::read(remote.join(format!("file{i}.txt"))).unwrap(),b"remote");}
    e.stop("policy-peers").unwrap();drop(restore);
}

#[cfg(windows)]
#[test]
#[ignore="generated localhost approved initial/watch policy"]
fn retained_remote_attribute_notice_cannot_be_promoted_after_reconnect_or_unrelated_event() {
    for reconnect in [false,true]{
        let f=Fixture::start(if reconnect{"compare-snapshot-policy-reconnect"}else{"compare-snapshot-content-race"});stable_comparison_candidates(&f);
        let root=f.root.join("local").canonicalize().unwrap();let source=root.join("nested/file0.txt");let remote=f.remote.join("upload/job/nested/file0.txt");
        fs::write(&remote,b"remote").unwrap();fs::File::options().write(true).open(&remote).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000040))).unwrap();
        let e=Engine::default();f.start_job(&e,"policy-epoch",root.clone(),"/upload/job",false);caught(&e,"policy-epoch",0);
        if reconnect{
            fs::write(f.root.join("server/request-disconnect"),b"generated").unwrap();
            let deadline=Instant::now()+Duration::from_secs(10);while !f.root.join("server/disconnected").exists(){assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
            thread::sleep(Duration::from_millis(200));
        }else{fs::write(f.root.join("server/hold-content-compare"),b"generated").unwrap();}
        struct Restore(PathBuf,fs::Permissions);impl Drop for Restore{fn drop(&mut self){let _=fs::set_permissions(&self.0,self.1.clone());}}
        let restore=Restore(source.clone(),fs::metadata(&source).unwrap().permissions());let mut permissions=restore.1.clone();permissions.set_readonly(true);fs::set_permissions(&source,permissions).unwrap();
        if !reconnect{
            let deadline=Instant::now()+Duration::from_secs(15);while !f.root.join("server/content-compare-held").exists(){assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
            let probe=crate::engine::sync_notice_test_hooks::register(root.clone());let before=probe.count();
            fs::write(root.join("nested/file1.txt"),b"edited").unwrap();
            while probe.count()==before{assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
            fs::write(f.root.join("server/release-content-compare"),b"generated").unwrap();
        }
        let deadline=Instant::now()+Duration::from_secs(20);
        loop{let s=e.status("policy-epoch").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert!(s.sent<=u64::from(!reconnect),"{:?}",s.logs);if s.sent==u64::from(!reconnect)&&serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"&&s.logs.iter().any(|l|l.contains(if reconnect{"Opening a new verified"}else{"Skipped unchanged content after local notice"})){break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
        assert_eq!(fs::read(&remote).unwrap(),b"remote");if reconnect{assert_eq!(f.metrics()["connections"],2);}
        e.stop("policy-epoch").unwrap();drop(restore);
    }
}

#[test]
#[ignore = "generated localhost classification diagnosis"]
fn diagnostic_identical_bytes_with_different_mtimes_are_not_content_compared() {
    let f = Fixture::start("compare-snapshot-classification");
    stable_comparison_candidates(&f);
    let root = f.root.join("local").canonicalize().unwrap();
    let stop = AtomicBool::new(false);
    let (mut connection, _) = crate::sftp::connect(&f.profile, &f.secret, &stop).unwrap();
    let report=crate::engine::sync_decisions::Diagnostics::default();connection.diagnostics=Some(report.clone());
    let local_time = 1_700_000_001u64;
    for offset in [0i64, -1, 1, -60] {
        let local = root.join("nested/file0.txt");
        let remote = f.remote.join("upload/job/nested/file0.txt");
        for (path, seconds) in [(&local, local_time), (&remote, (local_time as i64 + offset) as u64)] {
            fs::File::options().write(true).open(path).unwrap().set_times(
                fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds))
            ).unwrap();
        }
        assert_eq!(fs::read(&local).unwrap(), fs::read(&remote).unwrap());
        let relative = PathBuf::from("nested/file0.txt");
        let result = crate::sftp::compare_file(&mut connection, &root, &relative, "/upload/job", &stop).unwrap();
        assert_eq!(matches!(result, crate::sftp::FileComparison::Unchanged(_)), offset == 0);
        let snapshot = crate::sftp::comparison_snapshot(&mut connection, "/upload/job", &[relative.clone()], 1, &stop).unwrap().unwrap();
        let candidate = crate::sftp::listing_candidate(&root, &relative, snapshot.hints.get(&relative).unwrap(), 1, &stop).unwrap();
        assert_eq!(candidate == crate::listing_hint::Candidate::ListedUnchanged, offset == 0);
        println!("generated identical bytes: remote-minus-local={offset}s fresh_unchanged={} listing={candidate:?}", matches!(result, crate::sftp::FileComparison::Unchanged(_)));
    }
    // Size-only equality must never become permission to skip an actual edit.
    fs::write(root.join("nested/file0.txt"), b"changed-size").unwrap();
    for path in [root.join("nested/file0.txt"),f.remote.join("upload/job/nested/file0.txt")] {
        fs::File::options().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(local_time))).unwrap();
    }
    let result = crate::sftp::compare_file(&mut connection, &root, Path::new("nested/file0.txt"), "/upload/job", &stop).unwrap();
    assert!(matches!(result, crate::sftp::FileComparison::Upload { .. }));
    let report=serde_json::to_value(report).unwrap();
    assert_eq!(report["counts"]["mtime_mismatch"],3);assert_eq!(report["counts"]["size_mismatch"],1);assert_eq!(report["counts"]["metadata_unchanged"],1);
    assert_eq!(report["examples"].as_array().unwrap().iter().find(|e|e["reason"]=="mtime_mismatch").unwrap()["remoteMinusLocalSeconds"],-1);
}

#[test]
#[ignore = "generated localhost classification diagnosis"]
fn diagnostic_same_bytes_mtime_mismatch_reuploads_then_nearly_preserved_restart_skips() {
    let f = Fixture::start("compare-snapshot-classification-engine");
    stable_comparison_candidates(&f);
    for i in 0..8 {
        fs::File::options().write(true).open(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap()
            .set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_699_999_999))).unwrap();
    }
    let e = Engine::default();
    f.start_job(&e, "mtime-diagnostic", f.root.join("local"), "/upload/job", false);
    caught(&e, "mtime-diagnostic", 8);
    assert_eq!(e.status("mtime-diagnostic").unwrap().sent, 8);
    let report=serde_json::to_value(e.status("mtime-diagnostic").unwrap()).unwrap();assert_eq!(report["syncDecisions"]["counts"]["mtime_mismatch"],8);
    e.stop("mtime-diagnostic").unwrap();
    f.start_job(&e, "mtime-diagnostic", f.root.join("local"), "/upload/job", false);
    caught(&e, "mtime-diagnostic", 0);
    assert_eq!(e.status("mtime-diagnostic").unwrap().sent, 0);
    let report=serde_json::to_value(e.status("mtime-diagnostic").unwrap()).unwrap();assert!(report["syncDecisions"]["counts"]["mtime_mismatch"].is_null());assert_eq!(report["syncDecisions"]["counts"]["metadata_unchanged"],8);
    e.stop("mtime-diagnostic").unwrap();
    println!("generated 8 identical-byte files: different mtime sent8; restart after Nearly timestamp preservation sent0");
}

#[cfg(windows)]
#[test]
#[ignore = "generated localhost classification diagnosis"]
fn initial_local_content_baseline_skips_windows_attribute_only_notice() {
    let f = Fixture::start("compare-snapshot-classification-attributes");
    stable_comparison_candidates(&f);
    let e = Engine::default();
    f.start_job(&e, "attribute-diagnostic", f.root.join("local"), "/upload/job", false);
    caught(&e, "attribute-diagnostic", 0);
    assert_eq!(e.status("attribute-diagnostic").unwrap().sent, 0);
    let file = f.root.join("local/nested/file0.txt");
    let before = fs::metadata(&file).unwrap();
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| { let _ = tx.send(event); }).unwrap();
    watcher.watch(&file, notify::RecursiveMode::NonRecursive).unwrap();
    struct Restore(PathBuf, fs::Permissions);
    impl Drop for Restore { fn drop(&mut self) { let _ = fs::set_permissions(&self.0, self.1.clone()); } }
    let restore = Restore(file.clone(), before.permissions());
    let mut permissions = before.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&file, permissions).unwrap();
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), before.modified().unwrap());
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{let s=e.status("attribute-diagnostic").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert_eq!(s.sent,0);if s.logs.iter().any(|l|l.contains("Skipped unchanged content after local notice")){break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
    let notice = rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    let report=serde_json::to_value(e.status("attribute-diagnostic").unwrap()).unwrap();assert!(report["syncDecisions"]["counts"]["watcher_forced_candidate"].as_u64().unwrap()>0);assert!(report["syncDecisions"]["counts"]["upload_dispatched"].is_null());
    assert_eq!(notice.kind, notify::EventKind::Modify(notify::event::ModifyKind::Any));
    assert_eq!(fs::read(&file).unwrap(), fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap());
    println!("generated Windows read-only-attribute change: event={:?}, same bytes/size/mtime, sent={}", notice.kind, e.status("attribute-diagnostic").unwrap().sent);
    e.stop("attribute-diagnostic").unwrap();
    drop(restore);
}

#[cfg(windows)]
#[test]
#[ignore = "generated localhost content-notice regression"]
fn own_upload_content_evidence_skips_attribute_notice_but_sends_same_timestamp_edit() {
    for mirror in [false, true] {
        let f = Fixture::start("compare-snapshot-content-notice");
        stable_comparison_candidates(&f);
        fs::remove_file(f.remote.join("upload/job/nested/file0.txt")).unwrap();
        let e = Engine::default();
        f.start_job(&e, "content-notice", f.root.join("local"), "/upload/job", mirror);
        caught(&e, "content-notice", 1);
        let file = f.root.join("local/nested/file0.txt");
        let before = fs::metadata(&file).unwrap();
        struct Restore(PathBuf, fs::Permissions);
        impl Drop for Restore { fn drop(&mut self) { let _ = fs::set_permissions(&self.0, self.1.clone()); } }
        let restore = Restore(file.clone(), before.permissions());
        let mut permissions = before.permissions();permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let s = e.status("content-notice").unwrap();assert!(s.failure.is_none(), "{:?}", s.logs);
            assert_eq!(s.sent, 1, "attribute-only event must not write the same uploaded content");
            if s.logs.iter().any(|l| l.contains("Skipped unchanged content after local notice")) { break; }
            assert!(Instant::now() < deadline, "content notice was not processed: {:?}", s.logs);
            thread::sleep(Duration::from_millis(5));
        }
        let report=serde_json::to_value(e.status("content-notice").unwrap()).unwrap();let counts=&report["syncDecisions"]["counts"];
        assert_eq!(counts["remote_missing"],1);assert_eq!(counts["upload_dispatched"],1);
        // Observations are not distinct-file counts: a slow peer/watch notice can
        // legitimately trigger another read-only comparison before settling.
        assert!(counts["metadata_unchanged"].as_u64().unwrap()>=7);
        assert!(counts["watcher_forced_candidate"].as_u64().unwrap()>0);assert!(counts["uploaded_content_unchanged"].as_u64().unwrap()>0);
        // A real edit has the exact old size AND timestamp: metadata alone cannot skip it.
        fs::set_permissions(&file, restore.1.clone()).unwrap();
        fs::write(&file, b"change").unwrap();
        fs::File::options().write(true).open(&file).unwrap().set_times(
            fs::FileTimes::new().set_modified(before.modified().unwrap())
        ).unwrap();
        caught(&e, "content-notice", 2);
        assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(), b"change");
        e.stop("content-notice").unwrap();drop(restore);
    }
}

#[test]
#[ignore = "generated localhost content-notice regression"]
fn uploaded_content_evidence_never_survives_remote_change_reconnect_or_atomic_replacement() {
    use crate::sftp::{self, SourceOutcome};
    let f = Fixture::start("compare-snapshot-content-guards");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let path=Path::new("nested/file0.txt");
    let stop=AtomicBool::new(false);let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    assert!(matches!(sftp::upload(&mut c,&root,path,"/upload/job",&stop,"content-guards").unwrap(),SourceOutcome::Complete(_)));
    assert!(c.has_upload_fingerprint(&root,path,"/upload/job"));
    assert!(sftp::unchanged_uploaded_content(&mut c,&root,path,"/upload/job",&stop).unwrap());
    // A changed remote is not covered by a local fingerprint.
    let target=f.remote.join("upload/job").join(path);
    fs::File::options().write(true).open(&target).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1_700_000_001))).unwrap();
    assert!(!sftp::unchanged_uploaded_content(&mut c,&root,path,"/upload/job",&stop).unwrap());
    assert!(!c.has_upload_fingerprint(&root,path,"/upload/job"));
    sftp::upload(&mut c,&root,path,"/upload/job",&stop,"content-guards").unwrap();
    let old=fs::metadata(root.join(path)).unwrap();let next=root.join("nested/replacement.txt");
    fs::write(&next,b"change").unwrap();fs::File::options().write(true).open(&next).unwrap().set_times(fs::FileTimes::new().set_modified(old.modified().unwrap())).unwrap();
    fs::rename(&next,root.join(path)).unwrap();
    assert!(!sftp::unchanged_uploaded_content(&mut c,&root,path,"/upload/job",&stop).unwrap());
    sftp::upload(&mut c,&root,path,"/upload/job",&stop,"content-guards").unwrap();
    let stopped=AtomicBool::new(true);
    assert!(sftp::unchanged_uploaded_content(&mut c,&root,path,"/upload/job",&stopped).is_err());
    drop(c);
    let(mut c,_)=sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    assert!(!c.has_upload_fingerprint(&root,path,"/upload/job"));
    assert!(!sftp::unchanged_uploaded_content(&mut c,&root,path,"/upload/job",&stop).unwrap());
    println!("generated decisions: own-upload+same-content => fresh-guarded skip; remote-mtime, replaced-source, new-connection => no skip; stopped => error");
}

#[cfg(windows)]
#[test]
#[ignore = "generated localhost content-notice regression"]
fn own_parallel_upload_notice_batch_skips_all_peers_and_restart_recaptures_local_baseline() {
    let f=Fixture::start("compare-snapshot-content-batch");stable_comparison_candidates(&f);
    for i in 0..4{fs::remove_file(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap();}
    let e=Engine::default();f.start_job(&e,"content-batch",f.root.join("local"),"/upload/job",false);caught(&e,"content-batch",4);
    let mut restore=Vec::new();
    for i in 0..4{let p=f.root.join(format!("local/nested/file{i}.txt"));let mut permissions=fs::metadata(&p).unwrap().permissions();restore.push((p.clone(),permissions.clone()));permissions.set_readonly(true);fs::set_permissions(p,permissions).unwrap();}
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{let s=e.status("content-batch").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert_eq!(s.sent,4);if s.logs.iter().filter(|l|l.contains("Skipped unchanged content after local notice")).count()>=4{break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
    e.stop("content-batch").unwrap();
    // Restart captures a fresh local baseline after a fresh initial comparison.
    f.start_job(&e,"content-batch",f.root.join("local"),"/upload/job",false);caught(&e,"content-batch",0);
    for(p,permissions)in &restore{fs::set_permissions(p,permissions.clone()).unwrap();}
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{let s=e.status("content-batch").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert_eq!(s.sent,0);if s.logs.iter().filter(|l|l.contains("Skipped unchanged content after local notice")).count()>=4{break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
    e.stop("content-batch").unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "generated localhost content-notice regression"]
fn newer_exact_timestamp_edit_during_content_comparison_is_not_consumed_as_noop() {
    let f=Fixture::start("compare-snapshot-content-race");stable_comparison_candidates(&f);
    fs::remove_file(f.remote.join("upload/job/nested/file0.txt")).unwrap();
    let root=f.root.join("local").canonicalize().unwrap();
    let probe=crate::engine::sync_notice_test_hooks::register(root.clone());
    let e=Engine::default();f.start_job(&e,"content-race",root.clone(),"/upload/job",false);caught(&e,"content-race",1);
    let source=root.join("nested/file0.txt");let before=fs::metadata(&source).unwrap();let mut permissions=before.permissions();permissions.set_readonly(true);
    fs::write(f.root.join("server/hold-content-compare"),b"generated").unwrap();fs::set_permissions(&source,permissions).unwrap();
    let deadline=Instant::now()+Duration::from_secs(15);
    while !f.root.join("server/content-compare-held").exists(){assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
    let observed=probe.count();fs::set_permissions(&source,before.permissions()).unwrap();fs::write(&source,b"change").unwrap();
    fs::File::options().write(true).open(&source).unwrap().set_times(fs::FileTimes::new().set_modified(before.modified().unwrap())).unwrap();
    while probe.count()==observed{assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(2));}
    fs::write(f.root.join("server/release-content-compare"),b"generated").unwrap();caught(&e,"content-race",2);
    assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(),b"change");
    e.stop("content-race").unwrap();
}

#[test]
#[ignore = "generated localhost content-notice regression"]
fn large_uploaded_file_has_no_notice_fingerprint_or_extra_hash_scan() {
    let f=Fixture::start("compare-snapshot-content-large");stable_comparison_candidates(&f);
    let root=f.root.join("local").canonicalize().unwrap();let path=Path::new("nested/file0.txt");
    fs::write(root.join(path),vec![65;8*1024*1024+1]).unwrap();
    let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
    crate::sftp::upload(&mut c,&root,path,"/upload/job",&stop,"content-large").unwrap();
    assert!(!c.has_upload_fingerprint(&root,path,"/upload/job"));
    assert!(!crate::sftp::unchanged_uploaded_content(&mut c,&root,path,"/upload/job",&stop).unwrap());
    assert_eq!(fs::metadata(f.remote.join("upload/job").join(path)).unwrap().len(),8*1024*1024+1);
}
