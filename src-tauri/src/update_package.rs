//! Fixed-repository updater trust boundary. No renderer supplied paths or URLs.
//! Minisign framing follows jedisct1/rust-minisign-verify; cryptography is provided
//! by maintained ring Ed25519 and RustCrypto BLAKE2b, never local crypto code.
//! Registered public trust is embedded for a reviewed bootstrap distribution.
//! The separate installation gate remains false pending installed-NSIS qualification.
use base64::{engine::general_purpose::STANDARD, Engine};
use blake2::{Blake2b512, Digest};
use reqwest::Url;
use serde::Deserialize;
use std::{fs::File, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::Duration};

pub const MAX_METADATA: usize = 131_072;
pub const MAX_PACKAGE: usize = 256 * 1024 * 1024;
const MAX_SIGNATURE: usize = 16_384;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError { SigningNotConfigured, InvalidMetadata, NoCompatibleAsset, Network, TooLarge, Cancelled, InvalidSignature, SignedVersion, SignedPayload, SignedProtocol, Architecture, Staging, UnsupportedPlatform }
impl PackageError {
    pub fn code(self) -> &'static str { match self {
        Self::SigningNotConfigured=>"signingNotConfigured", Self::InvalidMetadata=>"invalidMetadata", Self::NoCompatibleAsset=>"noCompatibleAsset", Self::Network=>"downloadFailed", Self::TooLarge=>"packageTooLarge", Self::Cancelled=>"cancelled", Self::InvalidSignature=>"invalidSignature", Self::SignedVersion=>"signedVersionMismatch", Self::SignedPayload=>"invalidSignedPayload", Self::SignedProtocol=>"signedProtocolMismatch", Self::Architecture=>"incompatibleArchitecture", Self::Staging=>"stagingFailed", Self::UnsupportedPlatform=>"unsupportedPlatform",
    }}
}
type Result<T> = std::result::Result<T, PackageError>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Architecture { X64, Arm64 }
impl Architecture {
    pub fn current() -> Result<Self> { match std::env::consts::ARCH { "x86_64"=>Ok(Self::X64), "aarch64"=>Ok(Self::Arm64), _=>Err(PackageError::Architecture) } }
    pub(crate) fn label(self) -> &'static str { match self {Self::X64=>"x64",Self::Arm64=>"arm64"} }
}
#[derive(Clone, Debug)]
pub struct ReleaseCandidate { version: semver::Version, arch: Architecture, asset: Url, signature: Url, size: usize }
#[derive(Deserialize)]
struct Release { tag_name: String, draft: bool, prerelease: bool, html_url: String, assets: Vec<Asset> }
#[derive(Deserialize)]
struct Asset { name: String, browser_download_url: String, size: u64 }
impl ReleaseCandidate {
    pub fn version(&self) -> String { self.version.to_string() }
    pub fn display_version(&self) -> String { crate::version::display_label(&self.version) }
    pub fn from_github_metadata(body: &[u8], current: &str, arch: Architecture) -> Result<Option<Self>> {
        if body.len()>MAX_METADATA {return Err(PackageError::InvalidMetadata)}
        let release:Release=serde_json::from_slice(body).map_err(|_|PackageError::InvalidMetadata)?;
        let version=crate::version::release_version(&release.tag_name).ok_or(PackageError::InvalidMetadata)?;
        let current=semver::Version::parse(current).map_err(|_|PackageError::InvalidMetadata)?;
        // Canonical tag, no build aliases, path syntax, or ambiguous release names.
        if release.html_url != format!("https://github.com/nea-c/Nearly/releases/tag/{}",release.tag_name) {return Err(PackageError::InvalidMetadata)}
        if release.draft || release.prerelease || !version.pre.is_empty() || version.cmp_precedence(&current)!=std::cmp::Ordering::Greater {return Ok(None)}
        let name=format!("Nearly_{}_{}-setup.exe",crate::version::display_label(&version),arch.label());
        let select=|wanted:&str| -> Result<&Asset> { let mut found=release.assets.iter().filter(|a|a.name==wanted); let a=found.next().ok_or(PackageError::NoCompatibleAsset)?; if found.next().is_some(){return Err(PackageError::InvalidMetadata)} Ok(a) };
        let asset=select(&name)?;
        let signature=select(&format!("{name}.sig"))?;
        if asset.size==0 || asset.size>MAX_PACKAGE as u64 || signature.size==0 || signature.size>MAX_SIGNATURE as u64 {return Err(PackageError::TooLarge)}
        let parse=|a:&Asset| -> Result<Url> {let expected=format!("https://github.com/nea-c/Nearly/releases/download/{}/{}",release.tag_name,a.name); if a.browser_download_url!=expected{return Err(PackageError::InvalidMetadata)} Url::parse(&expected).map_err(|_|PackageError::InvalidMetadata)};
        Ok(Some(Self {version,arch,asset:parse(asset)?,signature:parse(signature)?,size:asset.size as usize}))
    }
}
/// Only native embedded configuration can establish trust; no public key setter.
pub struct TrustedKey { bytes: [u8;42] }
const PRODUCTION_KEY_BYTES:[u8;42]=[69,100,204,60,239,74,226,200,249,50,76,211,219,189,45,171,194,223,151,77,145,136,167,90,146,246,161,87,252,110,169,52,0,234,165,86,42,84,149,211,117,49];
pub fn production_key() -> Option<TrustedKey> { Some(TrustedKey{bytes:PRODUCTION_KEY_BYTES}) }
pub(crate) fn runtime_key()->Option<TrustedKey>{
    #[cfg(all(feature="installer-qa",windows))]
    {crate::installer_qa::context().map(|c|TrustedKey{bytes:c.key})}
    #[cfg(not(all(feature="installer-qa",windows)))]
    {production_key()}
}
#[cfg(all(feature="installer-qa",windows))]
pub(crate) fn qa_stage()->std::result::Result<(ReleaseCandidate,StagedInstaller),&'static str>{
    let c=crate::installer_qa::context().ok_or("qaContext")?;
    let (bytes,signature)=crate::installer_qa::fixture()?;
    let url="https://github.com/nea-c/Nearly/releases/download/r2.0/";
    let metadata=serde_json::to_vec(&serde_json::json!({"tag_name":"r2.0","draft":false,"prerelease":false,"html_url":"https://github.com/nea-c/Nearly/releases/tag/r2.0","assets":[{"name":c.plan.target_file,"size":bytes.len(),"browser_download_url":format!("{url}{}",c.plan.target_file)},{"name":c.plan.signature_file,"size":signature.len(),"browser_download_url":format!("{url}{}",c.plan.signature_file)}]})).map_err(|_|"qaMetadata")?;
    let candidate=ReleaseCandidate::from_github_metadata(&metadata,&c.plan.source_version,Architecture::current().map_err(|e|e.code())?).map_err(|e|e.code())?.ok_or("qaMetadata")?;
    let key=runtime_key().ok_or("qaKey")?;
    let parent=crate::update_handoff::installed_executable().map_err(|_|"qaImage")?;
    let staged=win::stage_in(parent.parent().ok_or("qaImage")?,&bytes,signature,&candidate,&key,&AtomicBool::new(false)).map_err(|e|e.code())?;
    if staged.proof.as_ref().ok_or("qaPayload")?.payload_sha256()!=c.plan.payload_sha256{return Err("qaPayload")}
    Ok((candidate,staged))
}

