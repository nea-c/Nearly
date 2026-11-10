//! Mocked SSH protocol coverage only; no server-side archive execution.
use super::*;
#[test]
#[ignore = "generated localhost remote ZIP transport fixture"]
fn remote_zip_transport_fixture() {
    let manifest=PathBuf::from(std::env::var("NEARLY_REMOTE_ZIP_FIXTURE").unwrap()).canonicalize().unwrap();
    let root=manifest.parent().unwrap();
    let allowed=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap();
    assert!(root.starts_with(&allowed)&&root!=allowed);
    let v:serde_json::Value=serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(v["generatedOnly"],true);
    let remote=PathBuf::from(v["remote"].as_str().unwrap()).canonicalize().unwrap();assert!(remote.starts_with(root));
    let key=PathBuf::from(v["key"].as_str().unwrap()).canonicalize().unwrap();assert!(key.starts_with(root));
    let mode=v["mode"].as_str().unwrap();
    assert!(["exec-denied","windows","missing-python","pre-cancel","unknown","disconnect","mismatch","success","cancel-dispatched","missing-safe-publish","cancel-namespace"].contains(&mode));
    let p=sftp::Profile{id:"generated-zip".into(),name:"loopback only".into(),host:"127.0.0.1".into(),port:u16::try_from(v["port"].as_u64().unwrap()).unwrap(),user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:key.to_str().unwrap().into(),host_key:v["fingerprint"].as_str().unwrap().into()};
    let sessions=Arc::new(sessions::Sessions::default());sessions.prepare("zip").unwrap();
    let mut connected=sessions.connect("zip",p,zeroize::Zeroizing::new(v["passphrase"].as_str().unwrap().into())).unwrap();connected.browse_home().unwrap();connected.install().unwrap();drop(connected);
    let engine=engine::Engine::default();
    for index in 0..if mode=="success"{2}else{1} {
        let id=format!("archive-{index}");let stop=engine.claim_operation(&id).unwrap();
        let lease=sessions.resolve("zip").unwrap();lease.link_stop(&stop).unwrap();
        let request:remote_zip::Request=serde_json::from_value(serde_json::json!({"id":id,"sessionId":"zip","action":"compress","sources":["/bench/odd '$(x)&.txt"],"destination":format!("/bench/output-{index}.zip")})).unwrap();
        if mode=="pre-cancel"{stop.store(true,Ordering::SeqCst);}
        let result=std::thread::scope(|scope|{
            let canceller=if matches!(mode,"cancel-dispatched"|"cancel-namespace") {Some(scope.spawn(||{
                let start=std::time::Instant::now();while !root.join("dispatched").exists(){assert!(start.elapsed()<std::time::Duration::from_secs(20));std::thread::sleep(std::time::Duration::from_millis(5));}
                stop.store(true,Ordering::SeqCst);std::fs::write(root.join("cancelled"),b"generated").unwrap();
            }))}else{None};
            let result=remote_zip::run(&engine,&request,&lease,&stop);if let Some(c)=canceller{c.join().unwrap();}result
        });
        if mode=="success" {let out=result.unwrap();assert_eq!((out.entries,out.bytes),(1,7));assert_eq!(out.final_path,request.destination);assert_eq!(engine.operation_progress(&id).unwrap().snapshot().phase,"finalizing");}
        else {let expected=match mode{"exec-denied"=>"remote_exec_unavailable","windows"=>"remote_platform_unsupported","missing-python"=>"remote_tool_unavailable","missing-safe-publish"=>"remote_publish_unavailable","pre-cancel"|"cancel-dispatched"|"cancel-namespace"=>"cancelled","mismatch"=>"remote_path_mismatch",_=>"remote_outcome_unknown"};assert_eq!(result.unwrap_err().code,expected,"mode {mode}");}
        engine.finish_operation(&id);
    }
    sessions.shutdown();
    // The fake executor must never create an archive or touch selected sources.
    assert_eq!(std::fs::read(remote.join("bench/odd '$(x)&.txt")).unwrap(),b"fixture");
    assert!(!remote.join("bench/output-0.zip").exists());
}
