//! Explicitly compiled, guest-only installer qualification. Never a production override.
use serde::Deserialize;
use std::{collections::HashMap, path::{Path, PathBuf}};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Plan {
    pub schema_version:u32, pub destination_kind:String, pub run_id:String, pub run_attempt:String,
    pub controller_sha:String, pub token:String, pub source_version:String,
    pub target_version:String, pub target_file:String, pub target_sha256:String,
    pub target_bytes:usize, pub payload_sha256:String, pub signature_file:String,
}
fn hex(s:&str,n:usize)->bool{s.len()==n&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn id(s:&str)->bool{!s.starts_with('0')&&s.len()<=20&&!s.is_empty()&&s.bytes().all(|b|b.is_ascii_digit())}
fn same(a:&Path,b:&Path)->bool{a.to_string_lossy().replace('/',"\\").eq_ignore_ascii_case(&b.to_string_lossy().replace('/',"\\"))}
fn nsis_plugin_folder(folder:&str)->bool {
    // NSIS v3.11 exehead/util.c my_GetTempFileName uses nsa..nsz.
    // GetTempFileNameW adds a 16-bit hexadecimal suffix and .TMP:
    // https://github.com/NSIS-Dev/nsis/blob/v311/Source/exehead/util.c#L470-L478
    // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-gettempfilenamew
    let b=folder.as_bytes();
    (8..=11).contains(&b.len())&&b[..2].eq_ignore_ascii_case(b"ns")
        &&b[2].is_ascii_alphabetic()&&b[b.len()-4..].eq_ignore_ascii_case(b".tmp")
        &&b[3..b.len()-4].iter().all(u8::is_ascii_hexdigit)
}
fn installed_path(env:&HashMap<String,String>,kind:&str,run:&str,attempt:&str)->Result<PathBuf,&'static str>{
    let local=env.get("LOCALAPPDATA").ok_or("qaContext")?;
    match kind {
        "default"=>Ok(Path::new(local).join("Nearly")),
        "custom"=>Ok(Path::new(local).join(format!("Nearly Installer QA {run}-{attempt}")).join("日本語 space").join("Nearly")),
        "drive"=>Ok(PathBuf::from(format!("D:\\Nearly QA 日本語 {run}-{attempt}"))),
        _=>Err("qaPlan"),
    }
}
fn validate_install_policy(env:&HashMap<String,String>,p:&Plan,image:&Path,args:&[String],bases:&[PathBuf],token:&str,sha:&str)->Result<PathBuf,&'static str>{
    let command=args.first().map(String::as_str).ok_or("qaPolicy")?;
    let prepare=command=="--nearly-install-prepare";
    if (!prepare&&command!="--nearly-install-check")||args.len()!=if prepare{3}else{2}{return Err("qaPolicy");}
    if prepare {
        let fields:Vec<_>=args[2].split('.').collect();
        if fields.len()!=3||!matches!(fields[0],"ready"|"new"|"empty")||!hex(fields[1],32)||!hex(fields[2],64){return Err("qaPolicy");}
    }
    crate::install_root::validate_path(&args[1]).map_err(|_|"qaPolicy")?;
    let plugin=image.parent().ok_or("qaPolicy")?;let folder=plugin.file_name().and_then(|s|s.to_str()).ok_or("qaPolicy")?;
    if image.file_name().and_then(|s|s.to_str())!=Some("Nearly-install-policy.exe")||!nsis_plugin_folder(folder)||!bases.iter().any(|base|plugin.parent().is_some_and(|parent|same(parent,base))){return Err("qaPolicy");}
    if !["default","custom","drive"].iter().any(|kind|installed_path(env,kind,&p.run_id,&p.run_attempt).is_ok_and(|root|same(&root,Path::new(&args[1])))){return Err("qaPolicy");}
    // Only after proving the exact extracted helper, arguments and one of this
    // run's three targets may the common compiled identity validator be reused.
    let expected=installed_path(env,&p.destination_kind,&p.run_id,&p.run_attempt)?.join("Nearly.exe");
    validate(env,p,&expected,token,sha)
}
fn validate(env:&HashMap<String,String>,p:&Plan,image:&Path,compiled_token:&str,compiled_sha:&str)->Result<PathBuf,&'static str>{
    let get=|k:&str|env.get(k).map(String::as_str).ok_or("qaContext");
    for(k,v)in[("GITHUB_ACTIONS","true"),("RUNNER_ENVIRONMENT","github-hosted"),("RUNNER_OS","Windows"),("GITHUB_REPOSITORY","nea-c/Nearly"),("GITHUB_EVENT_NAME","workflow_dispatch")]{if get(k)?!=v{return Err("qaContext")}}
    if !matches!(get("GITHUB_REF")?,"refs/heads/main"|"refs/heads/codex/private-install-directory"){return Err("qaContext")}
    if env.contains_key("SYNCFILES_CONFIG_DIR")||!matches!(get("NEARLY_QA_SCENARIO")?,"success"|"health-failure"){return Err("qaContext")}
    if !hex(compiled_token,64)||!hex(compiled_sha,40)||p.token!=compiled_token||get("NEARLY_QA_TOKEN")?!=compiled_token||p.controller_sha!=compiled_sha||get("GITHUB_SHA")?!=compiled_sha||get("GITHUB_WORKFLOW_SHA")?!=compiled_sha||get("QA_CONTROLLER_SHA")?!=compiled_sha||get("QA_CONFIRMATION")?!=format!("installer-qa {compiled_sha}"){return Err("qaIdentity")}
    if p.schema_version!=2||!matches!(p.destination_kind.as_str(),"default"|"custom"|"drive")||get("QA_DESTINATION")?!=p.destination_kind||!id(&p.run_id)||!id(&p.run_attempt)||get("GITHUB_RUN_ID")?!=p.run_id||get("GITHUB_RUN_ATTEMPT")?!=p.run_attempt||p.source_version!="1.9.0"||p.target_version!="2.0.0"||p.target_file!="Nearly_r2.0_x64-setup.exe"||p.signature_file!="Nearly_r2.0_x64-setup.exe.sig"||!hex(&p.target_sha256,64)||!hex(&p.payload_sha256,64)||p.target_bytes==0||p.target_bytes>64*1024*1024{return Err("qaPlan")}
    let safe=|s:&str|{let b=s.as_bytes();b.len()>3&&b[0].is_ascii_alphabetic()&&b[1]==b':'&&(b[2]==b'\\'||b[2]==b'/')&&!s[2..].contains(':')&&!s.split(['\\','/']).any(|x|x=="."||x==".."||x.ends_with(' ')||x.ends_with('.'))};
    let temp=get("RUNNER_TEMP")?;let local=get("LOCALAPPDATA")?;let supplied=get("NEARLY_QA_RUN_ROOT")?;
    if !safe(temp)||!safe(local)||!safe(supplied)||!safe(&image.to_string_lossy()){return Err("qaPath")}
    let root=Path::new(temp).join(format!("nearly-installer-qa-{}-{}",p.run_id,p.run_attempt));
    if !same(&root,Path::new(supplied)){return Err("qaPath")}
    // Both roots are derived from the confirmed guest identity. No renderer,
    // registry value, command argument, or arbitrary plan path grants QA trust.
    // Production installation admission still independently checks root ACLs.
    let installed=installed_path(env,&p.destination_kind,&p.run_id,&p.run_attempt)?;
    if !same(image,&installed.join("Nearly.exe")){
        let parent=image.parent().ok_or("qaImage")?;let nonce=parent.file_name().and_then(|n|n.to_str()).ok_or("qaImage")?;
        if !hex(nonce,32)||!same(parent.parent().ok_or("qaImage")?,&installed.join(".Nearly-update-state"))||image.file_name().and_then(|n|n.to_str())!=Some("previous-image.exe"){return Err("qaImage")}
    }
    Ok(root)
}

