//! Opt-in generated localhost timing; hooks compile out of product builds.
use super::*;
use std::sync::OnceLock;
#[derive(serde::Serialize)] struct Mark{name:String,phase:String,micros:u128}
type Trace=Option<(PathBuf,Instant,Vec<Mark>)>;
static TRACE:OnceLock<Mutex<Trace>>=OnceLock::new();
pub(super) fn mark(path:&Path,phase:&str){if let Some(trace)=TRACE.get(){if let Some((root,start,marks))=trace.lock().unwrap().as_mut(){if let Ok(relative)=path.strip_prefix(root){if marks.len()<10000{marks.push(Mark{name:relative.to_string_lossy().into_owned(),phase:phase.into(),micros:start.elapsed().as_micros()});}}}}}
fn wait_until(mut condition:impl FnMut()->bool){let start=Instant::now();while !condition(){assert!(start.elapsed()<Duration::from_secs(30),"generated wait timing timeout");thread::sleep(Duration::from_millis(2));}}
#[test]#[ignore="generated localhost new-file latency measurement"]
fn new_file_wait_generated(){
 let manifest=PathBuf::from(std::env::var("NEARLY_WAIT_FIXTURE").unwrap());let out=manifest.parent().unwrap().canonicalize().unwrap();assert!(out.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
 let remote=PathBuf::from(v["remote"].as_str().unwrap());let profile=Profile{id:"generated".into(),name:"loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let mut results=Vec::new();
 for case in ["steady","burst","queued"]{
  let local=out.join(case);std::fs::create_dir(&local).unwrap();std::fs::create_dir(remote.join(case)).unwrap();std::fs::write(out.join("current-case"),case).unwrap();
  let engine=Engine::default();engine.start(format!("wait-{case}"),profile.clone(),local.to_string_lossy().into_owned(),format!("/{case}"),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),SyncOptions::default()).unwrap();let id=format!("wait-{case}");
  wait_until(||{let s=engine.status(&id).unwrap();assert!(s.failure.is_none());s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp});
  let clock=Instant::now();let epoch=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();*TRACE.get_or_init(||Mutex::new(None)).lock().unwrap()=Some((local.clone(),clock,Vec::new()));
  if case=="queued"{std::fs::write(local.join("blocker.txt"),vec![65;16384]).unwrap();wait_until(||out.join("write-held").exists());}
  let file=local.join("new.txt");mark(&file,"created");std::fs::write(&file,b"first generated chunk").unwrap();mark(&file,"write_done");
  if case=="burst"{use std::io::Write;for _ in 0..2{thread::sleep(Duration::from_millis(200));std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(b" appended chunk").unwrap();mark(&file,"write_done");}}
  if case=="queued"{thread::sleep(Duration::from_millis(800));std::fs::write(out.join("release-write"),b"generated").unwrap();}
  let target=remote.join(case).join("new.txt");wait_until(||{let s=engine.status(&id).unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);target.is_file()&&s.sent>=if case=="queued"{2}else{1}&&s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp});
  assert_eq!(std::fs::read(&target).unwrap(),std::fs::read(&file).unwrap());let status=engine.status(&id).unwrap();mark(&file,"caught_up");engine.stop(&id).unwrap();let marks=TRACE.get().unwrap().lock().unwrap().take().unwrap().2;
  results.push(serde_json::json!({"case":case,"startEpochMs":epoch,"statusLatencyMs":status.latency,"marks":marks}));
 }
 std::fs::write(out.join("native-timing.json"),serde_json::to_vec_pretty(&results).unwrap()).unwrap();
}
