//! Memory-only registration library. The explicitly invoked CLI acquires existing
//! credentials before generation; no secret arguments or private files are used.
use base64::{engine::general_purpose::STANDARD, Engine};
pub mod credential;
pub mod public_record;
pub mod transport;
pub fn seal(key: &str, value: &[u8]) -> Result<String, &'static str> {
    let bytes = STANDARD
        .decode(key)
        .map_err(|_| "invalid service public key")?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "invalid service public key")?;
    // crypto_box accepts non-contributory Montgomery points. A public clamped
    // test scalar detects the low-order points before encrypting any secret.
    if curve25519_dalek::MontgomeryPoint(bytes)
        .mul_clamped([0; 32])
        .to_bytes()
        == [0; 32]
    {
        return Err("invalid service public key");
    }
    let encrypted = crypto_box::PublicKey::from(bytes)
        .seal(&mut crypto_box::aead::OsRng, value)
        .map_err(|_| "encryption failed")?;
    Ok(STANDARD.encode(encrypted))
}

use std::io::Cursor;
use zeroize::Zeroizing;
// Intentionally no Debug/Clone/Serialize or secret getters.
pub struct PreparedKey {
    public: String,
    encrypted: Zeroizing<String>,
    password: Zeroizing<String>,
    proof: String,
}
const PROBE: &[u8] = b"Nearly disposable key registration self-verification v1";
pub fn generate() -> Result<PreparedKey, &'static str> {
    let mut random = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *random).map_err(|_| "random source failed")?;
    let password = Zeroizing::new(STANDARD.encode(*random));
    let pair = minisign::KeyPair::generate_encrypted_keypair(Some(password.to_string()))
        .map_err(|_| "key generation failed")?;
    let boxed = Zeroizing::new(
        pair.sk
            .to_box(None)
            .map_err(|_| "key encoding failed")?
            .to_string(),
    );
    let decrypted = minisign::SecretKeyBox::from_string(&boxed)
        .and_then(|b| b.into_secret_key(Some(password.to_string())))
        .map_err(|_| "key roundtrip failed")?;
    let proof = minisign::sign(
        Some(&pair.pk),
        &decrypted,
        Cursor::new(PROBE),
        Some("Nearly key registration proof v1"),
        None,
    )
    .map_err(|_| "proof signing failed")?
    .to_string();
    native_probe(&pair.pk, &decrypted)?;
    let key = PreparedKey {
        public: pair
            .pk
            .to_box()
            .map_err(|_| "public key encoding failed")?
            .to_string(),
        encrypted: Zeroizing::new(STANDARD.encode(boxed.as_bytes())),
        password,
        proof,
    };
    if !key.verify_probe() {
        return Err("proof verification failed");
    }
    Ok(key)
}
fn native_probe(pk: &minisign::PublicKey, sk: &minisign::SecretKey) -> Result<(), &'static str> {
    let pe = |machine: u16, magic: u16| {
        let mut b = vec![0u8; 256];
        b[..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());
        b[64..68].copy_from_slice(b"PE\0\0");
        b[68..70].copy_from_slice(&machine.to_le_bytes());
        b[88..90].copy_from_slice(&magic.to_le_bytes());
        b
    };
    let payload = pe(0x8664, 0x20b);
    let installer = pe(0x14c, 0x10b);
    let manifest = nearly_updater_signer::Manifest {
        updater_protocol: 3,
        version: "3.1.0".into(),
        arch: "x64".into(),
        file: "Nearly_r3.1_x64-setup.exe".into(),
        source_commit: "a".repeat(40),
        artifact_id: "1".into(),
        archive_member: "Nearly.exe".into(),
        installer_sha256: nearly_updater_signer::hash(&installer),
        payload_sha256: nearly_updater_signer::hash(&payload),
    };
    nearly_updater_signer::sign_bytes(&installer, &payload, &manifest, pk, sk)
        .map(|_| ())
        .map_err(|_| "native protocol-3 self-verification failed")
}
impl PreparedKey {
    pub fn public_key(&self) -> &str {
        &self.public
    }
    pub fn verify_probe(&self) -> bool {
        let Ok(pk) =
            minisign::PublicKeyBox::from_string(&self.public).and_then(|b| b.into_public_key())
        else {
            return false;
        };
        let Ok(sig) = minisign::SignatureBox::from_string(&self.proof) else {
            return false;
        };
        sig.trusted_comment().ok().as_deref() == Some("Nearly key registration proof v1")
            && minisign::verify(&pk, &sig, Cursor::new(PROBE), true, false, false).is_ok()
    }
}