/// Constructed only after both minisign signatures and every binding verify.
/// Journal deserialization must never manufacture this trusted type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PackageProof {
    target_version:String, public_label:String, arch:Architecture, asset_name:String,
    installer_sha256:String, payload_sha256:String, updater_protocol:u8, signature:Vec<u8>,
}
impl PackageProof {
    pub(crate) fn target_version(&self)->&str {&self.target_version}
    pub(crate) fn public_label(&self)->&str {&self.public_label}
    pub(crate) fn arch(&self)->Architecture {self.arch}
    pub(crate) fn asset_name(&self)->&str {&self.asset_name}
    pub(crate) fn installer_sha256(&self)->&str {&self.installer_sha256}
    pub(crate) fn payload_sha256(&self)->&str {&self.payload_sha256}
    pub(crate) fn updater_protocol(&self)->u8 {self.updater_protocol}
    pub(crate) fn signature(&self)->&[u8] {&self.signature}
}
fn sha256(bytes:&[u8])->String {
    ring::digest::digest(&ring::digest::SHA256,bytes).as_ref().iter().map(|byte|format!("{byte:02x}")).collect()
}

fn decode(s:&str) -> Result<Vec<u8>> {STANDARD.decode(s).map_err(|_|PackageError::InvalidSignature)}
fn verify(bytes:&[u8], signature:&[u8], key:&TrustedKey, candidate:&ReleaseCandidate) -> Result<()> {
    verify_proof(bytes,signature,key,candidate).map(|_|())
}
fn verify_proof(bytes:&[u8], signature:&[u8], key:&TrustedKey, candidate:&ReleaseCandidate) -> Result<PackageProof> {
    if bytes.len()!=candidate.size || bytes.len()>MAX_PACKAGE {return Err(PackageError::TooLarge)}
    if signature.len()>MAX_SIGNATURE {return Err(PackageError::InvalidSignature)}
    // Tauri .sig contains a base64 encoded four-line minisign signature document.
    let outer=std::str::from_utf8(signature).map_err(|_|PackageError::InvalidSignature)?.trim();
    let document=decode(outer)?;
    let text=std::str::from_utf8(&document).map_err(|_|PackageError::InvalidSignature)?;
    let lines:Vec<_>=text.lines().collect();
    if lines.len()!=4 || !lines[0].starts_with("untrusted comment: ") {return Err(PackageError::InvalidSignature)}
    let record=decode(lines[1])?;
    let comment=lines[2].strip_prefix("trusted comment: ").ok_or(PackageError::InvalidSignature)?;
    let global=decode(lines[3])?;
    if record.len()!=74 || global.len()!=64 || &key.bytes[..2]!=b"Ed" || record[2..10]!=key.bytes[2..10] {return Err(PackageError::InvalidSignature)}
    let verifier=ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519,&key.bytes[10..]);
    match &record[..2] {
        b"ED"=>verifier.verify(&Blake2b512::digest(bytes),&record[10..]),
        b"Ed"=>verifier.verify(bytes,&record[10..]),
        _=>return Err(PackageError::InvalidSignature),
    }.map_err(|_|PackageError::InvalidSignature)?;
    let mut authenticated=record[10..].to_vec(); authenticated.extend_from_slice(comment.as_bytes());
    verifier.verify(&authenticated,&global).map_err(|_|PackageError::InvalidSignature)?;
    // Authenticate the comment before reading version. Reject duplicate versions.
    let versions:Vec<_>=comment.split('\t').filter_map(|s|s.strip_prefix("version:")).collect();
    if versions.len()!=1 || versions[0]!=candidate.version.to_string() {return Err(PackageError::SignedVersion)}
    // NSIS has an x86 bootstrapper even when its payload targets x64/arm64.
    // Therefore the authenticated exact filename, rather than unsigned metadata
    // or the bootstrapper's machine, must also bind the application target.
    let files:Vec<_>=comment.split('\t').filter_map(|s|s.strip_prefix("file:")).collect();
    let expected=format!("Nearly_{}_{}-setup.exe",candidate.display_version(),candidate.arch.label());
    if files.len()!=1 || files[0]!=expected {return Err(PackageError::Architecture)}
    let payloads:Vec<_>=comment.split('\t').filter_map(|s|s.strip_prefix("payload-sha256:")).collect();
    if payloads.len()!=1 || payloads[0].len()!=64 || !payloads[0].bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {return Err(PackageError::SignedPayload)}
    // Capabilities come only from the globally authenticated trusted comment.
    // Old installers and duplicate or noncanonical fields cannot reach handoff.
    let protocols:Vec<_>=comment.split('\t').filter_map(|s|s.strip_prefix("updater-protocol:")).collect();
    if protocols.len()!=1 || protocols[0]!="3" {return Err(PackageError::SignedProtocol)}
    verify_pe(bytes,candidate.arch)?;
    Ok(PackageProof {target_version:candidate.version(),public_label:candidate.display_version(),arch:candidate.arch,
        asset_name:expected,installer_sha256:sha256(bytes),payload_sha256:payloads[0].into(),updater_protocol:3,signature:signature.to_vec()})
}

fn read_snapshot_bytes(file:&mut File)->Result<Vec<u8>> {
    let metadata=file.metadata().map_err(|_|PackageError::Staging)?;
    if !metadata.is_file(){return Err(PackageError::Staging)}
    if metadata.len()==0 || metadata.len()>MAX_PACKAGE as u64 {return Err(PackageError::TooLarge)}
    #[cfg(windows)]
    win::identity(file)?;
    file.seek(SeekFrom::Start(0)).map_err(|_|PackageError::Staging)?;
    let mut bytes=Vec::new();
    Read::by_ref(file).take((MAX_PACKAGE+1) as u64).read_to_end(&mut bytes).map_err(|_|PackageError::Staging)?;
    if bytes.len() as u64!=metadata.len() || bytes.len()>MAX_PACKAGE{return Err(PackageError::TooLarge)}
    Ok(bytes)
}

