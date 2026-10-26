//! Window-local notification policy. No job/error/badge state is modified here.
pub fn apply<E>(active: bool, focused: bool, dispatch: impl FnOnce(bool)->Result<(),E>)->Result<(),E>{
    if active && focused { return Ok(()); }
    dispatch(active)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn background_requests_and_focus_only_clears_notification(){
        let mut calls=Vec::new();
        apply(true,false,|v|{calls.push(v);Ok::<_,()>(())}).unwrap();
        apply(true,true,|v|{calls.push(v);Ok::<_,()>(())}).unwrap();
        apply(false,true,|v|{calls.push(v);Ok::<_,()>(())}).unwrap();
        apply(true,false,|v|{calls.push(v);Ok::<_,()>(())}).unwrap();
        assert_eq!(calls,vec![true,false,true]);
    }
    #[test] fn requests_do_not_leak_between_window_adapters(){
        let mut first=Vec::new();let mut second=Vec::new();
        apply(true,false,|v|{first.push(v);Ok::<_,()>(())}).unwrap();
        apply(false,true,|v|{second.push(v);Ok::<_,()>(())}).unwrap();
        assert_eq!(first,vec![true]);assert_eq!(second,vec![false]);
        assert_eq!(apply(true,false,|_|Err("fixture dispatch failed")),Err("fixture dispatch failed"));
    }
}
