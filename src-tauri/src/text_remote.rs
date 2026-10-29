use crate::{sftp::{Connection,checked_directory},file_ops::check,text_codec::MAX_BYTES};
use russh_sftp::{client::error::Error as SftpError,protocol::{FileAttributes,OpenFlags,Packet,StatusCode}};
use std::sync::atomic::AtomicBool;
pub struct Snapshot{pub bytes:Vec<u8>,attrs:FileAttributes}
fn parent(path:&str)->&str{let p=path.rsplit_once('/').unwrap().0;if p.is_empty(){"/"}else{p}}
fn same(a:&Snapshot,b:&Snapshot)->bool{a.bytes==b.bytes&&crate::transfer_io::attributes_match(&a.attrs,&b.attrs)}
async fn read_inner(c:&Connection,path:&str,stop:&AtomicBool)->Result<Snapshot,String>{
 checked_directory(&c.raw,parent(path),false).await?;check(stop)?;
 let attrs=c.raw.lstat(path).await.map_err(|_|"Remote file lookup failed")?.attrs;
 if attrs.is_symlink()||!attrs.file_type().is_file(){return Err("Only regular non-symlink text files can be edited".into());}let size=attrs.size.ok_or("Remote file size unavailable")?;if size>MAX_BYTES as u64{return Err("Text editor limit is 1 MiB".into());}
 let handle=c.raw.open(path,OpenFlags::READ,FileAttributes::empty()).await.map_err(|_|"Remote text open failed")?.handle;
 let read=async{let mut bytes=Vec::new();while (bytes.len() as u64)<size{check(stop)?;let data=c.raw.read(handle.clone(),bytes.len() as u64,(size-bytes.len() as u64).min(32768) as u32).await.map_err(|_|"Remote text read failed")?.data;if data.is_empty()||bytes.len()+data.len()>size as usize{return Err("Remote file changed during read".into());}bytes.extend_from_slice(&data);}
  let opened=c.raw.fstat(handle.clone()).await.map_err(|_|"Remote text verification failed")?.attrs;if !crate::transfer_io::attributes_match(&attrs,&opened){return Err("Remote file changed while opening".into());}Ok::<_,String>(bytes)}.await;
 let close=c.raw.close(handle).await.map_err(|_|"Remote text close acknowledgement failed");let bytes=read?;close?;
 checked_directory(&c.raw,parent(path),false).await?;let after=c.raw.lstat(path).await.map_err(|_|"Remote file disappeared")?.attrs;
 if after.is_symlink()||!after.file_type().is_file()||!crate::transfer_io::attributes_match(&attrs,&after){return Err("Remote file changed while opening".into());}Ok(Snapshot{bytes,attrs})
}
pub fn read(c:&mut Connection,path:&str,stop:&AtomicBool)->Result<Snapshot,String>{c.run(stop,read_inner(c,path,stop))}
pub fn read_only(c:&Connection,s:&Snapshot)->Option<String>{if !c.posix_rename{Some("Server lacks safe atomic replacement; this file is read-only".into())}else if s.attrs.permissions.is_none()||s.attrs.permissions.is_some_and(|p|p&0o7000!=0)||s.attrs.uid.is_none()||s.attrs.gid.is_none(){Some("Remote file ownership or special permissions cannot be preserved; read-only".into())}else{None}}
pub fn save(c:&mut Connection,path:&str,original:&Snapshot,bytes:&[u8],stop:&AtomicBool)->Result<Snapshot,String>{
 if bytes.len()>MAX_BYTES{return Err("Text editor limit is 1 MiB".into());}if let Some(reason)=read_only(c,original){return Err(reason);}
 let mut nonce=[0u8;16];getrandom::fill(&mut nonce).map_err(|_|"Random stage unavailable")?;let stage=format!("{}/.nearly-edit-{}.partial",parent(path).trim_end_matches('/'),nonce.iter().map(|b|format!("{b:02x}")).collect::<String>());
 c.run(stop,async{
  let current=read_inner(c,path,stop).await?;if !same(original,&current){return Err("External remote file change detected; original was not overwritten. Reopen and compare your edits".into());}if original.bytes==bytes{return Ok(current);}
  check(stop)?;checked_directory(&c.raw,parent(path),false).await?;let mut attrs=FileAttributes::empty();attrs.permissions=original.attrs.permissions.map(|p|p&0o777);
  let handle=c.raw.open(stage.clone(),OpenFlags::CREATE|OpenFlags::EXCLUDE|OpenFlags::WRITE,attrs).await.map_err(|_|"Exclusive editor staging creation failed")?.handle;
  let write=async{for (i,chunk) in bytes.chunks(32768).enumerate(){check(stop)?;c.raw.write(handle.clone(),(i*32768) as u64,chunk.to_vec()).await.map_err(|_|"Remote edit write failed; original retained")?;}
   let staged=c.raw.fstat(handle.clone()).await.map_err(|_|"Editor stage verification failed")?.attrs;
   if staged.is_symlink()||!staged.file_type().is_file()||staged.size!=Some(bytes.len() as u64)||staged.permissions.map(|p|p&0o777)!=original.attrs.permissions.map(|p|p&0o777)||staged.uid!=original.attrs.uid||staged.gid!=original.attrs.gid{return Err("Remote file permissions/ownership cannot be preserved; original retained".into());}Ok::<(),String>(())}.await;
  let close=c.raw.close(handle).await.map_err(|_|"Editor stage close acknowledgement uncertain");write?;close?;
  let current=read_inner(c,path,stop).await?;if !same(original,&current){return Err("External remote file change detected before publication; original retained".into());}check(stop)?;
  let mut data=Vec::new();for name in [&stage,path]{data.extend_from_slice(&(name.len() as u32).to_be_bytes());data.extend_from_slice(name.as_bytes());}
  match c.raw.extended("posix-rename@openssh.com",data).await{Ok(Packet::Status(s))if s.status_code==StatusCode::Ok=>{},_=>return Err("Remote save result uncertain; it may already be saved. Reopen and compare before retrying".into())}
  let after=read_inner(c,path,stop).await?;if after.bytes!=bytes{return Err("Remote file changed again after save; reopen and compare before retrying".into());}Ok(after)
 }).map_err(|e|format!("{e}. If created, owned editor staging may remain at {stage}; it was not automatically deleted or retried"))
}
