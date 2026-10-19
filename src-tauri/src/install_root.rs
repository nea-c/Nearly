//! Read-only admission for the one owned per-user installation. Directory
//! guards must overlap the transaction/recovery capture; a returned path alone
//! is never authority to mutate an installation.
use std::path::{Path, PathBuf};
// Longest fixed recovery suffix is 82 UTF-16 units (displaced uninstaller).
// Keep every protocol-3 path below MAX_PATH including the terminating NUL.
const MAX_ROOT_UTF16:usize=176;

fn validate_path(value: &str) -> Result<(), String> {
    let b = value.as_bytes();
    if b.len() < 4 || !b[0].is_ascii_alphabetic() || &b[1..3] != b":\\"
        || value.encode_utf16().count() > MAX_ROOT_UTF16 || value.len() > 512 || value.contains('/') || value.contains('\0') {
        return Err("Installation requires an unambiguous local drive path".into());
    }
    for part in value[3..].split('\\') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty() || part == "." || part == ".." || part.ends_with(['.', ' '])
            || part.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || ["COM", "LPT"].iter().any(|p| stem.strip_prefix(p).is_some_and(|n|
                matches!(n, "1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"¹"|"²"|"³"))) {
            return Err("Installation path contains an ambiguous Windows component".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) use native::RegisteredInstallation;
#[cfg(windows)]
mod native {
    use super::*;
    use crate::update_transaction::windows_impl as fs;
    use std::{ffi::c_void, fs::{File, OpenOptions}, os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle}};
    type Handle = *mut c_void;
    #[link(name="advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(key:Handle,sub:*const u16,value:*const u16,flags:u32,kind:*mut u32,data:*mut c_void,bytes:*mut u32)->i32;
        fn GetSecurityInfo(handle:Handle,kind:u32,flags:u32,owner:*mut Handle,group:*mut Handle,dacl:*mut Handle,sacl:*mut Handle,descriptor:*mut Handle)->u32;
        fn OpenProcessToken(process:Handle,access:u32,token:*mut Handle)->i32;
        fn GetTokenInformation(token:Handle,class:u32,data:Handle,length:u32,needed:*mut u32)->i32;
        fn ConvertStringSidToSidW(value:*const u16,sid:*mut Handle)->i32;
        fn LookupAccountNameW(system:*const u16,name:*const u16,sid:Handle,sid_bytes:*mut u32,domain:*mut u16,domain_chars:*mut u32,kind:*mut u32)->i32;
        fn EqualSid(a:Handle,b:Handle)->i32;
        fn IsValidSid(sid:Handle)->i32;
        fn GetLengthSid(sid:Handle)->u32;
        fn GetAce(acl:Handle,index:u32,ace:*mut Handle)->i32;
        fn IsValidAcl(acl:Handle)->i32;
        #[cfg(test)] fn ConvertStringSecurityDescriptorToSecurityDescriptorW(value:*const u16,revision:u32,descriptor:*mut Handle,size:*mut u32)->i32;
        #[cfg(test)] fn GetSecurityDescriptorOwner(descriptor:Handle,owner:*mut Handle,defaulted:*mut i32)->i32;
        #[cfg(test)] fn GetSecurityDescriptorDacl(descriptor:Handle,present:*mut i32,acl:*mut Handle,defaulted:*mut i32)->i32;
    }
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess()->Handle;
        fn CloseHandle(handle:Handle)->i32;
        fn LocalFree(memory:Handle)->Handle;
        fn GetDriveTypeW(root:*const u16)->u32;
        fn GetVolumeInformationW(root:*const u16,name:*mut u16,name_length:u32,serial:*mut u32,maximum_component:*mut u32,flags:*mut u32,filesystem:*mut u16,filesystem_length:u32)->i32;
        fn GetFinalPathNameByHandleW(file:Handle,path:*mut u16,length:u32,flags:u32)->u32;
        fn CompareStringOrdinal(first:*const u16,first_length:i32,second:*const u16,second_length:i32,ignore_case:i32)->i32;
    }
    fn wide(value:&str)->Vec<u16>{std::ffi::OsStr::new(value).encode_wide().chain(Some(0)).collect()}
    struct Local(Handle);
    impl Drop for Local {fn drop(&mut self){unsafe{LocalFree(self.0);}}}
    struct Token(Handle);
    impl Drop for Token {fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
    fn registry_optional(value:&str)->Result<Option<String>,String>{
        let sub=wide("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\local.syncfiles.native");
        let name=wide(value); let mut data=[0u16;32768]; let mut bytes=(data.len()*2) as u32;
        let flags=2 | if cfg!(target_pointer_width="64"){0x10000}else{0x20000};
        let rc=unsafe{RegGetValueW((-2147483647isize) as Handle,sub.as_ptr(),name.as_ptr(),flags,std::ptr::null_mut(),data.as_mut_ptr().cast(),&mut bytes)};
        if rc==2 {return Ok(None);}
        if rc!=0 || bytes<2 || bytes as usize>data.len()*2 || bytes%2!=0 {return Err("Per-user installation registration is unavailable".into());}
        let count=bytes as usize/2;
        if data[count-1]!=0 || data[..count-1].contains(&0){return Err("Invalid installation registration".into());}
        String::from_utf16(&data[..count-1]).map(Some).map_err(|_|"Invalid installation registration".into())
    }
    fn registry(value:&str)->Result<String,String>{registry_optional(value)?.ok_or_else(||"Per-user installation registration is unavailable".into())}
    struct Trusted {user:Vec<usize>,system:Vec<Local>,installer:Vec<usize>,creator_owner:Local}
    impl Trusted {
        fn capture()->Result<Self,String>{
            let mut token=std::ptr::null_mut();
            if unsafe{OpenProcessToken(GetCurrentProcess(),8,&mut token)}==0{return Err("Cannot identify installation user".into());}
            let token=Token(token); let mut needed=0;
            unsafe{GetTokenInformation(token.0,1,std::ptr::null_mut(),0,&mut needed);}
            if needed==0 || needed>65536{return Err("Cannot identify installation user".into());}
            let mut user=vec![0usize;(needed as usize+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];
            if unsafe{GetTokenInformation(token.0,1,user.as_mut_ptr().cast(),needed,&mut needed)}==0{return Err("Cannot identify installation user".into());}
            let mut system=Vec::new();
            for sid in ["S-1-5-18","S-1-5-32-544"] {
                let mut result=std::ptr::null_mut();
                if unsafe{ConvertStringSidToSidW(wide(sid).as_ptr(),&mut result)}==0{return Err("Cannot resolve trusted installation principal".into());}
                system.push(Local(result));
            }
            let name=wide("NT SERVICE\\TrustedInstaller");
            let (mut sid_bytes,mut domain_chars,mut kind)=(0,0,0);
            unsafe{LookupAccountNameW(std::ptr::null(),name.as_ptr(),std::ptr::null_mut(),&mut sid_bytes,std::ptr::null_mut(),&mut domain_chars,&mut kind);}
            if sid_bytes==0 || sid_bytes>65536 || domain_chars>32768{return Err("Cannot identify OS installer principal".into());}
            let mut installer=vec![0usize;(sid_bytes as usize+std::mem::size_of::<usize>()-1)/std::mem::size_of::<usize>()];
            let mut domain=vec![0u16;domain_chars as usize];
            if unsafe{LookupAccountNameW(std::ptr::null(),name.as_ptr(),installer.as_mut_ptr().cast(),&mut sid_bytes,domain.as_mut_ptr(),&mut domain_chars,&mut kind)}==0{return Err("Cannot identify OS installer principal".into());}
            let mut creator_owner=std::ptr::null_mut();
            if unsafe{ConvertStringSidToSidW(wide("S-1-3-0").as_ptr(),&mut creator_owner)}==0{return Err("Cannot resolve creator-owner principal".into());}
            Ok(Self{user,system,installer,creator_owner:Local(creator_owner)})
        }
        fn contains(&self,sid:Handle)->bool {
            if sid.is_null() || unsafe{IsValidSid(sid)}==0{return false;}
            let user=unsafe{*(self.user.as_ptr() as *const Handle)};
            (unsafe{EqualSid(user,sid)!=0 || EqualSid(self.installer.as_ptr() as Handle,sid)!=0}) || self.system.iter().any(|s|unsafe{EqualSid(s.0,sid)!=0})
        }
    }
    fn safe_security(file:&File,leaf:bool,trusted:&Trusted)->Result<(),String>{
        let mut owner=std::ptr::null_mut(); let mut acl=std::ptr::null_mut(); let mut sd=std::ptr::null_mut();
        if unsafe{GetSecurityInfo(file.as_raw_handle(),1,5,&mut owner,std::ptr::null_mut(),&mut acl,std::ptr::null_mut(),&mut sd)}!=0{return Err("Cannot inspect installation permissions".into());}
        let _descriptor=Local(sd);
        safe_acl(owner,acl,leaf,trusted)
    }
    fn safe_acl(owner:Handle,acl:Handle,leaf:bool,trusted:&Trusted)->Result<(),String>{
        if !trusted.contains(owner) || acl.is_null() || unsafe{IsValidAcl(acl)}==0{return Err("Installation requires a privately controlled directory".into());}
        let count=unsafe{*((acl as *const u8).add(4) as *const u16)} as u32;
        for index in 0..count {
            let mut ace=std::ptr::null_mut();
            if unsafe{GetAce(acl,index,&mut ace)}==0 || ace.is_null(){return Err("Cannot inspect installation access entry".into());}
            let p=ace as *const u8;
            let (kind,flags,size)=unsafe{(*p,*p.add(1),std::ptr::read_unaligned(p.add(2).cast::<u16>()) as usize)};
            // Inherit-only parent grants are checked when opening the child.
            // At the selected root they also govern future journal/payload
            // children, so foreign writable inheritance must be rejected.
            if flags&8!=0 && !leaf {continue;}
            if kind==1 {continue;} // A deny cannot grant takeover rights.
            if kind!=0 || size<16{return Err("Unsupported installation access entry".into());}
            let mask=unsafe{std::ptr::read_unaligned(p.add(4).cast::<u32>())};
            let sid=unsafe{p.add(8)} as Handle;
            if unsafe{IsValidSid(sid)}==0 || unsafe{GetLengthSid(sid)} as usize>size-8{return Err("Invalid installation access principal".into());}
            // This generic SID becomes the actual creator's SID on child
            // inheritance. Only trusted principals can create children here.
            // Never treat an effective CREATOR_OWNER ACE as a trusted identity.
            if leaf && flags&8!=0 && flags&3!=0
                && unsafe{EqualSid(trusted.creator_owner.0,sid)}!=0 {continue;}
            if dangerous_rights(mask,leaf) && !trusted.contains(sid){return Err("Installation requires a private writable directory".into());}
        }
        Ok(())
    }
    fn validate_final_root_name(root:&Path,guard:&File)->Result<(),String>{
        let mut buffer=vec![0u16;32768];
        let count=unsafe{GetFinalPathNameByHandleW(guard.as_raw_handle(),buffer.as_mut_ptr(),buffer.len() as u32,0)} as usize;
        if count==0 || count>=buffer.len(){return Err("Cannot resolve pinned installation directory".into());}
        let final_name=String::from_utf16(&buffer[..count]).map_err(|_|"Invalid pinned installation path")?;
        let final_path=PathBuf::from(final_name);
        let final_name:Vec<_>=dunce::simplified(&final_path).as_os_str().encode_wide().collect();
        let expected:Vec<_>=root.as_os_str().encode_wide().collect();
        if unsafe{CompareStringOrdinal(expected.as_ptr(),expected.len() as i32,final_name.as_ptr(),final_name.len() as i32,1)}!=2 {
            return Err("Installation path aliases are not supported".into());
        }
        Ok(())
    }
    pub(crate) struct RegisteredInstallation {root:PathBuf,_guards:Vec<File>}
    impl RegisteredInstallation {
        pub(crate) fn capture()->Result<Self,String>{
            let owner=registry("NearlyOwner")?; let root=registry("InstallLocation")?;
            Self::validate(&owner,&root,false)
        }
        pub(crate) fn capture_recovery()->Result<Self,String>{
            Self::validate(&registry("NearlyOwner")?,&registry("InstallLocation")?,true)
        }
        /// Portable instances remain independent. Once this process resolves to
        /// the registered location, unsafe registration cannot bypass recovery.
        pub(crate) fn capture_current_startup()->Result<Option<Self>,String>{
            // An unreadable/malformed location cannot identify this instance
            // as the registered image. Preserve independent portable startup;
            // valid matching locations still undergo strict admission below.
            let root=match registry_optional("InstallLocation") {
                Ok(Some(root))=>root, _=>return Ok(None),
            };
            let current=std::env::current_exe().map_err(|e|e.to_string())?;
            let installed=PathBuf::from(&root).join("Nearly.exe");
            let lexical=current.to_string_lossy().eq_ignore_ascii_case(&installed.to_string_lossy());
            let resolved=match (dunce::canonicalize(&current),dunce::canonicalize(&installed)) {
                (Ok(a),Ok(b))=>a==b, _=>false
            };
            if !lexical && !resolved {return Ok(None);}
            Self::capture_recovery().map(Some)
        }
        fn validate(owner:&str,value:&str,recovery:bool)->Result<Self,String>{
            if owner!="local.syncfiles.native"{return Err("Unrecognized installation owner".into());}
            validate_path(value)?;
            if unsafe{GetDriveTypeW(wide(&value[..3]).as_ptr())}!=3{return Err("Installation requires a fixed local drive".into());}
            let mut filesystem=[0u16;32];
            if unsafe{GetVolumeInformationW(wide(&value[..3]).as_ptr(),std::ptr::null_mut(),0,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),filesystem.as_mut_ptr(),filesystem.len() as u32)}==0
                || String::from_utf16_lossy(&filesystem[..filesystem.iter().position(|c|*c==0).unwrap_or(filesystem.len())])!="NTFS" {
                return Err("Installation requires a local NTFS filesystem".into());
            }
            let root=PathBuf::from(value); let trusted=Trusted::capture()?;
            let mut paths:Vec<_>=root.ancestors().collect(); paths.reverse(); let mut guards=Vec::new();
            for path in paths {
                let guard=fs::directory(path,0x20081).map_err(|_|"Cannot pin installation directory")?;
                safe_security(&guard,path==root,&trusted)?;
                guards.push(guard);
            }
            validate_final_root_name(&root,guards.last().ok_or("Missing installation directory pin")?)?;
            // Normal payloads must be regular, single-link files. These
            // observation handles allow replacement by the existing recovery
            // protocol; directory guards retain the namespace throughout.
            for name in ["Nearly.exe","uninstall.exe"] {
                let file=match OpenOptions::new().access_mode(0x20080).share_mode(7).custom_flags(0x00200000).open(root.join(name)) {
                    Ok(file)=>file,
                    Err(error) if recovery && error.kind()==std::io::ErrorKind::NotFound=>continue,
                    Err(_)=>return Err("Registered installation payload is unavailable".into()),
                };
                fs::regular(&file).map_err(|_|"Unsafe registered installation payload")?;
                safe_security(&file,true,&trusted)?;
            }
            Ok(Self{root,_guards:guards})
        }
        pub(crate) fn root(&self)->&Path{&self.root}
        pub(crate) fn into_guards(self)->Vec<File>{self._guards}
        pub(crate) fn executable(&self)->PathBuf{self.root.join("Nearly.exe")}
        pub(crate) fn is_current(&self)->Result<bool,String>{
            let current=std::env::current_exe().map_err(|e|e.to_string())?;
            Ok(dunce::canonicalize(current).map_err(|e|e.to_string())?==dunce::canonicalize(self.executable()).map_err(|e|e.to_string())?)
        }
    }
    #[cfg(test)] mod tests {
        use super::*;
        #[test] fn synthetic_acl_permissions_fail_closed_without_changing_any_acl(){
            let trusted=Trusted::capture().unwrap();
            for (sddl,leaf,expected) in [
                ("O:SYD:(A;;FA;;;SY)",true,true),
                ("O:WDD:(A;;FA;;;SY)",true,false),
                ("O:SYD:(A;;FW;;;WD)",true,false),
                ("O:SYD:(A;;0x00000004;;;WD)",false,true),
                ("O:SYD:(A;;0x00000040;;;WD)",false,false),
                ("O:SYD:(A;OICIIO;FA;;;WD)(A;;FA;;;SY)",true,false),
                ("O:SYD:(A;OICIIO;FA;;;CO)(A;;FA;;;SY)",true,true),
                ("O:SYD:(A;CIIO;FA;;;CO)(A;;FA;;;SY)",true,true),
                ("O:SYD:(A;OI;FA;;;CO)(A;;FA;;;SY)",true,false),
                ("O:SYD:(A;IO;FA;;;CO)(A;;FA;;;SY)",true,false),
                ("O:SYD:(A;;FA;;;CO)(A;;FA;;;SY)",true,false),
                ("O:SYD:(A;OICIIO;FA;;;WD)(A;;FA;;;SY)",false,true),
                ("O:SYD:(D;;FA;;;WD)(A;;FR;;;WD)(A;;FA;;;SY)",true,true),
                ("O:SYD:(OA;;FW;;;WD)",true,false),
            ] {
                let mut sd=std::ptr::null_mut();
                assert_ne!(unsafe{ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl).as_ptr(),1,&mut sd,std::ptr::null_mut())},0,"{sddl}");
                let descriptor=Local(sd); let mut owner=std::ptr::null_mut(); let mut acl=std::ptr::null_mut(); let (mut present,mut defaulted)=(0,0);
                assert_ne!(unsafe{GetSecurityDescriptorOwner(descriptor.0,&mut owner,&mut defaulted)},0);
                assert_ne!(unsafe{GetSecurityDescriptorDacl(descriptor.0,&mut present,&mut acl,&mut defaulted)},0);
                assert_eq!(safe_acl(owner,acl,leaf,&trusted).is_ok(),expected,"{sddl}");
            }
        }
        #[test]
        #[ignore="requires clean private LocalAppData; this host has unsafe sandbox capability grants"]
        fn default_local_appdata_compatibility(){
            let root=PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LocalAppData"));
            let trusted=Trusted::capture().unwrap();
            let mut paths:Vec<_>=root.ancestors().collect(); paths.reverse();
            let mut guards=Vec::new();
            for path in paths {
                let guard=fs::directory(path,0x20080).unwrap();
                safe_security(&guard,path==root,&trusted)
                    .unwrap_or_else(|error|panic!("{}: {error}",path.display()));
                guards.push(guard);
            }
        }
        #[test] fn generated_custom_root_payload_current_identity_and_namespace_guards(){
            let root=std::env::temp_dir().join(format!("nearly-install-root-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("Nearly.exe"),b"fixture image").unwrap();
            std::fs::write(root.join("uninstall.exe"),b"fixture uninstaller").unwrap();
            let value=root.to_str().unwrap();
            assert!(RegisteredInstallation::validate("foreign",value,false).is_err());
            // This namespace-only fixture deliberately bypasses ACL admission;
            // the host temp ACL may be writable by Everyone. ACL admission is
            // tested with synthetic descriptors above without changing ACLs.
            let installation=RegisteredInstallation{root:root.clone(),_guards:root.ancestors().map(|path|fs::directory(path,0x81).unwrap()).collect()};
            assert!(validate_final_root_name(&root,&installation._guards[0]).is_ok());
            assert!(validate_final_root_name(&root.with_extension("other"),&installation._guards[0]).is_err());
            let image=OpenOptions::new().access_mode(0x80).share_mode(7).custom_flags(0x00200000).open(root.join("Nearly.exe")).unwrap();
            assert!(fs::regular(&image).is_ok());
            let alias=root.join("alias.exe");
            std::fs::hard_link(root.join("Nearly.exe"),&alias).unwrap();
            assert!(fs::regular(&image).is_err(),"payload hard links must fail closed");
            std::fs::remove_file(alias).unwrap();
            drop(image);
            assert!(!installation.is_current().unwrap());
            let moved=root.with_extension("moved");
            assert!(std::fs::rename(&root,&moved).is_err(),"root must stay pinned");
            // Capture must overlap the old pins before those are dropped.
            let next=fs::directory(installation.root(),0x81).unwrap();
            drop(installation);
            assert!(std::fs::rename(&root,&moved).is_err(),"successor pin must retain root");
            drop(next);
            std::fs::remove_file(root.join("uninstall.exe")).unwrap();
            assert!(RegisteredInstallation::validate("local.syncfiles.native",value,false).is_err());
            std::fs::remove_file(root.join("Nearly.exe")).unwrap();
            std::fs::remove_dir(root).unwrap();
        }
    }
}

