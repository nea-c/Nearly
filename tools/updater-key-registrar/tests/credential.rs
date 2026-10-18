use nearly_updater_key_registrar::credential::parse;
#[test]
fn accepts_only_one_credential_for_exact_https_github_host_without_echo() {
    assert!(parse(b"protocol=https\nhost=github.com\nusername=nea-c\npassword=DISPOSABLE_CREDENTIAL_CANARY\n\n").is_ok());
    for text in [
        "protocol=http\nhost=github.com\npassword=SECRET_CANARY\n",
        "protocol=https\nhost=evil.invalid\npassword=SECRET_CANARY\n",
        "protocol=https\nhost=github.com\npassword=SECRET_CANARY\npassword=second\n",
        "protocol=https\nhost=github.com\npassword=\n",
        "protocol=https\nhost=github.com\npassword=SECRET CANARY\n",
        "protocol=https\nhost=github.com\nhost=evil.invalid\npassword=SECRET_CANARY\n",
    ] {
        let result = parse(text.as_bytes());
        assert!(result.is_err());
        if let Err(error) = result {
            assert!(!error.contains("SECRET_CANARY"));
        }
    }
    assert!(parse(&vec![b'x'; 65537]).is_err());
    assert!(parse(&[0xff]).is_err());
}
