use super::*;
use crate::{AppState,bind_sync_start,complete_sync_start,fail_prepared_sync_start};
use crate::taskbar_status::{TaskbarState as T,group_badge};

fn state()->AppState {
 let state=AppState::default();let mut r=state.ownership.lock().unwrap();
 for(label,workspace)in[("main","tab"),("other","other-tab")]{r.bootstrap(label).unwrap();r.claim(label,workspace).unwrap();}
 drop(r);state
}
fn prepare(state:&AppState,label:&str,workspace:&str,id:&str){state.ownership.lock().unwrap().prepare_job(label,id,Some(workspace)).unwrap();state.engine.prepare(id.into()).unwrap();}
fn describe(state:&AppState,id:&str){state.ownership.lock().unwrap().describe_job(id,serde_json::json!({"id":id,"status":"running"}));}
fn failure(state:&AppState,id:&str)->Result<(),String>{
 let missing=std::env::temp_dir().join(format!("nearly-generated-absent-badge-{}-{}",std::process::id(),getrandom::u64().unwrap()));assert!(!missing.exists());
 let profile=sftp::Profile{id:"generated".into(),name:"Generated".into(),host:"never-contacted.invalid".into(),port:22,user:"fixture".into(),auth:"key".into(),mode:"sftp".into(),key_file:String::new(),host_key:String::new()};
 let result=state.engine.start(id.into(),profile,missing.to_string_lossy().into(),"/generated".into(),zeroize::Zeroizing::new(String::new()),SyncOptions::default());
 assert_eq!(result,Err("Local folder not found".into()),"must fail before DNS/network");result
}
fn badge(state:&AppState,label:&str)->T {let r=state.ownership.lock().unwrap();let state=state.engine.taskbar_state_for(&r.job_ids(label)).unwrap();if state==T::Idle&&r.has_stopped_sync(label){T::Paused}else{state}}

#[test]
fn replaced_failed_start_stops_contributing_to_native_error_badge(){
 let s=state();prepare(&s,"main","tab","old");describe(&s,"old");let error=failure(&s,"old");assert!(complete_sync_start(&s,"old",error).is_err());assert_eq!(badge(&s,"main"),T::Error,"current failed attempt remains visible");
 prepare(&s,"main","tab","next");describe(&s,"next");
 assert_eq!(badge(&s,"main"),T::Working,"a completed old start must not override the new attempt");assert_eq!(group_badge([badge(&s,"main"),badge(&s,"other")]),T::Working);
}

