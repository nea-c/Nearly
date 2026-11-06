//! Generated-only, test-only coarse stages; never shipping instrumentation.
use std::{sync::{Mutex,OnceLock,atomic::{AtomicBool,Ordering}},time::Instant};
static ON:AtomicBool=AtomicBool::new(false);static DATA:OnceLock<Mutex<(Instant,Vec<serde_json::Value>)>>=OnceLock::new();
fn data()->&'static Mutex<(Instant,Vec<serde_json::Value>)>{DATA.get_or_init(||Mutex::new((Instant::now(),Vec::new())))}
pub(crate) fn start(t:Instant){*data().lock().unwrap()=(t,Vec::new());ON.store(true,Ordering::SeqCst);}
pub(crate) struct Span{label:&'static str,begin:u64,active:bool}
pub(crate) fn span(label:&'static str)->Span{let active=ON.load(Ordering::Relaxed);let begin=if active{data().lock().unwrap().0.elapsed().as_micros()as u64}else{0};Span{label,begin,active}}
impl Drop for Span{fn drop(&mut self){if self.active{let mut d=data().lock().unwrap();let end=d.0.elapsed().as_micros()as u64;d.1.push(serde_json::json!({"stage":self.label,"beginUs":self.begin,"endUs":end,"elapsedUs":end-self.begin}));}}}
pub(crate) fn finish()->Vec<serde_json::Value>{ON.store(false,Ordering::SeqCst);data().lock().unwrap().1.clone()}
