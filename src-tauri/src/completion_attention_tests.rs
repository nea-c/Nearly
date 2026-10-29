use super::*;
fn add(engine:&Engine,id:&str)->Arc<Mutex<Status>> {
  let job=super::tests::reserved_job(PathBuf::from("C:\\generated\\completion"),"/generated");
  let status=job.status.clone();engine.jobs.lock().unwrap().insert(id.into(),job);status
}
fn finish(status:&Arc<Mutex<Status>>){let mut s=status.lock().unwrap();s.activity.scan_finished();s.activity.settle(0,true,false,false,false);}
#[test]fn completion_is_private_once_and_window_scoped(){
  let e=Engine::default();let status=add(&e,"job");finish(&status);
  assert!(!e.take_sync_completion(&["other".into()]).unwrap());
  assert!(e.take_sync_completion(&["job".into()]).unwrap());
  assert!(!e.take_sync_completion(&["job".into()]).unwrap());
  let wire=serde_json::to_value(status.lock().unwrap().clone()).unwrap();assert!(wire.get("completionEpoch").is_none());assert_eq!(wire["syncPhase"],"caught_up");
}
#[test]fn fast_remote_changes_and_deletions_rearm_but_unchanged_events_do_not(){
  let e=Engine::default();let status=add(&e,"job");finish(&status);assert!(e.take_sync_completion(&["job".into()]).unwrap());
  {let mut s=status.lock().unwrap();s.activity.mark_working();s.activity.settle(0,true,false,false,false);}
  assert!(!e.take_sync_completion(&["job".into()]).unwrap());
  for deletion in [false,true]{
    {let mut s=status.lock().unwrap();s.activity.mark_working();if deletion{s.committed_remote_directory_removal("/generated",Path::new("empty"));}else{s.committed_remote_change("/generated",Path::new("a.txt"));}s.activity.settle(0,true,false,false,false);}
    assert!(e.take_sync_completion(&["job".into()]).unwrap());assert!(!e.take_sync_completion(&["job".into()]).unwrap());
  }
}
#[test]fn pending_start_defers_window_completion_and_errors_cancel_pending_success(){
  let e=Engine::default();let done=add(&e,"done");finish(&done);e.prepare("starting".into()).unwrap();
  let ids=vec!["done".into(),"starting".into()];assert!(!e.take_sync_completion(&ids).unwrap());
  e.discard_prepared_start("starting");assert!(e.take_sync_completion(&ids).unwrap());
  let failing=add(&e,"failing");finish(&failing);
  {done.lock().unwrap().status="failed".into();}
  let ids=vec!["done".into(),"failing".into()];assert!(!e.take_sync_completion(&ids).unwrap());
  done.lock().unwrap().status="running".into();assert!(!e.take_sync_completion(&ids).unwrap(),"old success must not replay after an error");
}
#[test]fn stop_request_prevents_completion_before_status_poll_updates(){
  let e=Engine::default();let status=add(&e,"job");finish(&status);
  e.jobs.lock().unwrap().get("job").unwrap().stop.store(true,Ordering::SeqCst);
  assert!(!e.take_sync_completion(&["job".into()]).unwrap());
}
#[test]fn cancelled_claimed_start_does_not_notify_or_replay_success_after_start_settles(){
  let e=Engine::default();let status=add(&e,"done");finish(&status);
  e.prepare("starting".into()).unwrap();let token=e.claim_start("starting").unwrap();token.store(true,Ordering::SeqCst);
  let ids=vec!["done".into(),"starting".into()];
  assert!(!e.take_sync_completion(&ids).unwrap(),"claimed start is still in flight after cancellation");
  e.starts.lock().unwrap().remove("starting");
  assert!(!e.take_sync_completion(&ids).unwrap(),"cancellation must discard earlier pending successes");
}
#[test]fn stopping_job_drops_stale_window_success_but_future_committed_work_can_complete(){
  let e=Engine::default();let status=add(&e,"done");finish(&status);let stopping=add(&e,"stopping");stopping.lock().unwrap().status="stopping".into();
  let ids=vec!["done".into(),"stopping".into()];assert!(!e.take_sync_completion(&ids).unwrap());
  e.jobs.lock().unwrap().remove("stopping");assert!(!e.take_sync_completion(&ids).unwrap());
  {let mut s=status.lock().unwrap();s.activity.mark_working();s.committed_remote_change("/generated",Path::new("later.txt"));s.activity.settle(0,true,false,false,false);}
  assert!(e.take_sync_completion(&ids).unwrap());
}
#[test]fn consumed_completion_does_not_replay_after_tab_transfer_or_restore(){
  let e=Engine::default();let status=add(&e,"job");finish(&status);
  let mut owners=crate::window_ownership::Registry::default();owners.bootstrap("main").unwrap();owners.bootstrap("other").unwrap();owners.claim("main","tab").unwrap();owners.prepare_job("main","job",Some("tab")).unwrap();
  assert!(e.take_sync_completion(&owners.job_ids("main")).unwrap());
  let transfer=owners.begin_drag("main","tab",serde_json::json!({"version":1,"workspace":{"id":"tab"}})).unwrap();let transfer=owners.activate_drag("main",&transfer.token,Some(("other",0,None))).unwrap();owners.commit("other",&transfer.token).unwrap();
  assert!(!e.take_sync_completion(&owners.job_ids("main")).unwrap());assert!(!e.take_sync_completion(&owners.job_ids("other")).unwrap());
  owners.bootstrap("other").unwrap();assert!(!e.take_sync_completion(&owners.job_ids("other")).unwrap());
}
#[cfg(windows)]
#[test]fn isolated_native_icon_slots_follow_working_and_caught_up_without_showing_a_window(){
  use windows::{core::w,Win32::{Foundation::WPARAM,UI::WindowsAndMessaging::{CreateWindowExW,DestroyWindow,SendMessageW,WM_GETICON,WINDOW_EX_STYLE,WS_OVERLAPPED,ICON_SMALL,ICON_BIG}}};
  let hwnd=unsafe{CreateWindowExW(WINDOW_EX_STYLE::default(),w!("STATIC"),w!("Nearly completion isolated hidden fixture"),WS_OVERLAPPED,0,0,32,32,None,None,None,None)}.unwrap();
  struct Window(windows::Win32::Foundation::HWND);impl Drop for Window{fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}let _window=Window(hwnd);
  let images=[tauri::include_image!("./icons/icon-source.png"),tauri::include_image!("./icons/badges/sync.png"),tauri::include_image!("./icons/badges/done.png"),tauri::include_image!("./icons/badges/error.png"),tauri::include_image!("./icons/badges/paused.png")];
  let e=Engine::default();let status=add(&e,"job");let ids=vec!["job".into()];
  assert_eq!(e.taskbar_state_for(&ids).unwrap(),crate::taskbar_status::TaskbarState::Working);
  crate::status_icon_native::apply(hwnd,1,images.clone()).unwrap();
  let read=|slot|unsafe{SendMessageW(hwnd,WM_GETICON,Some(WPARAM(slot as usize)),None).0};
  let sync=read(ICON_BIG);assert_ne!(sync,0);assert_eq!(read(ICON_SMALL),sync);
  finish(&status);assert_eq!(e.taskbar_state_for(&ids).unwrap(),crate::taskbar_status::TaskbarState::CaughtUp);
  crate::status_icon_native::apply(hwnd,2,images).unwrap();let done=read(ICON_BIG);assert_ne!(done,0);assert_ne!(done,sync);assert_eq!(read(ICON_SMALL),done);
  let mut policy=crate::error_attention::Controller::default();policy.request("fixture",crate::error_attention::Event::Clear,true,|kind|{assert_eq!(kind,None);Ok::<_,()>(())}).unwrap();
  assert_eq!(e.taskbar_state_for(&ids).unwrap(),crate::taskbar_status::TaskbarState::CaughtUp);assert_eq!(read(ICON_BIG),done);
  println!("isolated-icon-observation: working image=sync.png small/big={sync}; caught_up image=done.png small/big={done}; focus-policy keeps done; hidden=true; taskbar-rendering=unobserved");
}
