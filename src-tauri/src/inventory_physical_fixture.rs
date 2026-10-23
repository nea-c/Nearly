//! Physical directory/junction changes inside generated localhost fixture only.
#[test]
#[ignore="generated physical inventory fixture only"]
fn inventory_physical_ancestor_and_delete_guard(){
 use std::{path::{Path,PathBuf},sync::atomic::AtomicBool,time::{Duration,Instant}};
 let p=PathBuf::from(std::env::var("NEARLY_INVENTORY_PHYSICAL_MANIFEST").unwrap());let root=p.parent().unwrap().canonicalize().unwrap();
 let allowed=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-results").canonicalize().unwrap();
 assert!(root.starts_with(allowed));assert!(root.file_name().unwrap().to_string_lossy().starts_with("inventory-physical-"));
 let v:serde_json::Value=serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
 let profile=crate::sftp::Profile{id:"generated".into(),name:"physical loopback".into(),host:"127.0.0.1".into(),port:v["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:root.join("fixture-v3.ppk").to_string_lossy().into_owned(),host_key:v["fingerprint"].as_str().unwrap().into()};
 let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&profile,"fixture-only-not-a-user-secret",&stop).unwrap();
 let remote=if v["case"]=="root-slash"{"/"}else{"/physical-root"};
 let snapshot=crate::sftp::mirror_snapshot(&mut c,remote,&crate::exclusion::Rules::compile("").unwrap(),true,&stop);
 if v["case"]=="delete-after-junction" {
  let snapshot=snapshot.unwrap();let stamp=&snapshot.files.iter().find(|(p,_)|p==Path::new("d/victim.txt")).unwrap().1;
  std::fs::write(root.join("swap-request"),b"generated").unwrap();let deadline=Instant::now()+Duration::from_secs(5);
  while !root.join("swapped").exists(){assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(5));}
  let result=crate::sftp::delete_uploaded_file(&mut c,"/physical-root",Path::new("d/victim.txt"),stamp,&stop,&||Ok(()));
  assert!(result.is_err(),"fresh mutation guard must reject replaced ancestor");
  println!("PHYSICAL_RESULT {}",serde_json::json!({"case":v["case"],"mode":v["mode"],"deletion_refused":true,"reason":result.err()}));
 }else{
  assert_eq!(snapshot.is_ok(),v["accept"].as_bool().unwrap(),"{} {} {:?}",v["case"],v["mode"],snapshot.as_ref().err());
  println!("PHYSICAL_RESULT {}",serde_json::json!({"case":v["case"],"mode":v["mode"],"accepted":snapshot.is_ok(),"reason":snapshot.err()}));
 }
}
