use nearly_updater_signer::{
    decrypt, extract_payload, hash, publish, read_pinned, sign_bytes, Manifest, Result, MAX_FILE,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
fn required<'a>(args: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str> {
    args.get(name)
        .map(String::as_str)
        .ok_or("missing required option; use --help")
}
fn run() -> Result<()> {
    let mut input = std::env::args().skip(1);
    let mode = input.next().ok_or("use --help")?;
    if mode == "--help" {
        println!("Nearly updater signer: preflight|sign --installer ABS --payload ABS --manifest ABS --manifest-sha256 HEX --source-commit SHA --artifact-id ID [--public-key ABS (--key-file ABS | --ci)]\nNo key generation. Local password uses the console; CI uses NEARLY_UPDATER_PRIVATE_KEY and NEARLY_UPDATER_PRIVATE_KEY_PASSWORD. Only canonical .sig output is written.");
        return Ok(());
    }
    if !matches!(mode.as_str(), "preflight" | "sign") {
        return Err("unknown command");
    }
    let mut args = BTreeMap::new();
    let mut ci = false;
    while let Some(option) = input.next() {
        if option == "--ci" {
            if ci {
                return Err("duplicate option");
            };
            ci = true;
            continue;
        }
        if !matches!(
            option.as_str(),
            "--installer"
                | "--payload"
                | "--manifest"
                | "--manifest-sha256"
                | "--source-commit"
                | "--artifact-id"
                | "--public-key"
                | "--key-file"
        ) {
            return Err("unknown option");
        }
        let value = input.next().ok_or("missing option value")?;
        if args.insert(option, value).is_some() {
            return Err("duplicate option");
        }
    }
    if mode == "sign" && (ci == args.contains_key("--key-file")) {
        return Err("select exactly one local or CI key input");
    }
    // All packaging work, including child processes, precedes secret reads.
    let manifest_input = read_pinned(Path::new(required(&args, "--manifest")?), 131_072)?;
    if hash(&manifest_input.bytes) != required(&args, "--manifest-sha256")? {
        return Err("manifest identity mismatch");
    }
    let manifest: Manifest =
        serde_json::from_slice(&manifest_input.bytes).map_err(|_| "invalid packaging manifest")?;
    if manifest.source_commit != required(&args, "--source-commit")?
        || manifest.artifact_id != required(&args, "--artifact-id")?
    {
        return Err("build provenance identity mismatch");
    }
    let installer_path = PathBuf::from(required(&args, "--installer")?);
    if installer_path.file_name().and_then(|x| x.to_str()) != Some(manifest.file.as_str()) {
        return Err("installer filename mismatch");
    }
    let payload_path = Path::new(required(&args, "--payload")?);
    if payload_path.file_name().and_then(|x| x.to_str()) != Some("Nearly.exe") {
        return Err("payload filename mismatch");
    }
    let installer = read_pinned(&installer_path, MAX_FILE)?;
    let payload = read_pinned(payload_path, MAX_FILE)?;
    manifest.validate(&installer.bytes, &payload.bytes)?;
    let embedded = extract_payload(&installer_path, &manifest.archive_member)?;
    if embedded != payload.bytes || hash(&embedded) != manifest.payload_sha256 {
        return Err("embedded application mismatch");
    }
    if mode == "preflight" {
        println!(
            "Preflight verified exact installer, embedded application, manifest and protocol 3."
        );
        return Ok(());
    }
    let output = installer_path.with_file_name(format!("{}.sig", manifest.file));
    if std::fs::symlink_metadata(&output).is_ok() {
        return Err("signature output already exists");
    }
    let public = read_pinned(Path::new(required(&args, "--public-key")?), 16_384)?;
    let public_text = std::str::from_utf8(&public.bytes).map_err(|_| "invalid public key")?;
    let public_text = if public_text.starts_with("untrusted comment: ") {
        public_text.to_owned()
    } else {
        String::from_utf8(base64_decode(public_text)?).map_err(|_| "invalid public key")?
    };
    let pk = minisign::PublicKeyBox::from_string(&public_text)
        .and_then(|b| b.into_public_key())
        .map_err(|_| "invalid expected public key")?;
    let key_file;
    let (key_input, password) = if ci {
        let key =
            std::env::var("NEARLY_UPDATER_PRIVATE_KEY").map_err(|_| "missing CI key input")?;
        let pass = std::env::var("NEARLY_UPDATER_PRIVATE_KEY_PASSWORD")
            .map_err(|_| "missing CI password input")?;
        std::env::remove_var("NEARLY_UPDATER_PRIVATE_KEY");
        std::env::remove_var("NEARLY_UPDATER_PRIVATE_KEY_PASSWORD");
        (Zeroizing::new(key), Zeroizing::new(pass))
    } else {
        key_file = read_pinned(Path::new(required(&args, "--key-file")?), 16_384)?;
        let text = std::str::from_utf8(&key_file.bytes).map_err(|_| "invalid encrypted key")?;
        (
            Zeroizing::new(text.to_owned()),
            Zeroizing::new(
                rpassword::prompt_password("Signing key passphrase: ")
                    .map_err(|_| "local console password input failed")?,
            ),
        )
    };
    let sk = decrypt(&key_input, &password)?;
    let signature = sign_bytes(&installer.bytes, &payload.bytes, &manifest, &pk, &sk)?;
    publish(&output, &signature)?;
    println!("Verified canonical updater signature created.");
    Ok(())
}
fn base64_decode(text: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|_| "invalid public key")
}
fn main() {
    std::panic::set_hook(Box::new(|_| {
        eprintln!("Signer aborted; no key details are reported.")
    }));
    if let Err(message) = run() {
        eprintln!("Signer refused: {message}");
        std::process::exit(1)
    }
}