/// Recovery records provide untrusted strings/signature bytes. Reconstruct the
/// fixed candidate locally and regain proof only by authenticating pinned bytes.
/// Caller owns the read/identity/ancestor locks; this performs no network request.
pub(crate) fn authenticate_snapshot(file:&mut File,signature:&[u8],target_version:&str,arch:Architecture,key:&TrustedKey)->Result<PackageProof> {
    if signature.len()>MAX_SIGNATURE{return Err(PackageError::InvalidSignature)}
    let version=semver::Version::parse(target_version).map_err(|_|PackageError::InvalidMetadata)?;
    let tag=crate::version::display_label(&version);
    if crate::version::release_version(&tag).as_ref()!=Some(&version){return Err(PackageError::InvalidMetadata)}
    let name=format!("Nearly_{tag}_{}-setup.exe",arch.label());
    let asset=Url::parse(&format!("https://github.com/nea-c/Nearly/releases/download/{tag}/{name}")).map_err(|_|PackageError::InvalidMetadata)?;
    let signature_url=Url::parse(&format!("https://github.com/nea-c/Nearly/releases/download/{tag}/{name}.sig")).map_err(|_|PackageError::InvalidMetadata)?;
    let bytes=read_snapshot_bytes(file)?;
    let candidate=ReleaseCandidate{version,arch,asset,signature:signature_url,size:bytes.len()};
    verify_proof(&bytes,signature,key,&candidate)
}
fn verify_pe(bytes:&[u8], _arch:Architecture) -> Result<()> {
    let bad=PackageError::Architecture;
    if bytes.get(..2)!=Some(b"MZ") {return Err(bad)}
    let offset=u32::from_le_bytes(bytes.get(0x3c..0x40).ok_or(bad)?.try_into().map_err(|_|bad)?) as usize;
    let header=bytes.get(offset..offset.checked_add(26).ok_or(bad)?).ok_or(bad)?;
    if &header[..4]!=b"PE\0\0" || u16::from_le_bytes([header[4],header[5]])!=0x14c || u16::from_le_bytes([header[24],header[25]])!=0x10b {return Err(bad)}
    Ok(())
}
fn cancelled(cancel:&AtomicBool)->Result<()> {if cancel.load(Ordering::Acquire){Err(PackageError::Cancelled)}else{Ok(())}}
fn allowed_redirect(url:&Url) -> bool {
    url.scheme()=="https" && url.username().is_empty() && url.password().is_none() && url.port().is_none() && url.fragment().is_none() && url.host_str()==Some("release-assets.githubusercontent.com") && url.path().starts_with("/github-production-release-asset/")
}
async fn bounded_download(url:&Url, limit:usize, cancel:&AtomicBool)->Result<Vec<u8>> {
    cancelled(cancel)?;
    let client=reqwest::Client::builder().https_only(true).no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(120)).user_agent(concat!("Nearly/",env!("CARGO_PKG_VERSION"))).build().map_err(|_|PackageError::Network)?;
    bounded_download_with_client(&client,url,limit,cancel).await
}
// Kept private: only the production wrapper constructs a client for application
// calls. Tests inject a loopback-only HTTP client to exercise the same reader;
// HTTPS and fixed-candidate URL policy in production are never disabled.
async fn bounded_download_with_client(client:&reqwest::Client,url:&Url,limit:usize,cancel:&AtomicBool)->Result<Vec<u8>> {
    let mut target=url.clone();
    for hop in 0..=2 {
        cancelled(cancel)?;
        let response=tokio::select! { biased; _=wait_cancel(cancel)=>return Err(PackageError::Cancelled), r=client.get(target.clone()).header("Accept-Encoding","identity").send()=>r.map_err(|_|PackageError::Network)? };
        if response.status().is_redirection() {
            if hop==2{return Err(PackageError::Network)}
            let next=response.headers().get(reqwest::header::LOCATION).and_then(|h|h.to_str().ok()).and_then(|h|target.join(h).ok()).ok_or(PackageError::Network)?;
            if !allowed_redirect(&next){return Err(PackageError::Network)} target=next;continue
        }
        if response.status()!=reqwest::StatusCode::OK {return Err(PackageError::Network)}
        return bounded_response_body(response,limit,cancel).await
    }
    Err(PackageError::Network)
}
async fn bounded_response_body(mut response:reqwest::Response,limit:usize,cancel:&AtomicBool)->Result<Vec<u8>> {
    if response.content_length().is_some_and(|n|n>limit as u64){return Err(PackageError::TooLarge)}
    let mut body=Vec::new();
    loop {
        let chunk=tokio::select! { biased; _=wait_cancel(cancel)=>return Err(PackageError::Cancelled), c=response.chunk()=>c.map_err(|_|PackageError::Network)? };
        match chunk {Some(chunk)=>{if chunk.len()>limit.saturating_sub(body.len()){return Err(PackageError::TooLarge)}body.extend_from_slice(&chunk)},None=>break}
    }
    cancelled(cancel)?;Ok(body)
}
async fn wait_cancel(cancel:&AtomicBool) {while !cancel.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(50)).await}}

