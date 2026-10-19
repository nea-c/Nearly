//! Native ownership is independent of renderers and never contains credentials.
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Job { pub id:String, pub workspace_id:String, pub job:Option<Value>, #[serde(skip)] stopped:bool }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Transfer { pub token:String, pub workspace_id:String, pub source_label:String, pub target_label:String, pub phase:String, pub payload:Value, pub target_kind:String, pub target_index:Option<usize>, pub before_id:Option<String> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Bootstrap { pub label:String, pub owned_workspace_ids:Vec<String>, pub pending_transfer:Option<Transfer>, pub jobs:Vec<Job>, pub workspaces:Vec<Value>, pub outgoing_transfers:Vec<Transfer>, pub fresh_process:bool }
#[derive(Default)]
pub struct Registry {
    windows:HashSet<String>, closing:HashSet<String>, owners:HashMap<String,String>,
    jobs:HashMap<String,Job>, provisional:HashMap<String,String>,
    pub operations:HashMap<String,String>, pub probes:HashMap<String,String>,
    pub active_operations:HashSet<String>,
    pub cancelled_preparations:HashMap<String,String>,
    pub watches:HashMap<String,String>, transfers:HashMap<String,Transfer>,
    spawns:HashSet<String>,
    shutting_down:bool,
    update_pending:bool,
    update_sealed:bool,
    main_bootstrapped:bool,
    health_probation:bool,
    health_exit_sealed:bool,
}
fn identifier(id:&str)->Result<(),String>{if id.is_empty()||id.len()>128||!id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_'){Err("Invalid workspace identifier".into())}else{Ok(())}}
impl Registry {
    fn update_idle(&self)->Result<(),String>{if self.health_probation||self.health_exit_sealed||self.shutting_down||self.update_pending||self.update_sealed{Err("Application update is in progress".into())}else{Ok(())}}
    /// Only native startup and authenticated supervisor completion call these.
    pub(crate) fn enter_health_probation(&mut self){self.health_probation=true;}
    pub(crate) fn release_health_probation(&mut self)->Result<(),String>{if !self.health_probation||self.health_exit_sealed{return Err("Health probation cannot be released".into());}self.health_probation=false;Ok(())}
    /// Seal and check under the ownership lock used by admissions. Refusal
    /// preserves the app and leaves admissions sealed for manual repair.
    pub(crate) fn seal_health_exit(&mut self)->Result<Vec<String>,String>{
        if !self.health_probation||self.health_exit_sealed{return Err("No probation exit is available".into());}
        self.health_exit_sealed=true;
        self.health_work_idle()
    }
    pub(crate) fn attest_health_idle(&self)->Result<Vec<String>,String>{
        if !self.health_probation||self.health_exit_sealed{return Err("No live probation admission fence".into());}
        self.health_work_idle()
    }
    fn health_work_idle(&self)->Result<Vec<String>,String>{
        if !self.owners.is_empty()||!self.closing.is_empty()||!self.spawns.is_empty()||!self.operations.is_empty()||!self.probes.is_empty()||!self.active_operations.is_empty()||!self.provisional.is_empty()||self.jobs.values().any(|j|j.job.is_some())||self.transfers.values().any(|t|t.phase=="pending"||t.phase=="dragging"){
            return Err("User work detected; automatic health shutdown refused".into());
        }
        Ok(self.window_labels())
    }
    pub fn begin_update(&mut self)->Result<Vec<String>,String>{
        self.update_idle()?;
        if self.shutting_down||!self.closing.is_empty()||!self.spawns.is_empty()||!self.operations.is_empty()||!self.active_operations.is_empty()||!self.provisional.is_empty()||self.jobs.values().any(|j|j.job.is_some())||self.transfers.values().any(|t|t.phase=="pending"||t.phase=="dragging"){
            return Err("Finish active work before updating".into());
        }
        self.update_pending=true;
        Ok(self.window_labels())
    }
    pub fn update_owned_ids(&self)->Vec<String>{let mut ids:Vec<_>=self.owners.keys().cloned().collect();ids.sort();ids}
    pub fn window_labels(&self)->Vec<String>{let mut labels:Vec<_>=self.windows.iter().cloned().collect();labels.sort();labels}
    pub fn seal_update(&mut self)->Result<(),String>{if !self.update_pending||self.update_sealed{return Err("Application update is not awaiting settlement".into());}self.update_sealed=true;Ok(())}
    pub fn cancel_update(&mut self){self.update_pending=false;self.update_sealed=false;}
    pub fn register_native_window(&mut self,label:&str)->Result<(),String>{self.update_idle()?;if self.shutting_down||self.closing.contains(label){return Err("Window is closing".into());}if !self.windows.contains(label)&&self.windows.len()>=32{return Err("Window limit reached".into());}self.windows.insert(label.into());Ok(())}
    pub fn bootstrap(&mut self,label:&str)->Result<Bootstrap,String>{
        if !(self.health_probation&&!self.health_exit_sealed&&label=="main"&&self.windows.contains(label)){self.register_native_window(label)?;}
        let fresh_process=label=="main"&&!self.main_bootstrapped;
        if label=="main"{self.main_bootstrapped=true;}
        self.windows.insert(label.into());
        Ok(Bootstrap{fresh_process,outgoing_transfers:self.transfers.values().filter(|t|t.source_label==label&&(t.phase=="pending"||t.phase=="dragging")).cloned().collect(),workspaces:Vec::new(),label:label.into(),owned_workspace_ids:self.owned(label),pending_transfer:self.transfers.values().find(|t|t.target_label==label&&(t.phase=="pending"||t.phase=="dragging")).cloned(),jobs:self.jobs.values().filter(|j|self.owners.get(&j.workspace_id).is_some_and(|o|o==label)).cloned().collect()})
    }
    pub fn settings_registered(&self,label:&str)->Result<(),String>{if self.update_sealed||self.health_exit_sealed{return Err("Application update is sealed".into());}if self.windows.contains(label)&&!self.closing.contains(label){Ok(())}else{Err("Window is not registered or is closing".into())}}
    pub fn registered(&self,label:&str)->Result<(),String>{self.update_idle()?;self.settings_registered(label)}
    pub fn settings_mutable(&self,label:&str)->Result<(),String>{if self.health_probation||self.health_exit_sealed||self.shutting_down{return Err("Health probation blocks settings edits".into());}self.settings_registered(label)?;if self.transfers.values().any(|t|t.target_label==label&&t.target_kind=="new"&&(t.phase=="dragging"||t.phase=="pending")){return Err("Detached preview cannot change settings before transfer commit".into());}Ok(())}
    pub fn claim(&mut self,label:&str,id:&str)->Result<(),String>{self.registered(label)?;identifier(id)?;match self.owners.get(id){Some(o) if o==label=>Ok(()),Some(_)=>Err("Workspace belongs to another window".into()),None=>{if self.pending(label){return Err("Incoming window must wait for transfer commit".into());}if self.owners.len()>=128{return Err("Workspace limit reached".into());}self.owners.insert(id.into(),label.into());Ok(())}}}
    pub fn owner(&self,label:&str,id:&str)->Result<(),String>{self.registered(label)?;if self.owners.get(id).is_some_and(|o|o==label){Ok(())}else{Err("Workspace belongs to another window".into())}}
    pub fn mutable(&self,label:&str,id:&str)->Result<(),String>{self.owner(label,id)?;if self.pending(label){Err("Workspace transfer is pending".into())}else{Ok(())}}
    pub fn owned(&self,label:&str)->Vec<String>{self.owners.iter().filter(|(_,o)|o.as_str()==label).map(|(id,_)|id.clone()).collect()}
    pub fn has_stopped_sync(&self,label:&str)->bool{self.jobs.values().any(|j|j.stopped&&self.owners.get(&j.workspace_id).is_some_and(|owner|owner==label))}
    pub fn job_ids(&self,label:&str)->Vec<String>{self.jobs.values().filter(|j|self.owners.get(&j.workspace_id).is_some_and(|o|o==label)).map(|j|j.id.clone()).chain(self.provisional.iter().filter(|(_,o)|o.as_str()==label).map(|(id,_)|id.clone())).collect()}
    pub fn prepare_job(&mut self,label:&str,id:&str,workspace:Option<&str>)->Result<(),String>{self.registered(label)?;if self.pending(label){return Err("Window transfer is pending".into());}identifier(id)?;if let Some(w)=workspace{self.mutable(label,w)?;self.jobs.retain(|old,j|old==id||j.workspace_id!=w||j.job.is_some());}if self.jobs.len()+self.provisional.len()>=256&&!self.jobs.contains_key(id)&&!self.provisional.contains_key(id){return Err("Job descriptor limit reached".into());}if self.jobs.contains_key(id)||self.provisional.contains_key(id){self.job_owner(label,id)?;return Ok(());}if let Some(w)=workspace{self.mutable(label,w)?;self.jobs.insert(id.into(),Job{id:id.into(),workspace_id:w.into(),job:None,stopped:false});}else{self.provisional.insert(id.into(),label.into());}Ok(())}
    pub fn finish_job(&mut self,id:&str){if let Some(j)=self.jobs.get_mut(id){j.stopped|=j.job.is_some();j.job=None;}self.provisional.remove(id);}
    pub fn describe_job(&mut self,id:&str,job:Value){if let Some(j)=self.jobs.get_mut(id){j.stopped=false;j.job=Some(job);}}
    pub fn bind_job(&mut self,label:&str,id:&str,workspace:&str)->Result<(),String>{self.mutable(label,workspace)?;self.job_owner(label,id)?;self.jobs.retain(|old,j|old==id||j.workspace_id!=workspace||j.job.is_some());self.provisional.remove(id);self.jobs.insert(id.into(),Job{id:id.into(),workspace_id:workspace.into(),job:None,stopped:false});Ok(())}
    pub fn job_mutable(&self,label:&str,id:&str)->Result<(),String>{self.job_owner(label,id)?;if let Some(job)=self.jobs.get(id){self.mutable(label,&job.workspace_id)}else if self.pending(label){Err("Window transfer is pending".into())}else{Ok(())}}
    pub fn job_owner(&self,label:&str,id:&str)->Result<(),String>{self.registered(label)?;if let Some(j)=self.jobs.get(id){self.owner(label,&j.workspace_id)}else if self.provisional.get(id).is_some_and(|o|o==label){Ok(())}else{Err("Job belongs to another window".into())}}
    pub fn scoped(map:&mut HashMap<String,String>,label:&str,id:&str,create:bool)->Result<(),String>{identifier(id)?;match map.get(id){Some(o)if o==label=>Ok(()),Some(_)=>Err("Request belongs to another window".into()),None if create=>{map.insert(id.into(),label.into());Ok(())},_=>Err("Unknown request".into())}}
    pub fn begin(&mut self,label:&str,id:&str,payload:Value)->Result<Transfer,String>{
        self.mutable(label,id)?;validate_payload(&payload,id)?;
        let jobs:Vec<_>=self.jobs.values().filter(|j|j.workspace_id==id).filter(|j|j.job.is_some()).collect();
        let supplied=payload.get("job").filter(|j|!j.is_null()).and_then(|j|j.get("id")).and_then(Value::as_str);
        match (jobs.as_slice(),supplied){([],None)=>(),([],Some(job))if self.jobs.get(job).is_some_and(|j|j.workspace_id==id)=>(),([job],Some(id))if job.id==id=>(),_=>return Err("Transfer must include the workspace's exact native job".into())}
        if let Some(job)=jobs.first().and_then(|j|j.job.as_ref()) {let incoming=&payload["job"];for key in ["profile","local","remote"]{if incoming.get(key)!=job.get(key){return Err("Transfer job differs from the native runtime descriptor".into());}}for (key,default) in [("exclusionRules",Value::String(String::new())),("deleteRemoved",Value::Bool(false)),("recursive",Value::Bool(true))]{if incoming.get(key).unwrap_or(&default)!=job.get(key).unwrap_or(&default){return Err("Transfer options differ from the native runtime descriptor".into());}}}
        if self.transfers.len()>=64 {if let Some(key)=self.transfers.iter().find(|(_,t)|t.phase!="pending"&&t.phase!="dragging").map(|(k,_)|k.clone()){self.transfers.remove(&key);}else{return Err("Transfer history is busy".into());}}
        if self.operations.values().any(|o|o==label){return Err("Finish file operations or host verification before moving".into());}
        if self.transfers.values().filter(|t|t.phase=="pending"||t.phase=="dragging").count()>=16{return Err("Too many pending transfers".into());}
        let mut bytes=[0u8;24];getrandom::fill(&mut bytes).map_err(|_|"Transfer entropy unavailable")?;
        let token=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        let t=Transfer{target_label:format!("workspace-{}",&token[..24]),token:token.clone(),workspace_id:id.into(),source_label:label.into(),phase:"pending".into(),payload,target_kind:"new".into(),target_index:None,before_id:None};
        self.transfers.insert(token,t.clone());Ok(t)
    }
    pub fn status(&self,label:&str,token:&str)->Result<Transfer,String>{let t=self.transfers.get(token).ok_or("Unknown transfer")?;if t.source_label!=label&&t.target_label!=label{return Err("Transfer belongs to another window".into());}Ok(t.clone())}
    pub fn reserve_spawn(&mut self,label:&str)->Result<(),String>{self.update_idle()?;if self.shutting_down{return Err("Application is shutting down".into());}if self.windows.len()+self.spawns.len()>=32{return Err("Window limit reached".into());}if !self.spawns.insert(label.into()){return Err("Window creation already reserved".into());}Ok(())}
    pub fn finish_spawn(&mut self,label:&str){self.spawns.remove(label);}
    pub fn seal_shutdown_if_idle(&mut self)->bool{if self.windows.is_empty()&&self.spawns.is_empty(){self.shutting_down=true;true}else{false}}
    pub fn begin_drag(&mut self,label:&str,id:&str,payload:Value)->Result<Transfer,String>{if self.transfers.values().any(|t|t.phase=="dragging"){return Err("Another tab drag is active".into());}let mut t=self.begin(label,id,payload)?;t.phase="dragging".into();self.transfers.insert(t.token.clone(),t.clone());Ok(t)}
    pub fn preview_drag(&self,label:&str,token:&str)->Result<Transfer,String>{let t=self.status(label,token)?;self.owner(label,&t.workspace_id)?;if t.source_label!=label||t.phase!="dragging"||t.target_kind!="new"||self.owned(label).len()<=1{return Err("Only a multi-tab native drag can create a detached preview".into());}Ok(t)}
    pub fn preview_for_window(&self,label:&str)->Option<Transfer>{self.transfers.values().find(|t|t.target_label==label&&t.target_kind=="new"&&t.phase=="dragging").cloned()}
    pub fn activate_drag(&mut self,label:&str,token:&str,target:Option<(&str,usize,Option<String>)>)->Result<Transfer,String>{let old=self.status(label,token)?;self.owner(label,&old.workspace_id)?;if old.source_label!=label||old.phase!="dragging"{return Err("Drag is no longer active".into());}if target.is_none()&&self.owned(label).len()<=1{return Err("A single tab moves its existing window".into());}if let Some((target,_,ref before))=target{self.registered(target)?;if target==label||self.pending(target)||self.operations.values().any(|o|o==target){return Err("Target window is busy".into());}if let Some(before)=before{self.owner(target,before)?;}}let t=self.transfers.get_mut(token).unwrap();t.phase="pending".into();if let Some((target,index,before))=target{t.target_label=target.into();t.target_kind="existing".into();t.target_index=Some(index);t.before_id=before;}Ok(t.clone())}
    pub fn commit(&mut self,label:&str,token:&str)->Result<Transfer,String>{self.registered(label)?;let t=self.status(label,token)?;if t.target_label!=label{return Err("Only the incoming window can commit".into());}if t.phase!="pending"{return Err("Transfer is no longer pending".into());}self.owner(&t.source_label,&t.workspace_id)?;self.owners.insert(t.workspace_id.clone(),label.into());let t=self.transfers.get_mut(token).unwrap();t.phase="committed".into();Ok(t.clone())}
    pub fn abort(&mut self,label:&str,token:&str)->Result<Transfer,String>{let t=self.status(label,token)?;if t.phase!="pending"&&t.phase!="dragging"{return Err("Transfer is no longer pending".into());}let t=self.transfers.get_mut(token).unwrap();t.phase="aborted".into();Ok(t.clone())}
    pub fn pending(&self,label:&str)->bool{self.transfers.values().any(|t|(t.phase=="pending"||t.phase=="dragging")&&(t.source_label==label||t.target_label==label))}
    pub fn seal_close(&mut self,label:&str)->Result<Vec<String>,String>{self.registered(label)?;if self.pending(label)||self.operations.values().any(|o|o==label){return Err("This window has a transfer or operation in progress".into());}self.closing.insert(label.into());Ok(self.owned(label))}
    pub fn seal_empty_close(&mut self,label:&str)->Result<Vec<String>,String>{self.registered(label)?;if !self.owned(label).is_empty(){return Err("This window still owns tabs".into());}self.seal_close(label)}
    pub fn unseal(&mut self,label:&str){self.closing.remove(label);}
    pub fn release(&mut self,label:&str,id:&str)->Result<(),String>{self.mutable(label,id)?;self.jobs.retain(|_,j|j.workspace_id!=id);self.owners.remove(id);if self.watches.get(label).is_some_and(|w|w==id){self.watches.remove(label);}Ok(())}
    pub fn workspace_job_ids(&self,id:&str)->Vec<String>{self.jobs.values().filter(|j|j.workspace_id==id).map(|j|j.id.clone()).collect()}
    pub fn closed(&mut self,label:&str){let owned=self.owned(label);self.windows.remove(label);self.closing.remove(label);self.jobs.retain(|_,j|!owned.contains(&j.workspace_id));self.provisional.retain(|_,o|o!=label);self.probes.retain(|_,o|o!=label);self.operations.retain(|_,o|o!=label);self.owners.retain(|_,o|o!=label);self.watches.remove(label);}
}
// Explicit structural allowlists reject credentials and arbitrary nested payloads.
fn object<'a>(v:&'a Value,keys:&[&str])->Result<&'a serde_json::Map<String,Value>,String>{let m=v.as_object().ok_or("Transfer object required")?;if m.keys().any(|k|!keys.contains(&k.as_str())){return Err("Unknown transfer field".into());}Ok(m)}
pub fn validate_payload(v:&Value,id:&str)->Result<(),String>{
    if serde_json::to_vec(v).map_err(|_|"Invalid transfer")?.len()>2*1024*1024{return Err("Transfer exceeds 2 MiB; refresh large directories before moving".into());}
    let root=object(v,&["version","workspace","job","viewState"])?;if root.get("version").and_then(Value::as_u64)!=Some(1){return Err("Unsupported transfer version".into());}
    let w=object(root.get("workspace").ok_or("Workspace required")?,&["id","profileId","localBrowse","remoteBrowse","connection","logsOpen","entries"])?;
    if w.get("id").and_then(Value::as_str)!=Some(id){return Err("Transfer workspace mismatch".into());}
    if let Some(view)=root.get("viewState"){validate_view_state(view,w)?;}
    let profile_keys=["id","name","host","port","user","auth","mode","keyFile","hostKey"];
    if let Some(p)=w.get("connection").filter(|v|!v.is_null()){object(p,&profile_keys)?;serde_json::from_value::<crate::sftp::Profile>(p.clone()).map_err(|_|"Invalid transfer profile")?;}
    if let Some(entries)=w.get("entries"){let entries=object(entries,&["local","remote"])?;let mut count=0;for list in entries.values(){let list=list.as_array().ok_or("Invalid transfer entries")?;count+=list.len();for e in list{object(e,&["name","hidden","dir","size","modifiedAt","permissions","owner"])?;serde_json::from_value::<crate::sftp::Entry>(e.clone()).map_err(|_|"Invalid transfer entry")?;}}if count>20000{return Err("Transfer exceeds 20000 entries".into());}}
    if let Some(job)=root.get("job").filter(|v|!v.is_null()){
        let j=object(job,&["id","retainedId","profile","local","remote","status","pending","sent","speed","latency","errorCount","exclusionRules","deleteRemoved","recursive","logs"])?;
        let p=j.get("profile").ok_or("Job profile required")?;object(p,&profile_keys)?;serde_json::from_value::<crate::sftp::Profile>(p.clone()).map_err(|_|"Invalid job profile")?;
        let logs=j.get("logs").and_then(Value::as_array).ok_or("Job logs required")?;if logs.len()>100||logs.iter().any(|v|v.as_str().is_none_or(|s|s.len()>16384)){return Err("Transfer log limit exceeded".into());}
        for key in ["id","local","remote","status"]{if j.get(key).and_then(Value::as_str).is_none(){return Err("Missing job string field".into());}}
        for (key,value) in j{match key.as_str(){"profile"|"logs"=>(),"pending"|"sent"|"speed"|"latency"|"errorCount"=>if value.as_f64().is_none_or(|n|!n.is_finite()||n<0.0){return Err("Invalid job metric".into());},"deleteRemoved"|"recursive"=>if !value.is_boolean(){return Err("Invalid job flag".into());},_=>if value.as_str().is_none_or(|s|s.len()>65536){return Err("Invalid job string".into());}}}
    }
    // Primitive fields cannot smuggle arbitrarily structured credential objects.
    for (k,value) in w{if !["connection","entries"].contains(&k.as_str())&&!value.is_string()&&!value.is_boolean()&&!value.is_null(){return Err("Invalid workspace field type".into());}}
    Ok(())
}
fn bounded_string(value:&Value,limit:usize)->Result<&str,String>{let s=value.as_str().ok_or("Invalid view state string")?;if s.chars().count()>limit||s.contains('\0'){return Err("View state string exceeds limit".into());}Ok(s)}
fn required<'a>(m:&'a serde_json::Map<String,Value>,key:&str)->Result<&'a Value,String>{m.get(key).ok_or_else(||format!("Missing view state {key}"))}
fn path_string(value:&Value,local:bool,pc:bool)->Result<String,String>{let s=bounded_string(value,4096)?;if pc&&local&&s=="@pc"{return Ok(s.into());}if s.is_empty()||s.chars().any(|c|c<' '){return Err("Invalid view state path".into());}if local{let p=s.trim().replace('/',"\\");let bytes=p.as_bytes();if bytes.len()<3||!bytes[0].is_ascii_alphabetic()||bytes[1]!=b':'||bytes[2]!=b'\\'{return Err("Local view state path must be absolute".into());}Ok(p.trim_end_matches('\\').to_ascii_lowercase())}else{if !s.starts_with('/'){return Err("Remote view state path must be absolute".into());}Ok(s.trim_end_matches('/').to_owned())}}
fn validate_view_state(v:&Value,w:&serde_json::Map<String,Value>)->Result<(),String>{
    let view=object(v,&["selection","navigation","trees"])?;
    let selection=object(required(view,"selection")?,&["local","remote"])?;let navigation=object(required(view,"navigation")?,&["local","remote"])?;let trees=object(required(view,"trees")?,&["local","remote"])?;
    for side in ["local","remote"]{let local=side=="local";let current=required(w,if local{"localBrowse"}else{"remoteBrowse"})?;let _=path_string(current,local,false)?;
        let selected=object(required(selection,side)?,&["selected","focus","anchor"])?;let names=required(selected,"selected")?.as_array().ok_or("Invalid selection")?;if names.len()>20000{return Err("Selection limit exceeded".into());}
        let entries=w.get("entries").and_then(|e|e.get(side)).and_then(Value::as_array).ok_or("Selection requires entries")?;let available:HashSet<_>=entries.iter().filter_map(|e|e.get("name").and_then(Value::as_str)).collect();let mut unique=HashSet::new();
        for name in names{let name=bounded_string(name,4096)?;if name.is_empty()||!available.contains(name)||!unique.insert(name){return Err("Invalid selected entry".into());}}
        for key in ["focus","anchor"]{if let Some(value)=selected.get(key){let s=bounded_string(value,4096)?;if (key=="anchor"&&s.is_empty())||(!s.is_empty()&&!available.contains(s)){return Err("Invalid selection focus".into());}}else if key=="focus"{return Err("Selection focus required".into());}}
        let nav=object(required(navigation,side)?,&["paths","cursor"])?;let paths=required(nav,"paths")?.as_array().ok_or("Invalid navigation")?;if paths.len()>64{return Err("Navigation limit exceeded".into());}for p in paths{let _=path_string(p,local,false)?;}
        let cursor=required(nav,"cursor")?.as_i64().ok_or("Invalid navigation cursor")?;if cursor< -1||cursor>=paths.len() as i64||(!paths.is_empty()&&cursor<0)||(!paths.is_empty()&&paths[cursor as usize]!=*current){return Err("Invalid navigation cursor".into());}
        let tree=object(required(trees,side)?,&["root","key","expanded"])?;let root=path_string(required(tree,"root")?,local,true)?;bounded_string(required(tree,"key")?,32768)?;let expanded=required(tree,"expanded")?.as_array().ok_or("Invalid expanded tree")?;if expanded.len()>256{return Err("Tree expansion limit exceeded".into());}
        let mut expanded_keys=HashSet::new();let mut ancestors=HashSet::new();ancestors.insert(root);for p in expanded.iter().chain(std::iter::once(current)){let p=path_string(p,local,true)?;let mut path=p.clone();while !path.is_empty(){ancestors.insert(path.clone());if ancestors.len()>256{return Err("Tree node limit exceeded".into());}let separator=if local{'\\'}else{'/'};let Some(index)=path.rfind(separator)else{break;};path.truncate(index);}}
        for p in expanded{if !expanded_keys.insert(path_string(p,local,true)?){return Err("Duplicate expanded tree path".into());}}
    }Ok(())
}
#[cfg(test)] mod tests{
use super::*;
fn setup()->Registry{let mut r=Registry::default();r.bootstrap("main").unwrap();r.bootstrap("other").unwrap();r.claim("main","tab").unwrap();r}
fn payload()->Value{serde_json::json!({"version":1,"workspace":{"id":"tab"}})}
#[test]fn stopped_badge_is_window_scoped_survives_transfer_and_clears_with_its_workspace(){
 let mut r=setup();assert!(!r.has_stopped_sync("main"));
 r.prepare_job("main","job",Some("tab")).unwrap();r.finish_job("job");assert!(!r.has_stopped_sync("main"),"cancelled preparation is not a stopped sync");
 r.describe_job("job",serde_json::json!({"id":"job"}));r.finish_job("job");assert!(r.has_stopped_sync("main"));assert!(!r.has_stopped_sync("other"));
 let wire=serde_json::to_value(r.bootstrap("main").unwrap()).unwrap();assert_eq!(wire["jobs"][0],serde_json::json!({"id":"job","workspaceId":"tab","job":null}));
 let t=r.begin("main","tab",payload()).unwrap();r.bootstrap(&t.target_label).unwrap();r.commit(&t.target_label,&t.token).unwrap();
 assert!(!r.has_stopped_sync("main"));assert!(r.has_stopped_sync(&t.target_label));
 r.describe_job("job",serde_json::json!({"id":"job"}));assert!(!r.has_stopped_sync(&t.target_label),"resumed live sync clears pause artwork");r.finish_job("job");assert!(r.has_stopped_sync(&t.target_label));
 r.release(&t.target_label,"tab").unwrap();assert!(!r.has_stopped_sync(&t.target_label));assert!(r.job_ids(&t.target_label).is_empty());
}
#[test]fn health_probation_rejects_every_user_admission_in_all_windows(){
 let mut r=setup();r.enter_health_probation();
 for label in ["main","other"]{
  assert!(r.registered(label).is_err());assert!(r.claim(label,"late").is_err());
  assert!(r.prepare_job(label,"job",None).is_err());assert!(r.settings_mutable(label).is_err());
 }
 assert!(r.mutable("main","tab").is_err());assert!(r.begin("main","tab",payload()).is_err());
 assert!(r.reserve_spawn("late").is_err());assert!(r.register_native_window("late").is_err());
 assert!(r.bootstrap("main").is_ok());assert!(r.settings_registered("main").is_ok());
 assert!(r.begin_update().is_err());r.cancel_update();assert!(r.registered("main").is_err());
 r.release_health_probation().unwrap();assert!(r.mutable("main","tab").is_ok());
}
#[test]fn health_exit_refuses_user_work_and_retains_permanent_fence(){
 let mut r=setup();r.enter_health_probation();assert!(r.seal_health_exit().is_err());
 assert!(r.release_health_probation().is_err());assert!(r.settings_registered("main").is_err());
 assert!(r.claim("other","late").is_err());assert_eq!(r.owned("main"),vec!["tab"]);
 let mut ordinary=setup();assert!(ordinary.seal_health_exit().is_err());assert!(ordinary.mutable("main","tab").is_ok());
}
#[test]fn health_exit_atomically_seals_against_concurrent_window_and_job_admission(){
 use std::sync::{Arc,Mutex,Barrier};
 for _ in 0..64{
  let mut registry=Registry::default();registry.register_native_window("main").unwrap();registry.enter_health_probation();
  let shared=Arc::new(Mutex::new(registry));let barrier=Arc::new(Barrier::new(3));
  let gate=shared.clone();let ready=barrier.clone();let close=std::thread::spawn(move||{ready.wait();gate.lock().unwrap().seal_health_exit()});
  let gate=shared.clone();let ready=barrier.clone();let work=std::thread::spawn(move||{ready.wait();let mut r=gate.lock().unwrap();(r.reserve_spawn("late"),r.prepare_job("main","late-job",None),r.settings_mutable("main"))});
  barrier.wait();assert_eq!(close.join().unwrap().unwrap(),vec!["main"]);
  let(window,job,settings)=work.join().unwrap();assert!(window.is_err()&&job.is_err()&&settings.is_err());
  assert!(shared.lock().unwrap().release_health_probation().is_err());
 }
}
#[test]fn update_barrier_covers_all_windows_and_late_work(){let mut r=setup();r.claim("other","second").unwrap();assert_eq!(r.begin_update().unwrap(),vec!["main","other"]);assert_eq!(r.update_owned_ids(),vec!["second","tab"]);for label in ["main","other"]{assert!(r.registered(label).is_err());assert!(r.settings_registered(label).is_ok());assert!(r.claim(label,"late").is_err());assert!(r.prepare_job(label,"late-job",None).is_err());assert!(r.seal_close(label).is_err());assert!(r.register_native_window(label).is_err());}assert!(r.mutable("main","tab").is_err());assert!(r.begin("main","tab",payload()).is_err());assert!(r.reserve_spawn("late-window").is_err());assert!(r.begin_update().is_err());r.seal_update().unwrap();assert!(r.settings_registered("main").is_err());assert!(r.seal_update().is_err());r.cancel_update();assert!(r.registered("main").is_ok());assert!(r.settings_registered("other").is_ok());assert!(r.mutable("main","tab").is_ok());r.reserve_spawn("late-window").unwrap();}
#[test]fn update_rejects_other_window_work_and_pending_window_creation(){let mut r=setup();Registry::scoped(&mut r.operations,"other","op",true).unwrap();assert!(r.begin_update().is_err());r.operations.clear();r.active_operations.insert("active".into());assert!(r.begin_update().is_err());r.active_operations.clear();r.reserve_spawn("child").unwrap();assert!(r.begin_update().is_err());r.finish_spawn("child");r.seal_close("other").unwrap();assert!(r.begin_update().is_err());r.unseal("other");r.begin_update().unwrap();}
#[test]fn update_rejects_transfer_and_live_job_but_accepts_stopped_descriptor(){let mut r=setup();let t=r.begin_drag("main","tab",payload()).unwrap();assert!(r.begin_update().is_err());r.activate_drag("main",&t.token,Some(("other",0,None))).unwrap();assert!(r.begin_update().is_err());r.abort("main",&t.token).unwrap();r.prepare_job("main","job",Some("tab")).unwrap();r.describe_job("job",serde_json::json!({"id":"job"}));assert!(r.begin_update().is_err());r.finish_job("job");r.begin_update().unwrap();r.cancel_update();assert!(r.begin("main","tab",payload()).is_ok());}
#[test]fn single_tab_drag_cannot_spawn_but_can_merge_and_multiple_tabs_can_detach(){let mut r=setup();let drag=r.begin_drag("main","tab",payload()).unwrap();assert!(r.activate_drag("main",&drag.token,None).is_err());assert_eq!(r.status("main",&drag.token).unwrap().phase,"dragging");let merged=r.activate_drag("main",&drag.token,Some(("other",0,None))).unwrap();assert_eq!(merged.target_kind,"existing");r.abort("main",&drag.token).unwrap();r.claim("main","remaining").unwrap();let drag=r.begin_drag("main","tab",payload()).unwrap();assert!(r.activate_drag("main",&drag.token,None).is_ok());}
#[test]fn failed_create_and_timeout_preserve_source(){for _ in 0..2{let mut r=setup();let t=r.begin("main","tab",payload()).unwrap();r.abort("main",&t.token).unwrap();assert!(r.mutable("main","tab").is_ok());assert!(r.commit(&t.target_label,&t.token).is_err());}}
#[test]fn commit_moves_without_clone_and_cannot_repeat(){let mut r=setup();r.prepare_job("main","job",Some("tab")).unwrap();let t=r.begin("main","tab",payload()).unwrap();r.bootstrap(&t.target_label).unwrap();r.commit(&t.target_label,&t.token).unwrap();assert!(r.owner("main","tab").is_err());assert!(r.job_owner(&t.target_label,"job").is_ok());assert!(r.commit(&t.target_label,&t.token).is_err());}
#[test]fn spoof_and_unrelated_close(){let mut r=setup();assert!(r.begin("other","tab",payload()).is_err());let t=r.begin("main","tab",payload()).unwrap();assert!(r.commit("other",&t.token).is_err());assert!(r.seal_close("main").is_err());assert!(r.seal_close("other").is_ok());}
#[test]fn operation_scope_and_secret_rejection(){let mut r=setup();Registry::scoped(&mut r.operations,"other","op",true).unwrap();assert!(Registry::scoped(&mut r.operations,"main","op",false).is_err());assert!(r.begin("main","tab",payload()).is_ok());assert!(validate_payload(&serde_json::json!({"version":1,"workspace":{"id":"tab","passphrase":"secret"}}),"tab").is_err());}
#[test]fn pending_child_cannot_claim_an_unrelated_workspace(){let mut r=setup();let t=r.begin("main","tab",payload()).unwrap();r.bootstrap(&t.target_label).unwrap();assert!(r.claim(&t.target_label,"spoof").is_err());r.commit(&t.target_label,&t.token).unwrap();assert!(r.claim(&t.target_label,"fresh").is_ok());assert!(r.mutable("main","tab").is_err());}
#[test]fn missing_or_foreign_runtime_job_is_refused(){let mut r=setup();r.prepare_job("main","job",Some("tab")).unwrap();r.describe_job("job",serde_json::json!({"id":"job"}));assert!(r.begin("main","tab",payload()).is_err());r.finish_job("job");assert!(r.begin("main","tab",payload()).is_ok());}
#[test]fn secret_objects_in_job_primitives_are_refused(){let p=serde_json::json!({"version":1,"workspace":{"id":"tab"},"job":{"id":"job","profile":{"id":"p","name":"P","host":"mock","port":22,"user":"u","auth":"key","mode":"mock","keyFile":"","hostKey":""},"local":{"passphrase":"secret"},"remote":"/","status":"running","logs":[]}});assert!(validate_payload(&p,"tab").is_err());}
#[test]fn terminal_transfer_history_is_bounded(){let mut r=setup();for _ in 0..100{let t=r.begin("main","tab",payload()).unwrap();r.abort("main",&t.token).unwrap();}assert_eq!(r.transfers.len(),64);assert!(r.mutable("main","tab").is_ok());}
#[test]fn source_reload_recovers_pending_transfer(){let mut r=setup();let t=r.begin("main","tab",payload()).unwrap();let b=r.bootstrap("main").unwrap();assert_eq!(b.outgoing_transfers.len(),1);assert_eq!(b.outgoing_transfers[0].token,t.token);assert!(r.mutable("main","tab").is_err());r.abort("main",&t.token).unwrap();assert!(r.bootstrap("main").unwrap().outgoing_transfers.is_empty());}
#[test]fn repeated_sync_replaces_only_its_inactive_descriptor(){let mut r=setup();for n in 0..300{let id=format!("job-{n}");r.prepare_job("main",&id,Some("tab")).unwrap();r.describe_job(&id,serde_json::json!({"id":id}));r.finish_job(&id);}assert_eq!(r.jobs.len(),1);assert!(r.jobs.contains_key("job-299"));}
#[test]fn empty_main_reload_after_transfer_is_not_a_fresh_process(){let mut r=Registry::default();assert!(r.bootstrap("main").unwrap().fresh_process);r.claim("main","tab").unwrap();let t=r.begin("main","tab",payload()).unwrap();assert!(!r.bootstrap(&t.target_label).unwrap().fresh_process);r.commit(&t.target_label,&t.token).unwrap();let b=r.bootstrap("main").unwrap();assert!(!b.fresh_process);assert!(b.owned_workspace_ids.is_empty());}
#[test]fn drag_reservation_blocks_close_and_mutations_until_cancel(){let mut r=setup();r.claim("main","another").unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();assert!(r.mutable("main","tab").is_err());assert!(r.mutable("main","another").is_err());assert!(r.seal_close("main").is_err());assert!(r.begin_drag("main","another",serde_json::json!({"version":1,"workspace":{"id":"another"}})).is_err());r.abort("main",&t.token).unwrap();assert!(r.mutable("main","tab").is_ok());}
#[test]fn existing_target_abort_preserves_both_windows_and_owners(){let mut r=setup();r.claim("other","before").unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();let t=r.activate_drag("main",&t.token,Some(("other",0,Some("before".into())))).unwrap();assert_eq!(t.target_kind,"existing");assert_eq!(t.before_id.as_deref(),Some("before"));assert!(r.mutable("other","before").is_err());assert!(r.claim("other","new").is_err());assert!(r.seal_close("other").is_err());r.abort("other",&t.token).unwrap();assert!(r.owner("main","tab").is_ok());assert!(r.owner("other","before").is_ok());assert!(r.mutable("other","before").is_ok());}
#[test]fn existing_target_commit_moves_job_and_keeps_target_tabs(){let mut r=setup();r.claim("other","before").unwrap();r.prepare_job("main","job",Some("tab")).unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();let t=r.activate_drag("main",&t.token,Some(("other",1,None))).unwrap();r.commit("other",&t.token).unwrap();assert!(r.job_owner("other","job").is_ok());assert!(r.owner("other","before").is_ok());assert!(r.owner("main","tab").is_err());}
#[test]fn spawn_reservation_and_shutdown_are_atomic_and_bounded(){let mut r=setup();r.reserve_spawn("workspace-new").unwrap();r.closed("main");r.closed("other");assert!(!r.seal_shutdown_if_idle());r.finish_spawn("workspace-new");assert!(r.seal_shutdown_if_idle());assert!(r.reserve_spawn("too-late").is_err());assert!(r.bootstrap("main").is_err());let mut r=Registry::default();for n in 0..32{r.reserve_spawn(&format!("window-{n}")).unwrap();}assert!(r.reserve_spawn("extra").is_err());}
#[test]fn early_second_launch_does_not_steal_initial_main_bootstrap(){let mut r=Registry::default();assert!(!r.bootstrap("workspace-second").unwrap().fresh_process);assert!(r.bootstrap("main").unwrap().fresh_process);assert!(!r.bootstrap("main").unwrap().fresh_process);}
#[test]fn native_main_lifetime_precedes_renderer_and_survives_early_child_close(){let mut r=Registry::default();r.register_native_window("main").unwrap();r.reserve_spawn("workspace-second").unwrap();assert!(!r.bootstrap("workspace-second").unwrap().fresh_process);r.finish_spawn("workspace-second");r.seal_empty_close("workspace-second").unwrap();r.closed("workspace-second");assert!(!r.seal_shutdown_if_idle());assert!(r.bootstrap("main").unwrap().fresh_process);assert!(!r.bootstrap("main").unwrap().fresh_process);}
#[test]fn only_committed_last_tab_can_seal_source_empty_and_other_window_survives(){let mut r=setup();r.claim("other","target-tab").unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();assert!(r.seal_empty_close("main").is_err());let t=r.activate_drag("main",&t.token,Some(("other",1,None))).unwrap();assert!(r.seal_empty_close("main").is_err());r.commit("other",&t.token).unwrap();assert!(r.seal_empty_close("main").unwrap().is_empty());assert!(r.claim("main","late-tab").is_err());r.closed("main");assert!(!r.seal_shutdown_if_idle());assert!(r.owner("other","tab").is_ok());assert!(r.owner("other","target-tab").is_ok());}
#[test]fn failed_last_tab_transfer_and_source_with_another_tab_cannot_empty_close(){let mut r=setup();let t=r.begin_drag("main","tab",payload()).unwrap();r.abort("main",&t.token).unwrap();assert!(r.seal_empty_close("main").is_err());assert!(r.mutable("main","tab").is_ok());r.claim("main","remaining").unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();let t=r.activate_drag("main",&t.token,Some(("other",0,None))).unwrap();r.commit("other",&t.token).unwrap();assert!(r.seal_empty_close("main").is_err());assert!(r.mutable("main","remaining").is_ok());}
#[test]fn normal_final_tab_release_then_empty_close_leaves_process_until_final_window(){let mut r=setup();r.release("main","tab").unwrap();r.seal_empty_close("main").unwrap();r.closed("main");assert!(!r.seal_shutdown_if_idle());r.seal_empty_close("other").unwrap();r.closed("other");assert!(r.seal_shutdown_if_idle());}
#[test]fn populated_view_state_rejects_nested_secrets_and_bad_cursor(){let mut p=serde_json::json!({"version":1,"workspace":{"id":"tab","localBrowse":"C:\\work","remoteBrowse":"/work","entries":{"local":[{"name":"a","dir":false,"size":1}],"remote":[]}},"viewState":{"selection":{"local":{"selected":["a"],"focus":"a"},"remote":{"selected":[],"focus":""}},"navigation":{"local":{"paths":["C:\\work"],"cursor":0},"remote":{"paths":[],"cursor":-1}},"trees":{"local":{"root":"@pc","key":"","expanded":["C:\\work"]},"remote":{"root":"/","key":"","expanded":[]}}}});assert!(validate_payload(&p,"tab").is_ok());p["viewState"]["selection"]["local"]["passphrase"]="secret".into();assert!(validate_payload(&p,"tab").is_err());p["viewState"]["selection"]["local"].as_object_mut().unwrap().remove("passphrase");p["viewState"]["navigation"]["local"]["cursor"]=(-1).into();assert!(validate_payload(&p,"tab").is_err());}
#[test]fn provisional_drag_window_never_owns_or_operates_on_source_workspace(){let mut r=setup();r.claim("main","remaining").unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();let preview=r.preview_drag("main",&t.token).unwrap();let boot=r.bootstrap(&preview.target_label).unwrap();assert_eq!(boot.pending_transfer.unwrap().phase,"dragging");assert!(boot.owned_workspace_ids.is_empty());assert!(r.settings_registered(&preview.target_label).is_ok());assert!(r.settings_mutable(&preview.target_label).is_err());assert!(r.owner("main","tab").is_ok());assert!(r.owner(&preview.target_label,"tab").is_err());assert!(r.mutable(&preview.target_label,"tab").is_err());assert!(r.claim(&preview.target_label,"spoof").is_err());assert!(r.commit(&preview.target_label,&t.token).is_err());r.abort(&preview.target_label,&t.token).unwrap();assert!(r.owner("main","tab").is_ok());assert!(r.mutable("main","tab").is_ok());}
#[test]fn single_tab_and_foreign_window_cannot_construct_detached_preview(){let mut r=setup();let t=r.begin_drag("main","tab",payload()).unwrap();assert!(r.preview_drag("main",&t.token).is_err());assert!(r.preview_drag("other",&t.token).is_err());r.abort("main",&t.token).unwrap();r.claim("main","remaining").unwrap();let t=r.begin_drag("main","tab",payload()).unwrap();let preview=r.preview_drag("main",&t.token).unwrap();r.bootstrap(&preview.target_label).unwrap();r.activate_drag("main",&t.token,None).unwrap();assert!(r.settings_mutable(&preview.target_label).is_err());assert!(r.preview_drag("main",&t.token).is_err());r.commit(&preview.target_label,&t.token).unwrap();assert!(r.settings_mutable(&preview.target_label).is_ok());assert!(r.owner(&preview.target_label,"tab").is_ok());assert!(r.owner("main","tab").is_err());}

}
