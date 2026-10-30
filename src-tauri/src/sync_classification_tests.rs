//! Diagnostic-only generated loopback cases for reports of same-file uploads.
//! These describe current decisions, not proof that user files are identical.
use super::*;
use std::sync::atomic::AtomicBool;
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
fn diagnostic_windows_attribute_only_notice_reuploads_unchanged_content() {
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
    caught(&e, "attribute-diagnostic", 1);
    let notice = rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    let report=serde_json::to_value(e.status("attribute-diagnostic").unwrap()).unwrap();assert!(report["syncDecisions"]["counts"]["watcher_forced_candidate"].as_u64().unwrap()>0);assert_eq!(report["syncDecisions"]["counts"]["upload_dispatched"],1);
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
fn own_parallel_upload_notice_batch_skips_all_peers_and_restart_has_no_content_baseline() {
    let f=Fixture::start("compare-snapshot-content-batch");stable_comparison_candidates(&f);
    for i in 0..4{fs::remove_file(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap();}
    let e=Engine::default();f.start_job(&e,"content-batch",f.root.join("local"),"/upload/job",false);caught(&e,"content-batch",4);
    let mut restore=Vec::new();
    for i in 0..4{let p=f.root.join(format!("local/nested/file{i}.txt"));let mut permissions=fs::metadata(&p).unwrap().permissions();restore.push((p.clone(),permissions.clone()));permissions.set_readonly(true);fs::set_permissions(p,permissions).unwrap();}
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{let s=e.status("content-batch").unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);assert_eq!(s.sent,4);if s.logs.iter().filter(|l|l.contains("Skipped unchanged content after local notice")).count()>=4{break;}assert!(Instant::now()<deadline,"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}
    e.stop("content-batch").unwrap();
    // Restart never assumes that current local bytes equal a previous remote session.
    f.start_job(&e,"content-batch",f.root.join("local"),"/upload/job",false);caught(&e,"content-batch",0);
    for(p,permissions)in &restore{fs::set_permissions(p,permissions.clone()).unwrap();}
    caught(&e,"content-batch",4);assert_eq!(e.status("content-batch").unwrap().sent,4);
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
