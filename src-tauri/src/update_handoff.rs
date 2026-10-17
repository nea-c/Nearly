//! Native installer launch contract. Caller must hold the verified staging file
//! and directory locks through this call and process exit. No shell is involved.
//! A ready installer has opened and identified this process; it still cannot
//! mutate anything until that exact process handle signals exit.
use std::{path::{Path, PathBuf}, process::{Child, Command}, time::{Duration, Instant}};
pub(crate) use crate::startup_update::HANDOFF_RELEASE_VALIDATED;

pub(crate) fn installed_executable() -> Result<PathBuf,String> {
    #[cfg(windows)] { native::installed_executable() }
    #[cfg(not(windows))] { Err("Installed update transactions require Windows".into()) }
}

pub struct LaunchedInstaller { pub child: Child, identity:crate::update_transaction::ProcessIdentity, #[cfg(windows)] abort:native::CancelOnDrop, #[cfg(windows)] _health_events:native::HealthEvents }
impl LaunchedInstaller {
    pub(crate) fn process_identity(&self)->crate::update_transaction::ProcessIdentity {self.identity.clone()}
    /// Call only after sealed settings cleanup succeeds, immediately before
    /// controlled process exit. Dropping an uncommitted launch cancels setup.
    pub fn commit(mut self)->Result<Child,String> {
        if self.child.try_wait().map_err(|e|format!("Cannot confirm waiting installer: {e}"))?.is_some(){return Err("Installer exited before commit; Nearly remains open".into());}
        #[cfg(windows)] { self.abort.commit()?; }
        Ok(self.child)
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    type Handle = *mut c_void;
    #[repr(C)] #[derive(Default)] struct FileTime { low: u32, high: u32 }
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn GetProcessTimes(h: Handle, c: *mut FileTime, e: *mut FileTime, k: *mut FileTime, u: *mut FileTime) -> i32;
        fn CreateEventW(a: *const c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn CloseHandle(h: Handle) -> i32;
        fn GetLastError() -> u32;
        #[cfg(test)] fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        #[cfg(test)] fn OpenEventW(access:u32,inherit:i32,name:*const u16)->Handle;
        fn SetEvent(event:Handle)->i32;
    }
    #[repr(C)] struct Guid { a:u32,b:u16,c:u16,d:[u8;8] }
    #[link(name="shell32")]
    unsafe extern "system" { fn SHGetKnownFolderPath(id:*const Guid,flags:u32,token:Handle,path:*mut *mut u16)->i32; }
    #[link(name="ole32")]
    unsafe extern "system" { fn CoTaskMemFree(memory:*const c_void); }
    #[link(name="advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(key: Handle, sub: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, bytes: *mut u32) -> i32;
    }
    struct Event(Handle);
    // Kernel event handles permit cross-thread waits/signals. The owning wrapper
    // closes exactly once; CancelOnDrop mutation still requires exclusive access.
    unsafe impl Send for Event{}
    unsafe impl Sync for Event{}
    impl Drop for Event { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    pub(super) struct CancelOnDrop { event:Event, commit:Option<Event>, armed:bool }
    impl CancelOnDrop {
        pub(super) fn commit(&mut self)->Result<(),String> {
            let event=self.commit.as_ref().ok_or("Missing installer commit event")?;
            if unsafe {SetEvent(event.0)}==0 {return Err("Cannot authorize installer commit; Nearly remains open".into());}
            self.armed=false; Ok(())
        }
    }
    impl Drop for CancelOnDrop { fn drop(&mut self) {if self.armed {unsafe {SetEvent(self.event.0);}}} }
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> { s.encode_wide().chain(Some(0)).collect() }
    fn registry(value: &str) -> Result<String,String> {
        let sub=wide(std::ffi::OsStr::new("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\local.syncfiles.native"));
        let value=wide(std::ffi::OsStr::new(value));
        let mut data=[0u16;32768]; let mut bytes=(data.len()*2) as u32;
        // HKCU is a predefined sign-extended handle; read only REG_SZ in the
        // architecture's installer view. Never create/change registration.
        let flags=2 | if cfg!(target_pointer_width="64") { 0x10000 } else { 0x20000 };
        let rc=unsafe { RegGetValueW((-2147483647isize) as Handle,sub.as_ptr(),value.as_ptr(),flags,std::ptr::null_mut(),data.as_mut_ptr().cast(),&mut bytes) };
        if rc != 0 || bytes < 2 { return Err("Per-user installation registration is unavailable".into()); }
        let count=(bytes as usize/2).saturating_sub(1);
        String::from_utf16(&data[..count]).map_err(|_|"Invalid installation registration".into())
    }
    fn fixed_install_directory()->Result<PathBuf,String> {
        let id=Guid {a:0xf1b32785,b:0x6fba,c:0x4fcf,d:[0x9d,0x55,0x7b,0x8e,0x7f,0x15,0x70,0x91]};
        let mut path=std::ptr::null_mut();
        if unsafe { SHGetKnownFolderPath(&id,0,std::ptr::null_mut(),&mut path) } < 0 || path.is_null() { return Err("Cannot resolve per-user LocalAppData".into()); }
        let mut length=0;
        unsafe { while *path.add(length)!=0 {length+=1;} }
        let value=String::from_utf16(unsafe {std::slice::from_raw_parts(path,length)});
        unsafe {CoTaskMemFree(path.cast());}
        Ok(PathBuf::from(value.map_err(|_|"Invalid LocalAppData path")?).join("Nearly"))
    }
    pub fn installed_executable() -> Result<PathBuf,String> {
        if registry("NearlyOwner")? != "local.syncfiles.native" { return Err("Unrecognized installation owner".into()); }
        let fixed=fixed_install_directory()?;
        let registered=PathBuf::from(registry("InstallLocation")?);
        if std::fs::canonicalize(&fixed).map_err(|e|e.to_string())? != std::fs::canonicalize(registered).map_err(|e|e.to_string())? { return Err("Registered installation is not the fixed per-user location".into()); }
        Ok(fixed.join("Nearly.exe"))
    }
    pub fn launch(installer: &Path,nonce:&str) -> Result<LaunchedInstaller,String> {
        validate_nonce(nonce)?;
        let current=std::env::current_exe().map_err(|e|e.to_string())?;
        let installed=installed_executable()?;
        validate_sibling(installer,&current,&installed)?;
        let (mut c,mut e,mut k,mut u)=(FileTime::default(),FileTime::default(),FileTime::default(),FileTime::default());
        if unsafe { GetProcessTimes(GetCurrentProcess(),&mut c,&mut e,&mut k,&mut u) } == 0 { return Err("Cannot identify update parent".into()); }
        let event=fresh_event("Ready-v2",nonce)?;
        let mut abort=CancelOnDrop {event:fresh_event("Abort",nonce)?,commit:None,armed:true};
        abort.commit=Some(fresh_event("Commit",nonce)?);
        let health_events=HealthEvents { _installed:fresh_event("Installed",nonce)?,_healthy:fresh_event("Healthy",nonce)? };
        let mut child=Command::new(installer).args(["/S".into(),"/NEARLYUPDATE".into(),"/NEARLYPROTOCOL=2".into(),format!("/NEARLYPARENT={}",std::process::id()),format!("/NEARLYCREATED={}",((c.high as u64)<<32)|c.low as u64),format!("/NEARLYREADY={nonce}")]).spawn().map_err(|e|format!("Cannot launch verified installer: {e}"))?;
        let identity=identify_child(&child)?;
        wait_ready(&mut child,&event,Duration::from_secs(10))?;
        Ok(LaunchedInstaller { child, identity, abort, _health_events:health_events })
    }
    pub(super) struct HealthEvents {_installed:Event,_healthy:Event}
    fn fresh_event(kind:&str,nonce:&str)->Result<Event,String>{
        let name=wide(std::ffi::OsStr::new(&format!("Local\\NearlyUpdate{kind}-{nonce}")));
        let handle=unsafe{CreateEventW(std::ptr::null(),1,0,name.as_ptr())};
        let error=unsafe{GetLastError()};
        if handle.is_null(){return Err(format!("Cannot create installer {kind} event"));}
        let event=Event(handle);
        if error==183{return Err(format!("Installer {kind} event collision"));}
        Ok(event)
    }
    fn identify_child(child:&Child)->Result<crate::update_transaction::ProcessIdentity,String>{
        use std::os::windows::io::AsRawHandle;
        let(mut c,mut e,mut k,mut u)=(FileTime::default(),FileTime::default(),FileTime::default(),FileTime::default());
        if unsafe{GetProcessTimes(child.as_raw_handle(),&mut c,&mut e,&mut k,&mut u)}==0{return Err("Cannot identify launched installer".into());}
        let created=((c.high as u64)<<32)|c.low as u64;
        if created==0{return Err("Invalid installer creation identity".into());}
        Ok(crate::update_transaction::ProcessIdentity {pid:child.id(),created})
    }
    fn wait_ready(child:&mut Child,event:&Event,timeout:Duration)->Result<(),String> {
        let started=Instant::now();
        loop {
            if let Some(status)=child.try_wait().map_err(|e|e.to_string())? { return Err(format!("Installer rejected handoff ({status}); Nearly remains open")); }
            match unsafe { WaitForSingleObject(event.0,50) } {
                0 => return Ok(()),
                258 => {},
                _ => return Err("Cannot confirm installer readiness; Nearly remains open".into()),
            }
            if started.elapsed() >= timeout { return Err("Installer readiness timed out; Nearly remains open. Waiting setup will expire without changing files".into()); }
        }
    }
    #[cfg(test)] mod tests {
        use super::*;
        #[test] fn phase_event_collisions_are_rejected_without_signalling_existing_events(){
            for kind in ["Ready-v2","Abort","Commit","Installed","Healthy"]{
                let nonce=format!("{:032x}",std::process::id() as u128);
                let existing=fresh_event(kind,&nonce).unwrap();
                assert!(fresh_event(kind,&nonce).is_err());
                assert_eq!(unsafe{WaitForSingleObject(existing.0,0)},258);
            }
        }
        #[test] #[ignore] fn owned_wait_helper() {
            if let Some(name)=std::env::var_os("NEARLY_TEST_ABORT_EVENT") {
                let name=wide(&name); let handle=unsafe {OpenEventW(0x00100000,0,name.as_ptr())};
                // Missing event is rejection too: the native caller may have
                // already timed out and closed its last owning handle.
                if handle.is_null() {return;}
                std::thread::sleep(Duration::from_millis(250));
                let cancelled=unsafe {WaitForSingleObject(handle,0)} != 258;
                unsafe {CloseHandle(handle);}
                if cancelled {return;}
            }
            if let Some(name)=std::env::var_os("NEARLY_TEST_READY_EVENT") {
                let name=wide(&name); let handle=unsafe { OpenEventW(2,0,name.as_ptr()) };
                assert!(!handle.is_null()); assert_ne!(unsafe { SetEvent(handle) },0);
                unsafe { CloseHandle(handle); }
            }
            std::thread::sleep(Duration::from_millis(350));
        }
        #[test] fn delayed_fake_installer_is_cancelled_after_native_timeout() {
            let base=format!("Local\\NearlyLateTest-{}",std::process::id());
            let ready_name=wide(std::ffi::OsStr::new(&format!("{base}-ready")));
            let abort_name=wide(std::ffi::OsStr::new(&format!("{base}-abort")));
            let ready=Event(unsafe {CreateEventW(std::ptr::null(),1,0,ready_name.as_ptr())});
            let abort=CancelOnDrop {event:Event(unsafe {CreateEventW(std::ptr::null(),1,0,abort_name.as_ptr())}),commit:None,armed:true};
            let mut child=Command::new(std::env::current_exe().unwrap())
                .args(["owned_wait_helper","--ignored"])
                .env("NEARLY_TEST_READY_EVENT",format!("{base}-ready"))
                .env("NEARLY_TEST_ABORT_EVENT",format!("{base}-abort")).spawn().unwrap();
            assert!(wait_ready(&mut child,&ready,Duration::from_millis(50)).is_err());
            drop(abort);
            assert!(child.wait().unwrap().success());
            assert_eq!(unsafe {WaitForSingleObject(ready.0,0)},258,"late helper must never signal ready after cancellation");
        }
        #[test] fn commit_event_requires_explicit_successful_commit() {
            let abort_event=Event(unsafe {CreateEventW(std::ptr::null(),1,0,std::ptr::null())});
            let commit_event=Event(unsafe {CreateEventW(std::ptr::null(),1,0,std::ptr::null())});
            let mut cancel=CancelOnDrop {event:abort_event,commit:Some(commit_event),armed:true};
            assert_eq!(unsafe {WaitForSingleObject(cancel.commit.as_ref().unwrap().0,0)},258);
            cancel.commit().unwrap();
            assert_eq!(unsafe {WaitForSingleObject(cancel.commit.as_ref().unwrap().0,0)},0);
            assert_eq!(unsafe {WaitForSingleObject(cancel.event.0,0)},258);
            assert!(!cancel.armed);
        }
        #[test] fn owned_fake_installer_readiness_success_failure_and_timeout() {
            let exe=std::env::current_exe().unwrap();
            for mode in ["ready","failure","timeout"] {
                let name=format!("Local\\NearlyHandoffTest-{}-{mode}",std::process::id());
                let wide_name=wide(std::ffi::OsStr::new(&name));
                let event=Event(unsafe { CreateEventW(std::ptr::null(),1,0,wide_name.as_ptr()) });
                assert!(!event.0.is_null());
                let mut command=Command::new(&exe);
                command.args([if mode=="failure" {"no_matching_test"} else {"owned_wait_helper"},"--ignored"]);
                if mode=="ready" {command.env("NEARLY_TEST_READY_EVENT",&name);}
                let mut child=command.spawn().unwrap();
                let result=wait_ready(&mut child,&event,if mode=="timeout" {Duration::from_millis(80)} else {Duration::from_secs(3)});
                assert_eq!(result.is_ok(),mode=="ready");
                // Timeout never kills the waiting child; it exits naturally.
                if mode=="timeout" { assert!(child.try_wait().unwrap().is_none()); }
                assert!(child.wait().unwrap().success());
            }
        }
        #[test] fn exact_owned_process_handle_times_out_then_observes_natural_exit() {
            let mut child=Command::new(std::env::current_exe().unwrap())
                .args(["owned_wait_helper","--ignored"]).spawn().unwrap();
            let handle=unsafe { OpenProcess(0x00101000,0,child.id()) };
            assert!(!handle.is_null());
            let (mut c,mut e,mut k,mut u)=(FileTime::default(),FileTime::default(),FileTime::default(),FileTime::default());
            assert_ne!(unsafe { GetProcessTimes(handle,&mut c,&mut e,&mut k,&mut u) },0);
            let identity=((c.high as u64)<<32)|c.low as u64;
            assert_ne!(identity,0);
            // A mismatched creation identity must never become a PID-only wait.
            assert_ne!(identity,identity.wrapping_add(1));
            assert_eq!(unsafe { WaitForSingleObject(handle,1) },258);
            assert_eq!(unsafe { WaitForSingleObject(handle,5000) },0);
            assert!(child.wait().unwrap().success());
            unsafe { CloseHandle(handle); }
        }
    }
}

