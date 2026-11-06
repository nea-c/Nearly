use super::*;
#[test]#[ignore="generated readonly localhost inventory comparison"]fn generated_remote_inventory(){
 assert_eq!(std::env::var("NEARLY_REMOTE_SCAN_QA").as_deref(),Ok("GENERATED_ONLY"));
 let p=PathBuf::from(std::env::var("NEARLY_REMOTE_SCAN_FIXTURE").unwrap()).canonicalize().unwrap();
 let allowed=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join("release-r41-pre1-local/runs").canonicalize().unwrap();
 let base=p.parent().unwrap();assert!(base.starts_with(allowed));assert_eq!(std::fs::read(base.join("generated.marker")).unwrap(),b"GENERATED_ONLY");
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();let key=PathBuf::from(v["key"].as_str().unwrap()).canonicalize().unwrap();assert!(key.starts_with(base));
 let profile=Profile{id:"generated".into(),name:"generated".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap().try_into().unwrap(),user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:key.to_string_lossy().into_owned(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let stop=std::sync::Arc::new(AtomicBool::new(false));let(c,_)=connect(&profile,v["passphrase"].as_str().unwrap(),&stop).unwrap();
 let cancel=if v["cancelMs"].is_u64(){let s=stop.clone();let ms=v["cancelMs"].as_u64().unwrap();Some(std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(ms));s.store(true,Ordering::SeqCst)}))}else{None};
 let rules=crate::exclusion::Rules::compile(v["exclusions"].as_str().unwrap_or("")).unwrap();let start=std::time::Instant::now();
 let result=match v["variant"].as_str().unwrap(){"serial"=>scan_remote_serial(&c,"/sync/a/b",Path::new(""),&rules,true,&stop),"close"=>scan_remote_close(&c,"/sync/a/b",Path::new(""),&rules,true,&stop),"bounded4"=>scan_remote(&c,"/sync/a/b",Path::new(""),&rules,true,&stop),_=>panic!("variant")};
 let elapsed=start.elapsed().as_secs_f64()*1000.;
 let report=match result{Ok(i)=>{assert!(!v["expectError"].as_bool().unwrap_or(false));let rows=i.entries.into_iter().map(|(p,n)|serde_json::json!([p.to_string_lossy(),format!("{:?}",n.kind),n.version,n.permissions])).collect::<Vec<_>>();serde_json::json!({"elapsedMs":elapsed,"entries":rows})},Err(e)=>{assert!(v["expectError"].as_bool().unwrap_or(false),"{e}");serde_json::json!({"elapsedMs":elapsed,"error":e})}};
 drop(c);if let Some(t)=cancel{t.join().unwrap();}std::fs::write(base.join("result.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
