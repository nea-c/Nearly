//! Opt-in deterministic barriers for generated Engine watcher tests only.
use std::{collections::HashMap,path::{Path,PathBuf},sync::{Arc,Mutex,OnceLock,atomic::{AtomicU64,Ordering}}};
static PROBES:OnceLock<Mutex<HashMap<PathBuf,Arc<AtomicU64>>>>=OnceLock::new();
pub(crate) struct Probe{root:PathBuf,count:Arc<AtomicU64>}
pub(crate) fn register(root:PathBuf)->Probe{
    let count=Arc::new(AtomicU64::new(0));PROBES.get_or_init(Default::default).lock().unwrap().insert(root.clone(),count.clone());Probe{root,count}
}
impl Probe{pub(crate) fn count(&self)->u64{self.count.load(Ordering::SeqCst)}}
impl Drop for Probe{fn drop(&mut self){if let Some(probes)=PROBES.get(){probes.lock().unwrap().remove(&self.root);}}}
pub(super) fn observed(path:&Path){if let Some(probes)=PROBES.get(){for(root,count)in probes.lock().unwrap().iter(){if path.starts_with(root){count.fetch_add(1,Ordering::SeqCst);}}}}
