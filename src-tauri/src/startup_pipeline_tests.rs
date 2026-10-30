//! Generated localhost worker regressions; never load user profiles/settings.
use super::*;
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_batch_preserves_valid_unchanged_peer_hint(){
 let f=Fixture::load();let n="listing-batch";let(l,r)=f.tree(n);
 for root in [&l,&r]{for file in ["a.txt","deep/b.txt"]{write(root,file,b"same");std::fs::File::options().write(true).open(root.join(file)).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}}
 write(&l,"a.txt",b"changed local forces a fresh batch");
 let e=f.start(n,&l);caught(&e,n);
 assert_eq!(e.status(n).unwrap().sent,1,"an unchanged listed peer must not be forced into fresh comparison");
 assert!(e.status(n).unwrap().logs.iter().any(|line|line.contains("Skipped listed unchanged deep")));
 assert_eq!(std::fs::read(r.join("deep/b.txt")).unwrap(),b"same");
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_listed_baseline_allows_later_file_and_empty_parent_deletion(){
 let f=Fixture::load();let n="listing-skip-delete";let(l,r)=f.tree(n);
 for root in [&l,&r]{write(root,"parent/a.txt",b"same");std::fs::File::options().write(true).open(root.join("parent/a.txt")).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}
 let e=f.start(n,&l);caught(&e,n);
 assert!(e.status(n).unwrap().logs.iter().any(|s|s.contains("Skipped listed unchanged")),"worker must use listing-only classification");
 std::fs::remove_file(l.join("parent/a.txt")).unwrap();wait(||{let s=e.status(n).unwrap();assert_eq!(s.error_count,0,"{:?}",s.failure.as_ref().map(|f|&f.reason));!r.join("parent/a.txt").exists()});caught(&e,n);
 std::fs::remove_dir(l.join("parent")).unwrap();wait(||{assert_eq!(e.status(n).unwrap().error_count,0);!r.join("parent").exists()});caught(&e,n);
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_baseline_mismatch_stops_but_return_to_same_stamp_is_allowed(){
 for returned in [false,true]{
 let f=Fixture::load();let n=if returned{"listing-aba"}else{"listing-mismatch"};let(l,r)=f.tree(n);
 for root in [&l,&r]{write(root,"a.txt",b"same");std::fs::File::options().write(true).open(root.join("a.txt")).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}
 let e=f.start(n,&l);caught(&e,n);write(&r,"a.txt",b"remote edited after listing");
 if returned{write(&r,"a.txt",b"same");std::fs::File::options().write(true).open(r.join("a.txt")).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}
 std::fs::remove_file(l.join("a.txt")).unwrap();
 if returned{wait(||{assert_eq!(e.status(n).unwrap().error_count,0);!r.join("a.txt").exists()});caught(&e,n);}else{wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);assert_eq!(std::fs::read(r.join("a.txt")).unwrap(),b"remote edited after listing");}
 e.stop(n).unwrap();stopped_marker(&f,n);
 }
}
struct Fixture{root:PathBuf,remote:PathBuf,profile:Profile,secret:String}
fn stamped(root:&Path,relative:&str,bytes:&[u8],seconds:u64){write(root,relative,bytes);std::fs::File::options().write(true).open(root.join(relative)).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(seconds))).unwrap();}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_hint_capture_change_debounces_and_sends_final_source(){
 let f=Fixture::load();let n="listing-hint-race";let(l,r)=f.tree(n);for root in [&l,&r]{stamped(root,"hint-race.txt",b"same",1700000000);}
 let base=f.root.clone();let source=l.join("hint-race.txt");let writer=thread::spawn(move||{
  wait(||base.join("hint-captured").exists());std::fs::write(&source,b"save").unwrap();std::fs::File::options().write(true).open(source).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::new(1700000000,500000000))).unwrap();std::fs::write(base.join("hint-continue"),b"generated").unwrap();
 });
 let e=f.start(n,&l);writer.join().unwrap();caught(&e,n);let s=e.status(n).unwrap();assert_eq!(s.sent,1);assert!(s.logs.iter().any(|line|line.contains("Local source changed; waiting to resend")));assert_eq!(std::fs::read(r.join("hint-race.txt")).unwrap(),b"save");assert_eq!(std::fs::read_dir(&r).unwrap().count(),1);
 e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_hint_capture_metadata_only_change_never_overwrites_remote(){
 for newer in [false,true]{
  let f=Fixture::load();let n=if newer{"listing-hint-meta-newer"}else{"listing-hint-meta-equal"};let(l,r)=f.tree(n);
  stamped(&l,"hint-race.txt",b"same",1700000000);stamped(&r,"hint-race.txt",b"diff",if newer{1700000040}else{1700000000});
  for marker in ["hint-captured","hint-continue"]{let p=f.root.join(marker);if p.exists(){std::fs::remove_file(p).unwrap();}}
  let base=f.root.clone();let source=l.join("hint-race.txt");let writer=thread::spawn(move||{
   wait(||base.join("hint-captured").exists());std::fs::File::options().write(true).open(source).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::new(1700000000,500000000))).unwrap();std::fs::write(base.join("hint-continue"),b"generated").unwrap();
  });
  let e=f.start(n,&l);writer.join().unwrap();caught(&e,n);let s=e.status(n).unwrap();assert_eq!(s.sent,0);assert_eq!(std::fs::read(r.join("hint-race.txt")).unwrap(),b"diff");assert_eq!(std::fs::read(l.join("hint-race.txt")).unwrap(),b"same");assert!(s.logs.iter().any(|line|line=="Skipped unchanged content after local notice"));e.stop(n).unwrap();stopped_marker(&f,n);
 }
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_notice_before_first_content_baseline_is_explicit_conflict(){
 for fallback in [false,true]{for edit in [false,true]{
  let f=Fixture::load();let n=match(fallback,edit){(false,false)=>"listing-prebaseline-attribute",(false,true)=>"listing-prebaseline-edit",(true,false)=>"listing-prebaseline-fallback-attribute",(true,true)=>"listing-prebaseline-fallback-edit"};let(l,r)=f.tree(n);
  stamped(&l,"prebaseline.txt",b"same",1700000000);stamped(&r,"prebaseline.txt",b"diff",1700000040);
  let probe=crate::engine::sync_notice_test_hooks::register(l.canonicalize().unwrap());let base=f.root.clone();let source=l.join("prebaseline.txt");
  let writer=thread::spawn(move||{wait(||base.join(format!("{n}-before-capture")).exists());let before=probe.count();if edit{std::fs::write(&source,b"save").unwrap();}std::fs::File::options().write(true).open(source).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::new(1700000000,if edit{0}else{500000000}))).unwrap();wait(||probe.count()>before);std::fs::write(base.join(format!("{n}-continue")),b"generated").unwrap();});
  let e=if fallback{let e=Engine::default();e.start(n.into(),f.profile.clone(),l.to_string_lossy().into_owned(),format!("/{n}"),zeroize::Zeroizing::new(f.secret.clone()),SyncOptions::default()).unwrap();e}else{f.start(n,&l)};writer.join().unwrap();wait(||{let s=e.status(n).unwrap();s.failure.is_some()||s.activity.phase()==crate::taskbar_status::NativeSyncState::CaughtUp});let s=e.status(n).unwrap();
  assert_eq!(s.sent,0);assert_eq!(std::fs::read(r.join("prebaseline.txt")).unwrap(),b"diff");assert_eq!(std::fs::read(l.join("prebaseline.txt")).unwrap(),if edit{b"save"}else{b"same"});assert_eq!(s.failure.as_ref().map(|f|f.operation.as_str()),Some("conflict"),"early notice must not silently become a content no-op");assert_eq!(s.failure.as_ref().unwrap().pending,1,"conflicting source stays pending rather than disappearing");e.stop(n).unwrap();stopped_marker(&f,n);
 }}
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_fresh_file_match_cannot_rebase_listing_stamp(){
 let f=Fixture::load();let n="listing-fixed-file";let(l,r)=f.tree(n);for root in [&l,&r]{stamped(root,"parent/a.txt",b"same",1700000000);}
 let e=f.start(n,&l);caught(&e,n);stamped(&r,"parent/a.txt",b"new source",1700000001);
 let staged=f.root.join("replacement-file-parent");std::fs::create_dir(&staged).unwrap();stamped(&staged,"a.txt",b"new source",1700000001);
 std::fs::rename(l.join("parent"),f.root.join("old-file-parent")).unwrap();std::fs::rename(staged,l.join("parent")).unwrap();
 wait(||{let s=e.status(n).unwrap();assert_eq!(s.error_count,0);s.logs.iter().any(|line|line.contains("Skipped unchanged")&&line.contains("a.txt"))});caught(&e,n);assert_eq!(e.status(n).unwrap().sent,0,"fixture must exercise a fresh read-only match, not own upload");
 std::fs::remove_file(l.join("parent/a.txt")).unwrap();wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);assert_eq!(std::fs::read(r.join("parent/a.txt")).unwrap(),b"new source");e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_fresh_directory_match_cannot_rebase_listing_stamp(){
 let f=Fixture::load();let n="listing-fixed-directory";let(l,r)=f.tree(n);for root in [&l,&r]{std::fs::create_dir(root.join("parent")).unwrap();}
 let e=f.start(n,&l);caught(&e,n);std::fs::write(f.root.join("basis-mode-b"),b"generated").unwrap();
 let staged=f.root.join("old-empty-parent");std::fs::rename(l.join("parent"),&staged).unwrap();std::fs::rename(staged,l.join("parent")).unwrap();
 wait(||{let s=e.status(n).unwrap();assert_eq!(s.error_count,0);f.root.join("basis-read-b").exists()&&s.logs.iter().any(|line|line.contains("Verified local/remote directory")&&line.contains("parent"))});caught(&e,n);
 std::fs::remove_dir(l.join("parent")).unwrap();wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().error_count>0);assert!(r.join("parent").is_dir());e.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_reconnect_progresses_two_files_but_old_basis_cannot_delete(){
 let f=Fixture::load();let n="listing-reconnect";let(l,r)=f.tree(n);
 for root in [&l,&r]{for name in ["a.txt","b.txt","c.txt"]{write(root,&format!("parent/{name}"),b"same");std::fs::File::options().write(true).open(root.join("parent").join(name)).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(1700000000))).unwrap();}}
 let e=f.start(n,&l);caught(&e,n);std::fs::write(f.root.join("reconnect-now"),b"generated").unwrap();wait(||f.root.join("reconnect-closed").exists());thread::sleep(Duration::from_millis(100));
 write(&l,"parent/a.txt",b"first saved after reconnect");write(&l,"parent/b.txt",b"second saved after reconnect");
 wait(||{let s=e.status(n).unwrap();assert_eq!(s.error_count,0);s.sent==2});
 assert_eq!(std::fs::read(r.join("parent/a.txt")).unwrap(),b"first saved after reconnect");assert_eq!(std::fs::read(r.join("parent/b.txt")).unwrap(),b"second saved after reconnect");
 wait(||e.status(n).unwrap().activity.phase()==crate::taskbar_status::NativeSyncState::DeletionRescanRequired);
 let status=e.status(n).unwrap();assert!(status.deletion_rescan_required);assert_eq!(status.status,"running");assert_eq!(status.error_count,0);assert_eq!(status.activity.phase(),crate::taskbar_status::NativeSyncState::DeletionRescanRequired);assert_eq!(e.taskbar_state().unwrap(),crate::taskbar_status::TaskbarState::Paused);
 std::fs::remove_file(l.join("parent/c.txt")).unwrap();wait(||e.status(n).unwrap().stop_complete);assert!(e.status(n).unwrap().failure.as_ref().unwrap().reason.contains("basis"));assert!(r.join("parent/c.txt").exists());
 e.stop(n).unwrap();
 let restarted=f.start(n,&l);caught(&restarted,n);assert!(!r.join("parent/c.txt").exists());let fresh=restarted.status(n).unwrap();assert!(!fresh.deletion_rescan_required);assert_eq!(fresh.error_count,0);assert_eq!(fresh.activity.phase(),crate::taskbar_status::NativeSyncState::CaughtUp);restarted.stop(n).unwrap();stopped_marker(&f,n);
}
#[test]#[ignore="generated localhost listing fixture"]
fn listing_worker_new_missing_parents_have_receipts_and_can_later_be_deleted(){
 let f=Fixture::load();let n="listing-new-parents";let(l,r)=f.tree(n);
 write(&l,"new-parent/child/file.txt",b"own generated upload");std::fs::create_dir_all(l.join("new-parent/empty/sub")).unwrap();
 let e=f.start(n,&l);caught(&e,n);assert_eq!(std::fs::read(r.join("new-parent/child/file.txt")).unwrap(),b"own generated upload");assert!(r.join("new-parent/empty/sub").is_dir());
 let owned=l.join("new-parent");assert!(owned.canonicalize().unwrap().starts_with(f.root.canonicalize().unwrap()));
 std::fs::remove_dir_all(&owned).unwrap();wait(||{let s=e.status(n).unwrap();assert_eq!(s.error_count,0,"{:?}",s.failure.as_ref().map(|f|&f.reason));!r.join("new-parent").exists()});caught(&e,n);
 e.stop(n).unwrap();stopped_marker(&f,n);
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
 let failure=s.failure.as_ref().unwrap();assert_eq!(failure.operation,"directory");let failed_path=failure.relative_path.as_deref().expect("directory batch must preserve its failing relative path");assert!((0..8).any(|i|failed_path==format!("d{i}")),"unexpected failure path {failed_path}");
 write(&l,"after-error.txt",b"generated after error");thread::sleep(Duration::from_millis(150));assert!(!r.join("after-error.txt").exists());e.stop(n).unwrap();stopped_marker(&f,n);
 std::fs::write(f.root.join("allow-confirm-restart"),b"generated").unwrap();let resumed=f.start(n,&l);caught(&resumed,n);assert_eq!(std::fs::read(r.join("after-error.txt")).unwrap(),b"generated after error");resumed.stop(n).unwrap();
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
  if mode=="save" {caught(&e,&n);let status=e.status(&n).unwrap();assert_eq!(status.sent,3);assert_eq!(std::fs::read(r.join("deep/peer.txt")).unwrap(),b"save");assert!(status.logs.iter().any(|line|line.strip_prefix("Uploaded ").is_some_and(|path|path.replace('\\',"/")=="deep/peer.txt")),"edited peer must have its own acknowledged upload");}
  else {wait(||f.root.join(format!("{n}-batch-entered")).exists());if mode=="cancel" {e.stop(&n).unwrap();}else{wait(||e.status(&n).unwrap().stop_complete);assert!(e.status(&n).unwrap().error_count>0);}let status=observed.lock().unwrap().clone();assert_eq!(status.sent,0);if mode=="cancel"{assert_eq!(status.error_count,0);}assert!(!status.logs.iter().any(|line|line.contains("Skipped listed unchanged deep")));for name in ["a.txt","b.txt","deep/peer.txt"]{assert_eq!(std::fs::read(r.join(name)).unwrap(),b"same");}}
  for dir in [&r,&r.join("deep")] {assert!(!std::fs::read_dir(dir).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().ends_with(".part")));}
  if mode!="cancel"{e.stop(&n).unwrap();}stopped_marker(&f,&n);
 }
}