fn dangerous_rights(mask:u32,leaf:bool)->bool {
    // DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER, generic write/all.
    mask & (0x00010000|0x40|0x00040000|0x00080000|0x40000000|0x10000000
        | if leaf {0x2|0x4|0x10|0x100} else {0}) != 0
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn registered_paths_accept_default_and_custom_roots(){
        let default=["C:","Users","fixture","AppData","Local","Nearly"].join("\\");
        for p in [default.as_str(),r"D:\Applications\Nearly",r"E:\私用\Nearly"] {assert!(validate_path(p).is_ok(),"{p}");}
    }
    #[test] fn registered_paths_reject_ambiguous_or_shared_namespaces(){
        for p in [r"C:\",r"C:Nearly",r"\Nearly",r"\\server\Nearly",r"\\?\C:\Nearly",r"C:\Apps\..\Nearly",r"C:\Apps\.\Nearly",r"C:\Apps\Nearly.",r"C:\Apps\Nearly ",r"C:\Apps\Nearly:stream",r"C:\Apps\CON.txt",r"C:\Apps\com1",r"C:\Apps\LPT²",r"C:/Nearly",r"C:\Apps\\Nearly",r"C:\Apps\Nearly\"] {assert!(validate_path(p).is_err(),"{p}");}
    }
    #[test] fn admission_path_bounds_match_installer_and_recovery_codec(){
        assert!(validate_path(&format!("C:\\{}","a".repeat(173))).is_ok());
        assert!(validate_path(&format!("C:\\{}","a".repeat(174))).is_err());
        assert!(validate_path(&format!("C:\\{}","私".repeat(170))).is_err(),"UTF8 codec bound must also apply");
        let prefix=format!("\\{}\\{}\\",crate::update_transaction::STATE_DIRECTORY,"a".repeat(32));
        let suffixes=["candidate\\uninstall.exe","previous-uninstaller.exe","displaced-new-uninstall.exe","displaced-old-uninstall.exe","restore-uninstall.exe"];
        let longest=suffixes.iter().map(|name|prefix.encode_utf16().count()+name.encode_utf16().count()).max().unwrap();
        assert_eq!(longest,82);
        assert!(MAX_ROOT_UTF16+longest+1<260);
    }
    #[test] fn foreign_permissions_distinguish_parent_creation_from_takeover(){
        assert!(dangerous_rights(0x2|0x4,true));
        assert!(!dangerous_rights(0x2|0x4,false));
        for mask in [0x10000,0x40,0x40000,0x80000,0x40000000,0x10000000]{assert!(dangerous_rights(mask,false));}
        assert!(!dangerous_rights(0x80000000,false));
    }
}
