use base64::{engine::general_purpose::STANDARD, Engine};
pub type Result<T> = std::result::Result<T, &'static str>;
#[allow(dead_code)]
mod native_verifier {
    include!(concat!(env!("OUT_DIR"), "/native_verifier.rs"));
}
pub fn sign_bytes(
    installer: &[u8],
    payload: &[u8],
    m: &Manifest,
    pk: &minisign::PublicKey,
    sk: &minisign::SecretKey,
) -> Result<Vec<u8>> {
    m.validate(installer, payload)?;
    let sig = minisign::sign(
        Some(pk),
        sk,
        std::io::Cursor::new(installer),
        Some(&m.comment()),
        Some("Nearly updater signature"),
    )
    .map_err(|_| "signing failed")?;
    let outer = STANDARD.encode(sig.to_string()).into_bytes();
    if !verify_signature(installer, &outer, m, pk) {
        return Err("signature self-verification failed");
    }
    Ok(outer)
}
pub fn verify_signature(
    installer: &[u8],
    signature: &[u8],
    m: &Manifest,
    pk: &minisign::PublicKey,
) -> bool {
    if m.updater_protocol != 3 || signature.len() > 16_384 || hash(installer) != m.installer_sha256
    {
        return false;
    }
    let Ok(decoded) = STANDARD.decode(signature) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&decoded) else {
        return false;
    };
    let Ok(sig) = minisign::SignatureBox::from_string(text) else {
        return false;
    };
    if sig.trusted_comment().ok().as_deref() != Some(m.comment().as_str()) {
        return false;
    }
    minisign::verify(
        pk,
        &sig,
        std::io::Cursor::new(installer),
        true,
        false,
        false,
    )
    .is_ok()
        && native_verifier::check(
            installer,
            signature,
            &pk.to_bytes(),
            &m.version,
            &m.arch,
            &m.payload_sha256,
        )
}
pub fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub updater_protocol: u32,
    pub version: String,
    pub arch: String,
    pub file: String,
    pub source_commit: String,
    pub artifact_id: String,
    pub archive_member: String,
    pub installer_sha256: String,
    pub payload_sha256: String,
}
impl Manifest {
    fn comment(&self) -> String {
        format!(
            "version:{}\tfile:{}\tpayload-sha256:{}\tupdater-protocol:3",
            self.version, self.file, self.payload_sha256
        )
    }
    pub fn validate(&self, installer: &[u8], payload: &[u8]) -> Result<()> {
        let v = semver::Version::parse(&self.version).map_err(|_| "invalid version")?;
        if v.to_string() != self.version
            || v.patch != 0
            || !v.pre.is_empty()
            || !v.build.is_empty()
            || v.major > 65535
            || v.minor > 65535
        {
            return Err("noncanonical version");
        }
        if self.updater_protocol != 3
            || !matches!(self.arch.as_str(), "x64" | "arm64")
            || self.file != format!("Nearly_r{}.{}_{}-setup.exe", v.major, v.minor, self.arch)
        {
            return Err("invalid package identity");
        }
        if !matches!(
            self.archive_member.as_str(),
            "Nearly.exe" | "$INSTDIR/Nearly.exe"
        ) {
            return Err("invalid archive member");
        }
        let hex = |s: &str, n: usize| {
            s.len() == n
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !hex(&self.source_commit, 40)
            || self.artifact_id.is_empty()
            || self.artifact_id.len() > 20
            || self.artifact_id.starts_with('0')
            || !self.artifact_id.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("invalid build provenance");
        }
        if installer.is_empty()
            || payload.is_empty()
            || installer.len() > MAX_FILE
            || payload.len() > MAX_FILE
            || !hex(&self.installer_sha256, 64)
            || !hex(&self.payload_sha256, 64)
            || hash(installer) != self.installer_sha256
            || hash(payload) != self.payload_sha256
        {
            return Err("artifact digest mismatch");
        }
        pe_identity(installer, 0x14c, 0x10b)?;
        pe_identity(
            payload,
            if self.arch == "x64" { 0x8664 } else { 0xaa64 },
            0x20b,
        )
    }
}
pub const MAX_FILE: usize = 256 * 1024 * 1024;
pub const EXTRACTOR: &str = "C:\\Program Files\\7-Zip\\7z.exe";
pub fn extractor_path() -> std::path::PathBuf {
    std::env::var_os("NEARLY_UPDATER_EXTRACTOR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| EXTRACTOR.into())
}
fn reviewed_extractor(exe: &str, dll: &str) -> bool {
    matches!(
        (exe, dll),
        (
            "254cf6411d38903b2440819f7e0a847f0cfee7f8096cfad9e90fea62f42b0c23",
            "73578f14d50f747efa82527a503f1ad542f9db170e2901eddb54d6bce93fc00e"
        ) | (
            "95fff19b73eff77c87c0d7bd32822e43fb90dd2932459f962eb532d8dfb6ba53",
            "899cd73d7fc60e1c1c35c7de0f5bed3dc69bfe2cecbd48014d868a347970a0b1"
        )
    )
}
pub fn publish(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if bytes.is_empty() || bytes.len() > 16_384 {
        return Err("invalid signature size");
    }
    let _parents = pin_parents(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x0020_0000);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "signature output exists or cannot be created")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "signature write failed; retain partial evidence")
}
pub fn read_pinned(path: &std::path::Path, limit: usize) -> Result<Pinned> {
    use std::io::Read;
    let mut guards = pin_parents(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x0020_0000);
    }
    let mut file = options.open(path).map_err(|_| "cannot pin input")?;
    let meta = file.metadata().map_err(|_| "cannot inspect input")?;
    reject_reparse(&meta)?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > limit as u64 {
        return Err("unsafe input size or type");
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "input read failed")?;
    if bytes.len() as u64 != meta.len() {
        return Err("input changed or oversized");
    }
    guards.push(file);
    Ok(Pinned {
        bytes,
        _guards: guards,
    })
}
pub struct Pinned {
    pub bytes: Vec<u8>,
    _guards: Vec<std::fs::File>,
}
fn reject_reparse(meta: &std::fs::Metadata) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("reparse points refused");
        }
    }
    if meta.file_type().is_symlink() {
        return Err("symlinks refused");
    };
    Ok(())
}
fn pin_parents(path: &std::path::Path) -> Result<Vec<std::fs::File>> {
    if !cfg!(windows) {
        return Err("Windows handle protection required");
    }
    if !path.is_absolute()
        || path.components().any(|p| match p {
            std::path::Component::ParentDir | std::path::Component::CurDir => true,
            std::path::Component::Normal(n) => n
                .to_str()
                .is_none_or(|s| s.contains(':') || s.ends_with('.') || s.ends_with(' ')),
            _ => false,
        })
    {
        return Err("absolute normalized paths required");
    }
    let mut paths: Vec<_> = path.parent().ok_or("missing parent")?.ancestors().collect();
    paths.reverse();
    let mut guards = Vec::new();
    for dir in paths {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x0220_0000);
        }
        let file = options
            .open(dir)
            .map_err(|_| "cannot pin input ancestors")?;
        let meta = file.metadata().map_err(|_| "cannot inspect ancestors")?;
        reject_reparse(&meta)?;
        if !meta.is_dir() {
            return Err("invalid input ancestor");
        };
        guards.push(file);
    }
    Ok(guards)
}
pub fn validate_listing(listing: &str, member: &str) -> Result<()> {
    let matches: Vec<_> = listing
        .lines()
        .filter_map(|line| line.strip_prefix("Path = "))
        .filter(|path| {
            path.replace('\\', "/")
                .rsplit('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("Nearly.exe"))
        })
        .collect();
    if matches.len() != 1 || matches[0].replace('\\', "/") != member {
        return Err("archive member absent or ambiguous");
    };
    Ok(())
}
pub fn extract_payload(archive: &std::path::Path, member: &str) -> Result<Vec<u8>> {
    if !matches!(member, "Nearly.exe" | "$INSTDIR/Nearly.exe") {
        return Err("invalid archive member");
    }
    let _archive = read_pinned(archive, MAX_FILE)?;
    let extractor = extractor_path();
    if extractor.file_name().and_then(|n| n.to_str()) != Some("7z.exe") {
        return Err("explicit full extractor required");
    }
    let exe = read_pinned(&extractor, MAX_FILE)?;
    let dll = read_pinned(
        &extractor
            .parent()
            .ok_or("extractor parent missing")?
            .join("7z.dll"),
        MAX_FILE,
    )?;
    if !reviewed_extractor(&hash(&exe.bytes), &hash(&dll.bytes)) {
        return Err("unreviewed extractor binary");
    }
    let listing = run_extractor_at(&extractor, archive, None, 1024 * 1024)?;
    validate_listing(
        std::str::from_utf8(&listing).map_err(|_| "invalid archive listing")?,
        member,
    )?;
    run_extractor_at(&extractor, archive, Some(member), MAX_FILE)
}
#[cfg(test)]
fn run_extractor(archive: &std::path::Path, member: Option<&str>, limit: usize) -> Result<Vec<u8>> {
    run_extractor_at(&extractor_path(), archive, member, limit)
}
fn run_extractor_at(
    extractor: &std::path::Path,
    archive: &std::path::Path,
    member: Option<&str>,
    limit: usize,
) -> Result<Vec<u8>> {
    use std::{
        io::Read,
        process::{Command, Stdio},
        sync::mpsc,
        time::{Duration, Instant},
    };
    let mut command = Command::new(extractor);
    command
        .env_clear()
        .env(
            "SystemRoot",
            std::env::var_os("SystemRoot").ok_or("missing SystemRoot")?,
        )
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    if member.is_some() {
        command.args(["x", "-so", "-spd", "-bd", "-y"]);
    } else {
        command.args(["l", "-slt", "-sccUTF-8", "-bd"]);
    }
    command.arg("--").arg(archive);
    if let Some(member) = member {
        command.arg(member);
    }
    let mut child = command.spawn().map_err(|_| "extractor launch failed")?;
    let stdout = child.stdout.take().ok_or("extractor pipe failed")?;
    let (tx, rx) = mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let start = Instant::now();
    let bytes = loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(bytes)) if bytes.len() <= limit => break bytes,
            Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("extractor output exceeded limit or failed");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if start.elapsed() > Duration::from_secs(30) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err("extractor timeout");
                }
            }
        }
    };
    let _ = reader.join();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(bytes)
                } else {
                    Err("extractor rejected archive")
                }
            }
            Ok(None) if start.elapsed() < Duration::from_secs(30) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("extractor timeout or failure");
            }
        }
    }
}
fn pe_identity(bytes: &[u8], machine: u16, magic: u16) -> Result<()> {
    if bytes.get(..2) != Some(b"MZ") {
        return Err("invalid PE");
    }
    let off = u32::from_le_bytes(
        bytes
            .get(0x3c..0x40)
            .ok_or("invalid PE")?
            .try_into()
            .unwrap(),
    ) as usize;
    let h = bytes
        .get(off..off.checked_add(26).ok_or("invalid PE")?)
        .ok_or("invalid PE")?;
    if &h[..4] != b"PE\0\0"
        || u16::from_le_bytes([h[4], h[5]]) != machine
        || u16::from_le_bytes([h[24], h[25]]) != magic
    {
        return Err("wrong PE architecture");
    };
    Ok(())
}

