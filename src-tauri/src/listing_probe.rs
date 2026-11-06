//! Opt-in test-only completion/observer calibration. Never compiled into shipping code.
use std::{sync::{atomic::{AtomicBool,AtomicUsize,Ordering},Condvar,Mutex,OnceLock},time::{Duration,Instant}};
use serde::Serialize;
const JOB:&str="generated-engine";
static ENABLED:AtomicBool=AtomicBool::new(false);
static KIND:AtomicUsize=AtomicUsize::new(0);
static DATA:OnceLock<(Mutex<State>,Condvar)>=OnceLock::new();
#[derive(Clone,Copy,Serialize)]pub(crate) struct Cpu{pub user_100ns:u64,pub kernel_100ns:u64}
#[cfg(windows)]#[repr(C)]#[derive(Default)]struct Ft{lo:u32,hi:u32}
#[cfg(windows)]#[link(name="kernel32")]unsafe extern "system"{fn GetCurrentThread()->*mut std::ffi::c_void;fn GetCurrentProcess()->*mut std::ffi::c_void;fn GetThreadTimes(h:*mut std::ffi::c_void,c:*mut Ft,e:*mut Ft,k:*mut Ft,u:*mut Ft)->i32;fn GetProcessTimes(h:*mut std::ffi::c_void,c:*mut Ft,e:*mut Ft,k:*mut Ft,u:*mut Ft)->i32;}
fn cpu(thread:bool)->Result<Cpu,String>{
 #[cfg(windows)]{let(mut c,mut e,mut k,mut u)=(Ft::default(),Ft::default(),Ft::default(),Ft::default());let ok=unsafe{if thread{GetThreadTimes(GetCurrentThread(),&mut c,&mut e,&mut k,&mut u)}else{GetProcessTimes(GetCurrentProcess(),&mut c,&mut e,&mut k,&mut u)}};if ok==0{return Err("Self CPU query failed".into())}let ticks=|v:Ft|(u64::from(v.hi)<<32)|u64::from(v.lo);Ok(Cpu{user_100ns:ticks(u),kernel_100ns:ticks(k)})}
 #[cfg(not(windows))]{let _=thread;Err("CPU probe qualified only on Windows".into())}
}
pub(crate) fn thread_cpu()->Result<Cpu,String>{cpu(true)}
#[derive(Clone,Debug,Serialize)]#[serde(tag="kind",rename_all="snake_case")]
pub(crate) enum Event{CaughtUp{elapsed_ns:u64,sent:u64},CountMismatch{elapsed_ns:u64,sent:u64,expected:u64},IncompleteExit{elapsed_ns:u64}}
impl Event{pub(crate) fn caught_ns(&self)->Option<u64>{if let Self::CaughtUp{elapsed_ns,..}=self{Some(*elapsed_ns)}else{None}}}
struct State{generation:u64,start:Instant,expected:u64,event:Option<Event>,markers:u64,workers_started:u64,workers_exited:u64,process_start:Result<Cpu,String>,process_at_completion:Option<Result<Cpu,String>>,worker_start:Option<Result<Cpu,String>>,worker_at_completion:Option<Result<Cpu,String>>}
impl State{fn new(generation:u64,expected:u64)->Self{Self{generation,start:Instant::now(),expected,event:None,markers:0,workers_started:0,workers_exited:0,process_start:cpu(false),process_at_completion:None,worker_start:None,worker_at_completion:None}}}
fn data()->&'static(Mutex<State>,Condvar){DATA.get_or_init(||(Mutex::new(State::new(0,0)),Condvar::new()))}
pub(crate) struct Run{pub start:Instant,generation:u64}
pub(crate) fn arm(expected:u64)->Run{let mut s=data().0.lock().unwrap();let generation=s.generation.checked_add(1).unwrap();*s=State::new(generation,expected);KIND.store(0,Ordering::SeqCst);ENABLED.store(true,Ordering::SeqCst);Run{start:s.start,generation}}
impl Run{
 pub(crate) fn wait(&self,timeout:Duration)->Result<Event,String>{let started=Instant::now();let mut s=data().0.lock().unwrap();loop{if s.generation!=self.generation{return Err("Stale diagnostic generation".into())}if let Some(e)=&s.event{return Ok(e.clone())}let left=timeout.checked_sub(started.elapsed()).ok_or("Diagnostic completion wait timed out")?;let(next,result)=data().1.wait_timeout(s,left).unwrap();s=next;if result.timed_out()&&s.event.is_none(){return Err("Diagnostic completion wait timed out".into())}}}
 pub(crate) fn failed(&self)->bool{KIND.load(Ordering::SeqCst)>=2}
 pub(crate) fn finish(&self)->serde_json::Value{let s=data().0.lock().unwrap();assert_eq!(s.generation,self.generation);ENABLED.store(false,Ordering::SeqCst);serde_json::json!({"generation":s.generation,"event":s.event,"markers":s.markers,"expected":s.expected,"workers_started":s.workers_started,"workers_exited":s.workers_exited,"process_cpu_start":s.process_start,"process_cpu_at_completion":s.process_at_completion,"worker_cpu_start":s.worker_start,"worker_cpu_at_completion":s.worker_at_completion,"scope":"Test-only one-worker marker at existing caught_up transition; own process/thread CPU, not a wall-time partition"})}
}
pub(crate) struct Worker{active:bool,generation:u64}
pub(crate) fn worker(job:&str)->Worker{if !ENABLED.load(Ordering::SeqCst)||job!=JOB{return Worker{active:false,generation:0}}let mut s=data().0.lock().unwrap();s.workers_started+=1;s.worker_start=Some(cpu(true));Worker{active:true,generation:s.generation}}
impl Worker{pub(crate) fn observe(&self,phase:crate::taskbar_status::NativeSyncState,sent:u64){if !self.active||phase!=crate::taskbar_status::NativeSyncState::CaughtUp||!ENABLED.load(Ordering::SeqCst)||KIND.load(Ordering::SeqCst)!=0{return}let mut s=data().0.lock().unwrap();if s.generation!=self.generation||s.event.is_some(){return}let ns=s.start.elapsed().as_nanos()as u64;s.process_at_completion=Some(cpu(false));s.worker_at_completion=Some(cpu(true));s.markers+=1;let kind;if sent==s.expected{s.event=Some(Event::CaughtUp{elapsed_ns:ns,sent});kind=1}else{s.event=Some(Event::CountMismatch{elapsed_ns:ns,sent,expected:s.expected});kind=2}KIND.store(kind,Ordering::SeqCst);data().1.notify_all();}}
impl Drop for Worker{fn drop(&mut self){if !self.active||!ENABLED.load(Ordering::SeqCst){return}let mut s=data().0.lock().unwrap();if s.generation!=self.generation{return}s.workers_exited+=1;if s.event.is_none(){s.event=Some(Event::IncompleteExit{elapsed_ns:s.start.elapsed().as_nanos()as u64});KIND.store(3,Ordering::SeqCst);data().1.notify_all();}}}
#[cfg(test)]mod tests{use super::*;use crate::taskbar_status::NativeSyncState::*;#[test]fn observer_probe_calibration(){
 let r=arm(2);{let w=worker("wrong-job");w.observe(CaughtUp,2);}assert!(!r.failed());assert!(r.wait(Duration::from_millis(1)).is_err());
 let t=std::thread::spawn(||{let w=worker(JOB);w.observe(Working,2);std::thread::sleep(Duration::from_millis(40));w.observe(CaughtUp,2);w.observe(CaughtUp,2);});let e=r.wait(Duration::from_secs(1)).unwrap();assert!(e.caught_ns().unwrap()>=30_000_000);t.join().unwrap();let report=r.finish();assert_eq!(report["markers"],1);assert_eq!(report["workers_started"],1);assert_eq!(report["workers_exited"],1);
 let r=arm(2);{let w=worker(JOB);w.observe(CaughtUp,1);}assert!(r.failed());assert!(r.wait(Duration::from_secs(1)).unwrap().caught_ns().is_none());r.finish();
 let r=arm(2);drop(worker(JOB));assert!(r.failed());assert!(matches!(r.wait(Duration::from_secs(1)).unwrap(),Event::IncompleteExit{..}));r.finish();
 let _old=arm(2);let old_worker=worker(JOB);let r=arm(2);old_worker.observe(CaughtUp,2);drop(old_worker);assert!(r.wait(Duration::from_millis(1)).is_err());{let w=worker(JOB);w.observe(CaughtUp,2);}assert!(r.wait(Duration::from_secs(1)).unwrap().caught_ns().is_some());let p=r.finish();assert_eq!(p["workers_started"],1);assert_eq!(p["workers_exited"],1);#[cfg(windows)]{for k in["process_cpu_start","process_cpu_at_completion","worker_cpu_start","worker_cpu_at_completion"]{assert!(p[k].get("Ok").is_some())}assert!(thread_cpu().is_ok());}
}}
