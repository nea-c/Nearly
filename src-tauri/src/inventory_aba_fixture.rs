//! Generated metadata-observation experiment only, no user connection loading.
#[test]
#[ignore="generated inventory ABA localhost fixture only"]
fn inventory_experimental_ancestor_observation_window(){
 use std::{path::PathBuf,sync::atomic::AtomicBool};
 let p=PathBuf::from(std::env::var("NEARLY_INVENTORY_ABA_MANIFEST").unwrap());
 let root=p.parent().unwrap().canonicalize().unwrap();
 let allowed=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap();
 assert!(root.starts_with(allowed));assert!(root.file_name().unwrap().to_string_lossy().starts_with("inventory-aba-"));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
 let key=root.join("fixture-v3.ppk");assert!(!std::fs::symlink_metadata(&key).unwrap().file_type().is_symlink());
 let profile=crate::sftp::Profile{id:"generated".into(),name:"generated loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:key.to_string_lossy().into_owned(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&profile,"fixture-only-not-a-user-secret",&stop).unwrap();
 let result=crate::sftp::mirror_snapshot(&mut c,"/experiment-root",&crate::exclusion::Rules::compile("").unwrap(),true,&stop);
 let accepted=result.is_ok();assert_eq!(accepted,v["accept"].as_bool().unwrap(),"mode {} / case {} result {:?}",v["mode"],v["case"],result.as_ref().err());
 if accepted && v["case"]!="transient-permission" {
  let snap=result.as_ref().unwrap();let stamp=&snap.files.iter().find(|(p,_)|p==std::path::Path::new("d/victim.txt")).unwrap().1;
  let deletion=crate::sftp::delete_uploaded_file(&mut c,"/experiment-root",std::path::Path::new("d/victim.txt"),stamp,&stop,&||Ok(()));
  assert!(deletion.is_err(),"Fresh deletion guard must reject the changed ancestor");
 }
 println!("OBSERVATION_RESULT {}",serde_json::json!({"mode":v["mode"],"case":v["case"],"accepted":accepted,"reason":result.err()}));
}
