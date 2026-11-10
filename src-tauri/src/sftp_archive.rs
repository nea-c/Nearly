//! Explicit SSH exec, separate from the browsing channel. Never replay mutation.
use super::*;
use crate::{local_zip::ArchiveOutcome, remote_zip::{self,Request}, zip_preflight::ArchiveError};
use russh::{Channel,ChannelMsg,Sig};
use tokio::time::{timeout,Instant};
type ExecChannel=Channel<client::Msg>;
const PROBE_TIMEOUT:Duration=Duration::from_secs(15);
const UNKNOWN:&str="remote_outcome_unknown";

impl Connection {
    pub(crate) fn archive(&mut self,request:&Request,parent:&str,stop:&AtomicBool,progress:Option<&crate::operation_progress::Progress>)->Result<ArchiveOutcome,ArchiveError>{
        if !self.archive_ready {
            runtime().block_on(self.archive_probe(stop))?;
            self.archive_ready=true;
        }
        let result=runtime().block_on(self.archive_execute(request,parent,stop,progress));
        if result.is_err(){let _=self.abort.0.shutdown(Shutdown::Both);}
        result
    }
    async fn archive_channel(&self,command:&str,stop:&AtomicBool)->Result<ExecChannel,ArchiveError>{
        let failure=||ArchiveError::new("remote_exec_unavailable");
        if stop.load(Ordering::SeqCst){return Err(ArchiveError::new("cancelled"));}
        let setup=async{
            let mut channel=self.session.channel_open_session().await.map_err(|_|failure())?;
            channel.exec(true,command.as_bytes()).await.map_err(|_|failure())?;
            loop{match channel.wait().await {
                Some(ChannelMsg::Success)=>return Ok(channel),
                Some(ChannelMsg::WindowAdjusted{..})=>{},
                _=>{let _=channel.close().await;return Err(failure());}
            }}
        };
        tokio::select!{biased;
            _=cancelled(stop)=>Err(ArchiveError::new("cancelled")),
            result=timeout(PROBE_TIMEOUT,setup)=>result.map_err(|_|failure())?,
        }
    }
    async fn archive_probe_command(&self,command:&str,stop:&AtomicBool)->Result<(Option<u32>,Vec<u8>),ArchiveError>{
        let mut channel=self.archive_channel(command,stop).await?;
        let operation=async {
            channel.eof().await.map_err(|_|ArchiveError::new("remote_exec_unavailable"))?;
            let mut output=Vec::new();let mut received=0;let mut status=None;
            while let Some(message)=channel.wait().await {
                match message {
                    ChannelMsg::Data{data}=>{received+=data.len();output.extend_from_slice(&data);},
                    ChannelMsg::ExtendedData{data,..}=>received+=data.len(),
                    ChannelMsg::ExitStatus{exit_status}=>status=Some(exit_status),
                    ChannelMsg::Close=>break,
                    ChannelMsg::Failure|ChannelMsg::ExitSignal{..}=>return Err(ArchiveError::new("remote_exec_unavailable")),
                    _=>{},
                }
                if received>8192{return Err(ArchiveError::new("remote_exec_unavailable"));}
            }
            Ok((status,output))
        };
        let result=tokio::select!{biased;
            _=cancelled(stop)=>Err(ArchiveError::new("cancelled")),
            result=timeout(PROBE_TIMEOUT,operation)=>result.unwrap_or_else(|_|Err(ArchiveError::new("remote_exec_unavailable"))),
        };
        let _=timeout(Duration::from_secs(1),channel.close()).await;
        result
    }
    async fn archive_probe(&self,stop:&AtomicBool)->Result<(),ArchiveError>{
        // Static, read-only commands. No probe happens on connect/browse/menu.
        let (status,os)=self.archive_probe_command("uname -s",stop).await?;
        if status!=Some(0)||String::from_utf8_lossy(&os).trim()!="Linux" {
            // Windows exec shells need a distinct static command. The result
            // never enables unsafe path-based .NET archive publication.
            if status!=Some(0){let _=self.archive_probe_command("cmd.exe /d /c ver",stop).await;}
            return Err(ArchiveError::new("remote_platform_unsupported"));
        }
        let command="python3 -c 'import sys,os,zipfile,zlib,ctypes,select; assert sys.version_info >= (3,8); print(\"NEARLY_ZIP_PYTHON3\" if hasattr(ctypes.CDLL(None),\"renameat2\") else \"NEARLY_ZIP_NO_SAFE_PUBLISH\")'";
        let (status,output)=self.archive_probe_command(command,stop).await?;
        if status==Some(0)&&String::from_utf8_lossy(&output).trim()=="NEARLY_ZIP_NO_SAFE_PUBLISH" {return Err(ArchiveError::new("remote_publish_unavailable"));}
        if status!=Some(0)||String::from_utf8_lossy(&output).trim()!="NEARLY_ZIP_PYTHON3" {return Err(ArchiveError::new("remote_tool_unavailable"));}
        Ok(())
    }
    async fn archive_namespace_matches(&self,path:&str,token:&str)->bool {
        let verify=async {
            let attrs=self.raw.lstat(path).await.ok()?.attrs;
            if !attrs.is_regular() || attrs.size!=Some(token.len() as u64){return None;}
            let handle=self.raw.open(path,OpenFlags::READ,FileAttributes::empty()).await.ok()?.handle;
            let mut bytes=Vec::new();let mut valid=true;
            while bytes.len()<token.len(){
                match self.raw.read(handle.clone(),bytes.len() as u64,(token.len()-bytes.len()) as u32).await {
                    Ok(data) if !data.data.is_empty() && data.data.len()<=token.len()-bytes.len()=>bytes.extend_from_slice(&data.data),
                    _=>{valid=false;break;}
                }
            }
            let closed=self.raw.close(handle).await;
            if closed.is_err(){return None;}
            if valid && bytes==token.as_bytes(){Some(())}else{None}
        };
        timeout(Duration::from_secs(10),verify).await.ok().flatten().is_some()
    }
    async fn archive_execute(&self,request:&Request,parent:&str,stop:&AtomicBool,progress:Option<&crate::operation_progress::Progress>)->Result<ArchiveOutcome,ArchiveError>{
        if stop.load(Ordering::SeqCst){return Err(ArchiveError::new("cancelled"));}
        let payload=serde_json::json!({"action":request.action,"sources":request.sources,"destination":request.destination});
        let encoded=base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&payload).map_err(|_|ArchiveError::new("invalid_request"))?);
        let source=format!("NEARLY_REQUEST = '{encoded}'\n{}",include_str!("remote_zip.py"));
        // The only interpolated command value is our numeric source length.
        // Names, paths, and JSON travel on stdin as base64, never via a shell.
        let command=format!("python3 -u -c 'import sys;exec(compile(sys.stdin.buffer.read({}),\"nearly-remote-zip\",\"exec\"))'",source.len());
        let mut channel=self.archive_channel(&command,stop).await?;
        if timeout(PROBE_TIMEOUT,channel.data(source.as_bytes())).await.ok().and_then(Result::ok).is_none(){let _=channel.close().await;return Err(ArchiveError::new(UNKNOWN));}
        let mut decoder=remote_zip::Decoder::new();
        let mut stage:Option<String>=None;let mut confirmed=false;
        let mut terminal:Option<Result<ArchiveOutcome,ArchiveError>>=None;
        let mut deadline=Instant::now()+Duration::from_secs(330);
        let mut cancelling=false;let mut received_stderr=0usize;
        let mut last_counts=(0usize,0u64);
        if let Some(p)=progress{p.phase("scanning");}
        let transport=async {
            loop {
                let message=tokio::select!{biased;
                    _=cancelled(stop),if !cancelling && terminal.is_none()=>{
                        cancelling=true;deadline=Instant::now()+Duration::from_secs(5);
                        let _=timeout(Duration::from_secs(1),channel.signal(Sig::TERM)).await;
                        let _=timeout(Duration::from_secs(1),channel.eof()).await;
                        continue;
                    },
                    _=tokio::time::sleep_until(deadline)=>return Err(ArchiveError::new(UNKNOWN)),
                    message=channel.wait()=>message,
                };
                match message {
                    Some(ChannelMsg::Data{data})=>for frame in decoder.feed(&data)? {
                        if terminal.is_some(){return Err(ArchiveError::new(UNKNOWN));}
                        match frame["type"].as_str(){
                            Some("namespace")=>{
                                if stage.is_some(){return Err(ArchiveError::new(UNKNOWN));}
                                let (stage_path,path,token)=remote_zip::namespace(&frame,parent)?;
                                stage=Some(stage_path.into());
                                let valid=!cancelling && self.archive_namespace_matches(path,token).await && !stop.load(Ordering::SeqCst);
                                let answer=if valid{b"NEARLY_CONFIRM\n".as_slice()}else{b"NEARLY_REJECT\n".as_slice()};
                                timeout(PROBE_TIMEOUT,channel.data(answer)).await.map_err(|_|ArchiveError::new(UNKNOWN))?.map_err(|_|ArchiveError::new(UNKNOWN))?;
                                channel.eof().await.map_err(|_|ArchiveError::new(UNKNOWN))?;
                                confirmed=valid;
                            },
                            Some("progress")=>{
                                if !confirmed{return Err(ArchiveError::new(UNKNOWN));}
                                let counts=remote_zip::counts(&frame)?;
                                if counts.0<last_counts.0 || counts.1<last_counts.1{return Err(ArchiveError::new(UNKNOWN));}
                                last_counts=counts;
                                if let Some(p)=progress{p.archive(counts.0,counts.1);}
                            },
                            Some("result")=>{
                                if !confirmed{return Err(ArchiveError::new(UNKNOWN));}
                                let(entries,bytes)=remote_zip::counts(&frame)?;
                                if entries<last_counts.0 || bytes<last_counts.1{return Err(ArchiveError::new(UNKNOWN));}
                                if let Some(p)=progress{p.archive(entries,bytes);p.phase("finalizing");}
                                terminal=Some(Ok(ArchiveOutcome{final_path:request.destination.clone(),action:request.action,entries,bytes}));
                                deadline=Instant::now()+Duration::from_secs(5);
                            },
                            Some("error")=>{
                                terminal=Some(Err(remote_zip::remote_error(&frame,stage.as_deref())));
                                deadline=Instant::now()+Duration::from_secs(5);
                            },
                            _=>return Err(ArchiveError::new(UNKNOWN)),
                        }
                    },
                    Some(ChannelMsg::ExtendedData{data,..})=>{received_stderr=received_stderr.saturating_add(data.len());if received_stderr>8192{return Err(ArchiveError::new(UNKNOWN));}},
                    Some(ChannelMsg::Close)|None=>break,
                    Some(ChannelMsg::ExitSignal{..})|Some(ChannelMsg::Failure)=>break,
                    _=>{},
                }
            }
            Ok(())
        }.await;
        if terminal.is_none(){let _=timeout(Duration::from_secs(1),channel.signal(Sig::TERM)).await;}
        let _=timeout(Duration::from_secs(1),channel.close()).await;
        // An acknowledged published result wins over a later disconnect/cancel.
        // Without a terminal frame the operation may have published: no retry.
        if let Some(result)=terminal{return result;}
        let mut error=transport.err().unwrap_or_else(||ArchiveError::new(UNKNOWN));
        error.stage_path=stage;
        Err(error)
    }
}
