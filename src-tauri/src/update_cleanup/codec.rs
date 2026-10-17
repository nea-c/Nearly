use serde::{Deserialize, Serialize};

pub const MAX_RECEIPT_BYTES: usize = 4096;
pub const MAX_ATTEMPTS: u8 = 3;
pub const MAX_TIME_MS: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub volume: u64,
    pub file_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Root {
    pub path: String,
    pub identity: Identity,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub internal_version: String,
    pub public_tag: String,
    pub architecture: Architecture,
    pub download_asset: String,
    pub signature_proof_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Architecture {
    #[serde(rename = "x64")]
    X64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Installer {
    pub basename: String,
    pub identity: Identity,
    pub length: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub nonce: String,
    pub root: Root,
    pub release: Release,
    pub installer: Installer,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum State {
    Prepared,
    HandoffCommitted,
    InstallationSucceeded,
    RestartHealthy,
    CleanupPending,
    Cleaned,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub version: u8,
    pub binding: Binding,
    pub state: State,
    pub sequence: u8,
    pub attempts: u8,
    pub next_retry_ms: Option<u64>,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn identity(value: &Identity) -> bool {
    hex(&value.file_id, 32) && value.file_id.bytes().any(|c| c != b'0')
}
fn root_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() < 4
        || bytes.len() > 512
        || !bytes[0].is_ascii_uppercase()
        || &bytes[1..3] != b":\\"
    {
        return false;
    }
    path[3..].split('\\').all(|part| {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix)
                    .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
            });
        !reserved
            && !part.is_empty()
            && part != "."
            && part != ".."
            && !part.ends_with(['.', ' '])
            && !part
                .chars()
                .any(|c| c.is_control() || "<>:\"/|?*".contains(c))
    })
}
pub fn validate_binding(binding: &Binding) -> Result<(), String> {
    let reject = || Err("Invalid updater cleanup binding".into());
    let b = binding;
    if !hex(&b.nonce, 32)
        || !root_path(&b.root.path)
        || !identity(&b.root.identity)
        || !identity(&b.installer.identity)
        || !hex(&b.installer.sha256, 64)
        || !hex(&b.release.signature_proof_digest, 64)
        || b.installer.length == 0
        || b.installer.length > 1_073_741_824
    {
        return reject();
    }
    let pieces: Vec<_> = b.release.internal_version.split('.').collect();
    if pieces.len() != 3
        || pieces.iter().any(|p| {
            p.is_empty()
                || p.len() > 5
                || (p.len() > 1 && p.starts_with('0'))
                || !p.bytes().all(|c| c.is_ascii_digit())
                || p.parse::<u16>().is_err()
        })
    {
        return reject();
    }
    if pieces[2] != "0" {
        return reject();
    }
    let tag = format!("r{}.{}", pieces[0], pieces[1]);
    if b.release.public_tag != tag
        || b.release.download_asset != format!("Nearly_{tag}_x64-setup.exe")
        || b.installer.basename
            != format!(
                "Nearly-update-{}-{}-setup.exe",
                b.release.internal_version, b.nonce
            )
    {
        return reject();
    }
    Ok(())
}
fn validate(receipt: &Receipt) -> Result<(), String> {
    validate_binding(&receipt.binding)?;
    let min = match receipt.state {
        State::Prepared => 0,
        State::HandoffCommitted => 1,
        State::InstallationSucceeded => 2,
        State::RestartHealthy => 3,
        State::CleanupPending => 4,
        State::Cleaned => 5,
    };
    if receipt.version != 1
        || receipt.sequence < min
        || receipt.sequence > 64
        || receipt.attempts > MAX_ATTEMPTS
        || receipt.next_retry_ms.is_some_and(|t| t > MAX_TIME_MS)
        || (receipt.attempts == 0 && receipt.next_retry_ms.is_some())
        || (!matches!(receipt.state, State::CleanupPending | State::Cleaned)
            && receipt.attempts != 0)
        || (receipt.state == State::Cleaned && receipt.next_retry_ms.is_some())
        || (receipt.attempts == MAX_ATTEMPTS && receipt.next_retry_ms.is_some())
    {
        return Err("Invalid cleanup receipt state or bounds".into());
    }
    Ok(())
}
pub fn encode(receipt: &Receipt) -> Result<Vec<u8>, String> {
    validate(receipt)?;
    let bytes = serde_json::to_vec(receipt).map_err(|_| "Receipt encoding failed")?;
    if bytes.len() > MAX_RECEIPT_BYTES {
        return Err("Receipt exceeds byte limit".into());
    }
    Ok(bytes)
}
pub fn decode(bytes: &[u8]) -> Result<Receipt, String> {
    if bytes.len() > MAX_RECEIPT_BYTES {
        return Err("Receipt exceeds byte limit".into());
    }
    // Struct deserializers reject duplicate as well as unknown fields at every level.
    let receipt: Receipt =
        serde_json::from_slice(bytes).map_err(|_| "Invalid strict receipt JSON")?;
    validate(&receipt)?;
    Ok(receipt)
}
