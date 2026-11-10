use super::*;

#[test]
#[ignore = "generated localhost bounded parallel copy safety fixture"]
fn parallel_copy_fixture() {
    let manifest = PathBuf::from(std::env::var("NEARLY_PARALLEL_COPY_FIXTURE").unwrap());
    let root = manifest.parent().unwrap().canonicalize().unwrap();
    assert!(root.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap()));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(v["generatedOnly"], true);
    let remote = PathBuf::from(v["remote"].as_str().unwrap()).canonicalize().unwrap();
    assert!(remote.starts_with(&root));
    let mode = v["mode"].as_str().unwrap();
    let folder = mode.starts_with("folder");
    let fail = mode.ends_with("failure");
    let cancel = mode == "cancel" || mode.ends_with("-cancel");
    let large = mode.starts_with("large-");
    let refused = mode == "limit-one";
    let bytes = if mode == "zero" { 0 } else if large { 12 * 1024 * 1024 } else { 131072 };
    let profile = sftp::Profile { id:"parallel-fixture".into(), name:"loopback".into(), host:"127.0.0.1".into(), port:v["port"].as_u64().unwrap() as u16, user:"fixture".into(), auth:"key".into(), mode:"sftp".into(), key_file:v["key"].as_str().unwrap().into(), host_key:v["fingerprint"].as_str().unwrap().into() };
    assert!(PathBuf::from(&profile.key_file).canonicalize().unwrap().starts_with(&root));
    let source_dir = if folder { "bench/source" } else { "bench" };
    std::fs::create_dir_all(remote.join(source_dir)).unwrap();
    for i in 0..5 { std::fs::write(remote.join(format!("{source_dir}/source{i}")), vec![65+i as u8; bytes]).unwrap(); }
    let items: Vec<_> = if folder { vec![serde_json::json!({"source":"/bench/source","destination":"/bench/copy"})] } else { (0..5).map(|i|serde_json::json!({"source":format!("/bench/source{i}"),"destination":format!("/bench/copy{i}")})).collect() };
    let engine = engine::Engine::default();
    let stop = engine.claim_operation("parallel").unwrap();
    let request = serde_json::from_value(serde_json::json!({"id":"parallel","side":"remote","action":"copy","source":items[0]["source"],"profile":profile,"passphrase":v["passphrase"],"confirmDelete":false,"items":items})).unwrap();
    let result = if cancel {
        std::thread::scope(|scope| {
            let watcher = scope.spawn(|| {
                let start = std::time::Instant::now();
                while !root.join("mutation-held").exists() { assert!(start.elapsed() < std::time::Duration::from_secs(20)); std::thread::sleep(std::time::Duration::from_millis(5)); }
                engine.cancel_operation("parallel").unwrap();
                std::fs::write(root.join("mutation-release"), b"generated").unwrap();
            });
            let result = file_ops::run(&engine, request, &stop);
            watcher.join().unwrap(); result
        })
    } else { file_ops::run(&engine, request, &stop) };
    if refused {
        if let Ok(out) = result { assert_eq!(out.completed, 0); assert!(out.items.iter().all(|i|!i.completed)); }
        for i in 0..5 { assert!(!remote.join(format!("bench/copy{i}")).exists()); }
    } else {
        let out = result.unwrap();
        assert_eq!(out.items.len(), if folder { 1 } else { 5 });
        if large {
            assert_eq!(out.completed, 0);
            assert!(out.items[0].attempted);
            assert!(!out.items[0].completed);
            assert!(out.items[1..].iter().all(|i|!i.attempted && !i.completed));
            let partial = std::fs::read(remote.join("bench/copy0")).unwrap();
            assert!(!partial.is_empty() && partial.len() < bytes);
            assert!(partial.iter().all(|b|*b == 65));
            assert_eq!(partial.len(), if mode == "large-server-unsupported" { 4*1024*1024 } else if mode == "large-server-cancel" { 8*1024*1024 } else { 1024*1024 });
            assert_eq!(engine.operation_progress("parallel").unwrap().snapshot().selection_completed, Some(0));
            for i in 1..5 { assert!(!remote.join(format!("bench/copy{i}")).exists()); }
        } else if fail || cancel {
            if folder { assert!(!out.items[0].completed); assert!(out.items[0].attempted); }
            else {
                assert_eq!(out.completed, 3);
                for i in 0..5 {
                    assert_eq!(out.items[i].source, format!("/bench/source{i}"));
                    assert_eq!(out.items[i].completed, [0,2,3].contains(&i));
                    assert_eq!(out.items[i].attempted, i < 4);
                }
                assert_eq!(engine.operation_progress("parallel").unwrap().snapshot().selection_completed, Some(3));
            }
        } else { assert!(out.items.iter().all(|i|i.completed)); assert_eq!(out.completed, if folder { 6 } else { 5 }); }
        for i in 0..5 {
            let target = if folder { format!("bench/copy/source{i}") } else { format!("bench/copy{i}") };
            if !large && (!(fail || cancel) || [0,2,3].contains(&i)) { assert_eq!(std::fs::read(remote.join(&target)).unwrap(), vec![65+i as u8; bytes]); }
            if (fail || cancel || large) && i == 4 { assert!(!remote.join(target).exists()); }
        }
        std::fs::write(root.join("outcome.json"), serde_json::to_vec_pretty(&out).unwrap()).unwrap();
    }
    for i in 0..5 { assert_eq!(std::fs::read(remote.join(format!("{source_dir}/source{i}"))).unwrap(), vec![65+i as u8; bytes]); }
    engine.finish_operation("parallel");
    assert!(engine.operation_progress("parallel").is_none());
}
