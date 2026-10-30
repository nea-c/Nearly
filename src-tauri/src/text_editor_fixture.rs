use super::*;
use std::{sync::atomic::Ordering,time::{Instant,Duration}};
fn wait(path:&Path){let start=Instant::now();while !path.exists(){assert!(start.elapsed()<Duration::from_secs(20),"generated editor hold timeout");std::thread::sleep(Duration::from_millis(3));}}
#[test]#[ignore="generated localhost text editor end-to-end model fixture"]
fn text_editor_generated_localhost(){
 let manifest=PathBuf::from(std::env::var("NEARLY_EDITOR_FIXTURE").unwrap());let out=manifest.parent().unwrap().canonicalize().unwrap();assert!(out.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));let v:serde_json::Value=serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);
 let remote=PathBuf::from(v["remote"].as_str().unwrap());let mode=v["mode"].as_str().unwrap();fs::create_dir_all(remote.join("docs")).unwrap();let file=remote.join("docs/file.txt");let original=b"\xef\xbb\xbforiginal\r\n";fs::write(&file,original).unwrap();File::options().write(true).open(&file).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();
 if mode=="large"{fs::write(&file,vec![b'a';text_codec::MAX_BYTES+1]).unwrap();}if mode=="binary"{fs::write(&file,b"\x00\x01binary").unwrap();}
 let profile=crate::sftp::Profile{id:"generated".into(),name:"Same display name".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:v["key"].as_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
 if matches!(mode,"sync-conflict"|"local-sync"|"remote-resume"){sync_boundaries(&out,&remote,profile,v["passphrase"].as_str().unwrap(),mode=="local-sync");return;}
 let sessions=Arc::new(crate::sessions::Sessions::default());sessions.prepare("workspace").unwrap();let mut initial=sessions.connect("workspace",profile.clone(),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into())).unwrap();initial.install().unwrap();drop(initial);
 if mode=="origin-lifecycle"{origin_lifecycle(&out,&remote,profile,v["passphrase"].as_str().unwrap());return;}
 let engine=Engine::default();let broker=Broker::default();let stop=engine.claim_operation("open").unwrap();let opened=broker.open(&engine,"window","workspace","open",Target::Remote{path:"/docs/file.txt".into(),lease:if mode=="fork-origin-close"{sessions.resolve("workspace").unwrap().fork_editor().unwrap()}else{sessions.resolve("workspace").unwrap()}},&stop);engine.finish_operation("open");
 if matches!(mode,"large"|"binary"|"symlink"){assert!(opened.is_err());assert!(!broker.any_open());return;}
 let view=opened.unwrap();assert_eq!(view.text,"original\n");assert!(broker.get("other-window",&view.token).is_err());
 if mode=="fork-origin-close"{sessions.disconnect("workspace").unwrap();}
 if mode=="conflict"{fs::write(&file,b"\xef\xbb\xbfexternal\r\n").unwrap();File::options().write(true).open(&file).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}
 if mode=="disconnect-before"{sessions.disconnect("workspace").unwrap();assert!(sessions.prepare("workspace").is_err(),"frozen lease blocks silent same-tab reconnect until editor closes");}
 if mode=="sync-conflict"{let local=out.join("sync-source");fs::create_dir(&local).unwrap();engine.start("active-sync".into(),profile.clone(),local.to_string_lossy().into_owned(),"/docs".into(),zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into()),crate::engine::SyncOptions::default()).unwrap();}
 let replacement=if matches!(mode,"cancel-mid"|"concurrent"|"destroy-mid"){format!("{}\n","x".repeat(70000))}else{"updated\n".into()};
 let stop=engine.claim_operation("save").unwrap();if mode=="cancel-before"{engine.cancel_operation("save").unwrap();}
 let result=if matches!(mode,"cancel-mid"|"concurrent"|"destroy-mid"){
  std::thread::scope(|scope|{let worker=scope.spawn(||broker.save(&engine,"window",&view.token,"save",&replacement,&stop));wait(&out.join("write-held"));
   if matches!(mode,"cancel-mid"|"destroy-mid"){engine.cancel_operation("save").unwrap();if mode=="destroy-mid"{broker.forget_window("window");let _=engine.claim_operation("probe-destroy").unwrap();assert!(engine.reserve_upload_operation("probe-destroy",vec![],vec!["/docs/file.txt".into()],String::new(),vec![format!("127.0.0.1:{}",profile.port).parse().unwrap()]).is_err(),"destroy keeps reservation while its cancelled worker still owns the document");engine.finish_operation("probe-destroy");}}else{let other=engine.claim_operation("second").unwrap();assert!(broker.save(&engine,"window",&view.token,"second","wrong",&other).is_err());assert!(broker.close("window",&view.token).is_err());assert!(engine.reserve_upload_operation("second",vec![],vec!["/docs/file.txt".into()],String::new(),vec![format!("127.0.0.1:{}",profile.port).parse().unwrap()]).is_err());engine.finish_operation("second");}
   fs::write(out.join("release-write"),b"generated").unwrap();worker.join().unwrap()})
 }else{broker.save(&engine,"window",&view.token,"save",&replacement,&stop)};engine.finish_operation("save");
 match mode{
  "roundtrip"|"concurrent"=>{assert!(result.is_ok(),"{:?}",result.err());assert_eq!(fs::read(&file).unwrap(),format!("\u{feff}{}\r\n",replacement.trim_end_matches('\n')).as_bytes());let stop=engine.claim_operation("save-again").unwrap();broker.save(&engine,"window",&view.token,"save-again","second\n",&stop).unwrap();engine.finish_operation("save-again");assert_eq!(fs::read(&file).unwrap(),b"\xef\xbb\xbfsecond\r\n");},
  "conflict"|"later-conflict"=>{assert!(result.is_err());assert_eq!(fs::read(&file).unwrap(),b"\xef\xbb\xbfexternal\r\n");},
  _=>{assert!(result.is_err(),"mode {mode} unexpectedly saved");assert_eq!(fs::read(&file).unwrap(),original);},
 }
 if mode=="sync-conflict"{engine.stop("active-sync").unwrap();let stop=engine.claim_operation("after-sync").unwrap();broker.save(&engine,"window",&view.token,"after-sync","after stop\n",&stop).unwrap();engine.finish_operation("after-sync");assert_eq!(fs::read(&file).unwrap(),b"\xef\xbb\xbfafter stop\r\n");}
 if mode=="destroy-mid"{assert!(!broker.any_open());let _=engine.claim_operation("after-destroy").unwrap();assert!(engine.reserve_upload_operation("after-destroy",vec![],vec!["/docs/file.txt".into()],String::new(),vec![format!("127.0.0.1:{}",profile.port).parse().unwrap()]).is_ok());engine.finish_operation("after-destroy");return;}
 assert!(broker.get("window",&view.token).is_ok(),"failed saves keep the editor document");broker.close("window",&view.token).unwrap();assert!(!broker.any_open());
}
fn sync_boundaries(out:&Path,remote:&Path,profile:crate::sftp::Profile,secret:&str,local_side:bool){
 let ordinary=PathBuf::from(out.to_string_lossy().strip_prefix(r"\\?\").unwrap_or(&out.to_string_lossy()));let source=ordinary.join("editor-sync-source");fs::create_dir(&source).unwrap();let file=source.join("file.txt");let original=b"\xef\xbb\xbforiginal\r\n";fs::write(&file,original).unwrap();File::options().write(true).open(&file).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();
 let sessions=Arc::new(crate::sessions::Sessions::default());sessions.prepare("workspace").unwrap();let mut initial=sessions.connect("workspace",profile.clone(),zeroize::Zeroizing::new(secret.into())).unwrap();initial.install().unwrap();drop(initial);
 let engine=Engine::default();let broker=Broker::default();let target=||if local_side{Target::Local(file.clone())}else{Target::Remote{path:"/docs/file.txt".into(),lease:sessions.resolve("workspace").unwrap()}};
 let stop=engine.claim_operation("open").unwrap();let view=broker.open(&engine,"editor-window","editor-tab","open",target(),&stop).unwrap();engine.finish_operation("open");
 let start=|id:&str|{let mut other=profile.clone();other.id="other-tab-profile".into();other.name="Another tab sync".into();engine.start(id.into(),other,source.to_string_lossy().into_owned(),"/docs".into(),zeroize::Zeroizing::new(secret.into()),crate::engine::SyncOptions::default())};
 assert!(start("blocked-by-document").is_err(),"same target sync must not start while editor reserves it");broker.close("editor-window",&view.token).unwrap();
 let caught=|id:&str|{let start=Instant::now();loop{let s=engine.status(id).unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if engine.taskbar_state_for(&[id.to_string()]).unwrap()==crate::taskbar_status::TaskbarState::CaughtUp{break;}assert!(start.elapsed()<Duration::from_secs(20));std::thread::sleep(Duration::from_millis(5));}};
 start("other-tab-sync").unwrap();for id in ["during-start","caught-up"]{if id=="caught-up"{caught("other-tab-sync");}let stop=engine.claim_operation(id).unwrap();assert!(broker.open(&engine,"editor-window","another-tab",id,target(),&stop).is_err());engine.finish_operation(id);}engine.stop("other-tab-sync").unwrap();
 let stop=engine.claim_operation("reopen-after-stop").unwrap();let view=broker.open(&engine,"editor-window","editor-tab","reopen-after-stop",target(),&stop).unwrap();engine.finish_operation("reopen-after-stop");let stale=broker.get("editor-window",&view.token).unwrap();
 let stop=engine.claim_operation("after-stop").unwrap();broker.save(&engine,"editor-window",&view.token,"after-stop","editor saved\n",&stop).unwrap();engine.finish_operation("after-stop");let edited=b"\xef\xbb\xbfeditor saved\r\n";assert_eq!(fs::read(if local_side{file.clone()}else{remote.join("docs/file.txt")}).unwrap(),edited);broker.close("editor-window",&view.token).unwrap();drop(stale);
 start("resumed-other-tab").unwrap();
 if local_side{caught("resumed-other-tab");assert_eq!(fs::read(remote.join("docs/file.txt")).unwrap(),edited);assert_eq!(fs::read(&file).unwrap(),edited);}
 else{
  let end=Instant::now()+Duration::from_secs(20);loop{let status=engine.status("resumed-other-tab").unwrap();if let Some(failure)=status.failure{assert_eq!(failure.operation,"conflict");assert_eq!(status.sent,0);break;}assert!(Instant::now()<end,"resumed sync must preserve the newer editor save");std::thread::sleep(Duration::from_millis(5));}
  assert_eq!(fs::read(remote.join("docs/file.txt")).unwrap(),edited);assert_eq!(fs::read(&file).unwrap(),original);
 }
 engine.stop("resumed-other-tab").unwrap();assert!(broker.get("editor-window",&view.token).is_err());
}
fn origin_lifecycle(out:&Path,remote:&Path,profile:crate::sftp::Profile,secret:&str){
 let state=crate::AppState::default();
 {let mut r=state.ownership.lock().unwrap();for label in ["source-a","source-b","text-editor"]{r.bootstrap(label).unwrap();}r.claim("source-a","a").unwrap();r.claim("source-b","b").unwrap();}
 for id in ["a","b"]{state.sessions.prepare(id).unwrap();let mut initial=state.sessions.connect(id,profile.clone(),zeroize::Zeroizing::new(secret.into())).unwrap();initial.install().unwrap();}
 fs::write(remote.join("docs/other.txt"),b"other").unwrap();let local=PathBuf::from(out.to_string_lossy().strip_prefix(r"\\?\").unwrap_or(&out.to_string_lossy())).join("origin-local.txt");fs::write(&local,b"local").unwrap();
 let open=|id:&str,workspace:&str,target:Target|{let stop=state.engine.claim_operation(id).unwrap();let view=state.text_editor.open(&state.engine,"text-editor",workspace,id,target,&stop).unwrap();state.engine.finish_operation(id);view};
 let(ready_tx,ready_rx)=std::sync::mpsc::channel();let(release_tx,release_rx)=std::sync::mpsc::channel();
 let a=std::thread::scope(|scope|{
  let operation=crate::NativeOperation::claim(&state,"source-a","open-a",Some("a")).unwrap();let stop=state.engine.claim_operation("open-a").unwrap();let lease=state.sessions.resolve("a").unwrap().fork_editor().unwrap();let observed=&state;
  let worker=scope.spawn(move||{let _operation=operation;tests::hold_open(ready_tx,release_rx);let result=observed.text_editor.open(&observed.engine,"text-editor","a","open-a",Target::Remote{path:"/docs/file.txt".into(),lease},&stop);observed.engine.finish_operation("open-a");result});
  ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();assert!(crate::seal_native_window_close(&state,"source-a",false).is_err(),"a read waiting to insert must retain its source operation until insertion completes");assert!(state.sessions.resolve("a").is_ok(),"refused close cannot revoke the source lease");release_tx.send(()).unwrap();worker.join().unwrap().unwrap()
 });
 let b=open("open-b","b",Target::Remote{path:"/docs/other.txt".into(),lease:state.sessions.resolve("b").unwrap().fork_editor().unwrap()});
 let local_view=open("open-local","a",Target::Local(local.clone()));
 assert_eq!(state.text_editor.remote_tokens(&["a".into()]).unwrap(),vec![a.token.clone()]);
 assert!(crate::seal_native_window_close(&state,"source-a",false).is_err());
 assert!(state.text_editor.guard_origin_close(&["a".into()],||state.sessions.disconnect("a")).is_err());
 let captured=state.text_editor.get("text-editor",&a.token).unwrap();
 {let held=captured.content.lock().unwrap();assert!(state.text_editor.close("text-editor",&a.token).is_err());assert!(state.text_editor.guard_origin_close(&["a".into()],||state.sessions.disconnect("a")).is_err());drop(held);}
 state.text_editor.close("text-editor",&a.token).unwrap();state.text_editor.guard_origin_close(&["a".into()],||state.sessions.disconnect("a")).unwrap();
 assert_eq!(crate::seal_native_window_close(&state,"source-a",false).unwrap(),vec!["a".to_string()]);
 let stop=state.engine.claim_operation("stale-save").unwrap();assert!(save_document(&captured,&state.engine,"stale-save","must not save",&stop).is_err());state.engine.finish_operation("stale-save");
 let stop=state.engine.claim_operation("other-save").unwrap();state.text_editor.save(&state.engine,"text-editor",&b.token,"other-save","other remains writable",&stop).unwrap();state.engine.finish_operation("other-save");
 assert_eq!(state.text_editor.get("text-editor",&local_view.token).unwrap().workspace,"a");assert_eq!(fs::read(&local).unwrap(),b"local");assert_eq!(fs::read(remote.join("docs/file.txt")).unwrap(),b"\xef\xbb\xbforiginal\r\n");
 state.text_editor.close_window("text-editor").unwrap();
}
