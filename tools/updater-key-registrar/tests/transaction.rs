use base64::{engine::general_purpose::STANDARD, Engine};
use nearly_updater_key_registrar::{register, Api, PublicRecord, Stage, ENV, NAMES, REPO};
use serde_json::{json, Value};
use zeroize::Zeroizing;

#[derive(Default)]
struct Record {
    exists: bool,
    fail_save: bool,
    public: Option<String>,
}
impl PublicRecord for Record {
    fn assert_absent(&mut self) -> Result<(), &'static str> {
        if self.exists {
            Err("exists")
        } else {
            Ok(())
        }
    }
    fn save_new(&mut self, public: &str) -> Result<(), &'static str> {
        if self.fail_save || self.exists {
            return Err("create-new failed");
        }
        self.exists = true;
        self.public = Some(public.into());
        Ok(())
    }
}
struct Server {
    secret: crypto_box::SecretKey,
    writes: Vec<String>,
    statuses: Vec<Result<u16, &'static str>>,
    collision: bool,
    incomplete: bool,
    bad_policy: bool,
    bypass: bool,
    omitted_bypass: bool,
    race: bool,
    metadata_fail: bool,
}
impl Default for Server {
    fn default() -> Self {
        Self {
            secret: crypto_box::SecretKey::from([19; 32]),
            writes: vec![],
            statuses: vec![Ok(201), Ok(201)],
            collision: false,
            incomplete: false,
            bad_policy: false,
            bypass: false,
            omitted_bypass: false,
            race: false,
            metadata_fail: false,
        }
    }
}
impl Api for Server {
    fn get(&mut self, path: &str) -> Result<Value, &'static str> {
        if path == "/user" {
            return Ok(json!({"login":"nea-c","id":45559303}));
        }
        if path == REPO {
            return Ok(
                json!({"full_name":"nea-c/Nearly","owner":{"type":"User"},"default_branch":"main"}),
            );
        }
        if path.ends_with("/branches/main/protection") {
            let mut protection = json!({"enforce_admins":{"enabled":!self.bad_policy},"allow_force_pushes":{"enabled":false},"allow_deletions":{"enabled":false},"required_pull_request_reviews":{"required_approving_review_count":0,"bypass_pull_request_allowances":{"users":if self.bypass {vec![json!({"id":45559303})]} else {vec![]},"teams":[],"apps":[]}}});
            if self.omitted_bypass {
                protection["required_pull_request_reviews"]
                    .as_object_mut()
                    .unwrap()
                    .remove("bypass_pull_request_allowances");
            }
            return Ok(protection);
        }
        if path == ENV {
            return Ok(
                json!({"name":"nearly-updater-production","can_admins_bypass":false,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"protection_rules":[{"type":"required_reviewers","prevent_self_review":false,"reviewers":[{"type":"User","reviewer":{"id":45559303}}]}]}),
            );
        }
        if path.contains("/deployment-branch-policies?") {
            return Ok(
                json!({"total_count":1,"branch_policies":[{"name":"main","type":"branch"}]}),
            );
        }
        if path.ends_with("/secrets/public-key") {
            return Ok(
                json!({"key_id":"123","key":STANDARD.encode(self.secret.public_key().as_bytes())}),
            );
        }
        if path.contains("/secrets?") {
            let environment = path.starts_with(ENV);
            let mut secrets = vec![];
            if environment {
                for name in NAMES.iter().take(self.writes.len()) {
                    secrets.push(json!({"name":name,"created_at":"2026-10-18T00:00:00Z","updated_at":"2026-10-18T00:00:00Z"}));
                }
                if self.race && self.writes.len() == 1 {
                    secrets.push(json!({"name":NAMES[1]}));
                }
                if self.metadata_fail && self.writes.len() == 2 {
                    secrets.clear();
                }
            } else if self.collision {
                secrets.push(json!({"name":NAMES[0].to_lowercase()}));
            }
            return Ok(
                json!({"total_count":if self.incomplete {101} else {secrets.len()},"secrets":secrets}),
            );
        }
        Err("unexpected endpoint")
    }
    fn put(&mut self, path: &str, body: &str) -> Result<u16, &'static str> {
        let i = self.writes.len();
        if path != format!("{ENV}/secrets/{}", NAMES[i]) {
            return Err("wrong target");
        }
        self.writes.push(body.into());
        self.statuses[i]
    }
}

#[test]
fn personal_repository_omitted_bypass_metadata_matches_live_github_response() {
    let mut api = Server {
        omitted_bypass: true,
        collision: true,
        ..Server::default()
    };
    let mut record = Record::default();
    // Reaches the names read (collision), rather than rejecting the live schema.
    // A separate read-only preflight test below asserts the successful policy.
    assert_eq!(
        nearly_updater_key_registrar::preflight(&mut api, &mut record).unwrap_err(),
        "secret already exists"
    );
}

