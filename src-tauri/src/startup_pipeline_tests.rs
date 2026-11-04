//! Generated localhost regressions for the selected directory-checklist policy.
use super::*;
struct Fixture{root:PathBuf,remote:PathBuf,profile:Profile,secret:String}
fn stamped(root:&Path,relative:&str,bytes:&[u8],seconds:u64){write(root,relative,bytes);std::fs::File::options().write(true).open(root.join(relative)).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(seconds))).unwrap();}
fn decision_count(e:&Engine,n:&str,key:&str)->u64{serde_json::to_value(e.status(n).unwrap()).unwrap()["syncDecisions"]["counts"][key].as_u64().unwrap_or(0)}
fn healthy(e:&Engine,n:&str){let s=e.status(n).unwrap();assert_eq!(s.error_count,0,"{:?}",s.failure.as_ref().map(|f|&f.reason));assert!(!s.stop_complete);}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_checklist_skips_unchanged_peer_without_upload(){
 let f=Fixture::load();let n="listing-batch";let(l,r)=f.tree(n);
 for root in [&l,&r]{for file in ["a.txt","deep/b.txt"]{stamped(root,file,b"same",1700000000);}}
 write(&l,"a.txt",b"changed local forces a fresh batch");let e=f.start(n,&l);caught(&e,n);
 assert_eq!(e.status(n).unwrap().sent,1);assert!(decision_count(&e,n,"metadata_unchanged")>0);
 assert_eq!(std::fs::read(r.join("deep/b.txt")).unwrap(),b"same");
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_skipped_file_and_empty_parent_are_deleted_from_fresh_inventory(){
 let f=Fixture::load();let n="listing-skip-delete";let(l,r)=f.tree(n);
 for root in [&l,&r]{stamped(root,"parent/a.txt",b"same",1700000000);}
 let e=f.start(n,&l);caught(&e,n);assert!(decision_count(&e,n,"metadata_unchanged")>0);
 std::fs::remove_file(l.join("parent/a.txt")).unwrap();wait(||{healthy(&e,n);!r.join("parent/a.txt").exists()});caught(&e,n);
 std::fs::remove_dir(l.join("parent")).unwrap();wait(||{healthy(&e,n);!r.join("parent").exists()});caught(&e,n);
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_fresh_inventory_deletes_remote_only_file_including_changed_old_stamp(){
 for returned in [false,true]{let f=Fixture::load();let n=if returned{"listing-aba"}else{"listing-mismatch"};let(l,r)=f.tree(n);
 for root in [&l,&r]{stamped(root,"a.txt",b"same",1700000000);}
 let e=f.start(n,&l);caught(&e,n);stamped(&r,"a.txt",b"remote edited after listing",1700000040);
 if returned{stamped(&r,"a.txt",b"same",1700000000);}
 write(&r,"arrived-after-listing.txt",b"remote-only addition after first scan");std::fs::remove_file(l.join("a.txt")).unwrap();wait(||{healthy(&e,n);!r.join("a.txt").exists()&&!r.join("arrived-after-listing.txt").exists()});caught(&e,n);
 assert_eq!(e.status(n).unwrap().sent,0);assert!(e.status(n).unwrap().remote_changes.revision>0);
 e.stop(n).unwrap();stopped_marker(&f,n);}
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_change_during_inventory_is_not_lost_by_watch_notification(){
 let f=Fixture::load();let n="listing-hint-race";let(l,r)=f.tree(n);for root in [&l,&r]{stamped(root,"hint-race.txt",b"same",1700000000);}
 let base=f.root.clone();let source=l.clone();let writer=thread::spawn(move||{
  wait(||base.join(format!("capture-{n}")).exists());stamped(&source,"hint-race.txt",b"saved content with changed size",1700000040);std::fs::write(base.join(format!("continue-{n}")),b"generated").unwrap();
 });
 let e=f.start(n,&l);writer.join().unwrap();wait(||std::fs::read(r.join("hint-race.txt")).ok().as_deref()==Some(b"saved content with changed size"));wait(||f.root.join(format!("rescan-{n}")).exists());caught(&e,n);
 assert_eq!(e.status(n).unwrap().sent,1);healthy(&e,n);assert_eq!(std::fs::read_dir(&r).unwrap().count(),1);
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_metadata_only_notice_preserves_equal_and_newer_remote(){
 for newer in [false,true]{let f=Fixture::load();let n=if newer{"listing-hint-meta-newer"}else{"listing-hint-meta-equal"};let(l,r)=f.tree(n);
 stamped(&l,"hint-race.txt",b"same",1700000000);stamped(&r,"hint-race.txt",b"diff",if newer{1700000040}else{1700000000});
 let base=f.root.clone();let source=l.join("hint-race.txt");let writer=thread::spawn(move||{
  wait(||base.join(format!("capture-{n}")).exists());std::fs::File::options().write(true).open(source).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::new(1700000000,500000000))).unwrap();std::fs::write(base.join(format!("continue-{n}")),b"generated").unwrap();
 });
 let e=f.start(n,&l);writer.join().unwrap();wait(||f.root.join(format!("rescan-{n}")).exists());caught(&e,n);healthy(&e,n);
 assert_eq!(e.status(n).unwrap().sent,0);assert_eq!(std::fs::read(r.join("hint-race.txt")).unwrap(),b"diff");assert_eq!(std::fs::read(l.join("hint-race.txt")).unwrap(),b"same");
 assert!(decision_count(&e,n,if newer{"remote_newer_retained"}else{"metadata_unchanged"})>0);
 e.stop(n).unwrap();stopped_marker(&f,n);}
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_early_notice_retains_remote_newer_in_delete_on_and_off(){
 for delete_on in [false,true]{for edit in [false,true]{let f=Fixture::load();let n=match(delete_on,edit){(false,false)=>"listing-prebaseline-attribute",(false,true)=>"listing-prebaseline-edit",(true,false)=>"listing-prebaseline-fallback-attribute",(true,true)=>"listing-prebaseline-fallback-edit"};let(l,r)=f.tree(n);
 stamped(&l,"prebaseline.txt",b"same",1700000000);stamped(&r,"prebaseline.txt",b"diff",1700000040);
 let base=f.root.clone();let source=l.clone();let writer=thread::spawn(move||{wait(||base.join(format!("capture-{n}")).exists());stamped(&source,"prebaseline.txt",if edit{b"changed local source"}else{b"same"},1700000001);std::fs::write(base.join(format!("continue-{n}")),b"generated").unwrap();});
 let e=Engine::default();e.start(n.into(),f.profile.clone(),l.to_string_lossy().into_owned(),format!("/{n}"),zeroize::Zeroizing::new(f.secret.clone()),SyncOptions{delete_removed:delete_on,..SyncOptions::default()}).unwrap();writer.join().unwrap();wait(||f.root.join(format!("rescan-{n}")).exists());caught(&e,n);healthy(&e,n);
 assert_eq!(e.status(n).unwrap().sent,0);assert_eq!(std::fs::read(r.join("prebaseline.txt")).unwrap(),b"diff");assert_eq!(std::fs::read(l.join("prebaseline.txt")).unwrap(),if edit{b"changed local source".as_slice()}else{b"same".as_slice()});assert!(decision_count(&e,n,"remote_newer_retained")>0);
 e.stop(n).unwrap();stopped_marker(&f,n);}}
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_replaced_file_parent_uses_fresh_match_and_deletion_inventory(){
 let f=Fixture::load();let n="listing-fixed-file";let(l,r)=f.tree(n);for root in [&l,&r]{stamped(root,"parent/a.txt",b"same",1700000000);}
 let e=f.start(n,&l);caught(&e,n);let previous=decision_count(&e,n,"metadata_unchanged");stamped(&r,"parent/a.txt",b"new source",1700000001);
 let staged=f.root.join("replacement-file-parent");std::fs::create_dir(&staged).unwrap();stamped(&staged,"a.txt",b"new source",1700000001);
 std::fs::rename(l.join("parent"),f.root.join("old-file-parent")).unwrap();std::fs::rename(staged,l.join("parent")).unwrap();
 wait(||{healthy(&e,n);decision_count(&e,n,"metadata_unchanged")>previous});caught(&e,n);assert_eq!(e.status(n).unwrap().sent,0);assert_eq!(std::fs::read(r.join("parent/a.txt")).unwrap(),b"new source");
 std::fs::remove_file(l.join("parent/a.txt")).unwrap();wait(||{healthy(&e,n);!r.join("parent/a.txt").exists()});caught(&e,n);e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_replaced_empty_directory_uses_fresh_deletion_inventory(){
 let f=Fixture::load();let n="listing-fixed-directory";let(l,r)=f.tree(n);for root in [&l,&r]{std::fs::create_dir(root.join("parent")).unwrap();}
 let e=f.start(n,&l);caught(&e,n);std::fs::write(f.root.join("basis-mode-b"),b"generated").unwrap();
 let staged=f.root.join("old-empty-parent");std::fs::rename(l.join("parent"),&staged).unwrap();std::fs::rename(staged,l.join("parent")).unwrap();
 wait(||f.root.join("basis-read-b").exists());caught(&e,n);healthy(&e,n);
 std::fs::remove_dir(l.join("parent")).unwrap();wait(||{healthy(&e,n);!r.join("parent").exists()});caught(&e,n);e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_reconnect_refreshes_inventory_before_uploads_and_deletion(){
 let f=Fixture::load();let n="listing-reconnect";let(l,r)=f.tree(n);
 for root in [&l,&r]{for name in ["a.txt","b.txt","c.txt"]{stamped(root,&format!("parent/{name}"),b"same",1700000000);}}
 let e=f.start(n,&l);caught(&e,n);std::fs::write(f.root.join("reconnect-now"),b"generated").unwrap();wait(||f.root.join("reconnect-closed").exists());thread::sleep(Duration::from_millis(100));
 write(&l,"parent/a.txt",b"first saved after reconnect");write(&l,"parent/b.txt",b"second saved after reconnect");wait(||{healthy(&e,n);e.status(n).unwrap().sent==2});caught(&e,n);
 assert_eq!(std::fs::read(r.join("parent/a.txt")).unwrap(),b"first saved after reconnect");assert_eq!(std::fs::read(r.join("parent/b.txt")).unwrap(),b"second saved after reconnect");assert!(!e.status(n).unwrap().deletion_rescan_required);
 std::fs::remove_file(l.join("parent/c.txt")).unwrap();wait(||{healthy(&e,n);!r.join("parent/c.txt").exists()});caught(&e,n);e.stop(n).unwrap();
 let restarted=f.start(n,&l);caught(&restarted,n);healthy(&restarted,n);assert_eq!(restarted.status(n).unwrap().sent,0);assert!(!r.join("parent/c.txt").exists());restarted.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_new_missing_parents_and_empty_directories_can_later_be_deleted(){
 let f=Fixture::load();let n="listing-new-parents";let(l,r)=f.tree(n);
 write(&l,"new-parent/child/file.txt",b"own generated upload");std::fs::create_dir_all(l.join("new-parent/empty/sub")).unwrap();let e=f.start(n,&l);caught(&e,n);
 assert_eq!(std::fs::read(r.join("new-parent/child/file.txt")).unwrap(),b"own generated upload");assert!(r.join("new-parent/empty/sub").is_dir());let owned=l.join("new-parent");assert!(owned.canonicalize().unwrap().starts_with(f.root.canonicalize().unwrap()));
 std::fs::remove_dir_all(&owned).unwrap();wait(||{healthy(&e,n);!r.join("new-parent").exists()});caught(&e,n);e.stop(n).unwrap();stopped_marker(&f,n);
}

impl Fixture{
 fn load()->Self{let m:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(std::env::var("NEARLY_PIPELINE_FIXTURE").expect("generated fixture only")).unwrap()).unwrap();Self{root:m["root"].as_str().unwrap().into(),remote:m["remote"].as_str().unwrap().into(),secret:m["passphrase"].as_str().unwrap().into(),profile:Profile{id:"pipeline-fixture".into(),name:"Generated localhost".into(),host:"127.0.0.1".into(),port:m["port"].as_u64().unwrap() as u16,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:m["key"].as_str().unwrap().into(),host_key:m["fingerprint"].as_str().unwrap().into()}}}
 fn tree(&self,name:&str)->(PathBuf,PathBuf){let l=self.root.join(name);let r=self.remote.join(name);std::fs::create_dir_all(&l).unwrap();std::fs::create_dir_all(&r).unwrap();(l,r)}
 fn start(&self,name:&str,l:&Path)->Engine{let e=Engine::default();e.start(name.into(),self.profile.clone(),l.to_string_lossy().into_owned(),format!("/{name}"),zeroize::Zeroizing::new(self.secret.clone()),SyncOptions{delete_removed:true,..SyncOptions::default()}).unwrap();e}
}
fn write(root:&Path,name:&str,bytes:&[u8]){let p=root.join(name);std::fs::create_dir_all(p.parent().unwrap()).unwrap();std::fs::write(p,bytes).unwrap();}
fn wait(mut f:impl FnMut()->bool){let end=Instant::now()+Duration::from_secs(30);while !f(){assert!(Instant::now()<end,"generated pipeline fixture timed out");thread::sleep(Duration::from_millis(5));}}
fn caught(e:&Engine,n:&str){wait(||{let s=e.status(n).unwrap();assert_eq!(s.error_count,0,"{}",serde_json::to_string(&s.failure).unwrap());s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp});}
fn stopped_marker(f:&Fixture,n:&str){std::fs::write(f.root.join(format!("{n}-stopped")),b"generated").unwrap();}

#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_deletes_only_after_complete_inventory(){
 let f=Fixture::load();let n="pipeline-delete";let(l,r)=f.tree(n);
 for i in 0..8 {stamped(&l,&format!("d{i}/sub/a.txt"),b"new generated content",1700000040);stamped(&r,&format!("d{i}/sub/a.txt"),b"old",1700000000);write(&r,&format!("d{i}/sub/orphan.txt"),b"remove generated only");}
 let e=f.start(n,&l);caught(&e,n);assert_eq!(e.status(n).unwrap().sent,8);
 for i in 0..8{assert!(!r.join(format!("d{i}/sub/orphan.txt")).exists());assert_eq!(std::fs::read(l.join(format!("d{i}/sub/a.txt"))).unwrap(),std::fs::read(r.join(format!("d{i}/sub/a.txt"))).unwrap());}
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_inventory_failure_publishes_no_deletion(){
 let f=Fixture::load();let n="pipeline-inventory-fail";let(l,r)=f.tree(n);
 for d in ["a","b","bad","d"]{write(&l,&format!("{d}/a.txt"),b"new");write(&r,&format!("{d}/a.txt"),b"old");write(&r,&format!("{d}/orphan.txt"),b"retain generated");}
 let e=f.start(n,&l);wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);
 for d in ["a","b","bad","d"]{assert!(r.join(format!("{d}/orphan.txt")).exists());assert_eq!(std::fs::read(r.join(format!("{d}/a.txt"))).unwrap(),b"old");}
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_inventory_cancel_publishes_no_deletion(){
 let f=Fixture::load();let n="pipeline-inventory-cancel";let(l,r)=f.tree(n);
 for d in ["a","b","hold","d"]{write(&l,&format!("{d}/a.txt"),b"new");write(&r,&format!("{d}/a.txt"),b"old");write(&r,&format!("{d}/orphan.txt"),b"retain generated");}
 let e=f.start(n,&l);wait(||f.root.join("inventory-held").exists());let summary=e.stop_with_summary(n).unwrap();assert!(summary.known_unreflected);assert!(e.status(n).is_err());stopped_marker(&f,n);
 for d in ["a","b","hold","d"]{assert!(r.join(format!("{d}/orphan.txt")).exists());assert_eq!(std::fs::read(r.join(format!("{d}/a.txt"))).unwrap(),b"old");}
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_missing_shared_parents_and_empty_directories(){
 let f=Fixture::load();let n="pipeline-missing";let(l,r)=f.tree(n);
 for i in 0..8{write(&l,&format!("shared/parent/child{i}/file.txt"),b"generated");std::fs::create_dir_all(l.join(format!("shared/empty{i}/nested"))).unwrap();}
 let e=f.start(n,&l);caught(&e,n);
 for i in 0..8{assert_eq!(std::fs::read(r.join(format!("shared/parent/child{i}/file.txt"))).unwrap(),b"generated");assert!(r.join(format!("shared/empty{i}/nested")).is_dir());}
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_source_change_and_true_comparison_error(){
 let f=Fixture::load();let n="pipeline-compare-fail";let(l,r)=f.tree(n);
 for i in 0..8{stamped(&l,&format!("d{i}/a.txt"),b"changed",1700000040);stamped(&r,&format!("d{i}/a.txt"),b"old",1700000000);}
 let e=f.start(n,&l);wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);assert_eq!(e.status(n).unwrap().sent,0);e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_unsafe_remote_ancestor_and_names(){
 let f=Fixture::load();let n="pipeline-unsafe";let(l,r)=f.tree(n);
 // Keep the unrelated file present locally: deleting a source-absent safe file
 // before a later comparison error is permitted, not a safety failure.
 write(&l,"link/file.txt",b"new");write(&r,"link/file.txt",b"old");write(&r,"keep.txt",b"retain");write(&l,"keep.txt",b"retain");
 let e=f.start(n,&l);wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);assert_eq!(std::fs::read(r.join("link/file.txt")).unwrap(),b"old");assert!(r.join("keep.txt").exists());e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_shared_entry_budget_discards_snapshot(){
 let f=Fixture::load();let n="pipeline-budget";let(l,r)=f.tree(n);for i in 0..4{write(&r,&format!("d{i}/seed.txt"),b"generated");}write(&r,"orphan.txt",b"retain");
 let e=f.start(n,&l);wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);assert!(r.join("orphan.txt").exists());e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_directory_mutation_failure_requires_manual_restart(){
 let f=Fixture::load();let n="pipeline-confirm-fail";let(l,r)=f.tree(n);
 for i in 0..8{for root in [&l,&r]{std::fs::create_dir_all(root.join(format!("d{i}"))).unwrap();}}
 stamped(&l,"file.txt",b"new generated file",1700000040);stamped(&r,"file.txt",b"old",1700000000);
 let e=f.start(n,&l);caught(&e,n);assert_eq!(e.status(n).unwrap().sent,1);
 // No-op post-list directory checks are deliberately omitted. The real
 // deletion must still execute fresh guards and stop on this permission fault.
 std::fs::remove_dir(l.join("d0")).unwrap();wait(||e.status(n).unwrap().stop_complete);let s=e.status(n).unwrap();assert!(s.error_count>0);assert_eq!(s.sent,1);
 let failure=s.failure.as_ref().unwrap();assert_eq!(failure.operation,"delete");let failed_path=failure.relative_path.as_deref().expect("directory batch must preserve its failing relative path");assert_eq!(failed_path,"d0");assert!(r.join("d0").is_dir(),"failed RMDIR must preserve the directory");
 write(&l,"after-error.txt",b"generated after error");thread::sleep(Duration::from_millis(150));assert!(!r.join("after-error.txt").exists());e.stop(n).unwrap();stopped_marker(&f,n);
 std::fs::write(f.root.join("allow-confirm-restart"),b"generated").unwrap();let resumed=f.start(n,&l);caught(&resumed,n);assert_eq!(std::fs::read(r.join("after-error.txt")).unwrap(),b"generated after error");assert!(!r.join("d0").exists(),"explicit restart must perform the previously failed deletion");healthy(&resumed,n);resumed.stop(n).unwrap();
}
#[test]#[ignore="generated localhost pipeline fixture"]
fn startup_pipeline_source_change_during_inventory_sends_latest(){
 let f=Fixture::load();let n="pipeline-source-change";let(l,r)=f.tree(n);for i in 0..8{stamped(&l,&format!("d{i}/a.txt"),b"original",1700000040);stamped(&r,&format!("d{i}/a.txt"),b"original",1700000000);}
 let e=f.start(n,&l);wait(||f.root.join("source-inventory-held").exists());write(&l,"d0/a.txt",b"latest generated content saved during inventory");write(&l,"new-parent/new.txt",b"new generated file during inventory");caught(&e,n);
 assert_eq!(std::fs::read(r.join("d0/a.txt")).unwrap(),b"latest generated content saved during inventory");assert_eq!(std::fs::read(r.join("new-parent/new.txt")).unwrap(),b"new generated file during inventory");e.stop(n).unwrap();stopped_marker(&f,n);
}

#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_peer_edit_is_preserved_and_inventory_failure_stops_mutations(){
 for mode in ["save","error","cancel"] {
  let f=Fixture::load();let n=format!("listing-staged-{mode}");let(l,r)=f.tree(&n);
  for root in [&l,&r] {for name in ["a.txt","b.txt","deep/peer.txt"] {stamped(root,name,b"same",1700000000);}}
  write(&l,"a.txt",b"fresh candidate a");write(&l,"b.txt",b"fresh candidate b");
  let e=f.start(&n,&l);let observed=e.jobs.lock().unwrap().get(&n).unwrap().status.clone();
  if mode=="save" {caught(&e,&n);let status=e.status(&n).unwrap();assert_eq!(status.sent,3);assert_eq!(std::fs::read(r.join("deep/peer.txt")).unwrap(),b"saved peer during inventory");assert!(status.logs.iter().any(|line|line.strip_prefix("Uploaded ").is_some_and(|path|path.replace('\\',"/")=="deep/peer.txt")),"edited peer must have its own acknowledged upload");}
  else {wait(||f.root.join(format!("{n}-batch-entered")).exists());if mode=="cancel" {e.stop(&n).unwrap();}else{wait(||e.status(&n).unwrap().stop_complete);assert!(e.status(&n).unwrap().error_count>0);}let status=observed.lock().unwrap().clone();assert_eq!(status.sent,0);if mode=="cancel"{assert_eq!(status.error_count,0);}assert_eq!(serde_json::to_value(&status).unwrap()["syncDecisions"]["counts"]["metadata_unchanged"].as_u64().unwrap_or(0),0,"incomplete inventory must not classify peers as complete");for name in ["a.txt","b.txt","deep/peer.txt"]{assert_eq!(std::fs::read(r.join(name)).unwrap(),b"same");}}
  for dir in [&r,&r.join("deep")] {assert!(!std::fs::read_dir(dir).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().ends_with(".part")));}
  if mode!="cancel"{e.stop(&n).unwrap();}stopped_marker(&f,&n);
 }
}

#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_same_size_within_tolerance_edit_is_explicitly_skipped(){
 let f=Fixture::load();let n="listing-same-size-edit";let(l,r)=f.tree(n);for root in [&l,&r]{stamped(root,"same.txt",b"same",1700000000);}
 let e=f.start(n,&l);caught(&e,n);let previous=decision_count(&e,n,"metadata_unchanged");stamped(&l,"same.txt",b"save",1700000001);
 wait(||decision_count(&e,n,"metadata_unchanged")>previous);caught(&e,n);healthy(&e,n);assert_eq!(e.status(n).unwrap().sent,0);assert_eq!(std::fs::read(r.join("same.txt")).unwrap(),b"same");assert_eq!(std::fs::read(l.join("same.txt")).unwrap(),b"save");e.stop(n).unwrap();stopped_marker(&f,n);
}
