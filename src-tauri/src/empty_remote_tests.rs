// Opt-in generated loopback fixture only; never loads saved connection settings.
use super::*;
fn manifest() -> (PathBuf, serde_json::Value, Profile) {
    let file=PathBuf::from(std::env::var("NEARLY_EMPTY_FIXTURE").unwrap());
    let root=file.parent().unwrap().canonicalize().unwrap();
    assert!(root.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
    let v:serde_json::Value=serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
    let p=Profile{id:"generated".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
    (root,v,p)
}
#[test]
#[ignore = "generated loopback protected directory creation regression"]
fn empty_remote_directory_creation_safety() {
    let (out,v,profile)=manifest();let remote=PathBuf::from(v["remote"].as_str().unwrap());
    let mode=v["mode"].as_str().unwrap();let stop=AtomicBool::new(false);
    let (mut connection,_)=sftp::connect(&profile,v["passphrase"].as_str().unwrap(),&stop).unwrap();
    let (root,relative)=match mode {
        "missing-root"=>("/upload/absent-root","child"),
        "missing-ancestor"=>("/absent/above/root","child"),
        "escape"=>("/upload/safe/root","../escape"),
        "symlink"=>("/upload/safe/root","link/child"),
        "file"=>("/upload/safe/root","file"),
        "slash-root"=>("/","generated-root-child"),
        _=>("/upload/safe/root","deep/leaf"),
    };
    std::fs::create_dir_all(remote.join("upload/safe/root/link")).unwrap();
    std::fs::write(remote.join("upload/safe/root/file"),b"unchanged sentinel").unwrap();
    let calls=std::cell::Cell::new(0);
    let verify=||{let n=calls.get()+1;calls.set(n);if mode=="local-change"&&n==2{return Err("generated local directory changed".into());}if mode=="cancel"{stop.store(true,Ordering::SeqCst);}Ok(())};
    let result=sftp::authorize_directory_observed(&mut connection,root,Path::new(relative),&stop,&verify);
    if mode=="create" || mode=="slash-root" {
        let (stamp,created)=result.unwrap();assert!(created);assert_eq!(calls.get(),2);
        let (again,created)=sftp::authorize_directory_observed(&mut connection,root,Path::new(relative),&stop,&||Ok(())).unwrap();assert!(!created);assert_eq!(stamp,again);
    }else {assert!(result.is_err(),"unsafe fixture accepted: {mode}");}
    assert!(!remote.join("upload/absent-root").exists());assert!(!remote.join("absent").exists());
    assert_eq!(std::fs::read(remote.join("upload/safe/root/file")).unwrap(),b"unchanged sentinel");
    std::fs::write(out.join("safety-result.json"),serde_json::to_vec(&serde_json::json!({"mode":mode,"local_verify_calls":calls.get(),"passed":true})).unwrap()).unwrap();
}
#[test]
#[ignore = "generated loopback absent-candidate behavior and failure contracts"]
fn empty_remote_absence_contracts() {
    let (out,v,profile)=manifest();let mode=v["mode"].as_str().unwrap();
    let local=out.join("local");let remote=PathBuf::from(v["remote"].as_str().unwrap()).join("upload").join(mode);
    std::fs::create_dir_all(&local).unwrap();std::fs::create_dir_all(&remote).unwrap();
    let stamp=|p:&Path|std::fs::File::options().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();
    let source_name=if matches!(mode,"replace-dir"|"rename-after") {"parent/a.txt"}else{"a.txt"};
    std::fs::create_dir_all(local.join(source_name).parent().unwrap()).unwrap();
    std::fs::write(local.join(source_name),if mode=="save-during" {vec![65;131072]}else{vec![65;128]}).unwrap();stamp(&local.join(source_name));
    if mode=="swap" {std::fs::create_dir_all(local.join("parent")).unwrap();std::fs::write(local.join("parent/child.txt"),b"local only").unwrap();}
    if mode=="save-during" {std::fs::write(local.join("b.txt"),b"fair peer").unwrap();}
    if mode=="excluded" {std::fs::create_dir_all(local.join("excluded")).unwrap();std::fs::write(local.join("excluded/no.txt"),b"must not upload").unwrap();std::fs::create_dir_all(remote.join("excluded")).unwrap();std::fs::write(remote.join("excluded/keep.txt"),b"keep").unwrap();}
    if mode=="unknown" {std::fs::write(remote.join("a.txt"),b"unknown attrs").unwrap();}
    if mode=="opaque" {std::fs::create_dir_all(remote.join("excluded")).unwrap();}
    let e=Engine::default();e.start("contract".into(),profile,local.to_string_lossy().into(),format!("/upload/{mode}"),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),SyncOptions{delete_removed:true,exclusion_rules:"excluded/".into(),..SyncOptions::default()}).unwrap();
    let deadline=Instant::now()+Duration::from_secs(30);let mut acted=false;
    loop {
        let status=e.status("contract").unwrap();
        if !acted && status.logs.iter().any(|s|s.starts_with("Mirror inventory verified")) {
            acted=true;
            if mode=="cancel" {assert_eq!(status.sent,0);e.stop("contract").unwrap();assert!(!remote.join("a.txt").exists());std::fs::write(out.join("contract-result.json"),b"{\"mode\":\"cancel\",\"passed\":true,\"sent\":0}").unwrap();return;}
            if mode=="save" {std::fs::write(local.join("a.txt"),vec![66;65536]).unwrap();}
            if mode=="replace-dir" {std::fs::rename(local.join("parent"),out.join("parked-source")).unwrap();std::fs::create_dir(local.join("parent")).unwrap();std::fs::write(local.join("parent/a.txt"),vec![66;128]).unwrap();}
            if mode=="reconnect" {std::fs::write(out.join("disconnect-now"),b"generated").unwrap();while !out.join("reconnected-ready").exists(){assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(2));}}
        }
        let failing=matches!(mode,"swap"|"incomplete"|"opaque"|"unknown"|"permission");
        if failing && status.stop_complete {assert!(status.error_count>0,"{mode}: {:?}",status.logs);break;}
        if !failing && status.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp {assert_eq!(status.error_count,0,"{:?}",status.logs);break;}
        assert!(Instant::now()<deadline,"{mode}: {:?}",status.logs);thread::sleep(Duration::from_millis(2));
    }
    let status=e.status("contract").unwrap();
    if mode=="replace-dir" {assert_eq!(std::fs::read(remote.join("parent/a.txt")).unwrap(),vec![66;128]);assert_eq!(status.sent,1);}
    if mode=="rename-after" {
        std::fs::rename(local.join("parent"),local.join("moved")).unwrap();
        loop {let s=e.status("contract").unwrap();assert_eq!(s.error_count,0,"{:?}",s.logs);if remote.join("moved/a.txt").exists()&&!remote.join("parent").exists(){break;}assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
        assert_eq!(std::fs::read(remote.join("moved/a.txt")).unwrap(),vec![65;128]);
    }
    if matches!(mode,"late"|"save"|"save-during"|"excluded") {assert_eq!(std::fs::read(remote.join("a.txt")).unwrap(),std::fs::read(local.join("a.txt")).unwrap());assert!(status.sent>=1);}
    if mode=="late" {assert_eq!(status.sent,1,"listed-absent candidate may reupload a concurrently created equal file");}
    if mode=="swap" {assert_eq!(status.sent,1,"safe root peer finishes before deferred unsafe-parent detection");assert!(!remote.join("parent/child.txt").exists());}
    if mode=="reconnect" {assert_eq!(status.sent,0,"stale absent candidate must not survive reconnect and overwrite equal remote file");assert!(status.logs.iter().any(|s|s.starts_with("Opening a new verified")));}
    if mode=="save-during" {assert_eq!(std::fs::read(remote.join("b.txt")).unwrap(),b"fair peer");assert!(status.logs.iter().any(|s|s.starts_with("Local source changed;")));}
    if mode=="excluded" {assert!(!remote.join("excluded/no.txt").exists());assert_eq!(std::fs::read(remote.join("excluded/keep.txt")).unwrap(),b"keep");}
    if mode=="cancel" {assert_eq!(status.sent,0);assert!(!remote.join("a.txt").exists());}
    if matches!(mode,"late"|"save-during") {
        std::fs::remove_file(local.join("a.txt")).unwrap();
        while remote.join("a.txt").exists(){let s=e.status("contract").unwrap();assert_eq!(s.error_count,0,"{:?}",s.logs);assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(5));}
    }
    e.stop("contract").unwrap();
    std::fs::write(out.join("contract-result.json"),serde_json::to_vec(&serde_json::json!({"mode":mode,"sent":status.sent,"error_count":status.error_count,"passed":true,"logs":status.logs})).unwrap()).unwrap();
}
#[test]
#[ignore = "generated loopback empty-remote measurement"]
fn empty_remote_worker_measurement() {
    let (out,v,profile)=manifest();
    let local=out.join("local");let remote=PathBuf::from(v["remote"].as_str().unwrap());
    let target=remote.join("upload/empty/root");std::fs::create_dir_all(&target).unwrap();
    let existing=v["existing"].as_bool().unwrap();let mirror=v["mirror"].as_bool().unwrap();
    let shape=v["shape"].as_str().unwrap_or("original");
    let paths:Vec<String>=match shape {
        "flat"=>(0..48).map(|i|format!("f{i}.txt")).collect(),
        "deep"=>(0..24).map(|i|format!("a/b/c/d/e/f/g/h/f{i}.txt")).collect(),
        "large"|"deeper"=>{
            let depth=if shape=="large"{6}else{10};
            let shared=(0..depth-2).map(|i|format!("s{i}")).collect::<Vec<_>>().join("/");
            let groups=(186-(depth-2))/2;
            (0..411).map(|i|format!("{shared}/g{:03}/leaf/f{i:04}.txt",i%groups)).collect()
        },
        _=>(0..3).flat_map(|g|(0..8).map(move|i|format!("common/deep/g{g}/leaf/f{i}.txt"))).collect(),
    };
    let mut directories=std::collections::HashSet::new();let mut max_depth=0;
    for p in &paths {
        std::fs::create_dir_all(local.join(p).parent().unwrap()).unwrap();
        std::fs::write(local.join(p),vec![65;128]).unwrap();
        if existing{std::fs::create_dir_all(target.join(p).parent().unwrap()).unwrap();}
        let mut ancestor=Path::new(p).parent();
        while let Some(dir)=ancestor {if dir.as_os_str().is_empty(){break;}directories.insert(dir.to_path_buf());max_depth=max_depth.max(dir.components().count());ancestor=dir.parent();}
    }
    let seed=|state:&str|{
        assert!(matches!(state,"empty"|"unchanged"|"outdated"|"mixed"));
        let mut expected_sent=0;
        for (i,p) in paths.iter().enumerate(){
            let local_file=local.join(p);let remote_file=target.join(p);
            let local_time=std::time::UNIX_EPOCH+Duration::from_secs(1700000010);
            std::fs::File::options().write(true).open(&local_file).unwrap().set_times(std::fs::FileTimes::new().set_modified(local_time)).unwrap();
            let unchanged=state=="unchanged"||(state=="mixed"&&i%2==0);
            if !unchanged{expected_sent+=1;}
            if state!="empty" {
                std::fs::create_dir_all(remote_file.parent().unwrap()).unwrap();
                std::fs::write(&remote_file,vec![if unchanged{65}else{66};128]).unwrap();
                let remote_time=if unchanged{local_time}else{std::time::UNIX_EPOCH+Duration::from_secs(1700000000)};
                std::fs::File::options().write(true).open(&remote_file).unwrap().set_times(std::fs::FileTimes::new().set_modified(remote_time)).unwrap();
            }else{assert!(!remote_file.exists(),"empty state requires fresh generated fixture");}
        }
        expected_sent
    };
    let engine=Engine::default();let mut runs=Vec::new();let mut watcher_run=None;
    let states=std::iter::once(v["remoteState"].as_str().unwrap_or("empty")).chain(v["restartState"].as_str());
    for (index,state) in states.enumerate(){
        let expected_sent=seed(state);
        let start_unix_us=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
        let started=Instant::now();
        engine.start("measure".into(),profile.clone(),local.to_string_lossy().into(),"/upload/empty/root".into(),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),SyncOptions{delete_removed:mirror,..SyncOptions::default()}).unwrap();
        let start_returned_ms=started.elapsed().as_millis();let mut first=None;
        let mut seen=std::collections::HashSet::new();let mut observed_logs=Vec::new();
        loop {
            let s=engine.status("measure").unwrap();assert_eq!(s.error_count,0,"{:?}",s.logs);
            for log in &s.logs{if seen.insert(log.clone()){observed_logs.push(serde_json::json!({"observed_ms":started.elapsed().as_millis(),"message":log}));}}
            if s.sent>0&&first.is_none(){first=Some(started.elapsed().as_millis());}
            if s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp {break;}
            assert!(started.elapsed()<Duration::from_secs(240),"{:?}",s.logs);thread::sleep(Duration::from_millis(2));
        }
        let elapsed=started.elapsed().as_millis();let status=engine.status("measure").unwrap();
        let caught_up_unix_us=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
        assert_eq!(status.pending,0);assert_eq!(status.sent,expected_sent);
        if index==0 && v["watcherRename"].as_bool()==Some(true) {
            assert_eq!(shape,"original");assert_eq!(state,"unchanged");assert!(mirror);
            let event_start_unix_us=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
            let event_started=Instant::now();
            // Generated source directory only; final names/content/mtime are unchanged.
            std::fs::rename(local.join("common"),out.join("parked-common")).unwrap();
            std::fs::rename(out.join("parked-common"),local.join("common")).unwrap();
            loop {
                let s=engine.status("measure").unwrap();assert_eq!(s.error_count,0,"{:?}",s.logs);assert_eq!(s.sent,0,"unchanged source must not upload");
                let fresh_skips=s.logs.iter().filter(|line|line.starts_with("Skipped unchanged ")).count();
                if fresh_skips>=paths.len() && s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp {
                    assert_eq!(s.pending,0);
                    watcher_run=Some(serde_json::json!({"run":"watcher_directory_rename_roundtrip","start_unix_us":event_start_unix_us,"end_unix_us":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros(),"elapsed_ms":event_started.elapsed().as_millis(),"sent":s.sent,"pending":s.pending,"fresh_skip_log_count":fresh_skips,"logs":s.logs}));break;
                }
                assert!(event_started.elapsed()<Duration::from_secs(60),"directory rename did not yield complete fresh comparisons: {:?}",s.logs);thread::sleep(Duration::from_millis(2));
            }
        }
        engine.stop("measure").unwrap();
        for p in &paths {assert_eq!(std::fs::read(local.join(p)).unwrap(),std::fs::read(target.join(p)).unwrap());}
        runs.push(serde_json::json!({"run":if index==0{"initial_start"}else{"manual_restart"},"state":state,"start_unix_us":start_unix_us,"end_unix_us":if v["watcherRename"].as_bool()==Some(true){caught_up_unix_us}else{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros()},"start_returned_ms":start_returned_ms,"elapsed_ms":elapsed,"first_uploaded_ms":first,"sent":status.sent,"skipped_inferred":paths.len() as u64-status.sent,"skipped_source":"file count minus successful sent count; status has no skipped counter","pending":status.pending,"final_bytes_verified":paths.len()*128,"logs":observed_logs}));
        std::fs::write(out.join("native.json"),serde_json::to_vec_pretty(&serde_json::json!({"shape":shape,"files":paths.len(),"relative_directories":directories.len(),"max_relative_directory_depth":max_depth,"file_bytes":128,"runs":runs,"watcher_run":watcher_run})).unwrap()).unwrap();
    }
}
