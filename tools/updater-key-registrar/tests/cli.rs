use std::process::Command;
#[test]
fn help_and_invalid_arguments_never_acquire_credentials_or_echo_input() {
    let executable = env!("CARGO_BIN_EXE_nearly-updater-key-registrar");
    let help = Command::new(executable).arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("nearly-updater-production"));
    for args in [
        vec!["SECRET_CANARY_UNKNOWN_COMMAND"],
        vec!["register", "--password", "SECRET_CANARY"],
        vec!["register", "--public-key", "relative.pub"],
    ] {
        let output = Command::new(executable).args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("SECRET_CANARY"));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("SECRET_CANARY"));
    }
}
