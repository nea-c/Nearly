use super::*;
#[test]fn held_input_detects_inplace_save_after_timestamp_and_rename_waits(){
 for mode in["compatible-held-postset","postchange","postsame"]{
  let f=Fixture::start(mode);let e=Engine::default();f.start_job(&e,mode,f.root.join("local"),"/upload/job",true);let deadline=Instant::now()+Duration::from_secs(30);loop{let s=e.status(mode).unwrap();assert_eq!(s.error_count,0,"{mode}: {:?}",s.logs);if serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"&&fs::read(f.remote.join("upload/job/a.txt")).is_ok_and(|b|b==vec![66;1024*1024]){break}assert!(Instant::now()<deadline,"{mode}: {:?}",s.logs);thread::sleep(Duration::from_millis(20));}
  assert!(e.status(mode).unwrap().logs.iter().any(|s|s.contains("waiting to resend")),"late edit must request rescan {mode}");let a=fs::metadata(f.root.join("local/a.txt")).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();let b=fs::metadata(f.remote.join("upload/job/a.txt")).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();assert_eq!(a,b);e.stop(mode).unwrap();assert!(!fs::read_dir(f.remote.join("upload/job")).unwrap().any(|e|e.unwrap().file_name().to_string_lossy().ends_with(".part")));
 }
}
