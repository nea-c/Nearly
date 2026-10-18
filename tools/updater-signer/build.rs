use std::{env, fs, path::PathBuf};
fn main() {
    let source = PathBuf::from("../../src-tauri/src/update_package.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(source)
        .expect("native verifier source")
        .replace("\r\n", "\n");
    // Compile the actual checked-out verifier bodies, not a maintained copy.
    // Markers deliberately fail the build if native code is reorganized.
    let constants = text
        .split("pub const MAX_METADATA")
        .nth(1)
        .unwrap()
        .split("#[derive(Clone, Debug)]\npub struct ReleaseCandidate")
        .next()
        .unwrap();
    let verification = text
        .split("/// Only native embedded configuration")
        .nth(1)
        .unwrap()
        .split("fn read_snapshot_bytes")
        .next()
        .unwrap();
    let pe = text
        .split("fn verify_pe(")
        .nth(1)
        .unwrap()
        .split("fn cancelled(")
        .next()
        .unwrap();
    let module = format!(
        r#"
use base64::{{engine::general_purpose::STANDARD, Engine}};
use blake2::{{Blake2b512, Digest}};
pub const MAX_METADATA{constants}
struct ReleaseCandidate {{version:semver::Version,arch:Architecture,size:usize}}
impl ReleaseCandidate {{fn display_version(&self)->String{{format!("r{{}}.{{}}",self.version.major,self.version.minor)}} fn version(&self)->String{{self.version.to_string()}}}}
/// Only native embedded configuration{verification}
fn verify_pe({pe}
pub fn check(bytes:&[u8],signature:&[u8],public:&[u8],version:&str,arch:&str,payload:&str)->bool {{
 let Ok(bytes_key)=public.try_into() else {{return false}};
 let Ok(version)=semver::Version::parse(version) else {{return false}};
 let arch=match arch {{"x64"=>Architecture::X64,"arm64"=>Architecture::Arm64,_=>return false}};
 let candidate=ReleaseCandidate{{version,arch,size:bytes.len()}};
 verify_proof(bytes,signature,&TrustedKey{{bytes:bytes_key}},&candidate).is_ok_and(|proof|proof.payload_sha256()==payload)
}}
"#
    );
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("native_verifier.rs"),
        module,
    )
    .unwrap();
}