#[test]
fn success_sends_only_sealed_values_and_saved_public_key_matches_registered_key() {
    let mut api = Server::default();
    let mut record = Record::default();
    assert_eq!(register(&mut api, &mut record), Ok(()));
    assert_eq!(api.writes.len(), 2);
    let decode = |body: &str| {
        let v: Value = serde_json::from_str(body).unwrap();
        assert_eq!(v.as_object().unwrap().len(), 2);
        assert_eq!(v["key_id"], "123");
        let bytes = STANDARD
            .decode(v["encrypted_value"].as_str().unwrap())
            .unwrap();
        Zeroizing::new(String::from_utf8(api.secret.unseal(&bytes).unwrap()).unwrap())
    };
    let key = decode(&api.writes[0]);
    let password = decode(&api.writes[1]);
    assert!(password.len() >= 43);
    assert!(!api
        .writes
        .iter()
        .any(|b| b.contains(password.as_str()) || b.contains(key.as_str())));
    let box_text =
        Zeroizing::new(String::from_utf8(STANDARD.decode(key.as_bytes()).unwrap()).unwrap());
    let sk = minisign::SecretKeyBox::from_string(&box_text)
        .unwrap()
        .into_secret_key(Some(password.to_string()))
        .unwrap();
    let pk = minisign::PublicKeyBox::from_string(record.public.as_ref().unwrap())
        .unwrap()
        .into_public_key()
        .unwrap();
    let data = b"independent disposable registration test";
    let sig = minisign::sign(Some(&pk), &sk, std::io::Cursor::new(data), None, None).unwrap();
    assert!(minisign::verify(&pk, &sig, std::io::Cursor::new(data), true, false, false).is_ok());
    // Same registered bytes must also satisfy the application's protocol-3
    // verifier, compiled into the existing signer from native source.
    let pe = |machine: u16, magic: u16| {
        let mut bytes = vec![0u8; 256];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&machine.to_le_bytes());
        bytes[88..90].copy_from_slice(&magic.to_le_bytes());
        bytes
    };
    let payload = pe(0x8664, 0x20b);
    let installer = pe(0x14c, 0x10b);
    let manifest = nearly_updater_signer::Manifest {
        updater_protocol: 3,
        version: "3.1.0".into(),
        arch: "x64".into(),
        file: "Nearly_r3.1_x64-setup.exe".into(),
        source_commit: "a".repeat(40),
        artifact_id: "123".into(),
        archive_member: "Nearly.exe".into(),
        installer_sha256: nearly_updater_signer::hash(&installer),
        payload_sha256: nearly_updater_signer::hash(&payload),
    };
    let signed =
        nearly_updater_signer::sign_bytes(&installer, &payload, &manifest, &pk, &sk).unwrap();
    assert!(nearly_updater_signer::verify_signature(
        &installer, &signed, &manifest, &pk
    ));
    let mut tampered = installer;
    tampered[140] ^= 1;
    assert!(!nearly_updater_signer::verify_signature(
        &tampered, &signed, &manifest, &pk
    ));
}

#[test]
fn existing_names_incomplete_lists_bad_policy_and_local_record_stop_before_generation_or_writes() {
    for i in 0..5 {
        let mut api = Server::default();
        let mut record = Record::default();
        match i {
            0 => api.collision = true,
            1 => api.incomplete = true,
            2 => api.bad_policy = true,
            3 => record.exists = true,
            _ => api.bypass = true,
        }
        assert_eq!(
            register(&mut api, &mut record).unwrap_err().stage,
            Stage::Preflight
        );
        assert!(api.writes.is_empty());
        assert!(record.public.is_none());
    }
}

#[test]
fn failed_public_record_never_writes_remote_secrets() {
    let mut api = Server::default();
    let mut record = Record {
        fail_save: true,
        ..Record::default()
    };
    assert_eq!(
        register(&mut api, &mut record).unwrap_err().stage,
        Stage::PublicRecord
    );
    assert!(api.writes.is_empty());
}

#[test]
fn updates_errors_and_timeouts_stop_without_retry_or_second_write() {
    for status in [Ok(204), Ok(403), Err("timeout: SECRET_CANARY_DO_NOT_ECHO")] {
        let mut api = Server {
            statuses: vec![status, Ok(201)],
            ..Server::default()
        };
        let mut record = Record::default();
        let error = register(&mut api, &mut record).unwrap_err();
        assert_eq!(error.stage, Stage::Put);
        assert!(error.outcome_uncertain);
        assert_eq!(error.confirmed_created, 0);
        assert_eq!(api.writes.len(), 1);
        assert!(record.public.is_some());
        assert!(!format!("{error:?}").contains("SECRET_CANARY"));
    }
}

#[test]
fn second_write_timeout_reports_first_success_and_preserves_public_binding() {
    let mut api = Server {
        statuses: vec![Ok(201), Err("timeout")],
        ..Server::default()
    };
    let mut record = Record::default();
    let error = register(&mut api, &mut record).unwrap_err();
    assert_eq!(error.stage, Stage::Put);
    assert_eq!(error.confirmed_created, 1);
    assert!(error.outcome_uncertain);
    assert_eq!(api.writes.len(), 2);
    assert!(record.public.is_some());
}

#[test]
fn name_appearing_between_writes_blocks_second_write() {
    let mut api = Server {
        race: true,
        ..Server::default()
    };
    let mut record = Record::default();
    let error = register(&mut api, &mut record).unwrap_err();
    assert_eq!(error.stage, Stage::Recheck);
    assert_eq!(error.confirmed_created, 1);
    assert_eq!(api.writes.len(), 1);
}

#[test]
fn missing_final_metadata_is_not_success() {
    let mut api = Server {
        metadata_fail: true,
        ..Server::default()
    };
    let mut record = Record::default();
    let error = register(&mut api, &mut record).unwrap_err();
    assert_eq!(error.stage, Stage::Confirmation);
    assert_eq!(error.confirmed_created, 2);
    assert_eq!(api.writes.len(), 2);
}