fn fail_and_complete(s:&AppState,id:&str){let error=failure(s,id);assert!(complete_sync_start(s,id,error).is_err());}
// Controlled native runtime snapshot; no worker, credentials or network is created.
fn caught_up_snapshot(s:&AppState,id:&str){
 s.engine.discard_prepared_start(id);
 let mut status=Status::new();status.activity.scan_finished();status.activity.settle(0,true,false,false,false);
 s.engine.jobs.lock().unwrap().insert(id.into(),Job{local:PathBuf::from("generated"),identity:String::new(),endpoints:vec![],remote:"/generated".into(),status:Arc::new(Mutex::new(status)),stop:Arc::new(AtomicBool::new(false)),retry:Arc::new(AtomicBool::new(false)),handle:None});
}
#[test]fn failed_resume_success_stop_and_close_reaggregate_without_old_error(){
 let s=state();prepare(&s,"main","tab","old");describe(&s,"old");fail_and_complete(&s,"old");
 prepare(&s,"main","tab","next");describe(&s,"next");assert_eq!(badge(&s,"main"),T::Working);
 caught_up_snapshot(&s,"next");assert_eq!(badge(&s,"main"),T::CaughtUp);
 s.engine.jobs.lock().unwrap().remove("next");s.ownership.lock().unwrap().finish_job("next");assert_eq!(badge(&s,"main"),T::Paused);
 s.ownership.lock().unwrap().release("main","tab").unwrap();assert_eq!(badge(&s,"main"),T::Idle);
 // Retired IDs cannot be resurrected by late descriptor or failure notifications.
 describe(&s,"old");s.engine.record_start_failure("old");assert_eq!(badge(&s,"main"),T::Idle);
}
#[test]fn another_window_or_tab_real_error_is_not_hidden_by_resume(){
 let s=state();s.ownership.lock().unwrap().claim("main","second-tab").unwrap();
 for(label,workspace,id)in[("other","other-tab","other-error"),("main","second-tab","same-window-error"),("main","tab","old")]{prepare(&s,label,workspace,id);describe(&s,id);fail_and_complete(&s,id);}
 prepare(&s,"main","tab","next");caught_up_snapshot(&s,"next");assert_eq!(badge(&s,"main"),T::Error);assert_eq!(badge(&s,"other"),T::Error);
 s.ownership.lock().unwrap().release("main","second-tab").unwrap();assert_eq!(badge(&s,"main"),T::CaughtUp);assert_eq!(group_badge([badge(&s,"main"),badge(&s,"other")]),T::Error);
 s.ownership.lock().unwrap().closed("other");assert_eq!(group_badge([badge(&s,"main"),badge(&s,"other")]),T::CaughtUp);
}
#[test]fn delayed_old_completion_does_not_hide_new_failure_or_restore_old_error(){
 for next_fails in [false,true]{let s=state();prepare(&s,"main","tab","old");describe(&s,"old");let old_result=failure(&s,"old");
 prepare(&s,"main","tab","next");describe(&s,"next");if next_fails{fail_and_complete(&s,"next");}else{caught_up_snapshot(&s,"next");}
 assert!(complete_sync_start(&s,"old",old_result.clone()).is_err());assert!(complete_sync_start(&s,"old",old_result).is_err());describe(&s,"old");
 assert_eq!(badge(&s,"main"),if next_fails{T::Error}else{T::CaughtUp});assert!(!s.ownership.lock().unwrap().job_ids("main").contains(&"old".into()));}
}
#[test]fn newest_failure_is_retained_even_with_an_older_active_descriptor(){
 let s=state();prepare(&s,"main","tab","old");describe(&s,"old");prepare(&s,"main","tab","next");describe(&s,"next");fail_and_complete(&s,"next");
 assert_eq!(badge(&s,"main"),T::Error);assert!(s.ownership.lock().unwrap().job_ids("main").contains(&"next".into()));
}
#[test]fn stale_prepare_and_bind_cannot_prune_newer_pending_attempt(){
 let s=state();prepare(&s,"main","tab","old");describe(&s,"old");prepare(&s,"main","tab","next");
 let mut r=s.ownership.lock().unwrap();r.prepare_job("main","old",Some("tab")).unwrap();assert!(r.bind_job("main","old","tab").unwrap_err().contains("superseded"));assert!(r.job_ids("main").contains(&"next".into()));
 let wire=serde_json::to_value(r.bootstrap("main").unwrap()).unwrap();assert!(wire["jobs"].as_array().unwrap().iter().all(|j|j.get("attempt").is_none()&&j.get("settled").is_none()));
}
#[test]fn unsettled_start_or_runtime_is_not_retired_on_worker_error(){
 for runtime in [false,true]{let s=state();prepare(&s,"main","tab","old");describe(&s,"old");if runtime{caught_up_snapshot(&s,"old");}else{s.engine.record_start_failure("old");}
 assert!(complete_sync_start(&s,"old",Err("generated worker error".into())).is_err());assert!(s.ownership.lock().unwrap().bootstrap("main").unwrap().jobs.iter().find(|j|j.id=="old").unwrap().job.is_some());}
}
#[test]fn legacy_provisional_binding_keeps_original_preparation_order(){
 let s=state();let mut r=s.ownership.lock().unwrap();r.prepare_job("main","old",None).unwrap();r.prepare_job("main","next",Some("tab")).unwrap();
 assert!(r.bind_job("main","old","tab").unwrap_err().contains("superseded"));assert!(r.job_ids("main").contains(&"next".into()));
 r.finish_job("old");r.finish_job("next");r.prepare_job("main","latest",None).unwrap();r.bind_job("main","latest","tab").unwrap();assert!(!r.job_ids("main").contains(&"next".into()));assert!(r.job_ids("main").contains(&"latest".into()));
 r.closed("main");assert!(r.job_ids("main").is_empty());
}
#[test]fn rejected_late_bind_retires_only_owned_unclaimed_preparation(){
 let s=state();s.ownership.lock().unwrap().prepare_job("main","old",None).unwrap();s.engine.prepare("old".into()).unwrap();prepare(&s,"main","tab","next");
 assert!(bind_sync_start(&s,"other","old",Some("other-tab")).is_err());assert!(s.engine.window_busy(&["old".into()],&[]).unwrap(),"unauthorized caller cannot discard another window's start");
 assert!(bind_sync_start(&s,"main","old",Some("tab")).unwrap_err().contains("superseded"));assert!(!s.engine.window_busy(&["old".into()],&[]).unwrap());assert_eq!(badge(&s,"main"),T::Working);assert_eq!(s.ownership.lock().unwrap().job_ids("main"),vec!["next".to_string()]);
}
#[test]fn bound_pending_start_is_not_orphaned_by_new_preparation(){
 let s=state();prepare(&s,"main","tab","old");prepare(&s,"main","tab","next");assert!(s.ownership.lock().unwrap().job_ids("main").contains(&"old".into()));
 assert!(bind_sync_start(&s,"main","old",Some("tab")).unwrap_err().contains("superseded"));assert!(!s.engine.window_busy(&["old".into()],&[]).unwrap());assert_eq!(s.ownership.lock().unwrap().job_ids("main"),vec!["next".to_string()]);
 assert_eq!(badge(&s,"main"),T::Working);
}
#[test]fn pre_description_failure_is_settled_before_replacement(){
 let s=state();prepare(&s,"main","tab","old");assert_eq!(fail_prepared_sync_start(&s,"old","generated credential validation failure".into()),Err("generated credential validation failure".into()));assert_eq!(badge(&s,"main"),T::Error);
 prepare(&s,"main","tab","next");assert_eq!(badge(&s,"main"),T::Working);assert!(!s.ownership.lock().unwrap().job_ids("main").contains(&"old".into()));
}
#[test]fn cancelled_prepared_start_settles_without_inventing_an_error(){
 for bound in [false,true]{let s=state();s.ownership.lock().unwrap().prepare_job("main","cancelled",bound.then_some("tab")).unwrap();s.engine.prepare("cancelled".into()).unwrap();s.engine.stop("cancelled").unwrap();assert!(fail_prepared_sync_start(&s,"cancelled","generated cancellation".into()).is_err());assert_eq!(badge(&s,"main"),T::Idle);
 if !bound{assert!(s.ownership.lock().unwrap().job_ids("main").is_empty(),"cancelled unbound request must not block lifecycle admission");}
 prepare(&s,"main","tab","next");assert_eq!(badge(&s,"main"),T::Working);}
}
#[test]fn genuine_unbound_failure_keeps_its_window_error_until_closed(){
 let s=state();s.ownership.lock().unwrap().prepare_job("main","legacy",None).unwrap();s.engine.prepare("legacy".into()).unwrap();fail_and_complete(&s,"legacy");
 assert_eq!(badge(&s,"main"),T::Error);prepare(&s,"main","tab","next");assert_eq!(badge(&s,"main"),T::Error,"unknown legacy workspace must not be assumed replaced");
 s.ownership.lock().unwrap().closed("main");assert_eq!(badge(&s,"main"),T::Idle);
}
#[test]fn recovered_badge_update_failure_retries_and_recreation_clears(){
 let s=state();prepare(&s,"main","tab","old");describe(&s,"old");fail_and_complete(&s,"old");let mut cache=Some((badge(&s,"main"),0));
 prepare(&s,"main","tab","next");let key=(badge(&s,"main"),0);let attempts=std::cell::Cell::new(0);
 assert!(crate::taskbar_effects::apply(&mut cache,Ok(key),||Err("generated overlay failure".into()),||{attempts.set(attempts.get()+1);Ok(())}).is_err());assert_eq!(cache,None);
 crate::taskbar_effects::apply(&mut cache,Ok(key),||{attempts.set(attempts.get()+1);Ok(())},||Ok(())).unwrap();assert_eq!(cache,Some((T::Working,0)));assert_eq!(attempts.get(),2);
 s.ownership.lock().unwrap().release("main","tab").unwrap();for epoch in [0,1]{crate::taskbar_effects::apply(&mut cache,Ok((badge(&s,"main"),epoch)),||{attempts.set(attempts.get()+1);Ok(())},||Ok(())).unwrap();}assert_eq!(cache,Some((T::Idle,1)));assert_eq!(attempts.get(),4);
}
