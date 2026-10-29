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
 let secret=v["passphrase"].as_str().unwrap();let e=engine::Engine::default();let stop=e.claim_operation("batch").unwrap();
 std::fs::create_dir_all(remote.join("bench")).unwrap();for i in 0..5{std::fs::write(remote.join(format!("bench/source{i}")),vec![65+i as u8;131072]).unwrap();}
 if mode=="collision"{std::fs::write(remote.join("bench/copy1"),b"sentinel").unwrap();}
 let action=if mode=="delete"||mode=="cancel-delete"{"delete"}else{"copy"};
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
 else if mode=="collision"||mode=="symlink"{let out=result.unwrap();assert!(out.items[0].completed);assert!(!out.items[1].completed);assert!(out.items[1].attempted);assert!(!out.items[2].attempted);if mode=="collision"{assert_eq!(std::fs::read(remote.join("bench/copy1")).unwrap(),b"sentinel");}else{assert!(!remote.join("bench/copy1").exists());}assert!(!remote.join("bench/copy2").exists());}
 else if mode=="changed"||mode=="write-failed"{let out=result.unwrap();assert!(!out.items[0].completed);assert!(!out.items[1].attempted);assert!(!remote.join("bench/copy1").exists());assert!(remote.join("bench/source0").exists());if mode=="write-failed"{assert_eq!(e.operation_progress("batch").unwrap().snapshot().done,0);}}
 else if mode=="cancel-during"||mode=="disconnect"||mode=="cancel-delete"{let out=result.unwrap();assert_eq!(out.completed,1);assert!(out.items[0].completed);assert!(!out.items[1].completed);assert!(out.items[1].attempted);assert!(!out.items[2].attempted);assert!(!remote.join("bench/copy2").exists());assert_eq!(e.operation_progress("batch").unwrap().snapshot().done,0);for i in (if mode=="cancel-delete"{1}else{0})..5{assert!(remote.join(format!("bench/source{i}")).exists());}}
 else{let out=result.unwrap();assert_eq!(out.completed,5);for i in 0..5{let source=remote.join(format!("bench/source{i}"));if action=="delete"{assert!(!source.exists());}else{assert_eq!(std::fs::read(remote.join(format!("bench/copy{i}"))).unwrap(),std::fs::read(source).unwrap());}}if !baseline{let s=e.operation_progress("batch").unwrap().snapshot();assert_eq!(s.phase,"finalizing");assert_eq!(s.item,5);assert_eq!(s.done,if action=="delete"{1}else{131072});}}
 std::fs::write(root.join("timing.json"),serde_json::to_vec(&serde_json::json!({"mode":mode,"baseline":baseline,"milliseconds":elapsed})).unwrap()).unwrap();e.finish_operation("batch");assert!(e.operation_progress("batch").is_none());
 if mode=="cancel-during"||mode=="disconnect"||mode=="cancel-delete"{e.claim_operation("after-cleanup").unwrap();e.reserve_operation("after-cleanup",vec![],vec![if mode=="cancel-delete"{"/bench/source4".into()}else{"/bench/copy4".into()}],String::new(),vec![format!("127.0.0.1:{}",p.port).parse().unwrap()],false).unwrap();e.finish_operation("after-cleanup");}
}
