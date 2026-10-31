//! Commit the presentation cache only when BOTH independently attempted effects succeed.
//! A partial failure invalidates the prior key: returning to an old state must reapply it.
pub fn apply<K: Eq + Clone>(cached: &mut Option<K>, key: Result<K,String>, icon: impl FnOnce()->Result<(),String>, progress: impl FnOnce()->Result<(),String>)->Result<(),String>{
    if key.as_ref().ok().is_some_and(|key|cached.as_ref()==Some(key)){return Ok(());}
    let mut errors=Vec::new();
    let key=match key{Ok(key)=>Some(key),Err(error)=>{errors.push(format!("Taskbar identity: {error}"));None}};
    if let Err(error)=icon(){errors.push(format!("Taskbar badge: {error}"));}
    if let Err(error)=progress(){errors.push(format!("Taskbar progress: {error}"));}
    if errors.is_empty(){*cached=key;Ok(())}else{*cached=None;Err(errors.join("; "))}
}
#[cfg(test)]mod tests{
 use super::*;use std::cell::RefCell;
 #[test]fn either_component_failure_still_attempts_both_and_preserves_diagnostics(){for (icon_ok,progress_ok)in[(false,true),(true,false),(false,false)]{let calls=RefCell::new(Vec::new());let mut cache=Some(0);let result=apply(&mut cache,Ok(1),||{calls.borrow_mut().push("icon");if icon_ok{Ok(())}else{Err("generated icon error".into())}},||{calls.borrow_mut().push("progress");if progress_ok{Ok(())}else{Err("generated progress error".into())}});assert_eq!(*calls.borrow(),["icon","progress"]);assert!(cache.is_none());let error=result.unwrap_err();assert_eq!(error.contains("generated icon error"),!icon_ok);assert_eq!(error.contains("generated progress error"),!progress_ok);}}
 #[test]fn partial_failure_then_return_to_old_state_cannot_reuse_stale_cache(){let mut cache=Some((0,1));assert!(apply(&mut cache,Ok((1,1)),||Err("icon".into()),||Ok(())).is_err());let calls=RefCell::new(0);apply(&mut cache,Ok((0,1)),||{*calls.borrow_mut()+=1;Ok(())},||{*calls.borrow_mut()+=1;Ok(())}).unwrap();assert_eq!(*calls.borrow(),2);assert_eq!(cache,Some((0,1)));}
 #[test]fn success_caches_both_and_recreation_reapplies_clear_state(){let mut cache=None;apply(&mut cache,Ok(("idle",1)),||Ok(()),||Ok(())).unwrap();apply(&mut cache,Ok(("idle",1)),||panic!("cached"),||panic!("cached")).unwrap();let calls=RefCell::new(Vec::new());apply(&mut cache,Ok(("idle",2)),||{calls.borrow_mut().push("clear badge");Ok(())},||{calls.borrow_mut().push("clear progress");Ok(())}).unwrap();assert_eq!(calls.into_inner(),["clear badge","clear progress"]);}
 #[test]fn identity_failure_does_not_block_effects_and_remains_pending(){let mut cache=Some(0);let calls=RefCell::new(0);let result=apply(&mut cache,Err("epoch unavailable".into()),||{*calls.borrow_mut()+=1;Ok(())},||{*calls.borrow_mut()+=1;Ok(())});assert_eq!(*calls.borrow(),2);assert!(result.unwrap_err().contains("epoch unavailable"));assert!(cache.is_none());}
 #[test]fn independent_windows_do_not_commit_each_others_pending_key(){let mut first=None;let mut second=None;assert!(apply(&mut first,Ok("working"),||Ok(()),||Err("progress".into())).is_err());apply(&mut second,Ok("caught_up"),||Ok(()),||Ok(())).unwrap();assert_eq!(second,Some("caught_up"));assert!(first.is_none());apply(&mut first,Ok("working"),||Ok(()),||Ok(())).unwrap();assert_eq!(first,Some("working"));}
}
