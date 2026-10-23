use super::*;
use std::sync::OnceLock;
static MARKS:OnceLock<Mutex<Option<(Instant,Vec<(String,u128)>)>>>=OnceLock::new();
pub(super) fn mark(name:&str){if let Some(m)=MARKS.get(){if let Some((start,v))=m.lock().unwrap().as_mut(){if !v.iter().any(|(n,_)|n==name){v.push((name.into(),start.elapsed().as_micros()));}}}}
#[test]#[ignore="generated localhost deep-shape full-start measurement"]
fn startup_measure_worker(){
 let m:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(std::env::var("NEARLY_STARTUP_MEASURE").unwrap()).unwrap()).unwrap();
 let root=PathBuf::from(m["root"].as_str().unwrap());let remote=PathBuf::from(m["remote"].as_str().unwrap());
 let name="deep-same";let local=root.join(name);let target=remote.join("m/a/b/c/d/e/f").join(name);
 std::fs::create_dir_all(&local).unwrap();std::fs::create_dir_all(&target).unwrap();
 // Shared depth3 + 61 independent depth3 branches = 186 directories.
 // Sum relative directory depths=921 (observed shape=915); 411 leaves.
 for g in 0..61{for base in [&local,&target]{std::fs::create_dir_all(base.join(format!("common/a/b/g{g:03}/sub/leaf"))).unwrap();}}
 for i in 0..411{let rel=format!("common/a/b/g{:03}/sub/leaf/f{i:04}.txt",i%61);for base in [&local,&target]{let p=base.join(rel.clone());std::fs::write(&p,b"original generated").unwrap();std::fs::File::options().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}}
 std::fs::write(root.join("current-case"),name).unwrap();thread::sleep(Duration::from_millis(30));
 let start_unix_us=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();let clock=Instant::now();*MARKS.get_or_init(||Mutex::new(None)).lock().unwrap()=Some((clock,vec![]));
 let profile=Profile{id:"measure".into(),name:"generated localhost".into(),host:"127.0.0.1".into(),port:m["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:m["key"].as_str().unwrap().into(),host_key:m["fingerprint"].as_str().unwrap().into()};
 let engine=Engine::default();engine.start(name.into(),profile,local.to_string_lossy().into_owned(),format!("/m/a/b/c/d/e/f/{name}"),zeroize::Zeroizing::new(m["passphrase"].as_str().unwrap().into()),SyncOptions{delete_removed:true,..SyncOptions::default()}).unwrap();mark("start_returned");
 let deadline=Instant::now()+Duration::from_secs(240);
 loop{let s=engine.status(name).unwrap();assert_eq!(s.error_count,0,"{}",serde_json::to_string(&s.failure).unwrap());if s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp{break;}assert!(Instant::now()<deadline,"deep measure timeout: {:?}",s.logs);thread::sleep(Duration::from_millis(2));}
 mark("caught_up");let s=engine.status(name).unwrap();assert_eq!(s.sent,0);engine.stop(name).unwrap();
 let marks=MARKS.get().unwrap().lock().unwrap().take().unwrap().1;
 std::fs::write(root.join("deep-same-native.json"),serde_json::to_vec_pretty(&serde_json::json!({"files":411,"directories":186,"changed":0,"start_unix_us":start_unix_us,"marks_us":marks})).unwrap()).unwrap();
}
