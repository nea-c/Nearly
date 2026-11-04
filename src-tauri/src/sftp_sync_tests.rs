use super::*;
use std::path::PathBuf;
#[test]fn prepared_default_preserves_opaque_file_refusal_before_open(){
 let root=std::env::temp_dir().join(format!("nearly-prepared-denial-{}",getrandom::u64().unwrap()));std::fs::create_dir(&root).unwrap();let root=root.canonicalize().unwrap();let calls=std::cell::RefCell::new(Vec::new());
 let check=|p:&Path,d:bool|{calls.borrow_mut().push((p.to_owned(),d));Err("generated per-file policy refusal".to_owned())};
 let result=CallbackValidation(&check).open_source(&root,Path::new("missing-no-read"));assert_eq!(result.err().unwrap(),"generated per-file policy refusal");assert_eq!(*calls.borrow(),vec![(PathBuf::from("missing-no-read"),false)]);std::fs::remove_dir(root).unwrap();
}
#[test]fn prepared_default_keeps_root_authority_refusal(){
 let root=std::env::temp_dir().join(format!("nearly-prepared-root-{}",getrandom::u64().unwrap()));std::fs::create_dir(&root).unwrap();std::fs::write(root.join("item"),b"generated").unwrap();let root=root.canonicalize().unwrap();
 let check=|p:&Path,_|if p.as_os_str().is_empty(){Err("generated root refusal".to_owned())}else{Ok(())};let result=CallbackValidation(&check).open_source(&root,Path::new("item"));assert_eq!(result.err().unwrap(),"generated root refusal");std::fs::remove_file(root.join("item")).unwrap();std::fs::remove_dir(root).unwrap();
}
#[cfg(windows)]#[test]fn prepared_handle_keeps_later_path_replacement_observable(){
 let root=std::env::temp_dir().join(format!("nearly-prepared-change-{}",getrandom::u64().unwrap()));std::fs::create_dir(&root).unwrap();std::fs::write(root.join("item"),b"oldbytes").unwrap();let root=root.canonicalize().unwrap();let check=|_:&Path,_|Ok(());let validator=CallbackValidation(&check);
 let old=validator.open_source(&root,Path::new("item")).unwrap();let snapshot=crate::source_change::Snapshot::capture(&old).unwrap();std::fs::write(root.join("new"),b"newbytes").unwrap();std::fs::rename(root.join("new"),root.join("item")).unwrap();let current=validator.open_source(&root,Path::new("item")).unwrap();assert_eq!(snapshot.changed(&old,&current,8).unwrap(),Some(crate::source_change::Change::Replaced));drop(old);drop(current);std::fs::remove_file(root.join("item")).unwrap();std::fs::remove_dir(root).unwrap();
}
#[test]#[ignore="generated localhost compatible product cycle"]fn compatible_cycle_generated(){
 use std::path::PathBuf;
 assert_eq!(std::env::var("NEARLY_WIN_SCP_PROTOTYPE").as_deref(),Ok("YES_GENERATED_ONLY"));let config=PathBuf::from(std::env::var("NEARLY_COMPARE_FIXTURE").unwrap());let out=config.parent().unwrap().canonicalize().unwrap();let allowed=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("nearly-sync-read-coalescing/test-results").canonicalize().unwrap();assert!(out.starts_with(allowed));assert_eq!(std::fs::read(out.join("generated-winscp-prototype.marker")).unwrap(),b"GENERATED_LOCALHOST_ONLY");
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(config).unwrap()).unwrap();assert_eq!(v["generatedOnly"],true);let root=PathBuf::from(v["local"].as_str().unwrap()).canonicalize().unwrap();let key=PathBuf::from(v["key"].as_str().unwrap()).canonicalize().unwrap();assert!(root.starts_with(&out)&&key.starts_with(&out));let profile=Profile{id:"fixture".into(),name:"generated".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap().try_into().unwrap(),user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:key.to_string_lossy().into_owned(),host_key:v["fingerprint"].as_str().unwrap().into()};let(mut c,_)=connect(&profile,v["passphrase"].as_str().unwrap(),&AtomicBool::new(false)).unwrap();let stop=Arc::new(AtomicBool::new(false));let done=Arc::new(AtomicBool::new(false));let watcher=if v["cancel"]==true{let(out,stop,done)=(out.clone(),stop.clone(),done.clone());Some(std::thread::spawn(move||{while !done.load(Ordering::Relaxed){if out.join("cancel-request").exists(){stop.store(true,Ordering::SeqCst);break;}std::thread::sleep(Duration::from_millis(2));}}))}else{None};let root_refused=std::cell::Cell::new(false);let sent=std::cell::Cell::new(0);let start=std::time::Instant::now();
 let result=cycle(&mut c,&root,"/sync/a/b",Path::new(v["scope"].as_str().unwrap_or("")),&crate::exclusion::Rules::compile(v["exclusions"].as_str().unwrap_or("")).unwrap(),v["recursive"].as_bool().unwrap_or(true),v["deleteRemoved"]==true,&stop,&RetryHints::new(),&|p,_|{if p.as_os_str().is_empty()&&root_refused.get(){return Err("Generated root veto after upload begin".into())}if root.join(p).exists(){let actual=root.join(p).canonicalize().map_err(|_|"Generated local lookup")?;if !actual.starts_with(&root){return Err("Generated source escaped".into())}}Ok(())},&|_,event|{if v["refuseRootAtUploadBegin"]==true&&matches!(event,Event::Begin("upload")){root_refused.set(true);}if matches!(event,Event::Uploaded(_)){sent.set(sent.get()+1);}});
 let rescan=matches!(&result,Ok(Outcome::Rescan{..}));done.store(true,Ordering::Relaxed);if let Some(w)=watcher{w.join().unwrap();}std::fs::write(out.join("native-timing.json"),serde_json::to_vec(&serde_json::json!({"elapsedUs":start.elapsed().as_micros(),"sent":sent.get(),"rescan":rescan,"error":result.as_ref().err(),"optimized":!cfg!(debug_assertions)})).unwrap()).unwrap();if v["expectRescan"]==true{assert!(rescan);}else if v["expectFailure"]==true{assert!(result.is_err());}else{assert!(matches!(result.unwrap(),Outcome::Complete));}
}
#[tokio::test]
async fn direct_pipeline_drains_out_of_order_write_close_time_replies(){
 use tokio::io::{AsyncReadExt,AsyncWriteExt,DuplexStream};
 use russh_sftp::protocol::{Status,Version,Handle};
 async fn read(s:&mut DuplexStream)->Packet{let n=s.read_u32().await.unwrap();let mut b=vec![0;n as usize];s.read_exact(&mut b).await.unwrap();Packet::try_from(&mut bytes::Bytes::from(b)).unwrap()}
 async fn send(s:&mut DuplexStream,p:Packet){s.write_all(&bytes::Bytes::try_from(p).unwrap()).await.unwrap();}
 let(a,mut b)=tokio::io::duplex(4096);let raw=RawSftpSession::new(a);raw.set_timeout(1);
 let server=tokio::spawn(async move{
  assert!(matches!(read(&mut b).await,Packet::Init(_)));send(&mut b,Version::new().into()).await;
  let id=match read(&mut b).await{Packet::Open(p)=>p.id,_=>panic!("OPEN")};send(&mut b,Handle{id,handle:vec![1]}.into()).await;
  let w=match read(&mut b).await{Packet::Write(p)=>{assert_eq!(p.data,vec![0,255,0,128]);p.id},_=>panic!("WRITE")};
  let c=match tokio::time::timeout(Duration::from_millis(500),read(&mut b)).await.expect("CLOSE must not wait WRITE response"){Packet::Close(p)=>p.id,_=>panic!("CLOSE")};
  let t=match read(&mut b).await{Packet::SetStat(p)=>{assert_eq!(p.path,"/generated.bin");p.id},_=>panic!("SETSTAT")};
  for id in [t,w,c]{send(&mut b,Status{id,status_code:StatusCode::Ok,error_message:String::new(),language_tag:String::new()}.into()).await;}
  tokio::time::sleep(Duration::from_millis(20)).await;
 });
 raw.init().await.unwrap();let h=raw.open("/generated.bin",OpenFlags::WRITE|OpenFlags::CREATE|OpenFlags::TRUNCATE,FileAttributes::empty()).await.unwrap().handle;
 direct(&raw,h,"/generated.bin".into(),vec![0,255,0,128],FileAttributes::empty(),&AtomicBool::new(false)).await.unwrap();server.await.unwrap();
}
