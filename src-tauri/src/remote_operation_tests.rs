use super::*;
#[test]fn progress_cannot_be_read_by_another_window_or_after_cleanup(){
 let s=AppState::default();{let mut r=s.ownership.lock().unwrap();r.bootstrap("owner").unwrap();r.bootstrap("other").unwrap();r.operations.insert("generated".into(),"owner".into());}
 s.engine.prepare_operation("generated").unwrap();assert!(read_operation_progress(&s,"owner","generated").unwrap().is_some());assert!(read_operation_progress(&s,"other","generated").is_err());assert!(read_operation_progress(&s,"unknown","generated").is_err());s.engine.finish_operation("generated");assert!(read_operation_progress(&s,"owner","generated").unwrap().is_none());
}
#[test]
#[ignore="generated localhost operation performance/safety fixture"]
fn remote_selection_fixture(){
 let manifest=PathBuf::from(std::env::var("NEARLY_OPERATION_FIXTURE").unwrap());let root=manifest.parent().unwrap().canonicalize().unwrap();
 assert!(root.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
 let remote=PathBuf::from(v["remote"].as_str().unwrap());let mode=v["mode"].as_str().unwrap();let baseline=v["baseline"].as_bool().unwrap();
 let p=sftp::Profile{id:"generated".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let file_bytes=v["fileBytes"].as_u64().unwrap_or(131072) as usize;assert!((1..=16*1024*1024).contains(&file_bytes));
 let secret=v["passphrase"].as_str().unwrap();let e=engine::Engine::default();let stop=e.claim_operation("batch").unwrap();
 std::fs::create_dir_all(remote.join("bench")).unwrap();for i in 0..5{std::fs::write(remote.join(format!("bench/source{i}")),vec![65+i as u8;file_bytes]).unwrap();}
 if matches!(mode,"mixed-copy"|"mixed-delete"){std::fs::remove_file(remote.join("bench/source4")).unwrap();std::fs::create_dir_all(remote.join("bench/source4/empty")).unwrap();std::fs::write(remote.join("bench/source4/zero.bin"),[]).unwrap();std::fs::write(remote.join("bench/source4/one.bin"),[42]).unwrap();}
 if mode=="collision"{std::fs::write(remote.join("bench/copy1"),b"sentinel").unwrap();}
 let action=if mode=="delete"||mode=="cancel-delete"||mode=="mixed-delete"{"delete"}else{"copy"};
 let mut items:Vec<serde_json::Value>=(0..5).map(|i|serde_json::json!({"source":format!("/bench/source{i}"),"destination":if action=="delete"{None}else{Some(format!("/bench/copy{i}"))}})).collect();
 if mode=="overlap"{items[1]["source"]=serde_json::json!("/bench/source0");}
 if mode=="cancel"{stop.store(true,Ordering::SeqCst);}
 let started=std::time::Instant::now();
 let result=if baseline{
  let mut count=0;for item in &items{let(mut c,identity)=sftp::connect(&p,secret,&stop).unwrap();e.reserve_operation("batch",vec![],vec![item["source"].as_str().unwrap().into()],identity,vec![],false).unwrap();let out=sftp::file_operation(&mut c,if action=="delete"{file_ops::Action::Delete}else{file_ops::Action::Copy},item["source"].as_str().unwrap(),item["destination"].as_str(),&stop).unwrap();count+=out.completed;}
  Ok(file_ops::Outcome{completed:count,items:vec![],message:"baseline".into()})
 }else{
  let request=serde_json::from_value(serde_json::json!({"id":"batch","side":"remote","action":action,"source":"/bench/source0","destination":null,"profile":p,"passphrase":secret,"confirmDelete":action=="delete","items":items})).unwrap();
  if matches!(mode,"cancel-during"|"disconnect"|"cancel-delete"){
   std::thread::scope(|scope|{
    let verifier=scope.spawn(||{
     let start=std::time::Instant::now();while !root.join("mutation-held").exists(){assert!(start.elapsed()<std::time::Duration::from_secs(20),"generated mutation never reached hold");std::thread::sleep(std::time::Duration::from_millis(5));}
     assert_eq!(e.operation_progress("batch").unwrap().snapshot().selection_completed,Some(if mode=="cancel-delete"{1}else{3}));
     // A prior root has committed, but ALL selected roots remain reserved.
     if mode=="cancel-delete"{assert!(!remote.join("bench/source0").exists());}else{assert!(remote.join("bench/copy0").is_file());}
     e.claim_operation("overlap-probe").unwrap();
     assert!(e.reserve_operation("overlap-probe",vec![],vec![if mode=="cancel-delete"{"/bench/source4".into()}else{"/bench/copy4".into()}],String::new(),vec![format!("127.0.0.1:{}",p.port).parse().unwrap()],false).is_err());e.finish_operation("overlap-probe");
     if mode=="cancel-during"||mode=="cancel-delete"{e.cancel_operation("batch").unwrap();}
     std::fs::write(root.join("mutation-release"),b"generated").unwrap();
    });
    let result=file_ops::run(&e,request,&stop);verifier.join().unwrap();result
   })
  }else{file_ops::run(&e,request,&stop)}
 };
 let elapsed=started.elapsed().as_millis();
 if matches!(mode,"cancel"|"overlap"){assert!(result.is_err());for i in 0..5{assert!(!remote.join(format!("bench/copy{i}")).exists());}}
 else if mode=="collision" {let out=result.unwrap();assert_eq!(out.completed,3);assert!(out.items[0].completed && out.items[2].completed && out.items[3].completed);assert!(out.items[1].attempted && !out.items[1].completed);assert!(!out.items[4].attempted);assert_eq!(std::fs::read(remote.join("bench/copy1")).unwrap(),b"sentinel");assert!(!remote.join("bench/copy4").exists());}
 else if mode=="symlink"{let out=result.unwrap();assert!(out.items[0].completed);assert!(!out.items[1].completed);assert!(out.items[1].attempted);assert!(!out.items[2].attempted);assert!(!remote.join("bench/copy1").exists());assert!(!remote.join("bench/copy2").exists());}
 else if matches!(mode,"write-failed"|"close-failed"){let out=result.unwrap();assert!(!out.items[0].completed);assert!(out.items[..4].iter().all(|item|item.attempted));assert!(!out.items[4].attempted);assert!(!remote.join("bench/copy4").exists());assert!(remote.join("bench/source0").exists());assert_eq!(e.operation_progress("batch").unwrap().snapshot().selection_completed,Some(out.items.iter().filter(|i|i.completed).count()));if mode=="write-failed"{assert_eq!(e.operation_progress("batch").unwrap().snapshot().done,0);}else{assert!(out.items[0].message.contains("close"));assert_eq!(std::fs::read(remote.join("bench/copy0")).unwrap(),std::fs::read(remote.join("bench/source0")).unwrap());}}
 else if mode=="changed"{let out=result.unwrap();assert_eq!(out.completed,5);let copied=std::fs::read(remote.join("bench/copy0")).unwrap();assert!(copied.iter().all(|b|*b==65));assert_eq!(copied.len(),file_bytes);assert_eq!(std::fs::read(remote.join("bench/source0")).unwrap(),b"concurrent generated change");}
 else if mode=="cancel-during"||mode=="disconnect"||mode=="cancel-delete"{let out=result.unwrap();let count=if mode=="cancel-delete"{1}else{3};assert_eq!(out.completed,count);assert_eq!((e.operation_progress("batch").unwrap().snapshot().selection_completed,e.operation_progress("batch").unwrap().snapshot().selection_total),(Some(count),Some(5)));assert!(out.items[0].completed);assert!(!out.items[1].completed);assert!(out.items[1].attempted);if mode=="cancel-delete"{assert!(!out.items[2].attempted);}else{assert!(out.items[2].completed && out.items[3].completed);assert!(!out.items[4].attempted);assert!(!remote.join("bench/copy4").exists());}for i in (if mode=="cancel-delete"{1}else{0})..5{assert!(remote.join(format!("bench/source{i}")).exists());}}
 else if matches!(mode,"mixed-copy"|"mixed-delete"){let out=result.unwrap();assert_eq!(out.completed,8);assert_eq!(out.items.len(),5);assert!(out.items.iter().all(|item|item.completed));let snapshot=e.operation_progress("batch").unwrap().snapshot();assert_eq!((snapshot.selection_completed,snapshot.selection_total),(Some(5),Some(5)));if action=="copy"{assert!(remote.join("bench/copy4/empty").is_dir());assert_eq!(std::fs::read(remote.join("bench/copy4/zero.bin")).unwrap(),Vec::<u8>::new());assert_eq!(std::fs::read(remote.join("bench/copy4/one.bin")).unwrap(),[42]);}else{assert!(!remote.join("bench/source4").exists());}}
 else{let out=result.unwrap();assert_eq!(out.completed,5);for i in 0..5{let source=remote.join(format!("bench/source{i}"));if action=="delete"{assert!(!source.exists());}else{assert_eq!(std::fs::read(remote.join(format!("bench/copy{i}"))).unwrap(),std::fs::read(source).unwrap());}}if !baseline{let s=e.operation_progress("batch").unwrap().snapshot();assert_eq!(s.phase,"finalizing");assert_eq!(s.item,5);assert_eq!((s.selection_completed,s.selection_total),(Some(5),Some(5)));assert_eq!(s.done,if action=="delete"{1}else{file_bytes as u64});}}
 std::fs::write(root.join("timing.json"),serde_json::to_vec(&serde_json::json!({"mode":mode,"baseline":baseline,"milliseconds":elapsed})).unwrap()).unwrap();e.finish_operation("batch");assert!(e.operation_progress("batch").is_none());
 if mode=="cancel-during"||mode=="disconnect"||mode=="cancel-delete"{e.claim_operation("after-cleanup").unwrap();e.reserve_operation("after-cleanup",vec![],vec![if mode=="cancel-delete"{"/bench/source4".into()}else{"/bench/copy4".into()}],String::new(),vec![format!("127.0.0.1:{}",p.port).parse().unwrap()],false).unwrap();e.finish_operation("after-cleanup");}
}

#[test]
#[ignore = "generated localhost move performance/safety fixture"]
fn remote_move_fixture() {
    let manifest = PathBuf::from(std::env::var("NEARLY_MOVE_FIXTURE").unwrap());
    let root = manifest.parent().unwrap().canonicalize().unwrap();
    assert!(root.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(v["generatedOnly"], true);
    let remote = PathBuf::from(v["remote"].as_str().unwrap());
    assert!(remote.canonicalize().unwrap().starts_with(&root));
    let mode = v["mode"].as_str().unwrap();
    let baseline = v["baseline"].as_bool().unwrap();
    let profile = sftp::Profile {id:"generated-move".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
    assert!(PathBuf::from(&profile.key_file).canonicalize().unwrap().starts_with(&root));
    let secret = v["passphrase"].as_str().unwrap();
    let engine = engine::Engine::default();
    let stop = engine.claim_operation("move-batch").unwrap();
    for i in 0..5 {
        let source = remote.join(format!("bench/source{i}"));
        std::fs::create_dir_all(source.join("nested")).unwrap();
        for j in 0..64 { std::fs::write(source.join(format!("nested/file{j}")), [i as u8, j as u8]).unwrap(); }
    }
    if mode == "collision" { std::fs::write(remote.join("bench/target1"), b"sentinel").unwrap(); }
    let items: Vec<_> = (0..5).map(|i|serde_json::json!({"source":format!("/bench/source{i}"),"destination":format!("/bench/target{i}")})).collect();
    let started = std::time::Instant::now();
    let result = if baseline {
        for (i,item) in items.iter().enumerate() {
            let request = serde_json::from_value(serde_json::json!({"id":"move-batch","side":"remote","action":"move","source":item["source"],"destination":item["destination"],"profile":profile,"passphrase":secret,"confirmDelete":false})).unwrap();
            let out = file_ops::run(&engine, request, &stop).unwrap();
            assert_eq!(out.completed, 1, "move root {i}");
        }
        None
    } else {
        let request = serde_json::from_value(serde_json::json!({"id":"move-batch","side":"remote","action":"move","source":"/bench/source0","profile":profile,"passphrase":secret,"confirmDelete":false,"items":items})).unwrap();
        let out = if mode == "cancel" {
            std::thread::scope(|scope| {
                let verifier = scope.spawn(|| {
                    let start = std::time::Instant::now();
                    while !root.join("mutation-held").exists() {
                        assert!(start.elapsed() < std::time::Duration::from_secs(20));
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    assert_eq!(engine.operation_progress("move-batch").unwrap().snapshot().selection_completed, Some(1));
                    engine.cancel_operation("move-batch").unwrap();
                    std::fs::write(root.join("mutation-release"), b"generated").unwrap();
                });
                let out = file_ops::run(&engine, request, &stop).unwrap(); verifier.join().unwrap(); out
            })
        } else { file_ops::run(&engine, request, &stop).unwrap() };
        Some(out)
    };
    let elapsed = started.elapsed().as_millis();
    let failed = mode != "move";
    if let Some(out) = result {
        assert_eq!(out.completed, if failed {1} else {5});
        assert_eq!(out.items.len(), 5);
        assert!(out.items[0].completed);
        if failed { assert!(!out.items[1].completed); assert!(out.items[1].attempted); assert!(out.items[2..].iter().all(|item|!item.attempted)); }
        else { assert!(out.items.iter().all(|item|item.completed)); }
        assert_eq!(engine.operation_progress("move-batch").unwrap().snapshot().selection_completed, Some(if failed {1} else {5}));
    }
    for i in 0..5 {
        let moved = !failed || i == 0;
        let source = remote.join(format!("bench/source{i}"));
        let target = remote.join(format!("bench/target{i}"));
        assert_eq!(source.exists(), !moved);
        if matches!(mode,"collision"|"target-race") && i == 1 { assert_eq!(std::fs::read(&target).unwrap(), b"sentinel"); }
        else { assert_eq!(target.exists(), moved); }
        let content = if moved { target } else { source };
        for j in 0..64 { assert_eq!(std::fs::read(content.join(format!("nested/file{j}"))).unwrap(), [i as u8,j as u8]); }
    }
    std::fs::write(root.join("timing.json"), serde_json::to_vec(&serde_json::json!({"mode":mode,"baseline":baseline,"milliseconds":elapsed})).unwrap()).unwrap();
    engine.finish_operation("move-batch");
}
#[test]
#[ignore = "generated localhost metadata validation fixture"]
fn remote_metadata_validation_fixture() {
    let manifest=PathBuf::from(std::env::var("NEARLY_METADATA_FIXTURE").unwrap());
    let root=manifest.parent().unwrap().canonicalize().unwrap();
    assert!(root.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
    let v:serde_json::Value=serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(v["generatedOnly"],true);
    let remote=PathBuf::from(v["remote"].as_str().unwrap());
    assert!(remote.canonicalize().unwrap().starts_with(&root));
    let mode=v["mode"].as_str().unwrap();
    assert!(["standalone","separate-parents","source-ancestor","target-ancestor","ancestor-between","no-post-copy-probe","target-race"].contains(&mode));
    let profile=sftp::Profile{id:"metadata".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
    assert!(PathBuf::from(&profile.key_file).canonicalize().unwrap().starts_with(&root));
    std::fs::create_dir_all(remote.join("bench")).unwrap();
    for i in 0..2 {std::fs::write(remote.join(format!("bench/source{i}")),b"generated data").unwrap();}
    let stop=AtomicBool::new(false);
    let(mut connection,_)=sftp::connect(&profile,v["passphrase"].as_str().unwrap(),&stop).unwrap();
    let target_parent=if matches!(mode,"separate-parents"|"target-ancestor"){"other"}else{"bench"};
    for i in 0..2 {
        let target=format!("/{target_parent}/copy{i}");
        let result=sftp::file_operation(&mut connection,file_ops::Action::Copy,&format!("/bench/source{i}"),Some(&target),&stop);
        let succeeds=matches!(mode,"standalone"|"separate-parents"|"no-post-copy-probe") || mode=="ancestor-between" && i==0;
        if succeeds {assert_eq!(result.unwrap().completed,1);assert_eq!(std::fs::read(remote.join(target.trim_start_matches('/'))).unwrap(),b"generated data");}
        else {
            assert!(result.is_err(),"Expected refusal for {mode}");
            if mode=="target-race" {assert_eq!(std::fs::read(remote.join(target.trim_start_matches('/'))).unwrap(),b"race sentinel");}
            else if mode!="no-post-copy-probe" {assert!(!remote.join(target.trim_start_matches('/')).exists());}
            assert!(!remote.join(format!("{target_parent}/copy1")).exists());
            break;
        }
    }
    for i in 0..2 {assert_eq!(std::fs::read(remote.join(format!("bench/source{i}"))).unwrap(),b"generated data");}
}