pub const REPO: &str = "/repos/nea-c/Nearly";
pub const ENV: &str = "/repos/nea-c/Nearly/environments/nearly-updater-production";
pub const NAMES: [&str; 2] = [
    "NEARLY_UPDATER_PRIVATE_KEY",
    "NEARLY_UPDATER_PRIVATE_KEY_PASSWORD",
];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Preflight,
    Generation,
    PublicRecord,
    Recheck,
    Put,
    Confirmation,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub stage: Stage,
    pub confirmed_created: usize,
    pub outcome_uncertain: bool,
}
// Implementations are trusted. The CLI explicitly constructs the fixed HTTPS
// adapter only after argument validation and existing credential acquisition.
pub trait Api {
    fn get(&mut self, path: &str) -> Result<serde_json::Value, &'static str>;
    fn put(&mut self, path: &str, body: &str) -> Result<u16, &'static str>;
}
pub trait PublicRecord {
    // Must reject all pre-existing intended key/public-record paths before generation.
    fn assert_absent(&mut self) -> Result<(), &'static str>;
    // Atomic create-new and durable public-only record BEFORE the first remote PUT.
    fn save_new(&mut self, public_key: &str) -> Result<(), &'static str>;
}
fn policy(api: &mut impl Api) -> Result<(), &'static str> {
    use serde_json::json;
    let user = api.get("/user")?;
    let repo = api.get(REPO)?;
    if user["login"] != "nea-c"
        || user["id"] != 45559303u64
        || repo["full_name"] != "nea-c/Nearly"
        || repo["owner"]["type"] != "User"
        || repo["default_branch"] != "main"
    {
        return Err("wrong repository or account");
    }
    let p = api.get(&format!("{REPO}/branches/main/protection"))?;
    if p["enforce_admins"]["enabled"] != true
        || p["allow_force_pushes"]["enabled"] != false
        || p["allow_deletions"]["enabled"] != false
        || p["required_pull_request_reviews"]["required_approving_review_count"] != 0
    {
        return Err("main policy mismatch");
    }
    // GitHub omits this property for personal repositories; adding actors to
    // bypass lists is organization-only. Owner type User was required above.
    // A present property must still have all three empty arrays (null rejects).
    if let Some(bypass) = p["required_pull_request_reviews"].get("bypass_pull_request_allowances") {
        if ["users", "teams", "apps"]
            .iter()
            .any(|kind| bypass[kind].as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err("PR bypass policy mismatch");
        }
    }
    let e = api.get(ENV)?;
    if e["name"] != "nearly-updater-production"
        || e["can_admins_bypass"] != false
        || e["deployment_branch_policy"]
            != json!({"protected_branches":false,"custom_branch_policies":true})
    {
        return Err("environment policy mismatch");
    }
    let rules = e["protection_rules"]
        .as_array()
        .ok_or("missing reviewer rule")?;
    let reviewers: Vec<_> = rules
        .iter()
        .filter(|r| r["type"] == "required_reviewers")
        .collect();
    if reviewers.len() != 1
        || reviewers[0]["prevent_self_review"] != false
        || reviewers[0]["reviewers"].as_array().is_none_or(|r| {
            r.len() != 1 || r[0]["type"] != "User" || r[0]["reviewer"]["id"] != 45559303u64
        })
    {
        return Err("reviewer policy mismatch");
    }
    let b = api.get(&format!("{ENV}/deployment-branch-policies?per_page=100"))?;
    if b["total_count"] != 1
        || b["branch_policies"]
            .as_array()
            .is_none_or(|p| p.len() != 1 || p[0]["name"] != "main" || p[0]["type"] != "branch")
    {
        return Err("deployment branch mismatch");
    }
    Ok(())
}
fn names(api: &mut impl Api, created: usize) -> Result<(), &'static str> {
    for (path, environment) in [
        (format!("{REPO}/actions/secrets?per_page=100"), false),
        (format!("{ENV}/secrets?per_page=100"), true),
    ] {
        let v = api.get(&path)?;
        let entries = v["secrets"].as_array().ok_or("invalid secret metadata")?;
        // Never assume first-page absence. Larger/malformed lists fail closed.
        if entries.len() > 100 || v["total_count"].as_u64() != Some(entries.len() as u64) {
            return Err("incomplete secret metadata");
        }
        for (i, name) in NAMES.iter().enumerate() {
            let matched: Vec<_> = entries
                .iter()
                .filter(|s| {
                    s["name"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case(name))
                })
                .collect();
            if environment && i < created {
                if matched.len() != 1
                    || matched[0]["created_at"].as_str().is_none_or(str::is_empty)
                    || matched[0]["updated_at"].as_str().is_none_or(str::is_empty)
                {
                    return Err("created metadata missing");
                }
            } else if !matched.is_empty() {
                return Err("secret already exists");
            }
        }
    }
    Ok(())
}
/// Read-only preflight, never generates a key or sends a PUT.
pub fn preflight(api: &mut impl Api, record: &mut impl PublicRecord) -> Result<(), &'static str> {
    policy(api)
        .and_then(|_| names(api, 0))
        .and_then(|_| record.assert_absent())
}
/// Calling this does NOT establish human authorization. The CLI requires an
/// explicit target confirmation and a fresh public receipt. Requires an exclusive administrator change window:
/// GitHub PUT is create-or-update, NOT atomic create-only. Never retry this function
/// after an uncertain/partial result; retain the saved public record for diagnosis.
pub fn register(api: &mut impl Api, record: &mut impl PublicRecord) -> Result<(), Failure> {
    let fail = |stage, confirmed_created, outcome_uncertain| Failure {
        stage,
        confirmed_created,
        outcome_uncertain,
    };
    preflight(api, record).map_err(|_| fail(Stage::Preflight, 0, false))?;
    let service = api
        .get(&format!("{ENV}/secrets/public-key"))
        .map_err(|_| fail(Stage::Preflight, 0, false))?;
    let service_key = service["key"]
        .as_str()
        .ok_or(fail(Stage::Preflight, 0, false))?;
    let id = service["key_id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric()))
        .ok_or(fail(Stage::Preflight, 0, false))?;
    seal(service_key, b"preflight").map_err(|_| fail(Stage::Preflight, 0, false))?;
    let key = generate().map_err(|_| fail(Stage::Generation, 0, false))?;
    record
        .save_new(key.public_key())
        .map_err(|_| fail(Stage::PublicRecord, 0, false))?;
    for (i, value) in [key.encrypted.as_bytes(), key.password.as_bytes()]
        .iter()
        .enumerate()
    {
        // Re-read both names and policy immediately before EACH write. Still not CAS.
        policy(api)
            .and_then(|_| names(api, i))
            .map_err(|_| fail(Stage::Recheck, i, false))?;
        let encrypted = seal(service_key, value).map_err(|_| fail(Stage::Recheck, i, false))?;
        let body = Zeroizing::new(
            serde_json::json!({"encrypted_value":encrypted,"key_id":id}).to_string(),
        );
        match api.put(&format!("{ENV}/secrets/{}", NAMES[i]), &body) {
            Ok(201) => {}
            // 204 means an update occurred; even an error status may follow an
            // accepted write via an intermediary. Never regenerate or retry.
            Ok(_) | Err(_) => return Err(fail(Stage::Put, i, true)),
        }
    }
    names(api, 2).map_err(|_| fail(Stage::Confirmation, 2, false))?;
    Ok(())
}
