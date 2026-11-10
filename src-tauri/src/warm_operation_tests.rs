//! Generated, isolated loopback coverage. Run only via warm-operation-test.mjs.
use super::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn wait_for(path: &std::path::Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(start.elapsed() < Duration::from_secs(30), "fixture handshake timed out: {}", path.display());
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn checkpoint(root: &std::path::Path, name: &str) {
    std::fs::write(root.join(format!("{name}.ready")), b"generated").unwrap();
    wait_for(&root.join(format!("{name}.ack")));
}
fn profile(v: &Value, root: &std::path::Path) -> sftp::Profile {
    let key = PathBuf::from(v["key"].as_str().unwrap()).canonicalize().unwrap();
    assert!(key.starts_with(root));
    let port = v["port"].as_u64().unwrap();
    assert!((1..=65535).contains(&port));
    sftp::Profile { id:"same-generated-id".into(), name:"loopback".into(), host:"127.0.0.1".into(), port:port as u16, user:"fixture".into(), auth:"key".into(), mode:"sftp".into(), key_file:key.to_str().unwrap().into(), host_key:v["fingerprint"].as_str().unwrap().into() }
}
fn connect_session(sessions: &Arc<sessions::Sessions>, id: &str, p: &sftp::Profile, secret: &str) {
    sessions.prepare(id).unwrap();
    let mut lease = sessions.connect(id, p.clone(), zeroize::Zeroizing::new(secret.into())).unwrap();
    lease.browse_home().unwrap();
    lease.install().unwrap();
}
fn request(action: &str, source: &str, target: Option<&str>, items: Value, spoof: &sftp::Profile) -> file_ops::Request {
    serde_json::from_value(json!({"id":"warm-op","side":"remote","action":action,"source":source,"destination":target,"items":items,"profile":spoof,"passphrase":"intentionally-wrong-generated-secret","confirmDelete":true})).unwrap()
}
fn run(engine: &engine::Engine, sessions: &Arc<sessions::Sessions>, id: &str, mut request: file_ops::Request, times: &mut Vec<u128>) -> Result<file_ops::Outcome,String> {
    let stop = engine.claim_operation("warm-op").unwrap();
    let lease = sessions.resolve(if id == "baseline" { "one" } else { id }).unwrap();
    lease.link_stop(&stop).unwrap();
    let start = Instant::now();
    let out = if id == "baseline" { request.profile=Some(lease.profile().clone()); request.passphrase=zeroize::Zeroizing::new(lease.secret().into()); file_ops::run(engine, request, &stop) } else { file_ops::run_with_session(engine, request, &stop, Some(&lease)) };
    times.push(start.elapsed().as_micros());
    engine.finish_operation("warm-op");
    assert!(engine.operation_progress("warm-op").is_none());
    out
}
#[test]
#[ignore = "generated localhost warm operation fixture"]
fn warm_operation_fixture() {
    let manifest = PathBuf::from(std::env::var("NEARLY_WARM_FIXTURE").unwrap()).canonicalize().unwrap();
    let root = manifest.parent().unwrap();
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap();
    assert!(root.starts_with(&allowed) && root != allowed);
    let v: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(v["generatedOnly"], true);
    let mode = v["mode"].as_str().unwrap();
    assert!(["baseline","healthy","identity","ancestor","partial","cancel","disconnect","stale","uncertain"].contains(&mode));
    let remote = PathBuf::from(v["remote"].as_str().unwrap()).canonicalize().unwrap();
    assert!(remote.starts_with(root) && remote != root);
    let p = profile(&v,root);
    let mut spoof = p.clone(); spoof.port = 1; spoof.host_key = "invalid generated caller key".into();
    let secret = v["passphrase"].as_str().unwrap();
    let sessions = Arc::new(sessions::Sessions::default());
    let engine = engine::Engine::default();
    std::fs::create_dir_all(remote.join("bench")).unwrap();
    for i in 0..4 { std::fs::write(remote.join(format!("bench/source{i}")), vec![65+i as u8; 131072]).unwrap(); }
    connect_session(&sessions,"one",&p,secret);
    checkpoint(root,"connected");
    let mut times = vec![];
    let operation_session = if mode == "baseline" { "baseline" } else { "one" };
    let req = |action,source,target,items| request(action,source,target,items,&spoof);
    assert_eq!(run(&engine,&sessions,operation_session,req("copy","/bench/source0",Some("/bench/cold"),json!([])),&mut times).unwrap().completed,1);
    checkpoint(root,"cold");
    assert_eq!(run(&engine,&sessions,operation_session,req("copy","/bench/source0",Some("/bench/warm"),json!([])),&mut times).unwrap().completed,1);
    assert_eq!(std::fs::read(remote.join("bench/cold")).unwrap(),std::fs::read(remote.join("bench/warm")).unwrap());
    checkpoint(root,"warm");
    if mode == "healthy" || mode == "baseline" {
        for (action,source,target) in [("move","/bench/warm",Some("/bench/moved")),("createfile","/bench",Some("/bench/empty")),("mkdir","/bench",Some("/bench/dir")),("delete","/bench/moved",None)] {
            assert_eq!(run(&engine,&sessions,operation_session,req(action,source,target,json!([])),&mut times).unwrap().completed,1);
        }
        for action in ["copy","move","delete"] {
            let items:Vec<_> = (1..4).map(|i|json!({"source":format!("/bench/{}{i}",if action=="copy"{"source"}else if action=="move"{"copy"}else{"moved"}),"destination":if action=="delete"{None}else{Some(format!("/bench/{}{i}",if action=="copy"{"copy"}else{"moved"}))}})).collect();
            let out=run(&engine,&sessions,operation_session,req(action,"/bench/source1",None,json!(items)),&mut times).unwrap();
            assert_eq!(out.completed,3); assert!(out.items.iter().all(|i|i.completed));
            for i in 1..4 {if action!="delete" {assert_eq!(std::fs::read(remote.join(format!("bench/{}{i}",if action=="copy"{"copy"}else{"moved"}))).unwrap(),vec![65+i as u8;131072]);}else{assert!(!remote.join(format!("bench/moved{i}")).exists());}}
        }
        assert!(remote.join("bench/dir").is_dir()); assert_eq!(std::fs::metadata(remote.join("bench/empty")).unwrap().len(),0); assert!(!remote.join("bench/moved").exists());
        sessions.resolve("one").unwrap().list_remote("/bench").unwrap();
    } else if mode == "identity" {
        let second=&v["second"]; let other=PathBuf::from(second["remote"].as_str().unwrap()).canonicalize().unwrap(); assert!(other.starts_with(root));
        let p2=profile(second,root); assert_eq!(p.id,p2.id); assert_ne!(p.port,p2.port);
        std::fs::create_dir_all(other.join("bench")).unwrap(); std::fs::write(other.join("bench/source0"),b"second endpoint").unwrap();
        connect_session(&sessions,"two",&p2,second["passphrase"].as_str().unwrap());
        assert_eq!(run(&engine,&sessions,"two",request("copy","/bench/source0",Some("/bench/other"),json!([]),&p),&mut times).unwrap().completed,1);
        assert_eq!(std::fs::read(other.join("bench/other")).unwrap(),b"second endpoint"); assert!(!remote.join("bench/other").exists());
        assert_eq!(run(&engine,&sessions,operation_session,request("copy","/bench/source0",Some("/bench/first"),json!([]),&p2),&mut times).unwrap().completed,1);
        assert!(!other.join("bench/first").exists());
    } else if mode == "ancestor" {
        assert!(run(&engine,&sessions,operation_session,req("copy","/bench/source0",Some("/bench/refused"),json!([])),&mut times).is_err());
        assert!(!remote.join("bench/refused").exists()); checkpoint(root,"failed");
    } else if mode == "partial" {
        std::fs::write(remote.join("bench/collision"),b"sentinel").unwrap();
        let out=run(&engine,&sessions,operation_session,req("copy","/bench/source1",None,json!([{"source":"/bench/source1","destination":"/bench/partial"},{"source":"/bench/source2","destination":"/bench/collision"},{"source":"/bench/source3","destination":"/bench/unattempted"}])),&mut times).unwrap();
        assert_eq!(out.completed,2); assert!(out.items[0].completed); assert!(out.items[1].attempted && !out.items[1].completed); assert!(out.items[2].completed);
        assert_eq!(std::fs::read(remote.join("bench/collision")).unwrap(),b"sentinel"); assert_eq!(std::fs::read(remote.join("bench/unattempted")).unwrap(),vec![68;131072]); checkpoint(root,"failed");
    } else if mode=="cancel" || mode=="disconnect" {
        let stop=engine.claim_operation("warm-op").unwrap(); let lease=sessions.resolve("one").unwrap(); lease.link_stop(&stop).unwrap();
        std::thread::scope(|scope| {
            let cancel=scope.spawn(|| {wait_for(&root.join("mutation-held")); if mode=="cancel"{engine.cancel_operation("warm-op").unwrap();}else{sessions.disconnect("one").unwrap();} std::fs::write(root.join("mutation-release"),b"generated").unwrap();});
            assert!(file_ops::run_with_session(&engine,req("copy","/bench/source1",Some("/bench/cancelled"),json!([])),&stop,Some(&lease)).is_err()); cancel.join().unwrap();
        });
        assert!(stop.load(Ordering::SeqCst)); engine.finish_operation("warm-op");
        if mode=="disconnect" {assert!(sessions.resolve("one").is_err());assert!(sessions.prepare("one").is_err());assert!(lease.link_stop(&Arc::new(AtomicBool::new(false))).is_err());}
        drop(lease); checkpoint(root,"failed");
        if mode=="disconnect"{connect_session(&sessions,"one",&p,secret);}
    } else if mode=="stale" {checkpoint(root,"disconnect-idle");}
    else if mode=="uncertain" {
        assert!(run(&engine,&sessions,operation_session,req("move","/bench/source1",Some("/bench/uncertain"),json!([])),&mut times).is_err());
        assert!(!remote.join("bench/source1").exists()); assert_eq!(std::fs::read(remote.join("bench/uncertain")).unwrap(),vec![66;131072]); checkpoint(root,"failed");
    }
    if !matches!(mode,"baseline"|"healthy"|"identity") {
        assert_eq!(run(&engine,&sessions,operation_session,req("copy","/bench/source0",Some("/bench/recovered"),json!([])),&mut times).unwrap().completed,1);
        assert_eq!(std::fs::read(remote.join("bench/recovered")).unwrap(),vec![65;131072]);
    }
    checkpoint(root,"finished");
    sessions.shutdown();
    std::fs::write(root.join("timing.json"),serde_json::to_vec(&json!({"mode":mode,"operationMicroseconds":times})).unwrap()).unwrap();
}
