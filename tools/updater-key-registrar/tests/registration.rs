use base64::{engine::general_purpose::STANDARD, Engine};
use nearly_updater_key_registrar::seal;

#[test]
fn github_sealed_box_decrypts_and_rejects_tampering() {
    let secret = crypto_box::SecretKey::from([73u8; 32]);
    let public = secret.public_key();
    let encrypted = seal(
        &STANDARD.encode(public.as_bytes()),
        b"disposable test secret",
    )
    .unwrap();
    let mut bytes = STANDARD.decode(encrypted).unwrap();
    assert_eq!(secret.unseal(&bytes).unwrap(), b"disposable test secret");
    bytes[40] ^= 1;
    assert!(secret.unseal(&bytes).is_err());
}

#[test]
fn generated_disposable_key_roundtrips_and_public_key_verifies_probe() {
    let key = nearly_updater_key_registrar::generate().unwrap();
    assert!(key.public_key().starts_with("untrusted comment: "));
    assert!(key.verify_probe());
}

#[test]
fn rejects_invalid_github_public_key() {
    for key in [
        "",
        "bad!",
        "AQ==",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ] {
        assert!(seal(key, b"test").is_err());
    }
    let mut low_order = [0u8; 32];
    low_order[0] = 1;
    assert!(seal(&STANDARD.encode(low_order), b"test").is_err());
}
