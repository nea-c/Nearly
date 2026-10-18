//! Live restart evidence. Transaction records contain lookup hints only: this
//! module opens and retains the exact installer process and native events.
use crate::update_transaction::ProcessIdentity;
use std::{path::{Path,PathBuf},time::Duration};

/// Only an actual retained process-handle wait and zero exit can create this.
/// Persisted fields and caller-supplied booleans cannot construct exit proof.
#[derive(Debug)]
pub(crate) struct ExitProof {identity:ProcessIdentity,nonce:String,image_path:PathBuf}
impl ExitProof {
    pub(crate) fn process_identity(&self)->&ProcessIdentity{&self.identity}
    pub(crate) fn nonce(&self)->&str{&self.nonce}
    pub(crate) fn image_path(&self)->&Path{&self.image_path}
}
#[cfg(windows)] pub(crate) use native::{LiveInstaller,LiveRecoverySupervisor,current_identity};
#[cfg(not(windows))]
pub(crate) struct LiveInstaller;
#[cfg(not(windows))]
impl LiveInstaller {
    pub(crate) fn open(_: &str,_:&ProcessIdentity,_:&Path)->Result<Self,String>{Err("Live installer proof requires Windows".into())}
    pub(crate) fn signal_healthy(&self)->Result<(),String>{Err("Live installer proof requires Windows".into())}
    pub(crate) fn wait_exit_zero(&self,_:Duration)->Result<ExitProof,String>{Err("Live installer proof requires Windows".into())}
}
#[derive(Debug,PartialEq,Eq)]
pub(crate) enum SupervisorEvent { Success, ExitRequest }
fn valid_nonce(nonce:&str)->bool{nonce.len()==32&&nonce.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
#[cfg(windows)]
mod native {
    use super::*;
    use std::{ffi::{c_void,OsStr},os::windows::ffi::OsStrExt,sync::atomic::{AtomicBool,Ordering}};
    type RawHandle=*mut c_void;
    #[repr(C)]#[derive(Default)]struct FileTime{low:u32,high:u32}
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->RawHandle;
        fn GetProcessTimes(h:RawHandle,c:*mut FileTime,e:*mut FileTime,k:*mut FileTime,u:*mut FileTime)->i32;
        fn QueryFullProcessImageNameW(h:RawHandle,flags:u32,path:*mut u16,size:*mut u32)->i32;
        fn OpenEventW(access:u32,inherit:i32,name:*const u16)->RawHandle;
        fn WaitForSingleObject(h:RawHandle,ms:u32)->u32;
        fn GetExitCodeProcess(h:RawHandle,code:*mut u32)->i32;
        fn SetEvent(h:RawHandle)->i32;
        fn CloseHandle(h:RawHandle)->i32;
        #[cfg(test)]fn CreateEventW(a:*const c_void,manual:i32,initial:i32,name:*const u16)->RawHandle;
    }
    struct Handle(RawHandle);
    // Windows process/event handles may be waited on another thread. Ownership
    // remains unique and every kernel handle is closed exactly once on drop.
    unsafe impl Send for Handle{}
    unsafe impl Sync for Handle{}
    impl Drop for Handle{fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
    fn wide(s:&OsStr)->Vec<u16>{s.encode_wide().chain(Some(0)).collect()}
    fn event(kind:&str,nonce:&str,access:u32)->Result<Handle,String>{
        let name=wide(OsStr::new(&format!("Local\\NearlyUpdate{kind}-{nonce}")));
        let h=unsafe{OpenEventW(access,0,name.as_ptr())};
        if h.is_null(){return Err(format!("Live installer {kind} event is unavailable"));}Ok(Handle(h))
    }
    fn identity(h:&Handle,pid:u32)->Result<ProcessIdentity,String>{
        let(mut c,mut e,mut k,mut u)=(FileTime::default(),FileTime::default(),FileTime::default(),FileTime::default());
        if unsafe{GetProcessTimes(h.0,&mut c,&mut e,&mut k,&mut u)}==0{return Err("Cannot identify live installer".into());}
        let created=((c.high as u64)<<32)|c.low as u64;
        if created==0{return Err("Invalid installer creation identity".into());}Ok(ProcessIdentity{pid,created})
    }
    fn image_path(h:&Handle)->Result<PathBuf,String>{
        let mut path=vec![0u16;32768];let mut size=path.len() as u32;
        if unsafe{QueryFullProcessImageNameW(h.0,0,path.as_mut_ptr(),&mut size)}==0||size==0||size as usize>=path.len(){return Err("Cannot inspect live installer image".into());}
        let path=String::from_utf16(&path[..size as usize]).map_err(|_|"Invalid installer image path")?;
        dunce::canonicalize(path).map_err(|_|"Cannot resolve live installer image".into())
    }
    pub(crate) fn current_identity()->Result<ProcessIdentity,String>{
        let pid=std::process::id();let raw=unsafe{OpenProcess(0x1000,0,pid)};
        if raw.is_null(){return Err("Current process identity unavailable".into());}
        identity(&Handle(raw),pid)
    }
    pub(crate) struct LiveInstaller {process:Handle,installed:Handle,healthy:Handle,identity:ProcessIdentity,nonce:String,image_path:PathBuf,healthy_issued:AtomicBool}
    impl LiveInstaller {
        pub(crate) fn open(nonce:&str,expected:&ProcessIdentity,expected_installer:&Path)->Result<Self,String>{
            if !valid_nonce(nonce)||expected.pid==0||expected.created==0{return Err("Invalid live installer identity".into());}
            let raw=unsafe{OpenProcess(0x00101000,0,expected.pid)};
            if raw.is_null(){return Err("Live installer process is unavailable".into());}let process=Handle(raw);
            let captured=identity(&process,expected.pid)?;
            if &captured!=expected{return Err("Installer creation identity mismatch".into());}
            if unsafe{WaitForSingleObject(process.0,0)}!=258{return Err("Installer is no longer live".into());}
            let captured_path=image_path(&process)?;
            let expected_path=dunce::canonicalize(expected_installer).map_err(|_|"Verified installer path is unavailable")?;
            if captured_path!=expected_path{return Err("Installer image path mismatch".into());}
            let installed=event("Installed",nonce,0x00100000)?;
            let healthy=event("Healthy",nonce,0x00100002)?;
            if unsafe{WaitForSingleObject(installed.0,0)}!=0{return Err("Installer has not signaled installation success".into());}
            if unsafe{WaitForSingleObject(healthy.0,0)}!=258{return Err("Installer health event is stale".into());}
            Ok(Self{process,installed,healthy,identity:captured,nonce:nonce.into(),image_path:captured_path,healthy_issued:AtomicBool::new(false)})
        }
        pub(crate) fn verify_installed(&self)->Result<(),String>{
            if identity(&self.process,self.identity.pid)?!=self.identity
                || image_path(&self.process)?!=self.image_path
                || unsafe{WaitForSingleObject(self.process.0,0)}!=258
                || unsafe{WaitForSingleObject(self.installed.0,0)}!=0{return Err("Installer evidence unavailable".into());}
            Ok(())
        }
        pub(crate) fn process_identity(&self)->&ProcessIdentity{&self.identity}
        pub(crate) fn image_path(&self)->&Path{&self.image_path}
        pub(crate) fn nonce(&self)->&str{&self.nonce}
        /// Caller must first authenticate held installer bytes and native restart
        /// health. This method alone never authorizes transaction-file cleanup.
        pub(crate) fn signal_healthy(&self)->Result<(),String>{
            if unsafe{WaitForSingleObject(self.process.0,0)}!=258||unsafe{WaitForSingleObject(self.installed.0,0)}!=0{return Err("Live installer health handoff was lost".into());}
            if unsafe{SetEvent(self.healthy.0)}==0{return Err("Cannot signal restart health".into());}
            self.healthy_issued.store(true,Ordering::Release);Ok(())
        }
        pub(crate) fn wait_exit_zero(&self,timeout:Duration)->Result<ExitProof,String>{
            if !self.healthy_issued.load(Ordering::Acquire){return Err("Native restart health has not been signaled".into());}
            let ms=timeout.as_millis().min(30_000) as u32;
            match unsafe{WaitForSingleObject(self.process.0,ms)}{0=>{},258=>return Err("Installer exit timed out; recovery artifacts retained".into()),_=>return Err("Installer exit proof was lost; recovery artifacts retained".into())}
            let mut code=259;
            if unsafe{GetExitCodeProcess(self.process.0,&mut code)}==0||code!=0{return Err(format!("Installer did not exit successfully ({code}); recovery artifacts retained"));}
            Ok(ExitProof{identity:self.identity.clone(),nonce:self.nonce.clone(),image_path:self.image_path.clone()})
        }
    }
    /// Separate from installer exit evidence: this channel retains an exact live
    /// old-image supervisor and an authenticated root-only snapshot's file guards.
    pub(crate) struct LiveRecoverySupervisor {
        process:Handle, healthy:Handle, success:Handle, success_ack:Handle, exit_request:Handle, idle:Handle,
        snapshot:crate::update_recovery_windows::RecoveryHealthSnapshot,
    }
    impl LiveRecoverySupervisor {
        pub(crate) fn open(snapshot:crate::update_recovery_windows::RecoveryHealthSnapshot)->Result<Self,String>{
            let expected=snapshot.helper_identity();
            if !valid_nonce(snapshot.nonce())||expected.pid==0||expected.created==0{return Err("Invalid supervisor identity".into());}
            snapshot.verify_helper_image()?;
            let raw=unsafe{OpenProcess(0x00101000,0,expected.pid)};
            if raw.is_null(){return Err("Supervisor unavailable".into());}
            let process=Handle(raw);
            if identity(&process,expected.pid)?!=*expected||image_path(&process)?!=dunce::canonicalize(snapshot.helper_path()).map_err(|_|"Supervisor path unavailable")?||unsafe{WaitForSingleObject(process.0,0)}!=258{return Err("Supervisor identity mismatch".into());}
            let event=|kind:&str,access:u32|->Result<Handle,String>{
                let name=wide(OsStr::new(&format!("Local\\NearlyRecovery{kind}-{}",snapshot.nonce())));
                let h=unsafe{OpenEventW(access,0,name.as_ptr())};
                if h.is_null(){return Err("Supervisor event unavailable".into());}Ok(Handle(h))
            };
            let healthy=event("Healthy",0x00100002)?;
            let success=event("Success",0x00100000)?;
            let success_ack=event("SuccessAck",0x00100002)?;
            let exit_request=event("ExitRequest",0x00100000)?;
            let idle=event("Idle",0x00100002)?;
            // A pre-existing Health/Idle signal is a replay, never fresh readiness.
            if unsafe{WaitForSingleObject(healthy.0,0)}!=258||unsafe{WaitForSingleObject(idle.0,0)}!=258||unsafe{WaitForSingleObject(success_ack.0,0)}!=258{return Err("Stale supervisor channel".into());}
            Ok(Self{process,healthy,success,success_ack,exit_request,idle,snapshot})
        }
        fn verify(&self)->Result<(),String>{
            let expected=self.snapshot.helper_identity();
            if identity(&self.process,expected.pid)?!=*expected||image_path(&self.process)?!=self.snapshot.helper_path()||unsafe{WaitForSingleObject(self.process.0,0)}!=258{return Err("Supervisor evidence lost".into());}
            self.snapshot.verify_helper_image()
        }
        pub(crate) fn signal_healthy(&self)->Result<(),String>{self.verify()?;if unsafe{SetEvent(self.healthy.0)}==0{return Err("Health signal failed".into());}Ok(())}
        pub(crate) fn poll_event(&self)->Result<Option<SupervisorEvent>,String>{
            self.verify()?;
            let success=unsafe{WaitForSingleObject(self.success.0,0)};
            let exit=unsafe{WaitForSingleObject(self.exit_request.0,0)};
            if ![0,258].contains(&success)||![0,258].contains(&exit)||success==0&&exit==0{return Err("Supervisor events uncertain".into());}
            if success==0{self.snapshot.confirm_succeeded()?;self.verify()?;if unsafe{SetEvent(self.success_ack.0)}==0{return Err("Success acknowledgment failed".into());}return Ok(Some(SupervisorEvent::Success));}
            if exit==0{return Ok(Some(SupervisorEvent::ExitRequest));}Ok(None)
        }
        pub(crate) fn signal_probation_idle(&self,_proof:&crate::HealthIdleProof)->Result<(),String>{self.verify()?;if unsafe{SetEvent(self.idle.0)}==0{return Err("Probation idle signal failed".into());}Ok(())}
        pub(crate) fn signal_idle(&self,_seal:&crate::HealthExitSeal)->Result<(),String>{self.verify()?;if unsafe{SetEvent(self.idle.0)}==0{return Err("Idle signal failed".into());}Ok(())}
    }
    #[cfg(test)]mod tests {
        use super::*;
        use std::{process::{Child,Command},os::windows::io::AsRawHandle,sync::atomic::AtomicUsize};
        static NEXT:AtomicUsize=AtomicUsize::new(1);
        struct Events {nonce:String,installed:Handle,healthy:Handle}
        impl Events {fn new(installed:bool)->Self{let nonce=format!("{:016x}{:016x}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed));let make=|kind:&str,initial|{let name=wide(OsStr::new(&format!("Local\\NearlyUpdate{kind}-{nonce}")));let h=unsafe{CreateEventW(std::ptr::null(),1,initial,name.as_ptr())};assert!(!h.is_null());Handle(h)};Self{installed:make("Installed",installed as i32),healthy:make("Healthy",0),nonce}}}
        fn child(delay:u64,code:u32)->(Child,ProcessIdentity){let child=Command::new(std::env::current_exe().unwrap()).args(["update_restart::native::tests::restart_wait_helper","--exact","--ignored","--nocapture"]).env("NEARLY_RESTART_TEST_DELAY",delay.to_string()).env("NEARLY_RESTART_TEST_EXIT",code.to_string()).spawn().unwrap();let borrowed=std::mem::ManuallyDrop::new(Handle(child.as_raw_handle()));let id=identity(&borrowed,child.id()).unwrap();(child,id)}
        #[test]#[ignore]fn restart_wait_helper(){let delay=std::env::var("NEARLY_RESTART_TEST_DELAY").unwrap().parse::<u64>().unwrap();std::thread::sleep(Duration::from_millis(delay));let code=std::env::var("NEARLY_RESTART_TEST_EXIT").unwrap().parse::<i32>().unwrap();std::process::exit(code);}
        #[test]fn exact_live_process_health_and_zero_exit_produce_opaque_proof(){let events=Events::new(true);let(mut child,id)=child(350,0);let exe=std::env::current_exe().unwrap();let live=LiveInstaller::open(&events.nonce,&id,&exe).unwrap();assert!(live.wait_exit_zero(Duration::ZERO).is_err());live.signal_healthy().unwrap();assert_eq!(unsafe{WaitForSingleObject(events.healthy.0,0)},0);let proof=live.wait_exit_zero(Duration::from_secs(5)).unwrap();assert_eq!(proof.process_identity(),&id);assert_eq!(proof.nonce(),events.nonce);assert_eq!(proof.image_path(),dunce::canonicalize(exe).unwrap());assert!(child.wait().unwrap().success());}
        #[test]fn identity_image_missing_events_and_uninstalled_phase_are_rejected(){let events=Events::new(false);let(mut child,id)=child(700,0);let exe=std::env::current_exe().unwrap();assert!(LiveInstaller::open(&events.nonce,&ProcessIdentity{pid:id.pid,created:id.created+1},&exe).is_err());assert!(LiveInstaller::open(&events.nonce,&id,&exe.with_file_name("missing-installer.exe")).is_err());assert!(LiveInstaller::open(&"f".repeat(32),&id,&exe).is_err());assert!(LiveInstaller::open(&events.nonce,&id,&exe).is_err());unsafe{SetEvent(events.installed.0);SetEvent(events.healthy.0);}assert!(LiveInstaller::open(&events.nonce,&id,&exe).is_err());assert!(child.wait().unwrap().success());}
        #[test]fn timeout_and_nonzero_exit_never_produce_cleanup_authority(){for code in [0,9]{let events=Events::new(true);let(mut child,id)=child(350,code);let live=LiveInstaller::open(&events.nonce,&id,&std::env::current_exe().unwrap()).unwrap();live.signal_healthy().unwrap();assert!(live.wait_exit_zero(Duration::from_millis(1)).is_err());assert!(child.try_wait().unwrap().is_none(),"timeout must not terminate the owned fake child");let result=live.wait_exit_zero(Duration::from_secs(5));assert_eq!(result.is_ok(),code==0);let status=child.wait().unwrap();assert_eq!(status.code(),Some(code as i32));}}
        #[test]fn exited_process_cannot_be_reopened_as_live_proof(){let events=Events::new(true);let(mut child,id)=child(0,0);child.wait().unwrap();assert!(LiveInstaller::open(&events.nonce,&id,&std::env::current_exe().unwrap()).is_err());}
    }
}
#[cfg(test)]mod tests{use super::*;#[test]fn restart_nonce_is_strict_lowercase_128_bit(){for nonce in ["", "abc", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "0123456789abcdef0123456789abcdeg"]{assert!(!valid_nonce(nonce));}assert!(valid_nonce("0123456789abcdef0123456789abcdef"));}}
