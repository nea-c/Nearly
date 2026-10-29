//! Window-local notification policy. No job/error/badge state is modified here.
use std::collections::HashSet;

#[derive(Clone,Copy,Debug,Eq,PartialEq)]
pub enum Kind { Error, Completion }
#[derive(Clone,Copy)]
pub enum Event { Error, Completion, Clear }
#[derive(Default)]
pub struct Controller { errors:HashSet<String> }
impl Controller {
    pub fn forget(&mut self,label:&str){self.errors.remove(label);}
    pub fn request<E>(&mut self,label:&str,event:Event,focused:bool,dispatch:impl FnOnce(Option<Kind>)->Result<(),E>)->Result<(),E>{
        match event {
            Event::Clear=>{dispatch(None)?;self.forget(label);}
            Event::Error if !focused=>{dispatch(Some(Kind::Error))?;self.errors.insert(label.into());}
            Event::Completion if !focused&&!self.errors.contains(label)=>{dispatch(Some(Kind::Completion))?;}
            _=>{}
        }
        Ok(())
    }
}

pub fn dispatch(window:&tauri::Window,controller:&std::sync::Mutex<Controller>,event:Event)->tauri::Result<()> {
    let focused=window.is_focused()?;
    controller.lock().map_err(|_|tauri::Error::Io(std::io::Error::other("Attention lock failed")))?.request(window.label(),event,focused,|kind|window.request_user_attention(kind.map(|kind|match kind{Kind::Error=>tauri::UserAttentionType::Critical,Kind::Completion=>tauri::UserAttentionType::Informational})))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn completion_is_informational_foreground_is_consumed_and_focus_only_clears_attention(){
        let mut policy=Controller::default();let mut calls=vec![];
        policy.request("one",Event::Completion,false,|kind|{calls.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("one",Event::Clear,true,|kind|{calls.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("one",Event::Completion,true,|kind|{calls.push(kind);Ok::<_,()>(())}).unwrap();
        assert_eq!(calls,vec![Some(Kind::Completion),None]);
    }
    #[test] fn error_attention_is_never_downgraded_by_completion_and_windows_are_independent(){
        let mut policy=Controller::default();let mut first=vec![];let mut other=vec![];
        policy.request("one",Event::Error,false,|kind|{first.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("one",Event::Completion,false,|kind|{first.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("other",Event::Completion,false,|kind|{other.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("other",Event::Clear,true,|kind|{other.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("one",Event::Completion,false,|kind|{first.push(kind);Ok::<_,()>(())}).unwrap();
        assert_eq!(first,vec![Some(Kind::Error)]);assert_eq!(other,vec![Some(Kind::Completion),None]);
        policy.request("one",Event::Clear,true,|_|Ok::<_,()>(())).unwrap();
        policy.request("one",Event::Completion,false,|kind|{first.push(kind);Ok::<_,()>(())}).unwrap();
        assert_eq!(first,vec![Some(Kind::Error),Some(Kind::Completion)]);
    }
    #[test] fn failed_error_dispatch_does_not_latch_and_closed_windows_release_priority(){
        let mut policy=Controller::default();
        assert_eq!(policy.request("one",Event::Error,false,|_|Err("fixture failure")),Err("fixture failure"));
        let mut calls=vec![];policy.request("one",Event::Completion,false,|kind|{calls.push(kind);Ok::<_,()>(())}).unwrap();
        policy.request("one",Event::Error,false,|_|Ok::<_,()>(())).unwrap();policy.forget("one");
        policy.request("one",Event::Completion,false,|kind|{calls.push(kind);Ok::<_,()>(())}).unwrap();
        assert_eq!(calls,vec![Some(Kind::Completion),Some(Kind::Completion)]);
    }
}
