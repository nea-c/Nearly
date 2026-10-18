use nearly_updater_key_registrar::{
    transport::{bounded_json, endpoint, GitHubApi},
    ENV, NAMES, REPO,
};
use serde_json::json;
use zeroize::Zeroizing;
#[test]
fn endpoint_is_fixed_https_and_rejects_alternate_hosts_paths_and_methods() {
    assert_eq!(
        endpoint("/user", false).unwrap(),
        "https://api.github.com/user"
    );
    assert!(endpoint(&format!("{REPO}/actions/secrets?per_page=100"), false).is_ok());
    for path in [
        "https://evil.invalid/user",
        "//evil.invalid/user",
        "/user#@evil.invalid",
        "/user?x=1",
        "/repos/nea-c/Other",
        "/user/../user",
    ] {
        assert!(endpoint(path, false).is_err());
    }
    assert!(endpoint("/user", true).is_err());
    for name in NAMES {
        assert!(endpoint(&format!("{ENV}/secrets/{name}"), true).is_ok());
    }
}
#[test]
fn response_read_is_bounded_and_errors_do_not_echo_body_canaries() {
    assert_eq!(
        bounded_json(&b"{\"count\":1}"[..]).unwrap(),
        json!({"count":1})
    );
    let oversized = vec![b' '; 262145];
    assert!(bounded_json(oversized.as_slice()).is_err());
    let error = bounded_json(&b"SECRET_CANARY_INVALID_JSON"[..]).unwrap_err();
    assert!(!error.contains("SECRET_CANARY"));
}
#[test]
fn bad_credentials_are_rejected_without_network_or_echo() {
    for text in ["", "SECRET_CANARY\r\nHeader: x"] {
        let result = GitHubApi::new(Zeroizing::new(text.into()));
        assert!(result.is_err());
    }
}

#[test]
fn valid_disposable_credential_builds_tls_client_without_network() {
    assert!(GitHubApi::new(Zeroizing::new(
        "DISPOSABLE_CLIENT_CONSTRUCTOR_CANARY".into()
    ))
    .is_ok());
}