/// Never format minisign SecretKey or upstream errors: its Debug exposes secrets.
pub fn decrypt(input: &str, password: &str) -> Result<minisign::SecretKey> {
    if password.is_empty() || password.len() > 1024 || input.len() > 16_384 {
        return Err("invalid signing input");
    }
    let decoded;
    let text = if input.starts_with("untrusted comment: ") {
        input
    } else {
        decoded = STANDARD
            .decode(input.trim())
            .map_err(|_| "invalid encrypted key")?;
        std::str::from_utf8(&decoded).map_err(|_| "invalid encrypted key")?
    };
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 2 || !lines[0].starts_with("untrusted comment: ") {
        return Err("invalid encrypted key");
    }
    let record = STANDARD
        .decode(lines[1])
        .map_err(|_| "invalid encrypted key")?;
    if record.len() != 158 || &record[..6] != b"EdScB2" {
        return Err("encrypted key required");
    }
    let ops = u64::from_le_bytes(record[38..46].try_into().unwrap());
    let mem = u64::from_le_bytes(record[46..54].try_into().unwrap());
    if ops == 0 || ops > 33_554_432 || mem == 0 || mem > 268_435_456 {
        return Err("unsafe key derivation limits");
    }
    let boxed = minisign::SecretKeyBox::from_string(text).map_err(|_| "invalid encrypted key")?;
    if boxed.clone().into_secret_key(Some(String::new())).is_ok() {
        return Err("empty-password key refused");
    }
    boxed
        .into_secret_key(Some(password.into()))
        .map_err(|_| "key decryption failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pe(machine: u16, magic: u16) -> Vec<u8> {
        let mut bytes = vec![0; 256];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&64u32.to_le_bytes());
        bytes[64..68].copy_from_slice(b"PE\0\0");
        bytes[68..70].copy_from_slice(&machine.to_le_bytes());
        bytes[88..90].copy_from_slice(&magic.to_le_bytes());
        bytes
    }
    fn fixture() -> (Vec<u8>, Vec<u8>, Manifest) {
        let installer = pe(0x14c, 0x10b);
        let payload = pe(0x8664, 0x20b);
        let manifest = Manifest {
            updater_protocol: 3,
            version: "3.1.0".into(),
            arch: "x64".into(),
            file: "Nearly_r3.1_x64-setup.exe".into(),
            source_commit: "a".repeat(40),
            artifact_id: "12345".into(),
            archive_member: "Nearly.exe".into(),
            installer_sha256: hash(&installer),
            payload_sha256: hash(&payload),
        };
        (installer, payload, manifest)
    }
    #[test]
    fn signatures_interoperate_with_exact_native_verifier_and_reject_tampering() {
        let (installer, payload, m) = fixture();
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let signature = sign_bytes(&installer, &payload, &m, &pair.pk, &pair.sk).unwrap();
        assert!(verify_signature(&installer, &signature, &m, &pair.pk));
        let document = String::from_utf8(STANDARD.decode(&signature).unwrap()).unwrap();
        let signed = minisign::SignatureBox::from_string(&document).unwrap();
        minisign::verify(
            &pair.pk,
            &signed,
            std::io::Cursor::new(&installer),
            true,
            false,
            false,
        )
        .unwrap();
        assert_eq!(signed.trusted_comment().unwrap(),format!("version:3.1.0\tfile:Nearly_r3.1_x64-setup.exe\tpayload-sha256:{}\tupdater-protocol:3",m.payload_sha256));
        let mut bad = installer.clone();
        bad[200] ^= 1;
        assert!(!verify_signature(&bad, &signature, &m, &pair.pk));
        for field in ["version", "arch", "payload", "protocol"] {
            let mut wrong = m.clone();
            match field {
                "version" => wrong.version = "3.2.0".into(),
                "arch" => wrong.arch = "arm64".into(),
                "protocol" => wrong.updater_protocol = 2,
                _ => wrong.payload_sha256 = "b".repeat(64),
            };
            assert!(!verify_signature(&installer, &signature, &wrong, &pair.pk));
        }
        let other = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        assert!(!verify_signature(&installer, &signature, &m, &other.pk));
        let changed = document.replace("updater-protocol:3", "updater-protocol:4");
        assert!(!verify_signature(
            &installer,
            STANDARD.encode(changed).as_bytes(),
            &m,
            &pair.pk
        ));
        for duplicate in [
            "version:3.1.0",
            "file:Nearly_r3.1_x64-setup.exe",
            "payload-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            let sig = minisign::sign(
                Some(&pair.pk),
                &pair.sk,
                std::io::Cursor::new(&installer),
                Some(&format!("{}\t{duplicate}", m.comment())),
                None,
            )
            .unwrap();
            let outer = STANDARD.encode(sig.to_string());
            assert!(!native_verifier::check(
                &installer,
                outer.as_bytes(),
                &pair.pk.to_bytes(),
                &m.version,
                &m.arch,
                &m.payload_sha256
            ));
        }
    }
    #[test]
    fn preflight_rejects_wrong_payload_arch_version_name_and_hash() {
        let (i, p, m) = fixture();
        assert!(m.validate(&i, &p).is_ok());
        for field in [
            "protocol",
            "version",
            "name",
            "arch",
            "payload",
            "installer",
            "member",
            "source",
            "artifact",
        ] {
            let mut wrong = m.clone();
            match field {
                "protocol" => wrong.updater_protocol = 2,
                "version" => wrong.version = "3.1.1".into(),
                "name" => wrong.file = "Nearly_r3.2_x64-setup.exe".into(),
                "arch" => wrong.arch = "arm64".into(),
                "payload" => wrong.payload_sha256 = "c".repeat(64),
                "installer" => wrong.installer_sha256 = "c".repeat(64),
                "member" => wrong.archive_member = "../Nearly.exe".into(),
                "source" => wrong.source_commit = "main".into(),
                _ => wrong.artifact_id = "latest".into(),
            };
            assert!(wrong.validate(&i, &p).is_err(), "{field}");
        }
    }
    #[test]
    fn output_never_overwrites_and_pinned_input_denies_substitution_and_size_abuse() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input");
        std::fs::write(&input, b"safe").unwrap();
        assert!(read_pinned(&input, 3).is_err());
        let pinned = read_pinned(&input, 4).unwrap();
        assert_eq!(pinned.bytes, b"safe");
        #[cfg(windows)]
        {
            assert!(std::fs::write(&input, b"unsafe").is_err());
            assert!(std::fs::rename(&input, dir.path().join("replacement")).is_err());
        }
        let output = dir.path().join("package.sig");
        publish(&output, b"signature").unwrap();
        assert!(publish(&output, b"replacement").is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"signature");
        assert!(read_pinned(dir.path(), 100).is_err());
    }
    #[test]
    fn listing_requires_one_exact_member_and_rejects_case_and_duplicate_ambiguity() {
        assert!(validate_listing(
            "Path = archive.exe\n\nPath = Nearly.exe\nSize = 256\n",
            "Nearly.exe"
        )
        .is_ok());
        for listing in [
            "Path = nearly.exe\n",
            "Path = Nearly.exe\nPath = Nearly.exe\n",
            "Path = Nearly.exe\nPath = NEARLY.EXE\n",
            "Path = other.exe\n",
            "Path = Nearly.exe\nPath = other/Nearly.exe\n",
        ] {
            assert!(validate_listing(listing, "Nearly.exe").is_err());
        }
    }
    #[test]
    fn existing_pinned_extractor_streams_only_generated_fixture_member() {
        let dir = tempfile::tempdir().unwrap();
        let payload = pe(0x8664, 0x20b);
        std::fs::write(dir.path().join("Nearly.exe"), &payload).unwrap();
        let archive = dir.path().join("fixture.zip");
        let status = std::process::Command::new(extractor_path())
            .current_dir(dir.path())
            .args(["a", "-tzip", "-bd", "-y"])
            .arg(&archive)
            .arg("Nearly.exe")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(extract_payload(&archive, "Nearly.exe").unwrap(), payload);
        assert!(extract_payload(&archive, "Missing.exe").is_err());
        assert!(run_extractor(&archive, None, 8).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn directory_junction_input_and_output_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::write(real.join("input"), b"safe").unwrap();
        assert!(read_pinned(&link.join("input"), 4).is_err());
        assert!(publish(&link.join("output.sig"), b"sig").is_err());
        assert!(!real.join("output.sig").exists());
        std::fs::remove_dir(&link).unwrap();
    }
    #[test]
    fn encrypted_key_roundtrip_and_empty_password_refusal() {
        let pair = minisign::KeyPair::generate_encrypted_keypair(Some("fixture passphrase".into()))
            .unwrap();
        let boxed = pair.sk.to_box(None).unwrap().to_string();
        assert!(super::decrypt(&boxed, "").is_err());
        assert!(super::decrypt(&boxed, "wrong").is_err());
        let key = super::decrypt(&boxed, "fixture passphrase").unwrap();
        assert_eq!(key.keynum(), pair.pk.keynum());
    }
    #[test]
    fn rejects_unencrypted_and_empty_password_encrypted_boxes() {
        let raw = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        assert!(decrypt(&raw.sk.to_box(None).unwrap().to_string(), "nonempty").is_err());
        let empty = minisign::KeyPair::generate_encrypted_keypair(Some(String::new())).unwrap();
        assert!(decrypt(&empty.sk.to_box(None).unwrap().to_string(), "nonempty").is_err());
    }
}
#[test]
fn reviewed_ci_extractor_requires_the_complete_exact_pair() {
    assert!(reviewed_extractor(
        "95fff19b73eff77c87c0d7bd32822e43fb90dd2932459f962eb532d8dfb6ba53",
        "899cd73d7fc60e1c1c35c7de0f5bed3dc69bfe2cecbd48014d868a347970a0b1"
    ));
    assert!(!reviewed_extractor(
        "95fff19b73eff77c87c0d7bd32822e43fb90dd2932459f962eb532d8dfb6ba53",
        "73578f14d50f747efa82527a503f1ad542f9db170e2901eddb54d6bce93fc00e"
    ));
}