#[cfg(all(feature="installer-qa",windows))]
mod guest {
    use super::*;
    use std::{fs::OpenOptions,io::{Read,Write},os::windows::fs::{MetadataExt,OpenOptionsExt},sync::{OnceLock,atomic::{AtomicBool,Ordering}}};
    use base64::{Engine,engine::general_purpose::STANDARD};
    use tauri::Manager;
    pub(crate) struct Context {pub root:PathBuf,pub plan:Plan,pub key:[u8;42],pub scenario:String}
    static CONTEXT:OnceLock<Option<Context>>=OnceLock::new();
    static STARTED:AtomicBool=AtomicBool::new(false);
    struct Trace {file:std::fs::File,count:usize}
    static TRACE:OnceLock<Option<std::sync::Mutex<Trace>>>=OnceLock::new();
    fn regular_chain(path:&Path)->Result<(),&'static str>{
        for part in path.ancestors(){let m=std::fs::symlink_metadata(part).map_err(|_|"qaPath")?;if m.file_attributes()&0x400!=0||m.file_type().is_symlink(){return Err("qaPath")}}
        Ok(())
    }
    fn read(path:&Path,max:usize)->Result<Vec<u8>,&'static str>{
        regular_chain(path)?;
        let mut file=OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(path).map_err(|_|"qaFile")?;
        let m=file.metadata().map_err(|_|"qaFile")?;if !m.is_file()||m.file_attributes()&0x400!=0||m.len()>max as u64{return Err("qaFile")}
        let mut bytes=Vec::new();(&mut file).take(max as u64+1).read_to_end(&mut bytes).map_err(|_|"qaFile")?;if bytes.len()>max{return Err("qaFile")};Ok(bytes)
    }
    fn load()->Result<Context,&'static str>{load_with_policy(None)}
    fn load_with_policy(policy_args:Option<&[String]>)->Result<Context,&'static str>{
        std::hint::black_box("NEARLY-INSTALLER-QA-ONLY-v1");
        let e:HashMap<String,String>=std::env::vars().collect();
        let temp=e.get("RUNNER_TEMP").ok_or("qaContext")?;
        let run=e.get("GITHUB_RUN_ID").filter(|s|id(s)).ok_or("qaContext")?;
        let attempt=e.get("GITHUB_RUN_ATTEMPT").filter(|s|id(s)).ok_or("qaContext")?;
        let root=Path::new(temp).join(format!("nearly-installer-qa-{run}-{attempt}"));
        let p:Plan=serde_json::from_slice(&read(&root.join("authorization.json"),16384)?).map_err(|_|"qaPlan")?;
        let image=std::env::current_exe().map_err(|_|"qaImage")?;
        let token=option_env!("NEARLY_QA_BUILD_TOKEN").unwrap_or("");let sha=option_env!("NEARLY_QA_CONTROLLER_SHA").unwrap_or("");
        let root=if let Some(args)=policy_args {
            regular_chain(&image)?;let canonical=dunce::canonicalize(&image).map_err(|_|"qaPolicy")?;
            if !same(&canonical,&image){return Err("qaPolicy");}
            let mut bases=Vec::new();
            for name in ["TEMP","RUNNER_TEMP"] {
                let raw=e.get(name).ok_or("qaPolicy")?;regular_chain(Path::new(raw))?;
                let base=dunce::canonicalize(raw).map_err(|_|"qaPolicy")?;regular_chain(&base)?;bases.push(base);
            }
            validate_install_policy(&e,&p,&image,args,&bases,token,sha)?
        }else{validate(&e,&p,&image,token,sha)?};
        regular_chain(&root)?;regular_chain(&image)?;
        let raw=STANDARD.decode(option_env!("NEARLY_QA_PUBLIC_KEY").unwrap_or("")).map_err(|_|"qaKey")?;
        let key:[u8;42]=raw.try_into().map_err(|_|"qaKey")?;
        if &key[..10]!=b"Edqa-only!" {return Err("qaKey")}
        let version=env!("CARGO_PKG_VERSION");if version!=p.source_version&&version!=p.target_version{return Err("qaVersion")}
        Ok(Context{root,plan:p,key,scenario:e["NEARLY_QA_SCENARIO"].clone()})
    }
    pub(crate) fn context()->Option<&'static Context>{CONTEXT.get_or_init(||load().ok()).as_ref()}
    pub(crate) fn authorized()->bool{context().is_some()}
    pub(crate) fn authorized_install_policy(args:impl IntoIterator<Item=std::ffi::OsString>)->bool{
        let Ok(args)=args.into_iter().skip(1).map(std::ffi::OsString::into_string).collect::<Result<Vec<_>,_>>()else{return false};
        load_with_policy(Some(&args)).is_ok()
    }
    pub(crate) fn trace(event:&'static str,code:&'static str){
        if event.len()>64||code.len()>64||!event.bytes().chain(code.bytes()).all(|b|b.is_ascii_alphanumeric()){return}
        let Some(lock)=TRACE.get_or_init(||{
            let c=context()?;regular_chain(&c.root).ok()?;
            let file=OpenOptions::new().write(true).create_new(true).share_mode(1).custom_flags(0x00200000).open(c.root.join(format!("qa-trace-{}.jsonl",std::process::id()))).ok()?;
            Some(std::sync::Mutex::new(Trace{file,count:0}))
        })else{return};
        let Ok(mut t)=lock.lock()else{return};if t.count>=64{return}
        let Ok(mut bytes)=serde_json::to_vec(&serde_json::json!({"event":event,"code":code,"version":env!("CARGO_PKG_VERSION"),"pid":std::process::id()}))else{return};
        bytes.push(b'\n');if bytes.len()>256{return}t.count+=1;let _=t.file.write_all(&bytes);
    }
    pub(crate) fn trace_error(error:&crate::update_transaction::Error){
        use crate::update_transaction::Error::*;
        trace("nativeError",match error{Disabled=>"Disabled",Invalid=>"Invalid",Unsafe=>"Unsafe",Busy=>"Busy",Missing=>"Missing",Io=>"Io",Protection=>"Protection",Uncertain=>"Uncertain"});
    }
    pub(crate) fn trace_runtime(phase:&'static str,reason:Option<&'static str>){
        if matches!(phase,"idle"|"waitingForUi"|"checking"|"awaitingSuccess"|"succeeded"|"recoveryRequired"){trace("runtime",phase)}
        if let Some(code)=reason{trace("runtimeError",if matches!(code,"supervisorAuthenticationFailed"|"liveSupervisorMissing"|"restartInterrupted"|"supervisorEvidenceLost"|"runtimeUnavailable"|"probationReleaseFailed"|"healthShutdownBusy"|"supervisorHealthTimeout"|"transactionUnavailable"|"unsupportedPlatform"|"invalidHealthArguments"){code}else{"other"});}
    }
    pub(crate) fn suppress_health()->bool{context().is_some_and(|c|c.scenario=="health-failure"&&env!("CARGO_PKG_VERSION")==c.plan.target_version)}
    fn outcome(c:&Context,phase:&str,error:Option<&str>)->Result<(),&'static str>{
        let result=publish_outcome(c,phase,error);
        trace("outcome",if result.is_err(){"writeFailed"}else{match phase{"succeeded"=>"succeeded","rolledBack"=>"rolledBack",_=>"failed"}});
        result
    }
    fn publish_outcome(c:&Context,phase:&str,error:Option<&str>)->Result<(),&'static str>{
        let path=c.root.join(format!("outcome-{}.json",c.scenario));
        regular_chain(&c.root)?;
        let mut nonce=[0u8;16];getrandom::fill(&mut nonce).map_err(|_|"qaOutcome")?;
        let temporary=c.root.join(format!("outcome-{}-{}.tmp",c.scenario,nonce.iter().map(|b|format!("{b:02x}")).collect::<String>()));
        let mut f=OpenOptions::new().write(true).create_new(true).share_mode(1).custom_flags(0x00200000).open(&temporary).map_err(|_|"qaOutcome")?;
        let mut value=serde_json::json!({"schemaVersion":2,"destinationKind":c.plan.destination_kind,"scenario":c.scenario,"phase":phase,"version":env!("CARGO_PKG_VERSION")});if let Some(code)=error{value["error"]=code.into()}
        f.write_all(&serde_json::to_vec(&value).map_err(|_|"qaOutcome")?).and_then(|_|f.sync_all()).map_err(|_|"qaOutcome")?;
        drop(f);std::fs::hard_link(&temporary,&path).map_err(|_|"qaOutcome")?;
        std::fs::remove_file(temporary).map_err(|_|"qaOutcome")
    }
    pub(crate) fn fixture()->Result<(Vec<u8>,Vec<u8>),&'static str>{
        let c=context().ok_or("qaContext")?;let bytes=read(&c.root.join(&c.plan.target_file),c.plan.target_bytes)?;
        if bytes.len()!=c.plan.target_bytes||crate::update_transaction::sha256(&bytes)!=c.plan.target_sha256{return Err("qaHash")}
        let sig=read(&c.root.join(&c.plan.signature_file),16384)?;Ok((bytes,sig))
    }
    pub(crate) fn on_ready(window:tauri::WebviewWindow,app:tauri::AppHandle,bootstrap:bool){
        let Some(c)=context()else{return};
        if env!("CARGO_PKG_VERSION")==c.plan.source_version{
            if !bootstrap||app.state::<crate::AppState>().ownership.lock().map(|r|r.owned(window.label()).is_empty()).unwrap_or(true){return}
        }
        if STARTED.swap(true,Ordering::AcqRel){return}
        trace("bootstrap",if env!("CARGO_PKG_VERSION")==c.plan.source_version{"source"}else{"target"});
        if env!("CARGO_PKG_VERSION")==c.plan.source_version{
            let marker=c.root.join(format!("attempt-{}",c.scenario));
            match OpenOptions::new().write(true).create_new(true).share_mode(1).open(&marker){
                Ok(mut f)=>{trace("marker","created");if f.write_all(b"1").and_then(|_|f.sync_all()).is_err(){let _=outcome(c,"failed",Some("qaMarker"));return}},
                Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>{trace("marker","existing");if read(&marker,1).as_deref()==Ok(b"1")&&crate::update_recovery_windows::qa_restored(){trace("restoration","confirmed");let _=outcome(c,"rolledBack",None);}else{trace("restoration","rejected");let _=outcome(c,"failed",Some("qaRestoration"));}return},
                Err(_)=>{let _=outcome(c,"failed",Some("qaMarker"));return}
            }
            tauri::async_runtime::spawn(async move{
                trace("fixture","staging");let prepared=app.state::<crate::AppState>().startup_update.qa_prepare(window.label());
                if let Err(code)=prepared{let _=outcome(c,"failed",Some(code));return}
                trace("fixture","ready");
                let result=crate::install_startup_update(window,app).await;
                // A committed handoff exits the source process. Any return with an
                // error is a failed case, never a synthetic success.
                trace("handoff",if result.error_code.is_some(){"failed"}else{"returned"});
                if let Some(code)=result.error_code{let _=outcome(c,"failed",Some(code));}
            });
        }else{
            // Deliberate health failure is expected to terminate this target.
            // Only the restored source may publish its rollback outcome.
            if c.scenario=="health-failure"{return}
            tauri::async_runtime::spawn(async move{
                let deadline=std::time::Instant::now()+std::time::Duration::from_secs(150);
                loop{let status=app.state::<crate::AppState>().update_restart.status();
                    if status.phase=="succeeded"{let _=outcome(c,"succeeded",None);return}
                    if status.phase=="recoveryRequired"||std::time::Instant::now()>=deadline{let _=outcome(c,"failed",Some("qaHealth"));return}
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            });
        }
    }
}
#[cfg(all(feature="installer-qa",windows))]
pub(crate) use guest::*;

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->(HashMap<String,String>,Plan,PathBuf){
        let token="a".repeat(64);let sha="b".repeat(40);let confirmation=format!("installer-qa {sha}");
        let e=HashMap::from_iter([
            ("GITHUB_ACTIONS","true"),("RUNNER_ENVIRONMENT","github-hosted"),("RUNNER_OS","Windows"),
            ("GITHUB_REPOSITORY","nea-c/Nearly"),("GITHUB_EVENT_NAME","workflow_dispatch"),("GITHUB_REF","refs/heads/main"),
            ("GITHUB_RUN_ID","42"),("GITHUB_RUN_ATTEMPT","1"),("GITHUB_SHA",&sha),("GITHUB_WORKFLOW_SHA",&sha),("QA_CONTROLLER_SHA",&sha),("QA_CONFIRMATION",&confirmation),("NEARLY_QA_TOKEN",&token),
            ("RUNNER_TEMP",r"C:\runner\temp"),("LOCALAPPDATA",r"C:\guest\Local"),
            ("NEARLY_QA_RUN_ROOT",r"C:\runner\temp\nearly-installer-qa-42-1"),("NEARLY_QA_SCENARIO","success"),("QA_DESTINATION","default"),
        ].map(|(k,v)|(k.to_owned(),v.to_owned())));
        let p=Plan{schema_version:2,destination_kind:"default".into(),run_id:"42".into(),run_attempt:"1".into(),controller_sha:sha,token,source_version:"1.9.0".into(),target_version:"2.0.0".into(),target_file:"Nearly_r2.0_x64-setup.exe".into(),target_sha256:"c".repeat(64),target_bytes:1024,payload_sha256:"d".repeat(64),signature_file:"Nearly_r2.0_x64-setup.exe.sig".into()};
        (e,p,PathBuf::from(r"C:\guest\Local\Nearly\Nearly.exe"))
    }
    #[test] fn exact_manual_guest_context_accepts_installed_image(){let(e,p,i)=fixture();assert!(validate(&e,&p,&i,&p.token,&p.controller_sha).is_ok());}
    #[test]fn exact_private_install_branch_and_drive_destination_are_authorized(){
        let(mut e,mut p,_)=fixture();e.insert("GITHUB_REF".into(),"refs/heads/codex/private-install-directory".into());p.destination_kind="drive".into();e.insert("QA_DESTINATION".into(),"drive".into());
        let image=Path::new("D:\\Nearly QA 日本語 42-1\\Nearly.exe");assert!(validate(&e,&p,image,&p.token,&p.controller_sha).is_ok());
        for branch in ["refs/heads/codex/private-install-directory-extra","refs/heads/other","refs/pull/1/merge"]{e.insert("GITHUB_REF".into(),branch.into());assert!(validate(&e,&p,image,&p.token,&p.controller_sha).is_err());}
    }
    #[test]fn policy_helper_requires_exact_plugin_image_args_target_and_compiled_context(){
        let(mut e,p,_)=fixture();e.insert("GITHUB_REF".into(),"refs/heads/codex/private-install-directory".into());
        let bases=[PathBuf::from(r"C:\runner\temp"),PathBuf::from(r"C:\guest\Temp")];let image=Path::new(r"C:\guest\Temp\nszAB12.tmp\Nearly-install-policy.exe");
        for root in [r"C:\guest\Local\Nearly",r"C:\guest\Local\Nearly Installer QA 42-1\日本語 space\Nearly",r"D:\Nearly QA 日本語 42-1"]{
            let args=vec!["--nearly-install-check".into(),root.into()];assert!(validate_install_policy(&e,&p,image,&args,&bases,&p.token,&p.controller_sha).is_ok(),"{root}");
        }
        let consent=format!("new.{}.{}","a".repeat(32),"b".repeat(64));
        assert!(validate_install_policy(&e,&p,image,&["--nearly-install-prepare".into(),r"D:\Nearly QA 日本語 42-1".into(),consent],&bases,&p.token,&p.controller_sha).is_ok());
        assert!(validate_install_policy(&e,&p,Path::new(r"C:\runner\temp\nsa1.tmp\Nearly-install-policy.exe"),&["--nearly-install-check".into(),r"C:\guest\Local\Nearly".into()],&bases,&p.token,&p.controller_sha).is_ok());
        for bad in [r"C:\other\nszAB12.tmp\Nearly-install-policy.exe",r"C:\guest\Temp\sub\nszAB12.tmp\Nearly-install-policy.exe",r"C:\guest\Temp\anything.tmp\Nearly-install-policy.exe",r"C:\guest\Temp\nszAB12.tmp\Nearly.exe"]{
            assert!(validate_install_policy(&e,&p,Path::new(bad),&["--nearly-install-check".into(),r"C:\guest\Local\Nearly".into()],&bases,&p.token,&p.controller_sha).is_err());
        }
        for args in [vec!["--nearly-install-check".into(),r"D:\unrelated".into()],vec!["--nearly-install-prepare".into(),r"C:\guest\Local\Nearly".into(),"invalid".into()],vec!["--other".into(),r"C:\guest\Local\Nearly".into()]]{assert!(validate_install_policy(&e,&p,image,&args,&bases,&p.token,&p.controller_sha).is_err());}
        let mut bad=e.clone();bad.insert("GITHUB_SHA".into(),"c".repeat(40));assert!(validate_install_policy(&bad,&p,image,&["--nearly-install-check".into(),r"C:\guest\Local\Nearly".into()],&bases,&p.token,&p.controller_sha).is_err());
    }
    #[test]fn policy_helper_accepts_real_nsis_temp_names_and_rejects_other_formats(){
        let(e,p,_)=fixture();let bases=[PathBuf::from(r"C:\guest\Temp")];
        let args=vec!["--nearly-install-check".into(),r"C:\guest\Local\Nearly".into()];
        for prefix in b'a'..=b'z' {for unique in ["0","1","aF","1aB","FFFF"] {
            let image=bases[0].join(format!("ns{}{unique}.tmp",prefix as char)).join("Nearly-install-policy.exe");
            assert!(validate_install_policy(&e,&p,&image,&args,&bases,&p.token,&p.controller_sha).is_ok(),"{image:?}");
        }}
        for folder in ["nsa1.TMP","NSzAb12.tmp","nsGfF.TmP"] {
            let image=bases[0].join(folder).join("Nearly-install-policy.exe");
            assert!(validate_install_policy(&e,&p,&image,&args,&bases,&p.token,&p.controller_sha).is_ok(),"{folder}");
        }
        for folder in ["","ns1.tmp","nsz.tmp","nsz12345.tmp","nsz12g.tmp","nsa-1.tmp","nsa1.tmp.extra","nsa1.tmp ","msz1.tmp","ns_1.tmp","nsé1.tmp","ns😀1.tmp"] {
            let image=bases[0].join(folder).join("Nearly-install-policy.exe");
            assert!(validate_install_policy(&e,&p,&image,&args,&bases,&p.token,&p.controller_sha).is_err(),"{folder}");
        }
    }
    #[test] fn custom_guest_requires_exact_derived_unicode_root_and_destination_identity(){let(mut e,mut p,i)=fixture();p.destination_kind="custom".into();e.insert("QA_DESTINATION".into(),"custom".into());let image=Path::new(r"C:\guest\Local\Nearly Installer QA 42-1\日本語 space\Nearly\Nearly.exe");assert!(validate(&e,&p,image,&p.token,&p.controller_sha).is_ok());assert!(validate(&e,&p,&i,&p.token,&p.controller_sha).is_err());assert!(validate(&e,&p,Path::new(r"D:\Nearly QA 日本語 42-1\Nearly.exe"),&p.token,&p.controller_sha).is_err());e.insert("QA_DESTINATION".into(),"default".into());assert!(validate(&e,&p,image,&p.token,&p.controller_sha).is_err());p.destination_kind="drive".into();e.insert("QA_DESTINATION".into(),"drive".into());assert!(validate(&e,&p,image,&p.token,&p.controller_sha).is_err());}
    #[test] fn missing_or_foreign_guest_identity_refuses_before_io(){let(e,p,i)=fixture();for k in ["GITHUB_ACTIONS","RUNNER_ENVIRONMENT","RUNNER_OS","GITHUB_REPOSITORY","GITHUB_EVENT_NAME","GITHUB_REF","NEARLY_QA_TOKEN","GITHUB_SHA"]{let mut bad=e.clone();bad.insert(k.into(),"foreign".into());assert!(validate(&bad,&p,&i,&p.token,&p.controller_sha).is_err(),"{k}");}}
    #[test] fn root_traversal_foreign_image_and_config_override_are_refused(){let(e,p,i)=fixture();for value in [r"C:\runner\temp\..\outside",r"C:\runner\temp\nearly-installer-qa-42-2"]{let mut bad=e.clone();bad.insert("NEARLY_QA_RUN_ROOT".into(),value.into());assert!(validate(&bad,&p,&i,&p.token,&p.controller_sha).is_err());}assert!(validate(&e,&p,Path::new(r"D:\normal\Nearly.exe"),&p.token,&p.controller_sha).is_err());let mut bad=e.clone();bad.insert("SYNCFILES_CONFIG_DIR".into(),r"D:\normal".into());assert!(validate(&bad,&p,&i,&p.token,&p.controller_sha).is_err());}
    #[test] fn helper_requires_exact_nonce_backup_path(){let(e,p,_)=fixture();let valid=PathBuf::from(r"C:\guest\Local\Nearly\.Nearly-update-state").join("e".repeat(32)).join("previous-image.exe");assert!(validate(&e,&p,&valid,&p.token,&p.controller_sha).is_ok());for suffix in [r"..\previous-image.exe",r"short\previous-image.exe",r"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\other.exe"]{let bad=PathBuf::from(r"C:\guest\Local\Nearly\.Nearly-update-state").join(suffix);assert!(validate(&e,&p,&bad,&p.token,&p.controller_sha).is_err());}}
    #[test] fn malformed_plan_hash_version_size_and_unknown_fields_fail(){let(e,p,i)=fixture();let mut bad=p.clone();bad.target_bytes=0;assert!(validate(&e,&bad,&i,&p.token,&p.controller_sha).is_err());let mut bad=p.clone();bad.target_version="1.9.0".into();assert!(validate(&e,&bad,&i,&p.token,&p.controller_sha).is_err());let mut bad=p.clone();bad.payload_sha256="x".repeat(64);assert!(validate(&e,&bad,&i,&p.token,&p.controller_sha).is_err());assert!(serde_json::from_str::<Plan>(r#"{"schemaVersion":1,"unrecognized":true}"#).is_err());}
}
