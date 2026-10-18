use nearly_updater_key_registrar::{public_record::FilePublicRecord, PublicRecord};
#[test]
fn public_only_file_is_create_new_and_existing_key_paths_are_protected() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("public.pub");
    let forbidden = temp.path().join("existing.key");
    let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let public = pair.pk.to_box().unwrap().to_string();
    let mut record = FilePublicRecord::new(path.clone(), vec![forbidden.clone()]);
    assert!(record.assert_absent().is_ok());
    assert!(record.save_new(&public).is_ok());
    assert!(record.save_new("SECRET_CANARY").is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), public);
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    std::fs::write(&forbidden, b"existing fixture").unwrap();
    let mut other = FilePublicRecord::new(temp.path().join("other.pub"), vec![forbidden]);
    assert!(other.assert_absent().is_err());
    assert!(other.save_new(&public).is_err());
    assert!(!temp.path().join("other.pub").exists());
}
#[test]
fn invalid_or_private_content_is_never_written_as_public_record() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("public.pub");
    let mut record = FilePublicRecord::new(path.clone(), vec![]);
    assert!(record.save_new("SECRET_CANARY").is_err());
    assert!(!path.exists());
}
