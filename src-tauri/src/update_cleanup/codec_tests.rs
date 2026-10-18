use super::codec::*;

fn binding() -> Binding {
    Binding {
        nonce: "a".repeat(32),
        root: Root {
            path: "C:\\Fixture\\Nearly".into(),
            identity: Identity {
                volume: 7,
                file_id: "1".repeat(32),
            },
        },
        release: Release {
            internal_version: "1.0.0".into(),
            public_tag: "r1.0".into(),
            architecture: Architecture::X64,
            download_asset: "Nearly_r1.0_x64-setup.exe".into(),
            signature_proof_digest: "b".repeat(64),
        },
        installer: Installer {
            basename: format!("Nearly-update-1.0.0-{}-setup.exe", "a".repeat(32)),
            identity: Identity {
                volume: 7,
                file_id: "2".repeat(32),
            },
            length: 1234,
            sha256: "c".repeat(64),
        },
    }
}
fn receipt() -> Receipt {
    Receipt {
        version: 1,
        binding: binding(),
        state: State::Prepared,
        sequence: 0,
        attempts: 0,
        next_retry_ms: None,
    }
}

#[test]
fn valid_metadata_roundtrips_without_any_authorization_flags() {
    let r = receipt();
    let bytes = encode(&r).unwrap();
    assert_eq!(decode(&bytes).unwrap(), r);
    let json = String::from_utf8(bytes).unwrap();
    assert!(!json.contains("secret"));
    assert!(!json.contains("\"healthy\":"));
}
#[test]
fn abandoned_receipt_is_terminal_metadata_with_no_cleanup_retry_authority() {
    let mut value = serde_json::to_value(receipt()).unwrap();
    value["state"] = serde_json::json!("Abandoned");
    value["sequence"] = serde_json::json!(1);
    let bytes = serde_json::to_vec(&value).unwrap();
    let decoded = decode(&bytes).expect("a proved never-launched attempt can be abandoned durably");
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&encode(&decoded).unwrap()).unwrap(), value);
    for (field, invalid) in [("sequence", 0), ("attempts", 1)] {
        let mut bad = value.clone();
        bad[field] = serde_json::json!(invalid);
        assert!(decode(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
}
#[test]
fn nonce_version_public_asset_and_installer_name_must_match_exactly() {
    let mut b = binding();
    b.installer.basename = "Nearly_r1.0_x64-setup.exe".into();
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.nonce = "A".repeat(32);
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.release.download_asset = "Nearly_r1.0_arm64-setup.exe".into();
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.release.public_tag = "r2.0".into();
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.release.internal_version = "1.00.0".into();
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.release.internal_version = "1.0.1".into();
    b.release.public_tag = "r1.0.1".into();
    b.release.download_asset = "Nearly_r1.0.1_x64-setup.exe".into();
    b.installer.basename = format!("Nearly-update-1.0.1-{}-setup.exe", b.nonce);
    assert!(validate_binding(&b).is_err());
}
#[test]
fn strict_bounded_codec_rejects_unknown_duplicate_truncated_and_deep_data() {
    let bytes = encode(&receipt()).unwrap();
    let json = String::from_utf8(bytes.clone()).unwrap();
    for bad in [
        json.replacen("{", "{\"unknown\":1,", 1),
        json.replacen("{", "{\"version\":1,", 1),
        json.replacen("\"volume\":7", "\"volume\":7,\"volume\":8", 1),
    ] {
        assert!(decode(bad.as_bytes()).is_err());
    }
    assert!(decode(&bytes[..bytes.len() - 1]).is_err());
    assert!(decode(&vec![b' '; MAX_RECEIPT_BYTES + 1]).is_err());
    assert!(decode("[".repeat(200).as_bytes()).is_err());
    let mut r = receipt();
    r.sequence = 65;
    assert!(encode(&r).is_err());
    r = receipt();
    r.attempts = 4;
    assert!(encode(&r).is_err());
    r = receipt();
    r.next_retry_ms = Some(MAX_TIME_MS + 1);
    assert!(encode(&r).is_err());
}
#[test]
fn paths_and_identity_fields_cannot_smuggle_alternate_files_or_unbounded_values() {
    for path in [
        "relative\\Nearly",
        "C:\\Fixture\\..\\Nearly",
        "C:\\Fixture\\Nearly:stream",
        "\\\\server\\Nearly",
        "C:\\Fixture\\Nearly.",
        "C:\\Fixture\\Nearly\\",
        "C:\\NUL\\Nearly",
        "C:\\COM1.txt\\Nearly",
    ] {
        let mut b = binding();
        b.root.path = path.into();
        assert!(validate_binding(&b).is_err(), "{path}");
    }
    let mut b = binding();
    b.installer.length = 0;
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.installer.sha256 = "x".repeat(64);
    assert!(validate_binding(&b).is_err());
    b = binding();
    b.root.identity.file_id = "1".repeat(1000);
    assert!(validate_binding(&b).is_err());
}
