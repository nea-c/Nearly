//! Consent-bound fresh-install directory preparation. The OS adapter is never
//! used by mutation tests; those tests exercise the state machine with a mock.
use std::ffi::OsString;

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum Refusal { Rejected, Elevated }
type Result<T> = std::result::Result<T,Refusal>;
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum Kind { Ready, New, Empty }
impl Kind {fn label(self)->&'static str {match self {Self::Ready=>"ready",Self::New=>"new",Self::Empty=>"empty"}}}
#[derive(Clone,Debug)]
struct Snapshot {kind:Kind, fingerprint:String, elevated:bool}
fn classify_leaf(empty:bool,user_owned:bool,private:bool)->Result<Kind>{
    if !user_owned{return Err(Refusal::Rejected);}
    // Ready is read-only admission. NSIS separately enforces its default-only
    // retained-data whitelist before writing an unregistered private folder.
    // Preparation never acquires authority to replace a nonempty directory.
    if private{return Ok(Kind::Ready);}
    if !empty{return Err(Refusal::Rejected);}Ok(Kind::Empty)
}
fn plain_directory(attributes:u32)->bool {attributes&0x410==0x10}
trait Storage {
    fn snapshot(&mut self)->Result<Snapshot>;
    fn preserve_empty_original(&mut self,nonce:&str)->Result<()>;
    fn verify_preserved_empty(&mut self)->Result<()>;
    fn create_private(&mut self)->Result<()>;
    fn verify_private_empty(&mut self)->Result<()>;
}
fn hex(value:&str,count:usize)->bool {value.len()==count && value.bytes().all(|v|v.is_ascii_digit()||(b'a'..=b'f').contains(&v))}
fn issue(snapshot:&Snapshot,nonce:&str)->Result<String> {
    if snapshot.elevated {return Err(Refusal::Elevated);}
    if !hex(nonce,32)||!hex(&snapshot.fingerprint,64){return Err(Refusal::Rejected);}
    let digest=crate::update_transaction::sha256(format!("Nearly/install-prepare/v1/{}/{nonce}/{}",snapshot.kind.label(),snapshot.fingerprint).as_bytes());
    Ok(format!("{}.{nonce}.{digest}",snapshot.kind.label()))
}
fn check(storage:&mut impl Storage,nonce:&str)->Result<(i32,String)> {
    let snapshot=storage.snapshot()?;let token=issue(&snapshot,nonce)?;
    Ok((if snapshot.kind==Kind::Ready{0}else{10},token))
}
fn prepare(storage:&mut impl Storage,token:&str)->Result<()> {
    let mut parts=token.split('.');let kind=parts.next().ok_or(Refusal::Rejected)?;
    let nonce=parts.next().ok_or(Refusal::Rejected)?;let digest=parts.next().ok_or(Refusal::Rejected)?;
    if parts.next().is_some()||!matches!(kind,"ready"|"new"|"empty")||!hex(nonce,32)||!hex(digest,64){return Err(Refusal::Rejected);}
    let snapshot=storage.snapshot()?;
    if issue(&snapshot,nonce)?!=token{return Err(Refusal::Rejected);}
    match snapshot.kind {
        Kind::Ready=>{},
        Kind::New=>storage.create_private()?,
        Kind::Empty=>{storage.preserve_empty_original(nonce)?;storage.verify_preserved_empty()?;storage.create_private()?;},
    }
    storage.verify_private_empty()
}

pub(crate) fn dispatch(args:impl IntoIterator<Item=OsString>)->Option<i32> {
    let args:Vec<_>=args.into_iter().skip(1).collect();
    if !args.iter().any(|a|a.to_string_lossy().starts_with("--nearly-install-")){return None;}
    let result=(||->Result<(i32,Option<String>)>{
        let command=args.first().and_then(|s|s.to_str()).ok_or(Refusal::Rejected)?;
        let preparing=command=="--nearly-install-prepare";
        if (!preparing&&command!="--nearly-install-check")||args.len()!=if preparing{3}else{2}{return Err(Refusal::Rejected);}
        let path=args[1].to_str().ok_or(Refusal::Rejected)?;
        #[cfg(windows)] {
            let mut storage=native::NativeStorage::new(path,preparing)?;
            if preparing {
                prepare(&mut storage,args[2].to_str().ok_or(Refusal::Rejected)?)?;Ok((0,None))
            } else {
                let mut nonce=[0u8;16];getrandom::fill(&mut nonce).map_err(|_|Refusal::Rejected)?;
                let nonce=nonce.iter().map(|b|format!("{b:02x}")).collect::<String>();
                let (code,token)=check(&mut storage,&nonce)?;Ok((code,Some(token)))
            }
        }
        #[cfg(not(windows))] {let _=path;Err(Refusal::Rejected)}
    })();
    Some(match result {
        Ok((code,token))=>{
            if let Some(token)=token {
                use std::io::Write;
                if std::io::stdout().write_all(token.as_bytes()).is_err(){return Some(5);}
            }code
        },Err(Refusal::Elevated)=>8,Err(Refusal::Rejected)=>5,
    })
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::{install_root::native as policy,update_transaction::windows_impl as fs};
    use std::{ffi::c_void,fs::{File,OpenOptions},os::windows::{ffi::OsStrExt,fs::OpenOptionsExt,io::{AsRawHandle,FromRawHandle}},path::{Path,PathBuf}};
    use windows::{Win32::{Foundation::{HANDLE,UNICODE_STRING,OBJECT_ATTRIBUTE_FLAGS},System::IO::IO_STATUS_BLOCK,Storage::FileSystem::{FILE_ACCESS_RIGHTS,FILE_FLAGS_AND_ATTRIBUTES,FILE_SHARE_MODE}},Wdk::{Foundation::OBJECT_ATTRIBUTES,Storage::FileSystem::{NtCreateFile,NTCREATEFILE_CREATE_DISPOSITION,NTCREATEFILE_CREATE_OPTIONS}}};
    type Handle=*mut c_void;
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(file:Handle,class:u32,info:*mut c_void,length:u32)->i32;
        fn GetLastError()->u32;
        fn LocalFree(memory:Handle)->Handle;
    }
    #[link(name="advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(value:*const u16,revision:u32,descriptor:*mut Handle,size:*mut u32)->i32;
        #[cfg(test)]fn GetSecurityDescriptorControl(descriptor:Handle,control:*mut u16,revision:*mut u32)->i32;
        #[cfg(test)]fn GetSecurityDescriptorDacl(descriptor:Handle,present:*mut i32,acl:*mut Handle,defaulted:*mut i32)->i32;
    }
    #[link(name="ntdll")]
    unsafe extern "system" {
        fn NtSetInformationFile(file:Handle,status:*mut IO_STATUS_BLOCK,info:*const c_void,bytes:u32,class:u32)->i32;
    }
    struct Descriptor(Handle);
    impl Drop for Descriptor {fn drop(&mut self){unsafe{LocalFree(self.0);}}}
    fn descriptor(user:&str)->Result<Descriptor>{
        let sddl=format!("D:P(A;OICI;FA;;;{user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        let text:Vec<u16>=sddl.encode_utf16().chain(Some(0)).collect();let mut result=std::ptr::null_mut();
        if unsafe{ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(),1,&mut result,std::ptr::null_mut())}==0{return Err(Refusal::Rejected);}
        Ok(Descriptor(result))
    }
    fn rejected<T>(_:T)->Refusal{Refusal::Rejected}
    fn append(out:&mut Vec<u8>,part:&[u8]) {out.extend_from_slice(&(part.len() as u64).to_le_bytes());out.extend_from_slice(part);}
    fn identity(out:&mut Vec<u8>,file:&File)->Result<()> {
        let info=fs::info(file).map_err(rejected)?;
        append(out,&serde_json::to_vec(&fs::identity(&info)).map_err(rejected)?);Ok(())
    }
    /// Enumerate the pinned directory itself, never a path-based search that
    /// could accidentally inspect a replacement. No child is opened or removed.
    fn empty(file:&File)->Result<bool>{
        let mut buffer=vec![0u64;8192];let mut restart=true;
        loop {
            if unsafe{GetFileInformationByHandleEx(file.as_raw_handle(),if restart{15}else{14},buffer.as_mut_ptr().cast(),(buffer.len()*8) as u32)}==0 {
                return if unsafe{GetLastError()}==18{Ok(true)}else{Err(Refusal::Rejected)};
            }
            restart=false;let bytes=unsafe{std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(),buffer.len()*8)};
            let mut offset=0usize;
            loop {
                if offset+68>bytes.len(){return Err(Refusal::Rejected);}
                let next=u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap()) as usize;
                let length=u32::from_le_bytes(bytes[offset+60..offset+64].try_into().unwrap()) as usize;
                let limit=if next==0{bytes.len()}else{offset.checked_add(next).ok_or(Refusal::Rejected)?};
                if length%2!=0||limit>bytes.len()||offset+68+length>limit{return Err(Refusal::Rejected);}
                let name:Vec<u16>=bytes[offset+68..offset+68+length].chunks_exact(2).map(|b|u16::from_le_bytes([b[0],b[1]])).collect();
                if name!=[b'.' as u16]&&name!=[b'.' as u16,b'.' as u16]{return Ok(false);}
                if next==0{break;}if next<68{return Err(Refusal::Rejected);}offset=limit;
            }
        }
    }
    pub(super) struct NativeStorage {
        path:PathBuf,preparing:bool,trusted:policy::Trusted,parents:Vec<File>,leaf:Option<File>,preserved:Option<File>,original_security:Option<Vec<u8>>,
    }
    impl NativeStorage {
        pub(super) fn new(path:&str,preparing:bool)->Result<Self>{
            policy::require_user_token().map_err(|error|if error.starts_with("Elevated "){Refusal::Elevated}else{Refusal::Rejected})?;
            crate::install_root::validate_path(path).map_err(rejected)?;
            policy::require_unregistered(Path::new(path)).map_err(rejected)?;
            Ok(Self{path:PathBuf::from(path),preparing,trusted:policy::Trusted::capture().map_err(rejected)?,parents:vec![],leaf:None,preserved:None,original_security:None})
        }
        fn parent(&self)->Result<&File>{self.parents.last().ok_or(Refusal::Rejected)}
        fn verify_leaf(&self)->Result<()> {
            // A directory handle pins its identity, but write sharing alone
            // does not freeze in-place metadata/reparse changes. Revalidate
            // every exact ancestor before attesting to the final namespace.
            let mut paths:Vec<_>=self.path.parent().ok_or(Refusal::Rejected)?.ancestors().collect();paths.reverse();
            if paths.len()!=self.parents.len(){return Err(Refusal::Rejected);}
            for (path,guard) in paths.into_iter().zip(&self.parents) {
                if !plain_directory(fs::info(guard).map_err(rejected)?.dwFileAttributes){return Err(Refusal::Rejected);}
                policy::validate_final_root_name(path,guard).map_err(rejected)?;
                if !policy::inspect_directory(guard,path,false,&self.trusted).map_err(rejected)?.private{return Err(Refusal::Rejected);}
            }
            let leaf=self.leaf.as_ref().ok_or(Refusal::Rejected)?;
            if !plain_directory(fs::info(leaf).map_err(rejected)?.dwFileAttributes){return Err(Refusal::Rejected);}
            policy::validate_final_root_name(&self.path,leaf).map_err(rejected)?;
            let security=policy::inspect_directory(leaf,&self.path,true,&self.trusted).map_err(rejected)?;
            if !security.user_owned||!security.private||!empty(leaf)?{return Err(Refusal::Rejected);}Ok(())
        }
    }
    impl Storage for NativeStorage {
        fn snapshot(&mut self)->Result<Snapshot>{
            let mut binding=Vec::new();append(&mut binding,self.path.to_str().ok_or(Refusal::Rejected)?.as_bytes());
            let parent=self.path.parent().ok_or(Refusal::Rejected)?;
            let mut paths:Vec<_>=parent.ancestors().collect();paths.reverse();
            for path in paths {
                let guard=fs::directory(path,0x20081|if self.preparing&&path==parent{4}else{0}).map_err(rejected)?;
                policy::validate_final_root_name(path,&guard).map_err(rejected)?;
                let security=policy::inspect_directory(&guard,path,false,&self.trusted).map_err(rejected)?;
                if !security.private{return Err(Refusal::Rejected);}
                identity(&mut binding,&guard)?;append(&mut binding,&security.bytes);self.parents.push(guard);
            }
            let opened=OpenOptions::new().access_mode(0x20081|if self.preparing{0x10000}else{0}).share_mode(if self.preparing{1}else{3}).custom_flags(0x02200000).open(&self.path);
            let kind=match opened {
                Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{append(&mut binding,b"absent");Kind::New},
                Err(_)=>return Err(Refusal::Rejected),
                Ok(file)=>{
                    if !plain_directory(fs::info(&file).map_err(rejected)?.dwFileAttributes){return Err(Refusal::Rejected);}
                    policy::validate_final_root_name(&self.path,&file).map_err(rejected)?;
                    let security=policy::inspect_directory(&file,&self.path,true,&self.trusted).map_err(rejected)?;
                    let kind=classify_leaf(empty(&file)?,security.user_owned,security.private)?;
                    identity(&mut binding,&file)?;append(&mut binding,&security.bytes);self.original_security=Some(security.bytes);self.leaf=Some(file);
                    kind
                }
            };
            Ok(Snapshot{kind,fingerprint:crate::update_transaction::sha256(&binding),elevated:false})
        }
        fn preserve_empty_original(&mut self,nonce:&str)->Result<()> {
            if !self.preparing||!hex(nonce,32){return Err(Refusal::Rejected);}
            let original=self.leaf.as_ref().ok_or(Refusal::Rejected)?;
            let security=policy::inspect_directory(original,&self.path,true,&self.trusted).map_err(rejected)?;
            if !security.user_owned||self.original_security.as_ref()!=Some(&security.bytes)||!empty(original)?{return Err(Refusal::Rejected);}
            let name:Vec<u16>=format!(".Nearly-preserved-{nonce}").encode_utf16().collect();
            #[repr(C)]struct Rename {replace:u8,root:Handle,length:u32,name:[u16;1]}
            let offset=std::mem::offset_of!(Rename,name);let mut data=vec![0u64;(offset+name.len()*2+7)/8];
            let ptr=data.as_mut_ptr().cast::<u8>();
            unsafe {let header=ptr.cast::<Rename>();(*header).replace=0;(*header).root=self.parent()?.as_raw_handle();(*header).length=(name.len()*2) as u32;std::ptr::copy_nonoverlapping(name.as_ptr().cast::<u8>(),ptr.add(offset),name.len()*2);}
            let mut io=IO_STATUS_BLOCK::default();
            if unsafe{NtSetInformationFile(original.as_raw_handle(),&mut io,ptr.cast(),(offset+name.len()*2) as u32,10)}<0{return Err(Refusal::Rejected);}
            let sibling=self.path.parent().ok_or(Refusal::Rejected)?.join(format!(".Nearly-preserved-{nonce}"));
            policy::validate_final_root_name(&sibling,original).map_err(rejected)?;
            self.preserved=self.leaf.take();Ok(())
        }
        fn create_private(&mut self)->Result<()> {
            if !self.preparing||self.leaf.is_some(){return Err(Refusal::Rejected);}
            let descriptor=descriptor(&self.trusted.user_sid_string().map_err(rejected)?)?;
            let mut name:Vec<u16>=self.path.file_name().ok_or(Refusal::Rejected)?.encode_wide().collect();
            let unicode=UNICODE_STRING{Length:(name.len()*2) as u16,MaximumLength:(name.len()*2) as u16,Buffer:windows::core::PWSTR(name.as_mut_ptr())};
            let attributes=OBJECT_ATTRIBUTES{Length:std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,RootDirectory:HANDLE(self.parent()?.as_raw_handle()),ObjectName:&unicode,Attributes:OBJECT_ATTRIBUTE_FLAGS(0x40),SecurityDescriptor:descriptor.0.cast(),..Default::default()};
            let mut handle=HANDLE::default();let mut io=IO_STATUS_BLOCK::default();
            let status=unsafe{NtCreateFile(&mut handle,FILE_ACCESS_RIGHTS(0x00130081),&attributes,&mut io,None,FILE_FLAGS_AND_ATTRIBUTES(0x10),FILE_SHARE_MODE(1),NTCREATEFILE_CREATE_DISPOSITION(2),NTCREATEFILE_CREATE_OPTIONS(0x00200021),None,0)};
            if handle.is_invalid(){return Err(Refusal::Rejected);}
            let created=unsafe{File::from_raw_handle(handle.0)};
            if status.0<0||io.Information!=2{return Err(Refusal::Rejected);}
            self.leaf=Some(created);self.verify_leaf()
        }
        fn verify_preserved_empty(&mut self)->Result<()> {
            let original=self.preserved.as_ref().ok_or(Refusal::Rejected)?;
            if !plain_directory(fs::info(original).map_err(rejected)?.dwFileAttributes){return Err(Refusal::Rejected);}
            let security=policy::inspect_directory(original,&self.path,true,&self.trusted).map_err(rejected)?;
            if !security.user_owned||self.original_security.as_ref()!=Some(&security.bytes)||!empty(original)?{return Err(Refusal::Rejected);}Ok(())
        }
        fn verify_private_empty(&mut self)->Result<()> {self.verify_leaf()}
    }
    #[cfg(test)] mod tests {
        use super::*;
        #[test]fn private_descriptor_is_constructed_only_in_memory(){
            let trusted=policy::Trusted::capture().unwrap();let descriptor=descriptor(&trusted.user_sid_string().unwrap()).unwrap();assert!(!descriptor.0.is_null());
            let(mut control,mut revision)=(0u16,0u32);
            assert_ne!(unsafe{GetSecurityDescriptorControl(descriptor.0,&mut control,&mut revision)},0);
            assert_ne!(control&0x1000,0,"new leaf DACL must be protected from parent inheritance");
            let(mut present,mut defaulted)=(0,0);let mut acl=std::ptr::null_mut();
            assert_ne!(unsafe{GetSecurityDescriptorDacl(descriptor.0,&mut present,&mut acl,&mut defaulted)},0);assert_ne!(present,0);assert!(!acl.is_null());
            assert_eq!(unsafe{std::ptr::read_unaligned((acl as *const u8).add(4).cast::<u16>())},3,"only user, SYSTEM and Administrators receive allow entries");
        }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    const NONCE:&str="0123456789abcdef0123456789abcdef";
    struct Mock {snapshot:Snapshot,events:Vec<&'static str>,fail:Option<&'static str>}
    impl Mock {fn new(kind:Kind)->Self {Self {snapshot:Snapshot{kind,fingerprint:"a".repeat(64),elevated:false},events:vec![],fail:None}}}
    impl Storage for Mock {
        fn snapshot(&mut self)->Result<Snapshot>{self.events.push("read");Ok(self.snapshot.clone())}
        fn preserve_empty_original(&mut self,_:&str)->Result<()>{self.events.push("preserve-no-overwrite");if self.fail==Some("preserve"){Err(Refusal::Rejected)}else{Ok(())}}
        fn verify_preserved_empty(&mut self)->Result<()>{self.events.push("verify-preserved");if self.fail==Some("preserved-race"){Err(Refusal::Rejected)}else{Ok(())}}
        fn create_private(&mut self)->Result<()>{self.events.push("create-private-exclusive");if self.fail==Some("create"){Err(Refusal::Rejected)}else{Ok(())}}
        fn verify_private_empty(&mut self)->Result<()>{self.events.push("verify");if self.fail==Some("verify"){Err(Refusal::Rejected)}else{Ok(())}}
    }
    #[test] fn planning_is_read_only_and_reports_explicit_consent(){
        for (kind,code) in [(Kind::Ready,0),(Kind::New,10),(Kind::Empty,10)] {
            let mut mock=Mock::new(kind);let result=check(&mut mock,NONCE).unwrap();
            assert_eq!(result,(code,issue(&mock.snapshot,NONCE).unwrap()));assert_eq!(mock.events,vec!["read"]);
        }
    }
    #[test] fn shared_nonempty_and_foreign_owned_targets_are_always_rejected(){
        for private in [true,false] {
            assert_eq!(classify_leaf(true,false,private),Err(Refusal::Rejected));
            assert_eq!(classify_leaf(false,false,private),Err(Refusal::Rejected));
        }
        assert_eq!(classify_leaf(false,true,false),Err(Refusal::Rejected));
        assert_eq!(classify_leaf(false,true,true),Ok(Kind::Ready));
        assert_eq!(classify_leaf(true,true,true),Ok(Kind::Ready));
        assert_eq!(classify_leaf(true,true,false),Ok(Kind::Empty));
    }
    #[test]fn read_only_ready_for_private_retained_data_never_grants_preparation(){
        let mut mock=Mock::new(Kind::Ready);mock.fail=Some("verify");let token=issue(&mock.snapshot,NONCE).unwrap();
        assert_eq!(prepare(&mut mock,&token),Err(Refusal::Rejected));assert_eq!(mock.events,vec!["read","verify"]);
    }
    #[test]fn plain_leaf_must_be_directory_and_never_reparse(){
        assert!(plain_directory(0x10));assert!(plain_directory(0x12));
        for attributes in [0,0x80,0x400,0x410,0x412]{assert!(!plain_directory(attributes));}
    }
    #[test] fn unchanged_empty_folder_is_preserved_before_private_replacement(){
        let mut mock=Mock::new(Kind::Empty);let token=issue(&mock.snapshot,NONCE).unwrap();
        prepare(&mut mock,&token).unwrap();assert_eq!(mock.events,vec!["read","preserve-no-overwrite","verify-preserved","create-private-exclusive","verify"]);
    }
    #[test] fn new_creation_is_exclusive_and_ready_folder_never_mutates(){
        for (kind,events) in [(Kind::New,vec!["read","create-private-exclusive","verify"]),(Kind::Ready,vec!["read","verify"])] {
            let mut mock=Mock::new(kind);let token=issue(&mock.snapshot,NONCE).unwrap();prepare(&mut mock,&token).unwrap();assert_eq!(mock.events,events);
        }
    }
    #[test] fn changed_path_owner_acl_identity_or_kind_cannot_reuse_consent(){
        for change in ["path","owner","acl","identity","kind"] {
            let mut mock=Mock::new(Kind::Empty);let token=issue(&mock.snapshot,NONCE).unwrap();
            if change=="kind" {mock.snapshot.kind=Kind::Ready;}else{mock.snapshot.fingerprint="b".repeat(64);}
            assert_eq!(prepare(&mut mock,&token),Err(Refusal::Rejected));assert_eq!(mock.events,vec!["read"]);
        }
    }
    #[test]fn nonce_and_mode_are_bound_to_the_snapshot_digest(){
        let mut mock=Mock::new(Kind::Empty);let token=issue(&mock.snapshot,NONCE).unwrap();
        let changed=token.replacen(NONCE,"1123456789abcdef0123456789abcdef",1);
        assert_eq!(prepare(&mut mock,&changed),Err(Refusal::Rejected));assert_eq!(mock.events,vec!["read"]);
        assert!(token.is_ascii()&&token.len()<256);
    }
    #[test] fn races_never_overwrite_or_delete_original_or_unrelated_entries(){
        for (failure,expected) in [("preserve",vec!["read","preserve-no-overwrite"]),("preserved-race",vec!["read","preserve-no-overwrite","verify-preserved"]),("create",vec!["read","preserve-no-overwrite","verify-preserved","create-private-exclusive"]),("verify",vec!["read","preserve-no-overwrite","verify-preserved","create-private-exclusive","verify"])] {
            let mut mock=Mock::new(Kind::Empty);mock.fail=Some(failure);let token=issue(&mock.snapshot,NONCE).unwrap();assert!(prepare(&mut mock,&token).is_err());assert_eq!(mock.events,expected);
        }
    }
    #[test] fn elevation_and_malformed_consent_never_reach_mutation(){
        let mut mock=Mock::new(Kind::New);mock.snapshot.elevated=true;
        assert_eq!(check(&mut mock,NONCE),Err(Refusal::Elevated));
        let mut elevated=Mock::new(Kind::New);let token=issue(&elevated.snapshot,NONCE).unwrap();elevated.snapshot.elevated=true;
        assert_eq!(prepare(&mut elevated,&token),Err(Refusal::Elevated));assert_eq!(elevated.events,vec!["read"]);
        for token in ["","new.bad.hash","new.0123456789abcdef0123456789abcdef.extra", "new.0123456789abcdef0123456789abcdef.ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] {
            let mut mock=Mock::new(Kind::New);assert!(prepare(&mut mock,token).is_err());assert!(!mock.events.iter().any(|e|*e!="read"));
        }
    }
    #[test] fn reserved_helper_arguments_never_fall_through_to_gui(){
        for args in [vec!["app","--nearly-install-check"],vec!["app","extra","--nearly-install-prepare"],vec!["app","--nearly-install-checker"]] {
            assert_eq!(dispatch(args.into_iter().map(OsString::from)),Some(5));
        }
        assert_eq!(dispatch([OsString::from("app")]),None);
    }
}