/// Retain until process exit after CreateProcess. The read-only handle denies
/// writes/deletes while allowing NSIS's own FILE_SHARE_READ-only self-read.
/// Drop reacquires deletion rights only after closing it, then compares identity.
pub struct StagedInstaller { path:PathBuf, file:Option<File>, signature:Vec<u8>, proof:Option<PackageProof>, #[cfg(windows)] _directories:Vec<File> }
/// A trusted stage snapshot retains the same pinned read handle and ancestor
/// locks. It cannot be reconstructed from journal paths or deserialized hashes.
pub(crate) struct StageSnapshot {file:File,path:PathBuf,package:PackageProof,#[cfg(windows)] _directories:Vec<File>}
impl StageSnapshot {
    pub(crate) fn file(&self)->&File {&self.file}
    pub(crate) fn path(&self)->&Path {&self.path}
    pub(crate) fn package(&self)->&PackageProof {&self.package}
}
impl StagedInstaller {
    pub fn verified_path(&self)->&Path {&self.path}
    pub fn path(&self)->&Path {&self.path}
    pub fn reverify(&mut self,candidate:&ReleaseCandidate,key:&TrustedKey)->Result<()> {
        self.proof=None;
        let file=self.file.as_mut().ok_or(PackageError::Staging)?;
        let bytes=read_snapshot_bytes(file)?;
        self.proof=Some(verify_proof(&bytes,&self.signature,key,candidate)?);
        Ok(())
    }
    pub(crate) fn transaction_snapshot(&mut self,candidate:&ReleaseCandidate,key:&TrustedKey)->Result<StageSnapshot> {
        self.reverify(candidate,key)?;
        let file=self.file.as_ref().ok_or(PackageError::Staging)?.try_clone().map_err(|_|PackageError::Staging)?;
        #[cfg(windows)]
        let directories=self._directories.iter().map(File::try_clone).collect::<std::io::Result<Vec<_>>>().map_err(|_|PackageError::Staging)?;
        Ok(StageSnapshot {file,path:self.path.clone(),package:self.proof.as_ref().ok_or(PackageError::Staging)?.clone(),#[cfg(windows)] _directories:directories})
    }
}
pub async fn download_and_stage(candidate:&ReleaseCandidate,key:&TrustedKey,cancel:&AtomicBool)->Result<StagedInstaller> {
    let signature=bounded_download(&candidate.signature,MAX_SIGNATURE,cancel).await?;
    let bytes=bounded_download(&candidate.asset,candidate.size,cancel).await?;
    verify(&bytes,&signature,key,candidate)?;cancelled(cancel)?;
    stage(&bytes,signature,candidate,key,cancel)
}
#[cfg(not(windows))]
fn stage(_: &[u8],_:Vec<u8>,_:&ReleaseCandidate,_:&TrustedKey,_:&AtomicBool)->Result<StagedInstaller>{Err(PackageError::UnsupportedPlatform)}

#[cfg(windows)]
mod win {
    use super::*;
    use std::{fs::OpenOptions, os::windows::{fs::OpenOptionsExt,io::AsRawHandle}};
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::{GetFileInformationByHandle,SetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,FILE_DISPOSITION_INFO,FileDispositionInfo,FILE_FLAG_OPEN_REPARSE_POINT,FILE_FLAG_BACKUP_SEMANTICS,FILE_ATTRIBUTE_REPARSE_POINT}};
    const DELETE_ACCESS:u32=0x0001_0000;
    pub(super) fn identity(file:&File)->Result<(u32,u32,u32)> {
        let mut info=BY_HANDLE_FILE_INFORMATION::default();
        unsafe{GetFileInformationByHandle(HANDLE(file.as_raw_handle()),&mut info)}.map_err(|_|PackageError::Staging)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 !=0{return Err(PackageError::Staging)}
        Ok((info.dwVolumeSerialNumber,info.nFileIndexHigh,info.nFileIndexLow))
    }
    pub(super) fn remove(file:&File) {
        let info=FILE_DISPOSITION_INFO {DeleteFile:true.into()};
        let _=unsafe{SetFileInformationByHandle(HANDLE(file.as_raw_handle()),FileDispositionInfo,&info as *const _ as *const _,std::mem::size_of_val(&info) as u32)};
    }
    pub(super) fn cleanup_owned(path:&Path,owned:(u32,u32,u32)) {
        // Closing the read lock allows a pathname substitution. Never delete by
        // pathname: reopen without following reparse points, deny further
        // writes/deletes, and delete by handle only after matching native ID.
        // An error or substitution deliberately leaves the file untouched.
        let Ok(file)=OpenOptions::new().read(true).access_mode(0x80000000|DELETE_ACCESS).share_mode(1).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).open(path) else{return};
        if identity(&file)==Ok(owned) {remove(&file)}
    }
    pub(super) fn directories(parent:&Path)->Result<Vec<File>> {
        let mut guards=Vec::new();
        let mut paths:Vec<_>=parent.ancestors().collect();paths.reverse();
        for path in paths {
            // Deny DELETE sharing on every ancestor so the pathname cannot be
            // redirected between creation, verification and CreateProcess.
            let file=OpenOptions::new().access_mode(0x80).share_mode(3).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0|FILE_FLAG_OPEN_REPARSE_POINT.0).open(path).map_err(|_|PackageError::Staging)?;
            identity(&file)?;guards.push(file);
        }
        Ok(guards)
    }
    pub(super) fn stage_in(parent:&Path,bytes:&[u8],signature:Vec<u8>,candidate:&ReleaseCandidate,key:&TrustedKey,cancel:&AtomicBool)->Result<StagedInstaller> {
        // Recovery authenticates the canonical signed asset name. Exclusive
        // creation keeps an existing/foreign file from being overwritten.
        let name=format!("Nearly_{}_{}-setup.exe",candidate.display_version(),candidate.arch.label());
        stage_named(parent,&name,bytes,signature,candidate,key,cancel)
    }
    // Retired protocol2 unit fixtures still explicitly exercise their old
    // nonce-named contract. Production and protocol3 use stage_in above.
    #[cfg(test)]
    pub(super) fn legacy_fixture_stage(parent:&Path,bytes:&[u8],signature:Vec<u8>,candidate:&ReleaseCandidate,key:&TrustedKey,cancel:&AtomicBool)->Result<StagedInstaller>{
        let mut nonce=[0u8;16];getrandom::fill(&mut nonce).map_err(|_|PackageError::Staging)?;
        let nonce:String=nonce.iter().map(|b|format!("{b:02x}")).collect();
        stage_named(parent,&format!("Nearly-update-{}-{nonce}-setup.exe",candidate.version),bytes,signature,candidate,key,cancel)
    }
    fn stage_named(parent:&Path,name:&str,bytes:&[u8],signature:Vec<u8>,candidate:&ReleaseCandidate,key:&TrustedKey,cancel:&AtomicBool)->Result<StagedInstaller>{
        let guards=directories(parent)?;
        let path=parent.join(name);
        cancelled(cancel)?;
        let mut file=OpenOptions::new().read(true).write(true).access_mode(0xc0000000|DELETE_ACCESS).share_mode(1).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).create_new(true).open(&path).map_err(|_|PackageError::Staging)?;
        let owned=match identity(&file) {Ok(id)=>id,Err(error)=>{remove(&file);return Err(error)}};
        let written=(||{for chunk in bytes.chunks(64*1024){cancelled(cancel)?;file.write_all(chunk).map_err(|_|PackageError::Staging)?} file.sync_all().map_err(|_|PackageError::Staging)})();
        if let Err(e)=written {remove(&file);return Err(e)}
        drop(file);
        // This is the only unlocked gap. Reopen denies writes/deletes, compare
        // native identity and authenticate the bytes again before exposing path.
        let file=OpenOptions::new().read(true).access_mode(0x80000000).share_mode(1).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).open(&path).map_err(|_|PackageError::Staging)?;
        if identity(&file)?!=owned {return Err(PackageError::Staging)}
        let mut staged=StagedInstaller {path,file:Some(file),signature,proof:None,_directories:guards};
        cancelled(cancel)?;staged.reverify(candidate,key)?;Ok(staged)
    }
}
#[cfg(windows)]
fn stage(bytes:&[u8],signature:Vec<u8>,candidate:&ReleaseCandidate,key:&TrustedKey,cancel:&AtomicBool)->Result<StagedInstaller> {
    let executable=std::env::current_exe().map_err(|_|PackageError::Staging)?;
    let parent=executable.parent().ok_or(PackageError::Staging)?;
    win::stage_in(parent,bytes,signature,candidate,key,cancel)
}
impl Drop for StagedInstaller {fn drop(&mut self){
    #[cfg(windows)]
    if let Some(file)=self.file.take() {
        let owned=win::identity(&file);drop(file);
        // Ancestor guards remain alive throughout close/reopen/identity-check.
        if let Ok(owned)=owned {win::cleanup_owned(&self.path,owned)}
    }
}}

