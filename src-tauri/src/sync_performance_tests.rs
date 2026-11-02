//! Generated localhost phase measurements. No production instrumentation.
use super::*;
use std::time::{SystemTime,UNIX_EPOCH};
fn wait(engine:&Engine,id:&str,count:u64){let start=Instant::now();loop{let s=engine.status(id).unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if s.sent>=count&&s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp{return;}assert!(start.elapsed()<Duration::from_secs(600),"sync timeout");thread::sleep(Duration::from_millis(5));}}
#[test]#[ignore="generated localhost sync timing"]
fn sync_performance_generated(){
 let manifest=PathBuf::from(std::env::var("NEARLY_SYNC_PERF").unwrap());let out=manifest.parent().unwrap().canonicalize().unwrap();assert!(out.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
 let profile=Profile{id:"generated".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap()as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let remote=PathBuf::from(v["remote"].as_str().unwrap());let mut rows=Vec::new();
 for mirror in [false,true]{
  let case=if mirror{"mirror"}else{"upload"};let root=out.join(case);std::fs::create_dir(&root).unwrap();let root=root.canonicalize().unwrap();let target=format!("/{case}/a/b/c/d");std::fs::create_dir_all(remote.join(target.trim_start_matches('/'))).unwrap();
  for n in 0..16{std::fs::write(root.join(format!("file{n:02}.txt")),format!("generated-{n}")).unwrap();}
  let engine=Engine::default();let id=format!("perf-{case}");
  for phase in ["initial","modify","new","idle"]{
   let start=Instant::now();let epoch=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
   std::fs::write(out.join("phase"),format!("{case}-{phase}")).unwrap();
   if phase=="initial"{engine.start(id.clone(),profile.clone(),root.to_string_lossy().into_owned(),target.clone(),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),SyncOptions{delete_removed:mirror,..Default::default()}).unwrap();wait(&engine,&id,16);}
   else if phase=="modify"{for n in 0..2{std::fs::write(root.join(format!("file{n:02}.txt")),format!("modified-generated-{n}-longer")).unwrap();}wait(&engine,&id,18);}
   else if phase=="new"{for n in 0..2{std::fs::write(root.join(format!("new{n}.txt")),format!("new-generated-{n}")).unwrap();}wait(&engine,&id,20);}
   else{thread::sleep(Duration::from_millis(800));}
   rows.push(serde_json::json!({"case":case,"phase":phase,"epochMs":epoch,"elapsedMs":start.elapsed().as_millis(),"sent":engine.status(&id).unwrap().sent}));
  }
  for n in 0..2{assert_eq!(std::fs::read(root.join(format!("file{n:02}.txt"))).unwrap(),std::fs::read(remote.join(target.trim_start_matches('/')).join(format!("file{n:02}.txt"))).unwrap());}
  engine.stop(&id).unwrap();
 }
 std::fs::write(out.join("timing.json"),serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
}
#[test]#[ignore="generated 4000-file localhost sync"]
fn sync_bulk_performance_generated(){
 let manifest=PathBuf::from(std::env::var("NEARLY_SYNC_PERF").unwrap());let out=manifest.parent().unwrap().canonicalize().unwrap();assert!(out.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
 let profile=Profile{id:"generated-bulk".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap()as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let remote=PathBuf::from(v["remote"].as_str().unwrap()).join("bulk/a/b");std::fs::create_dir_all(&remote).unwrap();let root=out.join("local");std::fs::create_dir(&root).unwrap();let root=root.canonicalize().unwrap();
 let paths:Vec<_>=(0..4000).map(|n|PathBuf::from(format!("group{:02}/sub{}/file{n:04}.txt",n/400,(n/100)%4))).collect();
 for path in &paths{std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();std::fs::write(root.join(path),vec![b'A';512]).unwrap();}
 let mut rows=Vec::new();let engine=Engine::default();let id="bulk";
 for phase in ["initial","unchanged","delta","idle"]{
  let start=Instant::now();let epoch=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();std::fs::write(out.join("phase"),phase).unwrap();
  if phase=="initial"||phase=="unchanged"{engine.start(id.into(),profile.clone(),root.to_string_lossy().into_owned(),"/bulk/a/b".into(),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),SyncOptions::default()).unwrap();wait(&engine,id,if phase=="initial"{4000}else{0});}
  else if phase=="delta"{for path in paths.iter().take(20){std::fs::write(root.join(path),vec![b'B';513]).unwrap();}wait(&engine,id,20);}
  else{thread::sleep(Duration::from_millis(800));}
  rows.push(serde_json::json!({"phase":phase,"epochMs":epoch,"elapsedMs":start.elapsed().as_millis(),"sent":engine.status(id).unwrap().sent}));std::fs::write(out.join("timing.json"),serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
  if phase=="initial"{engine.stop(id).unwrap();}
 }
 for (n,path) in paths.iter().enumerate(){assert_eq!(std::fs::read(remote.join(path)).unwrap(),vec![if n<20{b'B'}else{b'A'};if n<20{513}else{512}]);}
 engine.stop(id).unwrap();
}

#[test]#[ignore="generated existing-file phase measurements"]
fn sync_existing_performance_generated(){
 let manifest=PathBuf::from(std::env::var("NEARLY_SYNC_PERF").unwrap());let out=manifest.parent().unwrap().canonicalize().unwrap();assert!(out.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
 let count:usize=std::env::var("NEARLY_PHASE_FILES").unwrap_or("4000".into()).parse().unwrap();assert!([64,4000].contains(&count));
 let profile=Profile{id:"generated-existing".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap()as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let remote=PathBuf::from(v["remote"].as_str().unwrap()).join("existing/a/b");std::fs::create_dir_all(&remote).unwrap();let root=out.join("local");std::fs::create_dir(&root).unwrap();let root=root.canonicalize().unwrap();
 let paths:Vec<_>=(0..count).map(|n|PathBuf::from(format!("group{:02}/sub{}/file{n:04}.txt",n/400,(n/100)%4))).collect();
 for p in &paths{std::fs::create_dir_all(root.join(p).parent().unwrap()).unwrap();std::fs::create_dir_all(remote.join(p).parent().unwrap()).unwrap();std::fs::write(root.join(p),vec![b'A';512]).unwrap();std::fs::write(remote.join(p),vec![b'Z';512]).unwrap();let local_time=std::fs::metadata(root.join(p)).unwrap().modified().unwrap();std::fs::File::options().write(true).open(remote.join(p)).unwrap().set_times(std::fs::FileTimes::new().set_modified(local_time-Duration::from_secs(40))).unwrap();}
 let engine=Engine::default();let id="existing";let mut rows=Vec::new();
 for phase in ["existing-initial","watch20","unchanged","idle"]{
  let start=Instant::now();let epoch=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();std::fs::write(out.join("phase"),phase).unwrap();
  match phase{
   "existing-initial"|"unchanged"=>{engine.start(id.into(),profile.clone(),root.to_string_lossy().into_owned(),"/existing/a/b".into(),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),SyncOptions::default()).unwrap();wait(&engine,id,if phase=="existing-initial"{count as u64}else{0});},
   "watch20"=>{for p in paths.iter().take(20){std::fs::write(root.join(p),vec![b'B';513]).unwrap();}wait(&engine,id,count as u64+20);},
   _=>thread::sleep(Duration::from_millis(800)),
  }
  rows.push(serde_json::json!({"phase":phase,"epochMs":epoch,"elapsedMs":start.elapsed().as_millis(),"sent":engine.status(id).unwrap().sent}));std::fs::write(out.join("timing.json"),serde_json::to_vec_pretty(&rows).unwrap()).unwrap();if phase=="watch20"{engine.stop(id).unwrap();}
 }
 for(n,p)in paths.iter().enumerate(){assert_eq!(std::fs::read(remote.join(p)).unwrap(),vec![if n<20{b'B'}else{b'A'};if n<20{513}else{512}]);}engine.stop(id).unwrap();
}