fn validate_sibling(installer:&Path,current:&Path,installed:&Path)->Result<(),String> {
    let canonical=|p:&Path|std::fs::canonicalize(p).map_err(|e|e.to_string());
    let current=canonical(current)?;
    let candidate=canonical(installer)?;
    validate_canonical_layout(&candidate,&current,&canonical(installed)?)
}
fn validate_canonical_layout(candidate:&Path,current:&Path,installed:&Path)->Result<(),String> {
    if current != installed { return Err("Installer updates require the registered per-user Nearly.exe".into()); }
    let name=candidate.file_name().and_then(|v|v.to_str()).ok_or("Invalid staged installer name")?;
    if candidate.parent()!=current.parent() || !name.starts_with("Nearly-update-") || !name.ends_with("-setup.exe") || candidate==current { return Err("Verified installer must use an owned sibling setup filename".into()); }
    Ok(())
}

fn validate_nonce(nonce:&str)->Result<(),String>{if nonce.len()!=32||!nonce.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("Invalid installer transaction nonce".into());}Ok(())}

pub fn launch_verified_sibling(installer:&Path,nonce:&str)->Result<LaunchedInstaller,String> {
    #[cfg(windows)] { native::launch(installer,nonce) }
    #[cfg(not(windows))] { let _=(installer,nonce); Err("Installer handoff requires Windows".into()) }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn transaction_nonce_cannot_be_malformed_or_caller_extended(){for nonce in ["", "abc", "0123456789abcdef0123456789abcdef-extra", "ABCDEF0123456789abcdef0123456789"]{assert!(validate_nonce(nonce).is_err());}assert!(validate_nonce("0123456789abcdef0123456789abcdef").is_ok());}
    #[test] fn portable_and_foreign_installer_layouts_are_rejected() {
        let dir=std::env::temp_dir().join(format!("nearly-handoff-test-{}",std::process::id()));
        std::fs::create_dir_all(dir.join("other")).unwrap();
        let current=dir.join("Nearly.exe"); let setup=dir.join("Nearly-update-test-setup.exe");
        let foreign=dir.join("other/Nearly.exe");
        for p in [&current,&setup,&foreign] { std::fs::write(p,b"fixture").unwrap(); }
        assert!(validate_canonical_layout(&setup,&current,&current).is_ok());
        assert!(validate_canonical_layout(&setup,&current,&foreign).is_err());
        assert!(validate_canonical_layout(&foreign,&current,&current).is_err());
        assert!(validate_canonical_layout(&current,&current,&current).is_err());
        match std::fs::canonicalize(&current) {
            Ok(_) => assert!(validate_sibling(&setup,&current,&current).is_ok()),
            Err(error) => { eprintln!("Native canonicalization unavailable ({error}); verifying fail-closed response"); assert!(validate_sibling(&setup,&current,&current).is_err()); }
        }
        assert!(validate_sibling(&setup,&current,&foreign).is_err());
        assert!(validate_sibling(&foreign,&current,&current).is_err());
        assert!(validate_sibling(&current,&current,&current).is_err());
        for p in [&current,&setup,&foreign] { std::fs::remove_file(p).unwrap(); }
        std::fs::remove_dir(dir.join("other")).unwrap(); std::fs::remove_dir(dir).unwrap();
    }
}




