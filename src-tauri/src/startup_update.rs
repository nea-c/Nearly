//! Process-owned update election and state. No renderer supplies URLs or paths.
//! Registered public trust is fixed natively; fixture keys never enter this state.
use crate::update_package::{self, Architecture, ReleaseCandidate, StagedInstaller};
use serde::Serialize;
use std::{collections::HashSet,sync::{atomic::{AtomicBool,Ordering},Mutex},time::{Duration,Instant}};
const ENDPOINT:&str="https://api.github.com/repos/nea-c/Nearly/releases/latest";
// Enabled after isolated signed installation, rollback/restart-health QA and
// explicit production activation approval. Power-loss qualification remains open.
pub const HANDOFF_RELEASE_VALIDATED:bool=true;
pub(crate) fn handoff_validated()->bool{
    #[cfg(all(feature="installer-qa",windows))]
    {crate::installer_qa::authorized()}
    #[cfg(not(all(feature="installer-qa",windows)))]
    {HANDOFF_RELEASE_VALIDATED}
}
const CURRENT_VERSION:&str=env!("CARGO_PKG_VERSION");
#[derive(Clone,Debug,Serialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub struct Report { pub state:&'static str,pub latest_version:Option<String>,pub can_install:bool,pub error_code:Option<&'static str> }
fn report(state:&'static str,version:Option<String>)->Report{Report{state,latest_version:version,can_install:false,error_code:None}}
#[derive(Default)]
struct Inner {owner:Option<String>,dismissed:bool,busy:bool,candidate:Option<ReleaseCandidate>,staged:Option<StagedInstaller>,report:Option<Report>,barrier:Option<Barrier>}
struct Barrier {token:String,pending:HashSet<String>,failed:bool,deadline:Instant}
#[derive(Default)]
pub struct StartupUpdate {checked:AtomicBool,cancel:AtomicBool,inner:Mutex<Inner>}
impl StartupUpdate {
    fn begin_check(&self,label:&str)->bool{
        if self.checked.swap(true,Ordering::AcqRel){return false}
        if let Ok(mut inner)=self.inner.lock(){inner.owner=Some(label.into());inner.report=Some(report("checking",None));true}else{false}
    }
    pub fn status(&self,label:&str)->Report{
        let Ok(inner)=self.inner.lock()else{return report("error",None)};
        if inner.dismissed||inner.owner.as_deref()!=Some(label){return report("notOwner",None)}
        inner.report.clone().unwrap_or_else(||report("checking",None))
    }
    pub async fn check(&self,label:&str)->Report{
        #[cfg(all(feature="installer-qa",windows))]
        {let _=label;return report("current",None)}
        if !self.begin_check(label){return report("alreadyChecked",None)}
        let body=fetch_latest().await;
        let (next,candidate)=match body {Ok(body)=>{
            let initial=evaluate(&body,CURRENT_VERSION);
            let candidate=Architecture::current().ok().and_then(|arch|ReleaseCandidate::from_github_metadata(&body,CURRENT_VERSION,arch).ok().flatten());
            let next=if initial.latest_version.is_some()&&update_package::runtime_key().is_some(){if candidate.is_some(){report("available",initial.latest_version)}else{let mut r=report("error",initial.latest_version);r.error_code=Some("noCompatibleAsset");r}}else{initial};
            (next,candidate)
        },Err(code)=>(report(code,None),None)};
        if let Ok(mut inner)=self.inner.lock(){inner.report=Some(next);inner.candidate=candidate;}
        self.status(label)
    }
    #[cfg(all(feature="installer-qa",windows))]
    pub(crate) fn qa_prepare(&self,label:&str)->Result<(),&'static str>{
        let (candidate,stage)=update_package::qa_stage()?;
        self.checked.store(true,Ordering::Release);self.cancel.store(false,Ordering::Release);
        let mut i=self.inner.lock().map_err(|_|"updateUnavailable")?;
        if i.busy||i.barrier.is_some()||i.staged.is_some(){return Err("updateBusy")}
        let mut r=report("ready",Some(candidate.display_version()));r.can_install=handoff_validated();
        i.owner=Some(label.into());i.dismissed=false;i.candidate=Some(candidate);i.staged=Some(stage);i.report=Some(r);Ok(())
    }
    pub fn begin_prepare(&self,label:&str)->Result<Report,&'static str>{
        let mut i=self.inner.lock().map_err(|_|"updateUnavailable")?;
        if i.owner.as_deref()!=Some(label)||i.dismissed{return Err("notOwner")}
        if update_package::runtime_key().is_none(){let r=report("signingNotConfigured",i.report.as_ref().and_then(|r|r.latest_version.clone()));i.report=Some(r.clone());return Ok(r)}
        if i.busy{return Err("updateBusy")}
        if i.candidate.is_none(){return Err("noCompatibleAsset")}
        self.cancel.store(false,Ordering::Release);i.staged=None;i.busy=true;
        let r=report("downloading",i.report.as_ref().and_then(|r|r.latest_version.clone()));i.report=Some(r.clone());Ok(r)
    }
    pub async fn download(&self){
        let candidate=self.inner.lock().ok().and_then(|i|i.candidate.clone());
        let result=match(candidate,update_package::runtime_key()){
            (Some(c),Some(key))=>update_package::download_and_stage(&c,&key,&self.cancel).await,
            _=>Err(update_package::PackageError::SigningNotConfigured),
        };
        if let Ok(mut i)=self.inner.lock(){i.busy=false;let version=i.report.as_ref().and_then(|r|r.latest_version.clone());
            if i.dismissed||self.cancel.load(Ordering::Acquire){i.report=Some(report("cancelled",version));return}
            match result{Ok(stage)=>{i.staged=Some(stage);let mut r=report("ready",version);r.can_install=handoff_validated();i.report=Some(r)},Err(error)=>{let mut r=report("error",version);r.error_code=Some(error.code());i.report=Some(r)}}
        }
    }
    pub fn cancel(&self,label:&str,dismiss:bool)->Report{
        let Ok(mut i)=self.inner.lock()else{return report("error",None)};
        if i.owner.as_deref()!=Some(label){return report("notOwner",None)}
        // Once the verified child is launched only the bounded handoff protocol
        // may complete it; renderer cancellation cannot race irreversible exit.
        if i.report.as_ref().is_some_and(|r|r.state=="installing"){return i.report.clone().unwrap()}
        self.cancel.store(true,Ordering::Release);i.staged=None;i.barrier=None;i.dismissed|=dismiss;
        let r=report("cancelled",i.report.as_ref().and_then(|r|r.latest_version.clone()));i.report=Some(r.clone());r
    }
    pub fn fail(&self,label:&str,code:&'static str)->Report{
        let Ok(mut i)=self.inner.lock()else{return report("error",None)};
        if i.owner.as_deref()!=Some(label){return report("notOwner",None)}
        i.barrier=None;let mut r=report("error",i.report.as_ref().and_then(|r|r.latest_version.clone()));r.error_code=Some(code);i.report=Some(r.clone());r
    }
    pub fn begin_settle(&self,label:&str,labels:Vec<String>)->Result<String,&'static str>{
        let mut i=self.inner.lock().map_err(|_|"updateUnavailable")?;
        if i.owner.as_deref()!=Some(label)||i.dismissed{return Err("notOwner")}
        if update_package::runtime_key().is_none(){return Err("signingNotConfigured")}
        if i.busy||i.staged.is_none()||i.report.as_ref().is_none_or(|r|r.state!="ready"){return Err("updateNotReady")}
        let mut bytes=[0u8;24];getrandom::fill(&mut bytes).map_err(|_|"updateUnavailable")?;
        let token=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        i.barrier=Some(Barrier{token:token.clone(),pending:labels.into_iter().collect(),failed:false,deadline:Instant::now()+Duration::from_secs(5)});
        i.report=Some(report("settling",i.report.as_ref().and_then(|r|r.latest_version.clone())));Ok(token)
    }
    pub fn acknowledge(&self,label:&str,token:&str,ready:bool)->Result<(),&'static str>{
        let mut i=self.inner.lock().map_err(|_|"updateUnavailable")?;let b=i.barrier.as_mut().ok_or("updateNotReady")?;
        if b.token!=token||!b.pending.remove(label){return Err("updateNotReady")};b.failed|=!ready;Ok(())
    }
    pub async fn wait_settled(&self,token:&str)->Result<(),&'static str>{
        loop{{let i=self.inner.lock().map_err(|_|"updateUnavailable")?;let b=i.barrier.as_ref().ok_or("updateCancelled")?;
            if b.token!=token||b.failed{return Err("settingsNotSettled")}
            if b.pending.is_empty(){return Ok(())}
            if Instant::now()>=b.deadline{return Err("settingsNotSettled")}
        }tokio::time::sleep(Duration::from_millis(25)).await;}
    }
    pub fn take_verified(&self,label:&str)->Result<(StagedInstaller,ReleaseCandidate,update_package::TrustedKey),&'static str>{
        let mut i=self.inner.lock().map_err(|_|"updateUnavailable")?;
        if i.owner.as_deref()!=Some(label)||i.dismissed||self.cancel.load(Ordering::Acquire){return Err("updateCancelled")}
        let key=update_package::runtime_key().ok_or("signingNotConfigured")?;
        let candidate=i.candidate.clone().ok_or("noCompatibleAsset")?;
        let mut staged=i.staged.take().ok_or("updateNotReady")?;
        staged.reverify(&candidate,&key).map_err(|_|"invalidSignature")?;
        i.report=Some(report("installing",Some(candidate.display_version())));i.barrier=None;Ok((staged,candidate,key))
    }
}
async fn fetch_latest()->Result<Vec<u8>,&'static str>{
    let client=reqwest::Client::builder().https_only(true).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(4)).timeout(Duration::from_secs(8)).user_agent(concat!("Nearly/",env!("CARGO_PKG_VERSION"))).build().map_err(|_|"unavailable")?;
    fetch_latest_from(&client,ENDPOINT).await
}
async fn fetch_latest_from(client:&reqwest::Client,url:&str)->Result<Vec<u8>,&'static str>{
    let mut response=client.get(url).header("Accept","application/vnd.github+json").header("X-GitHub-Api-Version","2022-11-28").send().await.map_err(|_|"unavailable")?;
    if response.status()==reqwest::StatusCode::NOT_FOUND{return Err("noStableRelease")}
    if response.status()!=reqwest::StatusCode::OK{return Err("unavailable")}
    if response.content_length().is_some_and(|n|n>update_package::MAX_METADATA as u64){return Err("invalidMetadata")}
    let mut body=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"unavailable")?{if chunk.len()>update_package::MAX_METADATA.saturating_sub(body.len()){return Err("invalidMetadata")};body.extend_from_slice(&chunk)}Ok(body)
}
fn evaluate(body:&[u8],current:&str)->Report{
    #[derive(serde::Deserialize)]struct Release{tag_name:String,draft:bool,prerelease:bool,html_url:String}
    if body.len()>update_package::MAX_METADATA{return report("invalidMetadata",None)}
    let Ok(r)=serde_json::from_slice::<Release>(body)else{return report("invalidMetadata",None)};
    if r.draft||r.prerelease{return report("noStableRelease",None)}
    let (Some(v),Ok(current))=(crate::version::release_version(&r.tag_name),semver::Version::parse(current))else{return report("invalidMetadata",None)};
    if r.html_url!=format!("https://github.com/nea-c/Nearly/releases/tag/{}",r.tag_name){return report("invalidMetadata",None)}
    if v.cmp_precedence(&current)!=std::cmp::Ordering::Greater{return report("current",None)}
    report("signingNotConfigured",Some(crate::version::display_label(&v)))
}
#[cfg(test)]mod tests{
    use super::*;
    fn release(tag:&str,draft:bool,pre:bool)->Vec<u8>{serde_json::to_vec(&serde_json::json!({"tag_name":tag,"draft":draft,"prerelease":pre,"html_url":format!("https://github.com/nea-c/Nearly/releases/tag/{tag}")})).unwrap()}
    #[test]fn public_release_tags_compare_numerically_and_reject_aliases(){
        for (tag,current,expected) in [("r1.0","1.0.0","current"),("r1.10","1.9.0","signingNotConfigured"),("r2.0","1.10.0","signingNotConfigured"),("r1.9","1.10.0","current")] {
            let result=evaluate(&release(tag,false,false),current);
            assert_eq!(result.state,expected);
            assert_eq!(result.latest_version.as_deref(),if expected=="signingNotConfigured" {Some(tag)} else {None});
        }
        for tag in ["r1.0.1","r1.0-beta","r1.0+build","r01.0","v1.0.0"] {assert_eq!(evaluate(&release(tag,false,false),"0.2.0").state,"invalidMetadata");}
        for (draft,pre) in [(true,false),(false,true)] {assert_eq!(evaluate(&release("r2.0",draft,pre),"1.0.0").state,"noStableRelease");}
    }
    #[test]fn only_latest_stable_newer_metadata_is_candidate(){for tag in ["r0.3","r0.10","r1.0"]{let r=evaluate(&release(tag,false,false),"0.2.0");assert_eq!(r.state,"signingNotConfigured");assert!(!r.can_install)}for tag in ["r0.2","r0.1"]{assert_eq!(evaluate(&release(tag,false,false),"0.2.0").state,"current")}for(tag,draft,pre)in[("r0.3",true,false),("r0.3",false,true)]{assert_eq!(evaluate(&release(tag,draft,pre),"0.2.0").state,"noStableRelease")}}
    #[test]fn foreign_malformed_and_oversized_are_rejected(){for body in [vec![0;update_package::MAX_METADATA+1],b"{}".to_vec(),br#"{"tag_name":"v1.0.0","draft":false,"prerelease":false,"html_url":"https://evil.invalid"}"#.to_vec()]{assert_eq!(evaluate(&body,"0.2.0").state,"invalidMetadata")}}
    #[test]fn process_election_dismissal_and_empty_execution_fail_closed(){let s=StartupUpdate::default();assert!(s.begin_check("main"));assert!(!s.begin_check("other"));assert_eq!(s.status("other").state,"notOwner");assert!(matches!(s.begin_prepare("main"),Err("noCompatibleAsset")));assert!(matches!(s.begin_settle("main",vec!["main".into()]),Err("updateNotReady")));assert!(matches!(s.take_verified("main"),Err("noCompatibleAsset")));s.cancel("main",true);assert_eq!(s.status("main").state,"notOwner");assert!(!s.begin_check("main"));assert!(matches!(s.begin_prepare("main"),Err("notOwner")))}
    #[tokio::test]async fn settings_barrier_rejects_wrong_owner_token_negative_ack_and_timeout(){let s=StartupUpdate::default();{let mut i=s.inner.lock().unwrap();i.barrier=Some(Barrier{token:"generated".into(),pending:["main".into(),"other".into()].into(),failed:false,deadline:Instant::now()+Duration::from_secs(1)});}assert!(s.acknowledge("foreign","generated",true).is_err());assert!(s.acknowledge("main","wrong",true).is_err());s.acknowledge("main","generated",true).unwrap();s.acknowledge("other","generated",false).unwrap();assert_eq!(s.wait_settled("generated").await,Err("settingsNotSettled"));}
    #[test]fn single_cancel_never_authorizes_a_new_owner_or_install(){let s=StartupUpdate::default();s.begin_check("main");s.cancel("other",false);assert_eq!(s.status("other").state,"notOwner");assert!(!s.cancel.load(Ordering::Acquire));s.cancel("main",false);assert!(s.cancel.load(Ordering::Acquire));assert!(!s.status("main").can_install)}
    #[tokio::test]
    async fn metadata_transport_handles_offline_limits_and_non_success_without_following_redirects(){
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        async fn serve(response:Vec<u8>)->(String,tokio::task::JoinHandle<()>){
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/latest",listener.local_addr().unwrap());
            let task=tokio::spawn(async move{let(mut stream,_)=tokio::time::timeout(Duration::from_secs(2),listener.accept()).await.unwrap().unwrap();let mut request=Vec::new();while !request.ends_with(b"\r\n\r\n"){let mut byte=[0u8;1];if tokio::time::timeout(Duration::from_secs(1),stream.read_exact(&mut byte)).await.is_err(){return}request.push(byte[0]);if request.len()>8192{return}}let _=stream.write_all(&response).await;});(url,task)
        }
        let client=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(1)).build().unwrap();
        for(response,expected)in[(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec(),"noStableRelease"),(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n".to_vec(),"unavailable"),(b"HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/run\r\nContent-Length: 0\r\n\r\n".to_vec(),"unavailable"),(b"HTTP/1.1 200 OK\r\nContent-Length: 131073\r\n\r\n".to_vec(),"invalidMetadata"),(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort".to_vec(),"unavailable")]{let(url,server)=serve(response).await;assert_eq!(fetch_latest_from(&client,&url).await,Err(expected));server.await.unwrap();}
        let(url,server)=serve(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec()).await;assert_eq!(fetch_latest_from(&client,&url).await.unwrap(),b"{}");server.await.unwrap();
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}/closed",listener.local_addr().unwrap());drop(listener);assert_eq!(fetch_latest_from(&client,&url).await,Err("unavailable"));
    }
    #[tokio::test]async fn settings_barrier_completes_only_all_exact_participants_and_times_out(){let s=StartupUpdate::default();{let mut i=s.inner.lock().unwrap();i.barrier=Some(Barrier{token:"one-use".into(),pending:["main".into(),"other".into()].into(),failed:false,deadline:Instant::now()+Duration::from_secs(1)});}s.acknowledge("main","one-use",true).unwrap();assert!(s.acknowledge("main","one-use",true).is_err());s.acknowledge("other","one-use",true).unwrap();assert!(s.wait_settled("one-use").await.is_ok());{let mut i=s.inner.lock().unwrap();i.barrier.as_mut().unwrap().pending.insert("late".into());i.barrier.as_mut().unwrap().deadline=Instant::now();}assert_eq!(s.wait_settled("one-use").await,Err("settingsNotSettled"));}

    #[tokio::test]async fn failed_install_request_does_not_release_an_inflight_download(){let s=StartupUpdate::default();s.begin_check("main");s.inner.lock().unwrap().busy=true;s.fail("main","updateNotReady");assert!(s.inner.lock().unwrap().busy);s.cancel("main",false);assert!(s.inner.lock().unwrap().busy);s.download().await;assert!(!s.inner.lock().unwrap().busy);assert!(!s.status("main").can_install);}

}