/// Test-only generated installer and ephemeral signing key. The returned stage
/// still passes the real signature, payload-field, identity and locking path.
#[cfg(all(test,windows))]
pub(crate) fn fixture_stage(parent:&Path,version:&str,payload_hash:&str)->(StagedInstaller,ReleaseCandidate,TrustedKey) {
    tests::fixture_stage(parent,version,payload_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair,KeyPair};
    fn pe()->Vec<u8> {let mut b=vec![0u8;128];b[..2].copy_from_slice(b"MZ");b[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());b[64..68].copy_from_slice(b"PE\0\0");b[68..70].copy_from_slice(&0x14cu16.to_le_bytes());b[88..90].copy_from_slice(&0x10bu16.to_le_bytes());b}
    fn metadata()->serde_json::Value {serde_json::json!({"tag_name":"r0.3","draft":false,"prerelease":false,"html_url":"https://github.com/nea-c/Nearly/releases/tag/r0.3","assets":[{"name":"Nearly_r0.3_x64-setup.exe","browser_download_url":"https://github.com/nea-c/Nearly/releases/download/r0.3/Nearly_r0.3_x64-setup.exe","size":128},{"name":"Nearly_r0.3_x64-setup.exe.sig","browser_download_url":"https://github.com/nea-c/Nearly/releases/download/r0.3/Nearly_r0.3_x64-setup.exe.sig","size":512}]})}
    fn candidate()->ReleaseCandidate {ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&metadata()).unwrap(),"0.2.0",Architecture::X64).unwrap().unwrap()}
    #[cfg(windows)]
    pub(super) fn fixture_stage(parent:&Path,version:&str,payload_hash:&str)->(StagedInstaller,ReleaseCandidate,TrustedKey) {
        let version=semver::Version::parse(version).unwrap();let tag=crate::version::display_label(&version);
        assert_eq!(crate::version::release_version(&tag),Some(version.clone()));
        let arch=Architecture::current().unwrap();let name=format!("Nearly_{tag}_{}-setup.exe",arch.label());let bytes=pe();
        let candidate=ReleaseCandidate {version:version.clone(),arch,
            asset:Url::parse(&format!("https://github.com/nea-c/Nearly/releases/download/{tag}/{name}")).unwrap(),
            signature:Url::parse(&format!("https://github.com/nea-c/Nearly/releases/download/{tag}/{name}.sig")).unwrap(),size:bytes.len()};
        let comment=format!("version:{version}\tfile:{name}\tpayload-sha256:{payload_hash}\tupdater-protocol:3");
        let (key,signature)=signed_document(&bytes,&comment,true);
        let stage=win::legacy_fixture_stage(parent,&bytes,signature,&candidate,&key,&AtomicBool::new(false)).unwrap();
        (stage,candidate,key)
    }
    #[test]
    fn prerelease_incoming_target_is_rejected_even_when_flag_is_false_but_formal_updates_pre_source() {
        for flag in [false,true] {
            let mut meta=metadata();meta["prerelease"]=flag.into();
            let body=serde_json::to_string(&meta).unwrap().replace("r0.3","r3.7-pre.1");
            assert!(ReleaseCandidate::from_github_metadata(body.as_bytes(),"3.6.0",Architecture::X64).is_err());
        }
        let body=serde_json::to_string(&metadata()).unwrap().replace("r0.3","r3.7");
        assert_eq!(ReleaseCandidate::from_github_metadata(body.as_bytes(),"3.7.0-pre.1",Architecture::X64).unwrap().unwrap().version(),"3.7.0");
    }
    #[test]
    fn public_tag_binds_internal_asset_version_and_orders_numerically() {
        for (tag,version,current) in [("r1.0","1.0.0","0.2.0"),("r1.10","1.10.0","1.9.0"),("r2.0","2.0.0","1.10.0")] {
            let body=serde_json::to_string(&metadata()).unwrap().replace("r0.3",tag).replace("0.3.0",version);
            let next=ReleaseCandidate::from_github_metadata(body.as_bytes(),current,Architecture::X64).unwrap().unwrap();
            assert_eq!(next.version(),version);
            assert_eq!(next.display_version(),tag);
            assert!(next.asset.as_str().contains(&format!("/download/{tag}/Nearly_{tag}_x64-setup.exe")));
            assert!(ReleaseCandidate::from_github_metadata(body.as_bytes(),version,Architecture::X64).unwrap().is_none());
        }
        for tag in ["v0.3.0","r0.3.0","r00.3","r0.3-beta","r0.3+build"] {
            let mut m=metadata();m["tag_name"]=tag.into();m["html_url"]=format!("https://github.com/nea-c/Nearly/releases/tag/{tag}").into();
            assert!(matches!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&m).unwrap(),"0.2.0",Architecture::X64),Err(PackageError::InvalidMetadata)));
        }
        for flag in ["draft","prerelease"] {let mut m=metadata();m[flag]=true.into();assert!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&m).unwrap(),"0.2.0",Architecture::X64).unwrap().is_none());}
        let mut m=metadata();m["assets"][0]["name"]="Nearly_0.3.0_x64-setup.exe".into();
        assert!(matches!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&m).unwrap(),"0.2.0",Architecture::X64),Err(PackageError::NoCompatibleAsset)));
    }
    #[test]
    fn published_minisign_prehashed_vector_reaches_required_version_check() {
        // Public upstream interoperability vector (not signing material):
        // https://github.com/jedisct1/rust-minisign-verify/blob/master/src/lib.rs
        let key=TrustedKey{bytes:decode("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3").unwrap().try_into().unwrap()};
        let document="untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
        let mut c=candidate();c.size=4;
        // Crypto succeeds, but old signatures cannot authorize an update.
        assert_eq!(verify(b"test",STANDARD.encode(document).as_bytes(),&key,&c),Err(PackageError::SignedVersion));
    }
    // All signing material is ephemeral memory-only test data; never persisted.
    fn signed(bytes:&[u8],comment:&str,prehashed:bool)->(TrustedKey,Vec<u8>) {
        signed_file(bytes,comment,prehashed,"Nearly_r0.3_x64-setup.exe")
    }
    fn fixture_payload()->&'static [u8] {b"Nearly generated application payload; not the installer"}
    fn signed_file(bytes:&[u8],comment:&str,prehashed:bool,file:&str)->(TrustedKey,Vec<u8>) {
        signed_document(bytes,&format!("{comment}\tfile:{file}\tpayload-sha256:{}\tupdater-protocol:3",sha256(fixture_payload())),prehashed)
    }
    fn signed_document(bytes:&[u8],comment:&str,prehashed:bool)->(TrustedKey,Vec<u8>) {
        let rng=ring::rand::SystemRandom::new();let pkcs8=Ed25519KeyPair::generate_pkcs8(&rng).unwrap();let pair=Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut key=[0u8;42];key[..2].copy_from_slice(b"Ed");key[2..10].copy_from_slice(b"testonly");key[10..].copy_from_slice(pair.public_key().as_ref());
        let digest=Blake2b512::digest(bytes);
        let sig=pair.sign(if prehashed {digest.as_slice()}else{bytes});
        let mut record=if prehashed{b"ED".to_vec()}else{b"Ed".to_vec()};record.extend_from_slice(b"testonly");record.extend_from_slice(sig.as_ref());
        let mut global=sig.as_ref().to_vec();global.extend_from_slice(comment.as_bytes());
        let text=format!("untrusted comment: test only\n{}\ntrusted comment: {comment}\n{}\n",STANDARD.encode(record),STANDARD.encode(pair.sign(&global).as_ref()));
        (TrustedKey{bytes:key},STANDARD.encode(text).into_bytes())
    }
    #[test]
    fn payload_proof_requires_one_authenticated_lowercase_sha256() {
        let bytes=pe();let base="version:0.3.0\tfile:Nearly_r0.3_x64-setup.exe";
        let digest=sha256(fixture_payload());
        for fields in [String::new(),"\tpayload-sha256:".into(),format!("\tpayload-sha256:{}",&digest[..63]),format!("\tpayload-sha256:{digest}0"),format!("\tpayload-sha256:{}",digest.to_uppercase()),format!("\tpayload-sha256:{}g",&digest[..63]),format!("\tpayload-sha256:{digest}\tpayload-sha256:{digest}")] {
            let (key,signature)=signed_document(&bytes,&format!("{base}{fields}"),true);
            assert_eq!(verify_proof(&bytes,&signature,&key,&candidate()),Err(PackageError::SignedPayload));
        }
        for prehashed in [false,true] {
            let (key,signature)=signed(&bytes,"version:0.3.0",prehashed);
            let proof=verify_proof(&bytes,&signature,&key,&candidate()).unwrap();
            assert_eq!(proof.target_version(),"0.3.0");assert_eq!(proof.public_label(),"r0.3");assert_eq!(proof.arch(),Architecture::X64);
            assert_eq!(proof.asset_name(),"Nearly_r0.3_x64-setup.exe");assert_eq!(proof.installer_sha256(),sha256(&bytes));
            assert_eq!(proof.payload_sha256(),digest);assert_ne!(proof.payload_sha256(),proof.installer_sha256());
            assert_ne!(proof.payload_sha256(),sha256(b"wrong replacement executable"));assert_eq!(proof.signature(),signature);
            let doc=String::from_utf8(decode(std::str::from_utf8(&signature).unwrap()).unwrap()).unwrap();
            let tampered=STANDARD.encode(doc.replace(&digest,&sha256(b"wrong replacement executable")));
            assert_eq!(verify_proof(&bytes,tampered.as_bytes(),&key,&candidate()),Err(PackageError::InvalidSignature));
        }
    }
    #[test]
    fn protocol_proof_requires_one_authenticated_exact_protocol3() {
        let bytes=pe();
        assert_eq!(PackageError::SignedProtocol.code(),"signedProtocolMismatch");
        let base=format!("version:0.3.0\tfile:Nearly_r0.3_x64-setup.exe\tpayload-sha256:{}",sha256(fixture_payload()));
        for fields in ["","\tupdater-protocol:","\tupdater-protocol:2","\tupdater-protocol:4","\tupdater-protocol:03","\tupdater-protocol:3 ","\tupdater-protocol:3\tupdater-protocol:3","\tupdater-protocol:2\tupdater-protocol:3"] {
            let (key,signature)=signed_document(&bytes,&format!("{base}{fields}"),true);
            assert_eq!(verify_proof(&bytes,&signature,&key,&candidate()),Err(PackageError::SignedProtocol));
        }
        for prehashed in [false,true] {
            let (key,signature)=signed_document(&bytes,&format!("{base}\tupdater-protocol:3"),prehashed);
            assert_eq!(verify_proof(&bytes,&signature,&key,&candidate()).unwrap().updater_protocol(),3);
            let document=String::from_utf8(decode(std::str::from_utf8(&signature).unwrap()).unwrap()).unwrap();
            for changed in [document.replace("updater-protocol:3","updater-protocol:2"),document.replace("\tupdater-protocol:3",""),document.replace("updater-protocol:3","updater-protocol:3\tupdater-protocol:3")] {
                assert_eq!(verify_proof(&bytes,STANDARD.encode(changed).as_bytes(),&key,&candidate()),Err(PackageError::InvalidSignature));
            }
            // Neither an untrusted minisign comment nor unsigned release metadata
            // can supply the authenticated package capability.
            let (missing_key,missing_signature)=signed_document(&bytes,&base,prehashed);
            let document=String::from_utf8(decode(std::str::from_utf8(&missing_signature).unwrap()).unwrap()).unwrap();
            let untrusted=document.replace("untrusted comment: test only","untrusted comment: updater-protocol:3");
            assert_eq!(verify_proof(&bytes,STANDARD.encode(untrusted).as_bytes(),&missing_key,&candidate()),Err(PackageError::SignedProtocol));
        }
    }
    #[test]
    fn recovery_regains_proof_only_from_valid_canonical_signed_file() {
        let mut nonce=[0u8;8];getrandom::fill(&mut nonce).unwrap();
        let path=std::env::temp_dir().join(format!("Nearly-snapshot-proof-{:x}.bin",u64::from_le_bytes(nonce)));
        let bytes=pe();std::fs::write(&path,&bytes).unwrap();
        let (key,signature)=signed(&bytes,"version:0.3.0",true);
        {
            let mut file=File::open(&path).unwrap();
            let proof=authenticate_snapshot(&mut file,&signature,"0.3.0",Architecture::X64,&key).unwrap();
            assert_eq!(proof.updater_protocol(),3);
            assert_eq!(proof.payload_sha256(),sha256(fixture_payload()));assert_eq!(proof.installer_sha256(),sha256(&bytes));
            let (legacy_key,legacy_signature)=signed_document(&bytes,&format!("version:0.3.0\tfile:Nearly_r0.3_x64-setup.exe\tpayload-sha256:{}",sha256(fixture_payload())),true);
            assert_eq!(authenticate_snapshot(&mut file,&legacy_signature,"0.3.0",Architecture::X64,&legacy_key),Err(PackageError::SignedProtocol));
            for version in ["r0.3","0.3.1","0.3.0+build","0.3.0-beta","65536.0.0"] {assert_eq!(authenticate_snapshot(&mut file,&signature,version,Architecture::X64,&key),Err(PackageError::InvalidMetadata));}
            assert_eq!(authenticate_snapshot(&mut file,&signature,"0.4.0",Architecture::X64,&key),Err(PackageError::SignedVersion));
            assert_eq!(authenticate_snapshot(&mut file,&signature,"0.3.0",Architecture::Arm64,&key),Err(PackageError::Architecture));
            assert_eq!(authenticate_snapshot(&mut file,b"invalid signature","0.3.0",Architecture::X64,&key),Err(PackageError::InvalidSignature));
        }
        let mut changed=bytes;changed[100]^=1;std::fs::write(&path,&changed).unwrap();
        assert_eq!(authenticate_snapshot(&mut File::open(&path).unwrap(),&signature,"0.3.0",Architecture::X64,&key),Err(PackageError::InvalidSignature));
        std::fs::write(&path,[]).unwrap();
        assert_eq!(authenticate_snapshot(&mut File::open(&path).unwrap(),&signature,"0.3.0",Architecture::X64,&key),Err(PackageError::TooLarge));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn verifies_both_published_minisign_modes_and_authenticated_version() {
        for mode in [false,true] {let bytes=pe();let c=candidate();let(k,s)=signed(&bytes,"timestamp:1\tversion:0.3.0",mode);assert_eq!(verify(&bytes,&s,&k,&c),Ok(()));
            let mut tamper=bytes.clone();tamper[100]^=1;assert_eq!(verify(&tamper,&s,&k,&c),Err(PackageError::InvalidSignature));
            let mut changed=c.clone();changed.version=semver::Version::parse("0.4.0").unwrap();assert_eq!(verify(&bytes,&s,&k,&changed),Err(PackageError::SignedVersion));
            let (other,_)=signed(&bytes,"version:0.3.0",mode);assert_eq!(verify(&bytes,&s,&other,&c),Err(PackageError::InvalidSignature));
        }
    }
    #[test]
    fn rejects_missing_duplicate_and_tampered_signed_comment() {
        let bytes=pe();for comment in ["timestamp:1","version:0.2.0","version:0.3.0\tversion:0.3.0","version:r0.3"] {let(k,s)=signed(&bytes,comment,true);assert_eq!(verify(&bytes,&s,&k,&candidate()),Err(PackageError::SignedVersion))}
        let(k,s)=signed(&bytes,"version:0.3.0",true);let d=String::from_utf8(decode(std::str::from_utf8(&s).unwrap()).unwrap()).unwrap().replace("version:0.3.0","version:0.4.0");assert_eq!(verify(&bytes,STANDARD.encode(d).as_bytes(),&k,&candidate()),Err(PackageError::InvalidSignature));
        for sig in [vec![],b"garbage".to_vec(),vec![b'A';MAX_SIGNATURE+1]]{assert_eq!(verify(&bytes,&sig,&k,&candidate()),Err(PackageError::InvalidSignature))}
    }
    #[test]
    fn authenticated_filename_binds_payload_architecture() {
        let bytes=pe();let c=candidate();let(k,s)=signed(&bytes,"version:0.3.0",true);
        let (numeric_key,numeric_sig)=signed_file(&bytes,"version:0.3.0",true,"Nearly_0.3.0_x64-setup.exe");
        assert_eq!(verify(&bytes,&numeric_sig,&numeric_key,&c),Err(PackageError::Architecture));
        let mut arm=c.clone();arm.arch=Architecture::Arm64;
        assert_eq!(verify(&bytes,&s,&k,&arm),Err(PackageError::Architecture));
        let(k,s)=signed(&bytes,"version:0.3.0\tfile:Nearly_r0.3_arm64-setup.exe",true);
        assert_eq!(verify(&bytes,&s,&k,&c),Err(PackageError::Architecture));
    }
    #[test]
    fn registered_public_key_matches_enabled_production_installation() {
        let public=include_str!("../../.github/updater-public-key.pub");
        let bytes=STANDARD.decode(public.lines().nth(1).unwrap()).unwrap();
        assert!(production_key().is_some());
        assert_eq!(production_key().unwrap().bytes.as_slice(),bytes.as_slice());
        assert_eq!(sha256(public.as_bytes()),"2592845a518adb9df5b7773dd58672ea411b3038758bfaf2808a3cb13dcc8695");
        assert!(crate::startup_update::HANDOFF_RELEASE_VALIDATED);
    }
    #[test]
    fn validates_fixed_release_urls_sizes_duplicates_and_precedence() {
        let c=candidate();assert_eq!(c.version(),"0.3.0");assert!(production_key().is_some());
        for current in ["0.3.0","0.4.0","0.3.0+build"]{assert!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&metadata()).unwrap(),current,Architecture::X64).unwrap().is_none())}
        for value in ["https://evil.invalid/x","https://github.com/other/Nearly/releases/download/r0.3/Nearly_r0.3_x64-setup.exe","http://github.com/nea-c/Nearly/releases/download/r0.3/Nearly_r0.3_x64-setup.exe","https://github.com/nea-c/Nearly/releases/download/r0.3/Nearly_r0.3_x64-setup.exe?x=1"]{let mut m=metadata();m["assets"][0]["browser_download_url"]=value.into();assert!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&m).unwrap(),"0.2.0",Architecture::X64).is_err())}
        let mut m=metadata();m["assets"][0]["size"]=((MAX_PACKAGE+1) as u64).into();assert!(matches!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&m).unwrap(),"0.2.0",Architecture::X64),Err(PackageError::TooLarge)));
        let mut m=metadata();let duplicate=m["assets"][0].clone();m["assets"].as_array_mut().unwrap().push(duplicate);assert!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&m).unwrap(),"0.2.0",Architecture::X64).is_err());
        assert!(ReleaseCandidate::from_github_metadata(&serde_json::to_vec(&metadata()).unwrap(),"0.2.0",Architecture::Arm64).is_err());
    }
    #[test]
    fn checks_architecture_truncation_budget_and_redirects() {
        let mut wrong=pe();wrong[68..70].copy_from_slice(&0x8664u16.to_le_bytes());assert_eq!(verify_pe(&wrong,Architecture::X64),Err(PackageError::Architecture));
        for n in 0..90{assert_eq!(verify_pe(&pe()[..n],Architecture::X64),Err(PackageError::Architecture))}
        let mut b=pe();b[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());assert_eq!(verify_pe(&b,Architecture::X64),Err(PackageError::Architecture));
        for u in ["http://release-assets.githubusercontent.com/github-production-release-asset/x","https://evil.invalid/github-production-release-asset/x","https://user@release-assets.githubusercontent.com/github-production-release-asset/x","https://release-assets.githubusercontent.com/wrong/x"]{assert!(!allowed_redirect(&Url::parse(u).unwrap()))}
        assert!(allowed_redirect(&Url::parse("https://release-assets.githubusercontent.com/github-production-release-asset/1/x?signature=temporary").unwrap()));
        assert_eq!(cancelled(&AtomicBool::new(true)),Err(PackageError::Cancelled));
        let(k,s)=signed(&pe(),"version:0.3.0",true);assert_eq!(verify(&pe()[..127],&s,&k,&candidate()),Err(PackageError::TooLarge));
    }
    #[tokio::test]
    async fn cancellation_prevents_any_network_request() {assert_eq!(bounded_download(&candidate().asset,128,&AtomicBool::new(true)).await,Err(PackageError::Cancelled));}
    /// Owns one loopback server and its task. Every test error/panic aborts the
    /// server through Drop, including a fixture deliberately holding a response.
    struct LocalResponse {
        url:Url,
        task:tokio::task::JoinHandle<()>,
        request:Option<tokio::sync::oneshot::Receiver<()>>,
        sent:Option<tokio::sync::oneshot::Receiver<()>>,
        _release:Option<tokio::sync::oneshot::Sender<()>>,
    }
    impl Drop for LocalResponse {fn drop(&mut self){self.task.abort()}}
    impl LocalResponse {
        async fn new(response:Vec<u8>,hold_open:bool)->Self {
            use tokio::io::{AsyncReadExt,AsyncWriteExt};
            let listener=tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,0)).await.unwrap();
            let url=Url::parse(&format!("http://{}/fixture",listener.local_addr().unwrap())).unwrap();
            let(request_tx,request)=tokio::sync::oneshot::channel();
            let(sent_tx,sent)=tokio::sync::oneshot::channel();
            let(release_tx,release)=tokio::sync::oneshot::channel();
            let task=tokio::spawn(async move {
                let fixture=async move {
                    let(mut socket,_)=listener.accept().await.unwrap();
                    let mut request=Vec::new();let mut byte=[0u8;1];
                    while !request.ends_with(b"\r\n\r\n") {
                        if request.len()>=8192 || socket.read(&mut byte).await.unwrap_or(0)==0 {return}
                        request.push(byte[0]);
                    }
                    let _=request_tx.send(());
                    if socket.write_all(&response).await.is_err(){return}
                    let _=socket.flush().await;let _=sent_tx.send(());
                    if hold_open {let _=release.await;}
                    let _=socket.shutdown().await;
                };
                // Every accept/read/hold also has a hard fixture deadline.
                let _=tokio::time::timeout(Duration::from_secs(3),fixture).await;
            });
            Self{url,task,request:Some(request),sent:Some(sent),_release:Some(release_tx)}
        }
        async fn requested(&mut self) {
            tokio::time::timeout(Duration::from_secs(2),self.request.take().unwrap()).await.unwrap().unwrap();
        }
        async fn response_sent(&mut self) {
            tokio::time::timeout(Duration::from_secs(2),self.sent.take().unwrap()).await.unwrap().unwrap();
        }
        async fn finished(&mut self) {
            tokio::time::timeout(Duration::from_secs(2),&mut self.task).await.unwrap().unwrap();
        }
    }
    fn local_client()->reqwest::Client {
        reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(1)).timeout(Duration::from_secs(2)).build().unwrap()
    }
    #[tokio::test]
    async fn actual_response_reader_accepts_exact_budget_and_rejects_http_failure() {
        let client=local_client();let cancel=AtomicBool::new(false);
        for (response,expected) in [
            (b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nsafe".to_vec(),Ok(b"safe".to_vec())),
            (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nsa\r\n2\r\nfe\r\n0\r\n\r\n".to_vec(),Ok(b"safe".to_vec())),
            (b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 18\r\nConnection: close\r\n\r\nuntrusted response".to_vec(),Err(PackageError::Network)),
        ] {
            let mut server=LocalResponse::new(response,false).await;
            assert_eq!(bounded_download_with_client(&client,&server.url,4,&cancel).await,expected);
            server.requested().await;server.finished().await;
        }
    }
    #[tokio::test]
    async fn actual_response_reader_enforces_declared_and_chunked_size_and_truncation() {
        let client=local_client();let cancel=AtomicBool::new(false);
        for (response,expected) in [
            (b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n".to_vec(),PackageError::TooLarge),
            (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n".to_vec(),PackageError::TooLarge),
            (b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabc".to_vec(),PackageError::Network),
            (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nab".to_vec(),PackageError::Network),
        ] {
            let mut server=LocalResponse::new(response,false).await;
            assert_eq!(bounded_download_with_client(&client,&server.url,4,&cancel).await,Err(expected));
            server.requested().await;server.finished().await;
        }
    }
    #[tokio::test]
    async fn actual_response_reader_refuses_redirect_without_contacting_target() {
        let target=LocalResponse::new(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nsafe".to_vec(),false).await;
        let response=format!("HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",target.url);
        let mut server=LocalResponse::new(response.into_bytes(),false).await;
        assert_eq!(bounded_download_with_client(&local_client(),&server.url,4,&AtomicBool::new(false)).await,Err(PackageError::Network));
        server.requested().await;server.finished().await;
        // A policy regression would follow to this fixture and return success.
        // Its receiver also proves no request was observed on the denied target.
        let mut target=target;
        assert!(matches!(target.request.as_mut().unwrap().try_recv(),Err(tokio::sync::oneshot::error::TryRecvError::Empty)));
    }
    #[tokio::test]
    async fn actual_response_reader_cancels_pending_headers_and_pending_body() {
        for response in [Vec::new(),b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\na".to_vec()] {
            let mut server=LocalResponse::new(response,true).await;
            let cancel=AtomicBool::new(false);let client=local_client();
            let url=server.url.clone();
            let download=bounded_download_with_client(&client,&url,4,&cancel);
            let signal=async {server.requested().await;server.response_sent().await;cancel.store(true,Ordering::Release)};
            // No timing sleeps: cancellation follows the server's actual response
            // signal while the client awaits either headers or the remaining body.
            let (result,())=tokio::time::timeout(Duration::from_secs(2),async {tokio::join!(download,signal)}).await.unwrap();
            assert_eq!(result,Err(PackageError::Cancelled));
        }
    }
    #[tokio::test]
    async fn cancellation_interrupts_confirmed_pending_body_read() {
        let mut server=LocalResponse::new(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\na".to_vec(),true).await;
        let client=local_client();let mut response=client.get(server.url.clone()).send().await.unwrap();
        // Confirm headers AND the first byte reached reqwest before cancelling
        // the same body reader used by production while the rest stays pending.
        assert_eq!(&response.chunk().await.unwrap().unwrap()[..],b"a");
        server.requested().await;server.response_sent().await;
        let cancel=AtomicBool::new(false);
        let reader=bounded_response_body(response,4,&cancel);
        let signal=async {cancel.store(true,Ordering::Release)};
        let(result,())=tokio::time::timeout(Duration::from_secs(2),async {tokio::join!(reader,signal)}).await.unwrap();
        assert_eq!(result,Err(PackageError::Cancelled));
    }
    #[cfg(windows)]
    #[test]
    fn staging_is_locked_reverified_and_cleanup_owns_only_created_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let mut random=[0u8;8];getrandom::fill(&mut random).unwrap();let dir=std::env::temp_dir().join(format!("Nearly-package-test-{:x}",u64::from_le_bytes(random)));std::fs::create_dir(&dir).unwrap();
        let sentinel=dir.join("settings.json");std::fs::write(&sentinel,b"preserve").unwrap();let c=candidate();let bytes=pe();let(k,s)=signed(&bytes,"version:0.3.0",true);
        let mut staged=win::stage_in(&dir,&bytes,s.clone(),&c,&k,&AtomicBool::new(false)).unwrap();let path=staged.path().to_owned();assert_eq!(path.parent(),Some(dir.as_path()));assert_eq!(path.file_name().unwrap(),"Nearly_r0.3_x64-setup.exe");staged.reverify(&c,&k).unwrap();
        {
            let snapshot=staged.transaction_snapshot(&c,&k).unwrap();
            assert_eq!(snapshot.path(),path);assert_eq!(snapshot.package().payload_sha256(),sha256(fixture_payload()));
            assert_eq!(win::identity(snapshot.file()).unwrap(),win::identity(staged.file.as_ref().unwrap()).unwrap());
            let mut clone=snapshot.file().try_clone().unwrap();
            let proof=authenticate_snapshot(&mut clone,snapshot.package().signature(),snapshot.package().target_version(),snapshot.package().arch(),&k).unwrap();
            assert_eq!(&proof,snapshot.package());
            assert!(std::fs::OpenOptions::new().write(true).open(snapshot.path()).is_err());
            assert!(std::fs::remove_file(snapshot.path()).is_err());
        }
        let mut wrong=c.clone();wrong.version=semver::Version::new(0,4,0);
        assert!(matches!(staged.transaction_snapshot(&wrong,&k),Err(PackageError::SignedVersion)));
        assert!(staged.proof.is_none());
        // Match NSIS exehead myOpenFile: GENERIC_READ, FILE_SHARE_READ only.
        let mut nsis_read=std::fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();let mut check=Vec::new();nsis_read.read_to_end(&mut check).unwrap();assert_eq!(check,bytes);drop(nsis_read);
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());assert!(std::fs::remove_file(&path).is_err());assert!(std::fs::OpenOptions::new().write(true).create_new(true).open(&path).is_err());drop(staged);assert!(!path.exists());
        std::fs::write(&path,b"foreign retained package").unwrap();
        assert!(matches!(win::stage_in(&dir,&bytes,s.clone(),&c,&k,&AtomicBool::new(false)),Err(PackageError::Staging)));
        assert_eq!(std::fs::read(&path).unwrap(),b"foreign retained package");std::fs::remove_file(&path).unwrap();
        assert!(matches!(win::stage_in(&dir,&bytes,s,&c,&k,&AtomicBool::new(true)),Err(PackageError::Cancelled)));assert_eq!(std::fs::read(&sentinel).unwrap(),b"preserve");std::fs::remove_file(sentinel).unwrap();std::fs::remove_dir(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn read_only_lock_allows_native_process_creation() {
        use std::os::windows::{fs::OpenOptionsExt,process::CommandExt};
        let mut random=[0u8;8];getrandom::fill(&mut random).unwrap();
        let path=std::env::temp_dir().join(format!("Nearly-package-launch-test-{:x}.exe",u64::from_le_bytes(random)));
        // Copy a test runner, never an installer, and execute its harmless list
        // mode under exactly the access/sharing contract used for staging.
        let bytes=std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let mut created=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();created.write_all(&bytes).unwrap();drop(created);
        let lock=std::fs::OpenOptions::new().read(true).access_mode(0x80000000).share_mode(1).open(&path).unwrap();
        let owned=win::identity(&lock).unwrap();
        let output=std::process::Command::new(&path).arg("--list").creation_flags(0x08000000).output();
        drop(lock);win::cleanup_owned(&path,owned);
        assert!(output.unwrap().status.success());assert!(!path.exists());
    }
    #[cfg(windows)]
    #[test]
    fn cleanup_refuses_foreign_replacement_after_read_lock_closes() {
        use std::os::windows::fs::OpenOptionsExt;
        let mut random=[0u8;8];getrandom::fill(&mut random).unwrap();let dir=std::env::temp_dir().join(format!("Nearly-package-cleanup-test-{:x}",u64::from_le_bytes(random)));std::fs::create_dir(&dir).unwrap();
        let _guards=win::directories(&dir).unwrap();let path=dir.join("owned.exe");let moved=dir.join("moved-owned.exe");
        let mut created=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();created.write_all(b"owned").unwrap();drop(created);
        let lock=std::fs::OpenOptions::new().read(true).access_mode(0x80000000).share_mode(1).open(&path).unwrap();let owned=win::identity(&lock).unwrap();drop(lock);
        // Deterministically model substitution in the close/reopen interval.
        std::fs::rename(&path,&moved).unwrap();let mut foreign=std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();foreign.write_all(b"foreign replacement").unwrap();drop(foreign);
        win::cleanup_owned(&path,owned);assert_eq!(std::fs::read(&path).unwrap(),b"foreign replacement");assert_eq!(std::fs::read(&moved).unwrap(),b"owned");
        // Correct identity still permits deletion of this attempt's own object.
        win::cleanup_owned(&moved,owned);assert!(!moved.exists());std::fs::remove_file(path).unwrap();drop(_guards);std::fs::remove_dir(dir).unwrap();
    }
}

