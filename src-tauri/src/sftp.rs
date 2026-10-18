use base64::Engine as _;
use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    io::Read,
    net::{Shutdown, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: String,
    pub mode: String,
    #[serde(default)]
    pub key_file: String,
    #[serde(default)]
    pub host_key: String,
}
#[derive(Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    #[serde(default)]
    pub hidden: bool,
    pub dir: bool,
    pub size: u64,
    #[serde(
        rename = "modifiedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub modified_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

fn listing_entry(name: String, attrs: FileAttributes) -> Entry {
    Entry {
        hidden: name.starts_with('.') && name != "." && name != "..",
        name,
        dir: attrs.is_dir(),
        size: attrs.size.unwrap_or(0),
        modified_at: attrs.mtime.map(u64::from),
        permissions: attrs.permissions,
        owner: attrs
            .user
            .filter(|name| {
                !name.is_empty() && name.len() <= 1024 && !name.chars().any(char::is_control)
            })
            .or_else(|| attrs.uid.map(|uid| uid.to_string())),
    }
}

#[cfg(test)]
mod listing_metadata_tests {
    use super::*;
    #[test]
    fn hidden_remote_entries_follow_basename_convention_only() {
        for (name, hidden) in [
            (".env", true),
            (".folder", true),
            ("visible", false),
            (".", false),
            ("..", false),
        ] {
            assert_eq!(
                listing_entry(name.into(), FileAttributes::default()).hidden,
                hidden
            );
        }
    }
    #[test]
    fn remote_metadata_uses_optional_attrs_without_requiring_them() {
        let mut attrs = FileAttributes::default();
        attrs.permissions = Some(0o1004755);
        attrs.uid = Some(1001);
        let entry = listing_entry("generated".into(), attrs.clone());
        assert_eq!(entry.permissions, Some(0o1004755));
        assert_eq!(entry.owner.as_deref(), Some("1001"));
        attrs.user = Some("fixture-user".into());
        assert_eq!(
            listing_entry("generated".into(), attrs.clone())
                .owner
                .as_deref(),
            Some("fixture-user")
        );
        attrs.user = Some("bad\nname".into());
        assert_eq!(
            listing_entry("generated".into(), attrs).owner.as_deref(),
            Some("1001")
        );
        let absent = listing_entry("missing-attributes".into(), FileAttributes::default());
        assert_eq!(absent.permissions, None);
        assert_eq!(absent.owner, None);
        let json = serde_json::to_value(absent).unwrap();
        assert!(json.get("permissions").is_none());
        assert!(json.get("owner").is_none());
    }
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(4)
            .enable_all()
            .build()
            .expect("SFTP runtime")
    })
}
async fn cancelled(stop: &AtomicBool) {
    while !stop.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn guarded<F, T>(stop: &AtomicBool, future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    if stop.load(Ordering::Relaxed) {
        return Err("Operation stopped; an already issued final rename may have completed. Restart to reconcile.".into());
    }
    tokio::select! { biased;
        _ = cancelled(stop) => Err("Operation stopped; staging may remain and an issued final rename may have completed. Restart to reconcile.".into()),
        value = future => value,
    }
}
fn fingerprint(s: &str) -> Result<(Option<String>, String), String> {
    let parts: Vec<_> = s.split_whitespace().collect();
    let (algorithm, digest) = match parts.as_slice() {
        [digest] if digest.starts_with("SHA256:") => (None, *digest),
        [algorithm, bits, digest]
            if (algorithm.starts_with("ssh-") || algorithm.starts_with("ecdsa-sha2-"))
                && bits.parse::<u32>().is_ok() =>
        {
            (Some(algorithm.to_string()), *digest)
        }
        _ => {
            return Err(
                "A verified SHA256 host fingerprint is required; automatic trust is disabled"
                    .into(),
            )
        }
    };
    let digest = digest.trim_start_matches("SHA256:").trim_end_matches('=');
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(digest)
        .map_err(|_| "Invalid SHA256 fingerprint")?;
    if bytes.len() != 32 {
        return Err("SHA256 fingerprint must contain 32 bytes".into());
    }
    Ok((algorithm, format!("SHA256:{digest}")))
}
pub fn canonical_fingerprint(value: &str) -> Result<String, String> {
    fingerprint(value).map(|(_, digest)| digest)
}
#[derive(Clone, Debug)]
pub struct ObservedHostKey {
    pub algorithm: String,
    pub fingerprint: String,
}
struct ProbeHost {
    observed: Arc<std::sync::Mutex<Option<ObservedHostKey>>>,
}
impl client::Handler for ProbeHost {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        if key.certificate().is_some() {
            return Ok(false);
        }
        let public = key.public_key();
        *self.observed.lock().unwrap() = Some(ObservedHostKey {
            algorithm: public.algorithm().as_str().to_owned(),
            fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        });
        // Observe only. Reject this unauthenticated probe connection outright;
        // approval always requires a new, strictly pinned authenticated handshake.
        Ok(false)
    }
}
pub fn probe_host_key(profile: &Profile, stop: &AtomicBool) -> Result<ObservedHostKey, String> {
    crate::host_verification::endpoint(profile)?;
    if !profile.host_key.trim().is_empty() {
        return Err("Pinned host keys cannot enter first-use approval".into());
    }
    // Deliberately independent from connect/load_key: no passphrase parameter,
    // private-key read, username authentication, channel, or SFTP initialization.
    runtime().block_on(guarded(stop, async {
        tokio::time::timeout(Duration::from_secs(20), async {
            let tcp = tokio::time::timeout(
                Duration::from_secs(10),
                tokio::net::TcpStream::connect((profile.host.trim(), profile.port)),
            )
            .await
            .map_err(|_| "Host-key probe TCP connection timed out")?
            .map_err(|_| "Host-key probe TCP connection failed")?;
            let stream = tcp
                .into_std()
                .map_err(|_| "Host-key probe socket unavailable")?;
            let _abort = AbortSocket(
                stream
                    .try_clone()
                    .map_err(|_| "Host-key probe cancellation socket unavailable")?,
            );
            let tcp = tokio::net::TcpStream::from_std(stream)
                .map_err(|_| "Host-key probe socket unavailable")?;
            let observed = Arc::new(std::sync::Mutex::new(None));
            let result = client::connect_stream(
                Arc::new(client::Config::default()),
                tcp,
                ProbeHost {
                    observed: observed.clone(),
                },
            )
            .await;
            // The handler intentionally rejects the offered key, so a normal
            // probe ends with UnknownKey. No accepted handle is authenticated.
            drop(result);
            if stop.load(Ordering::SeqCst) {
                return Err("Host-key probe stopped".into());
            }
            let captured = observed
                .lock()
                .map_err(|_| "Host-key probe result unavailable")?
                .clone();
            captured.ok_or_else(|| {
                "SSH host-key probe failed or the server supplied an unsupported certificate".into()
            })
        })
        .await
        .map_err(|_| "SSH host-key probe timed out")?
    }))
}
#[cfg(test)]
fn valid_host_key(s: &str) -> bool {
    fingerprint(s).is_ok()
}
struct VerifyHost {
    algorithm: Option<String>,
    digest: String,
}
impl client::Handler for VerifyHost {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        if key.certificate().is_some() {
            return Ok(false);
        }
        let key = key.public_key();
        Ok(self
            .algorithm
            .as_ref()
            .is_none_or(|kind| kind == key.algorithm().as_str())
            && key.fingerprint(HashAlg::Sha256).to_string() == self.digest)
    }
}
struct AbortSocket(TcpStream);
impl Drop for AbortSocket {
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}
pub struct Connection {
    pub(crate) raw: RawSftpSession,
    session: client::Handle<VerifyHost>,
    abort: AbortSocket,
    pub(crate) posix_rename: bool,
}
impl Connection {
    pub(crate) fn run<F, T>(&self, stop: &AtomicBool, future: F) -> Result<T, String>
    where
        F: Future<Output = Result<T, String>>,
    {
        let result = runtime().block_on(guarded(stop, future));
        if result.is_err() {
            let _ = self.abort.0.shutdown(Shutdown::Both);
        }
        result
    }
    pub fn root(&mut self, path: &str, stop: &AtomicBool) -> Result<String, String> {
        let path = normalize(path)?;
        self.run(stop, async {
            checked_directory(&self.raw, &path, false).await?;
            Ok(path)
        })
    }
    pub fn home(&mut self, stop: &AtomicBool) -> Result<String, String> {
        self.run(stop, async {
            let names = self
                .raw
                .realpath(".")
                .await
                .map_err(|_| remote_error("home lookup"))?
                .files;
            if names.len() != 1 {
                return Err("Server did not return one canonical home path".into());
            }
            let returned = &names[0].filename;
            if returned.split('/').any(|part| part == ".." || part == ".") {
                return Err("Server returned an unsafe canonical home path".into());
            }
            let path = normalize(returned)?;
            checked_directory(&self.raw, &path, false).await?;
            Ok(path)
        })
    }
    pub fn needs_recycle(&self) -> bool {
        self.session.is_closed()
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
        let _ = self.abort.0.shutdown(Shutdown::Both);
    }
}

const KEY_UNLOCK_FAILED: &str = "Check the passphrase or key file";
const KEY_VERIFICATION_FAILED: &str =
    "PPK verification failed: wrong passphrase, damaged MAC, or unsupported key";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum ConnectErrorKind {
    KeyUnlockFailed,
    Other,
}
#[derive(Debug, Serialize)]
pub struct ConnectError {
    kind: ConnectErrorKind,
    message: String,
}
impl From<String> for ConnectError {
    fn from(message: String) -> Self {
        // The existing sessions/engine transport carries String errors. Only
        // the bounded local PPK decoder emits this complete native-owned value.
        // Never classify a substring, a server error, or raw decoder details.
        let kind = if message == KEY_UNLOCK_FAILED {
            ConnectErrorKind::KeyUnlockFailed
        } else {
            ConnectErrorKind::Other
        };
        Self { kind, message }
    }
}

fn validate_key_input(text: &str) -> Result<(), String> {
    if !text.starts_with("PuTTY-User-Key-File-2:") && !text.starts_with("PuTTY-User-Key-File-3:") {
        return Err("Select a PuTTY PPK v2 or v3 key".into());
    }
    if text.len() > 1024 * 1024 {
        return Err("PPK file exceeds 1 MiB".into());
    }
    // ssh-key's PPK map otherwise accepts duplicate metadata with last-value
    // wins semantics. Reject ambiguity before either derivation or classification.
    for field in [
        "Encryption:",
        "Comment:",
        "Public-Lines:",
        "Private-Lines:",
        "Private-MAC:",
        "Key-Derivation:",
        "Argon2-Salt:",
    ] {
        if text
            .lines()
            .filter(|line| line.starts_with(field))
            .take(2)
            .count()
            > 1
        {
            return Err(KEY_VERIFICATION_FAILED.into());
        }
    }
    let mac = text
        .lines()
        .find_map(|line| line.strip_prefix("Private-MAC: "));
    let mac_length = if text.starts_with("PuTTY-User-Key-File-2:") {
        40
    } else {
        64
    };
    if !mac.is_some_and(|mac| mac.len() == mac_length && mac.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(KEY_VERIFICATION_FAILED.into());
    }
    for (field, limit) in [
        ("Argon2-Memory:", 65536u32),
        ("Argon2-Passes:", 64),
        ("Argon2-Parallelism:", 8),
    ] {
        let values: Vec<_> = text
            .lines()
            .filter_map(|line| line.strip_prefix(field))
            .collect();
        if values.len() > 1
            || values.iter().any(|v| {
                v.trim()
                    .parse::<u32>()
                    .map_or(true, |n| n == 0 || n > limit)
            })
        {
            return Err(format!("PPK derivation cost is unsupported: {field} maximum {limit}. The key is not converted or modified."));
        }
    }
    Ok(())
}

fn supported_encrypted_ppk(text: &str) -> bool {
    // This is a conservative classification gate, not a replacement decoder.
    // Known malformed/unsupported material must not look like a password error.
    if !text.lines().any(|line| line == "Encryption: aes256-cbc") {
        return false;
    }
    let mut lines = text.lines();
    let Some((_, algorithm)) = lines.next().and_then(|line| line.split_once(": ")) else {
        return false;
    };
    // These are the signing algorithms enabled by pinned russh + rsa/ring.
    if !matches!(
        algorithm,
        "ssh-rsa"
            | "ssh-ed25519"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
    ) {
        return false;
    }
    let Some(count) = lines
        .by_ref()
        .find_map(|line| line.strip_prefix("Public-Lines: "))
        .and_then(|count| count.parse::<usize>().ok())
    else {
        return false;
    };
    // The iterator and input are bounded by the prevalidated 1 MiB text size.
    let encoded = lines.take(count).collect::<String>();
    let Ok(public) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    russh::keys::PublicKey::from_bytes(&public)
        .is_ok_and(|key| key.algorithm().to_string() == algorithm)
}
async fn load_key(
    path: String,
    secret: zeroize::Zeroizing<String>,
) -> Result<russh::keys::PrivateKey, String> {
    static DERIVERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = DERIVERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Key decoder unavailable")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut text = zeroize::Zeroizing::new(String::new());
        std::fs::File::open(path)
            .map_err(|_| "PPK key file cannot be read")?
            .take(1024 * 1024 + 1)
            .read_to_string(&mut text)
            .map_err(|_| "PPK key file is not valid text")?;
        validate_key_input(&text)?;
        russh::keys::decode_secret_key(&text, Some(&secret)).map_err(|error| {
            // ssh-key 0.7.0-rc.11 does not export its inner PpkParseError type.
            // Bound the adapter to its typed outer variant and exact fixed
            // display value. Never expose raw parser text (which can include
            // key material). A dependency change conservatively falls to other.
            let mac_failed = matches!(error,
                russh::keys::Error::SshKey(russh::keys::ssh_key::Error::Ppk(ref inner))
                if inner.to_string() == "incorrect MAC"
            );
            if mac_failed && supported_encrypted_ppk(&text) {
                // Wrong secret and authenticated encrypted-file damage cannot
                // be distinguished cryptographically. Do not claim certainty.
                KEY_UNLOCK_FAILED.into()
            } else {
                KEY_VERIFICATION_FAILED.into()
            }
        })
    })
    .await
    .map_err(|_| "PPK decoder failed")?
}
pub fn connect(
    p: &Profile,
    passphrase: &str,
    stop: &AtomicBool,
) -> Result<(Connection, String), String> {
    if p.auth != "key"
        || p.mode != "sftp"
        || p.host.trim().is_empty()
        || p.user.trim().is_empty()
        || p.port == 0
    {
        return Err("Use a PPK private-key SFTP profile".into());
    }
    let (algorithm, digest) = fingerprint(&p.host_key)?;
    let identity = digest.clone();
    runtime().block_on(guarded(stop, async {
        tokio::time::timeout(Duration::from_secs(45), async {
            let key = load_key(
                p.key_file.clone(),
                zeroize::Zeroizing::new(passphrase.to_owned()),
            )
            .await?;
            let tcp = tokio::time::timeout(
                Duration::from_secs(15),
                tokio::net::TcpStream::connect((p.host.as_str(), p.port)),
            )
            .await
            .map_err(|_| "TCP connection timed out")?
            .map_err(|_| "TCP connection failed")?;
            let stream = tcp.into_std().map_err(|_| "TCP socket unavailable")?;
            let abort = AbortSocket(
                stream
                    .try_clone()
                    .map_err(|_| "Cannot prepare connection cancellation")?,
            );
            let tcp =
                tokio::net::TcpStream::from_std(stream).map_err(|_| "TCP socket unavailable")?;
            let config = client::Config {
                keepalive_interval: Some(Duration::from_secs(15)),
                keepalive_max: 3,
                ..Default::default()
            };
            let mut session = tokio::time::timeout(
                Duration::from_secs(20),
                client::connect_stream(Arc::new(config), tcp, VerifyHost { algorithm, digest }),
            )
            .await
            .map_err(|_| "SSH handshake timed out")?
            .map_err(|_| "SSH handshake or host-key verification failed")?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|_| "SSH authentication negotiation failed")?
                .flatten();
            let auth = tokio::time::timeout(
                Duration::from_secs(20),
                session.authenticate_publickey(
                    &p.user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                ),
            )
            .await
            .map_err(|_| "SSH key authentication timed out")?
            .map_err(|_| "SSH key authentication failed")?;
            if !auth.success() {
                return Err("SSH server refused this key or username".into());
            }
            let channel = session
                .channel_open_session()
                .await
                .map_err(|_| "Cannot open SFTP channel")?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|_| "Server refused SFTP")?;
            let raw = RawSftpSession::new_with_config(
                channel.into_stream(),
                russh_sftp::client::Config {
                    max_packet_len: 1024 * 1024,
                    request_timeout_secs: 15,
                    ..Default::default()
                },
            );
            let version = raw.init().await.map_err(|_| "SFTP initialization failed")?;
            let posix_rename = version
                .extensions
                .get("posix-rename@openssh.com")
                .is_some_and(|v| v == "1");
            Ok((
                Connection {
                    raw,
                    session,
                    abort,
                    posix_rename,
                },
                identity,
            ))
        })
        .await
        .map_err(|_| "SFTP connection setup timed out")?
    }))
}
fn remote_error(operation: &str) -> String {
    format!(
        "SFTP {operation} failed; check connection and permissions. Staging files are retained."
    )
}
pub(crate) async fn checked_directory(raw: &RawSftpSession, path: &str, create: bool) -> Result<(), String> {
    let root = raw
        .lstat("/")
        .await
        .map_err(|_| remote_error("root lookup"))?;
    if !root.attrs.is_dir() {
        return Err("Remote root is not a directory".into());
    }
    let mut current = String::new();
    for component in path.split('/').filter(|s| !s.is_empty()) {
        current.push('/');
        current.push_str(component);
        let attrs = match raw.lstat(current.clone()).await {
            Ok(a) => a.attrs,
            Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile && create => {
                raw.mkdir(current.clone(), FileAttributes::empty())
                    .await
                    .map_err(|_| remote_error("mkdir"))?;
                raw.lstat(current.clone())
                    .await
                    .map_err(|_| remote_error("directory verification"))?
                    .attrs
            }
            Err(_) => return Err(remote_error("directory lookup")),
        };
        if !attrs.is_dir() || attrs.is_symlink() {
            return Err("Remote path contains a symlink or non-directory".into());
        }
    }
    Ok(())
}
pub fn normalize(p: &str) -> Result<String, String> {
    if !p.starts_with('/') || p.contains('\\') || p.chars().any(|c| c.is_control()) {
        return Err("Use an absolute POSIX remote path".into());
    }
    let mut parts = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            x => parts.push(x),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}
pub fn overlap(a: &str, b: &str) -> bool {
    a == b
        || a == "/"
        || b == "/"
        || a.starts_with(&format!("{b}/"))
        || b.starts_with(&format!("{a}/"))
}
pub fn list(s: &mut Connection, path: &str) -> Result<Vec<Entry>, String> {
    list_with_stop(s, path, &AtomicBool::new(false))
}
pub fn list_with_stop(
    s: &mut Connection,
    path: &str,
    stop: &AtomicBool,
) -> Result<Vec<Entry>, String> {
    let path = normalize(path)?;
    s.run(stop, async {
        checked_directory(&s.raw, &path, false).await?;
        let handle = s
            .raw
            .opendir(path)
            .await
            .map_err(|_| remote_error("opendir"))?
            .handle;
        let mut entries = Vec::new();
        loop {
            match s.raw.readdir(handle.clone()).await {
                Ok(batch) => {
                    for f in batch.files {
                        if f.filename == "." || f.filename == ".." {
                            continue;
                        }
                        if entries.len() >= 20000 {
                            return Err("Remote listing exceeds 20,000 entries".into());
                        }
                        entries.push(listing_entry(f.filename, f.attrs));
                    }
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(_) => return Err(remote_error("readdir")),
            }
        }
        s.raw
            .close(handle)
            .await
            .map_err(|_| remote_error("listing close"))?;
        entries.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.cmp(&b.name)));
        Ok(entries)
    })
}

// Explorer operations deliberately use ordinary v3 rename (which must refuse an
// existing destination), never the replacing posix-rename extension.
pub fn create_entry(
    s: &mut Connection,
    action: crate::file_ops::Action,
    parent: &str,
    target: &str,
    stop: &AtomicBool,
) -> Result<crate::file_ops::Outcome, String> {
    use crate::file_ops::{check, Action, Outcome};
    if !matches!(action, Action::CreateFile | Action::Mkdir) {
        return Err("Unsupported creation action".into());
    }
    let (_, checked_target) = crate::file_ops::remote_creation_paths(parent, target)?;
    if checked_target != target {
        return Err("Creation target changed during validation".into());
    }
    s.run(stop,async{
        checked_directory(&s.raw,parent,false).await?;
        match s.raw.lstat(target).await {
            Err(SftpError::Status(status)) if status.status_code==StatusCode::NoSuchFile=>{},
            Ok(_)=>return Err("Destination already exists; overwrite is unsupported".into()),
            Err(_)=>return Err("Destination lookup failed; no changes attempted".into()),
        }
        // Last cancellation check must follow all network validation and reservation.
        check(stop)?;
        match action {
            Action::CreateFile=>{
                let handle=s.raw.open(target,OpenFlags::CREATE|OpenFlags::EXCLUDE|OpenFlags::WRITE,FileAttributes::empty()).await
                    .map_err(|_|"Remote new file creation failed or result is uncertain; no overwrite or automatic retry was attempted. Refresh before retrying")?.handle;
                // No WRITE packet is sent: this operation creates an empty file only.
                s.raw.close(handle).await.map_err(|_|"Remote new file may already exist; close acknowledgement failed. Refresh before retrying")?;
            },
            Action::Mkdir=>{s.raw.mkdir(target,FileAttributes::empty()).await.map_err(|_|"Remote new folder creation failed or result is uncertain; no recursive creation or automatic retry was attempted. Refresh before retrying")?;},
            _=>unreachable!(),
        }
        let attrs=s.raw.lstat(target).await.map_err(|_|"Remote entry may already exist; creation verification failed. Refresh before retrying")?.attrs;
        if attrs.is_symlink() || (action==Action::CreateFile && (!attrs.file_type().is_file() || attrs.size!=Some(0))) || (action==Action::Mkdir && !attrs.is_dir()) {
            return Err("Remote entry may already exist but its type or empty size could not be verified. Refresh before retrying".into());
        }
        Ok(Outcome{completed:1,message:"Created one new entry; refresh its parent folder.".into()})
    })
}
pub fn file_operation(
    s: &mut Connection,
    action: crate::file_ops::Action,
    source: &str,
    destination: Option<&str>,
    stop: &AtomicBool,
) -> Result<crate::file_ops::Outcome, String> {
    use crate::file_ops::{check, Action, Outcome};
    fn parent(path: &str) -> &str {
        let (p, _) = path.rsplit_once('/').unwrap();
        if p.is_empty() {
            "/"
        } else {
            p
        }
    }
    async fn absent(raw: &RawSftpSession, path: &str) -> Result<(), String> {
        checked_directory(raw, parent(path), false).await?;
        match raw.lstat(path).await {
            Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(()),
            Ok(_) => Err("Destination already exists; overwrite is unsupported".into()),
            Err(_) => Err("Destination lookup failed; no changes attempted".into()),
        }
    }
    async fn attrs(raw: &RawSftpSession, path: &str) -> Result<FileAttributes, String> {
        checked_directory(raw, parent(path), false).await?;
        let attrs = raw
            .lstat(path)
            .await
            .map_err(|_| remote_error("source lookup"))?
            .attrs;
        if attrs.is_symlink() || (!attrs.is_dir() && !attrs.file_type().is_file()) {
            return Err(
                "Remote tree contains a symlink or unsupported entry; operation refused".into(),
            );
        }
        Ok(attrs)
    }
    s.run(stop,async {
        let mut pending=vec![(source.to_string(),0)]; let mut tree=Vec::new();
        while let Some((path,depth))=pending.pop() {
            check(stop)?;
            if depth>64 || tree.len()>=10000 {return Err("Operation tree exceeds 10,000 entries or depth 64".into());}
            let a=attrs(&s.raw,&path).await?;
            if a.is_dir() {
                let handle=s.raw.opendir(path.clone()).await.map_err(|_|remote_error("opendir"))?.handle;
                loop {
                    check(stop)?;
                    match s.raw.readdir(handle.clone()).await {
                        Ok(batch)=>for entry in batch.files {
                            let name=entry.filename;
                            if name=="." || name==".." {continue;}
                            if name.is_empty() || name.contains(['/', '\\']) || name.chars().any(|c|c.is_control()) {return Err("Unsafe remote entry name; operation refused before mutation".into());}
                            if pending.len()+tree.len()>=9999 {return Err("Operation tree exceeds 10,000 entries".into());}
                            pending.push((format!("{path}/{name}"),depth+1));
                        },
                        Err(SftpError::Status(status)) if status.status_code==StatusCode::Eof=>break,
                        Err(_)=>return Err(remote_error("tree listing")),
                    }
                }
                s.raw.close(handle).await.map_err(|_|remote_error("tree listing close"))?;
            }
            tree.push((path,a));
        }
        if let Some(target)=destination {absent(&s.raw,target).await?;}
        check(stop)?;
        match action {
            Action::CreateFile | Action::Mkdir=>return Err("Creation requires its dedicated validation path".into()),
            Action::Move=>{
                attrs(&s.raw,source).await?;
                let target=destination.ok_or("Move requires destination")?;
                absent(&s.raw,target).await?;
                check(stop)?;
                s.raw.rename(source,target).await.map_err(|_|"Remote rename failed or result uncertain; no delete-before-copy fallback was attempted. Refresh before retrying")?;
            },
            Action::Delete=>for (path,original) in tree.iter().rev() {
                check(stop)?;
                let current=attrs(&s.raw,path).await?;
                if current.is_dir()!=original.is_dir() {return Err("Remote source changed; deletion stopped. Earlier items may already be deleted".into());}
                if current.is_dir() {s.raw.rmdir(path.clone()).await.map_err(|_|"Remote directory deletion failed; some selected descendants may already be deleted")?;}
                else {s.raw.remove(path.clone()).await.map_err(|_|"Remote deletion failed; some selected descendants may already be deleted")?;}
            },
            Action::Copy=>{
                let target=destination.ok_or("Copy requires destination")?;
                for (path,original) in &tree {
                    check(stop)?;
                    let current=attrs(&s.raw,path).await?;
                    if current.is_dir()!=original.is_dir() || current.size!=original.size || current.mtime!=original.mtime {return Err("Remote source changed; partial copy retained; source not removed".into());}
                    let suffix=path.strip_prefix(source).ok_or("Remote source escaped tree")?;
                    let output=format!("{target}{suffix}");
                    absent(&s.raw,&output).await?;
                    if original.is_dir() {s.raw.mkdir(output,FileAttributes::empty()).await.map_err(|_|"Remote copy directory creation failed; partial target retained")?;continue;}
                    let expected=original.size.ok_or("Remote file size unavailable; copy refused")?;
                    let input=s.raw.open(path.clone(),OpenFlags::READ,FileAttributes::empty()).await.map_err(|_|remote_error("copy source open"))?.handle;
                    let out=s.raw.open(output,OpenFlags::CREATE|OpenFlags::EXCLUDE|OpenFlags::WRITE,FileAttributes::empty()).await.map_err(|_|"Remote target creation failed; partial target retained; no overwrite attempted")?.handle;
                    let mut offset=0;
                    while offset<expected {
                        check(stop)?;
                        let data=s.raw.read(input.clone(),offset,((expected-offset).min(65536)) as u32).await.map_err(|_|"Remote copy read failed; partial target retained")?.data;
                        if data.is_empty() || data.len() as u64>expected-offset {return Err("Remote copy source size changed; partial target retained".into());}
                        let len=data.len();s.raw.write(out.clone(),offset,data).await.map_err(|_|"Remote copy write failed; partial target retained")?;offset+=len as u64;
                    }
                    s.raw.close(input).await.map_err(|_|remote_error("copy source close"))?;
                    s.raw.close(out).await.map_err(|_|remote_error("copy target close"))?;
                    let after=attrs(&s.raw,path).await?;
                    if after.size!=original.size || after.mtime!=original.mtime {return Err("Remote source changed during copy; partial target retained".into());}
                }
            },
        }
        Ok(Outcome {completed:tree.len(),message:"Remote operation completed; refresh both folders.".into()})
    })
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteStamp {
    pub size: u64,
    pub mtime: u32,
    parent: Option<RemoteDirectoryStamp>,
}
impl RemoteStamp {
    pub fn authority_bytes(&self) -> usize {
        self.parent.as_ref().map_or(0,RemoteDirectoryStamp::authority_bytes)
    }
}
fn recorded_target(remote: &str, relative: &Path) -> Result<String, String> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Unsafe owned-file relative path".into());
    }
    let relative = relative
        .to_str()
        .ok_or("Unsupported owned filename")?
        .replace('\\', "/");
    let root = normalize(remote)?;
    let target = normalize(&format!("{root}/{relative}"))?;
    if target == "/" || target == root || root != "/" && !target.starts_with(&format!("{root}/")) {
        return Err("Owned-file deletion escaped its sync root".into());
    }
    Ok(target)
}
fn remote_stamp(attrs: &FileAttributes) -> Result<RemoteStamp, String> {
    if attrs.is_symlink() || !attrs.file_type().is_file() {
        return Err(
            "Owned remote entry is not a regular non-symlink file; deletion refused".into(),
        );
    }
    Ok(RemoteStamp {
        size: attrs
            .size
            .ok_or("Remote size unavailable; deletion ownership cannot be recorded")?,
        mtime: attrs
            .mtime
            .filter(|mtime| *mtime != 0)
            .ok_or("Remote modification time unavailable or unsupported; deletion refused")?,
        parent: None,
    })
}
fn protocol_seconds(time: SystemTime) -> Option<u32> {
    u32::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_secs()).ok().filter(|v| *v != 0)
}
fn matching_metadata(local_size: u64, local_time: Option<SystemTime>, attrs: &FileAttributes) -> bool {
    attrs.file_type().is_file() && !attrs.is_symlink()
        && attrs.size == Some(local_size)
        && local_time.and_then(protocol_seconds).is_some_and(|time| attrs.mtime == Some(time))
}
pub enum FileComparison {
    Unchanged(RemoteStamp),
    Upload { remote_newer: bool },
}
// Comparison is metadata-only. Keep the exact source metadata stable across the
// round trip; unknown times always require upload (which may refuse preservation).
pub fn compare_file(s: &mut Connection, root: &Path, relative: &Path, remote: &str, stop: &AtomicBool) -> Result<FileComparison, String> {
    let target = recorded_target(remote, relative)?;
    let source = root.join(relative);
    let canonical = source.canonicalize().map_err(|_| "Local source unavailable for comparison")?;
    if !canonical.starts_with(root) { return Err("Local comparison path escaped root".into()); }
    let input = std::fs::File::open(&source).map_err(|_| "Local source unreadable for comparison")?;
    let before = input.metadata().map_err(|_| "Local metadata unavailable for comparison")?;
    if !before.is_file() { return Err("Local comparison source is not a file".into()); }
    s.run(stop, async {
        let parent = target.rsplit_once('/').map(|(p,_)| if p.is_empty(){"/"}else{p}).ok_or("Invalid comparison target")?;
        let mut current = String::new();
        for part in parent.split('/').filter(|p| !p.is_empty()) {
            current.push('/'); current.push_str(part);
            match s.raw.lstat(current.clone()).await {
                Ok(a) if a.attrs.file_type().is_dir() && !a.attrs.is_symlink() => (),
                Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => return Ok(FileComparison::Upload { remote_newer: false }),
                _ => return Err("Remote comparison parent unavailable or unsafe".into()),
            }
        }
        let attrs = match s.raw.lstat(target.clone()).await {
            Ok(a) => a.attrs,
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => return Ok(FileComparison::Upload { remote_newer: false }),
            Err(_) => return Err("Remote comparison lookup failed".into()),
        };
        if !attrs.file_type().is_file() || attrs.is_symlink() { return Err("Remote comparison target is not a regular file".into()); }
        let after = input.metadata().map_err(|_| "Local comparison source changed")?;
        let current = std::fs::symlink_metadata(&source).map_err(|_| "Local comparison source changed")?;
        if current.file_type().is_symlink() || before.len()!=after.len() || before.modified().ok()!=after.modified().ok()
            || current.len()!=before.len() || current.modified().ok()!=before.modified().ok() {
            return Err("Local source changed during comparison".into());
        }
        if matching_metadata(before.len(), before.modified().ok(), &attrs) {
            let mut stamp = remote_stamp(&attrs)?;
            stamp.parent = Some(directory_guard(&s.raw, parent).await?);
            return Ok(FileComparison::Unchanged(stamp));
        }
        Ok(FileComparison::Upload { remote_newer: attrs.mtime.zip(before.modified().ok().and_then(protocol_seconds)).is_some_and(|(r,l)| r>l) })
    })
}

#[derive(Default)]
pub struct RetainedDirectories {
    paths: std::collections::HashSet<std::path::PathBuf>,
    bytes: usize,
    exhausted: bool,
}
impl RetainedDirectories {
    pub fn contains(&self,path:&Path)->bool { self.paths.contains(path) }
    pub fn exhausted(&self)->bool { self.exhausted }
    pub fn retain(&mut self,path:&Path)->Result<(),String> {
        let missing:Vec<_>=path.ancestors().filter(|path|!path.as_os_str().is_empty() && !self.paths.contains(*path)).collect();
        let added=missing.iter().fold(0usize,|sum,path|sum.saturating_add(path.as_os_str().len().saturating_mul(2).saturating_add(64)));
        let next=self.bytes.saturating_add(added);
        if self.paths.len().saturating_add(missing.len())>10000 || next>16*1024*1024 {
            self.exhausted=true;
            return Err("Retained directory tracking limit reached; deletion paused, stop and start a new sync".into());
        }
        for ancestor in missing { self.paths.insert(ancestor.to_path_buf()); }
        self.bytes=next;
        Ok(())
    }
}
pub struct RemoteSnapshot {
    pub files: Vec<(std::path::PathBuf, RemoteStamp)>,
    pub directories: Vec<(std::path::PathBuf, RemoteDirectoryStamp)>,
    pub retained: RetainedDirectories,
}
// Build everything before publishing authority. A failed READDIR, budget or
// invalid UTF-8 packet discards the complete snapshot, never authorizes a purge.
pub fn mirror_snapshot(s: &mut Connection, remote: &str, rules: &crate::exclusion::Rules, recursive: bool, stop: &AtomicBool) -> Result<RemoteSnapshot, String> {
    let remote = normalize(remote)?;
    s.run(stop, async {
        let mut snapshot = RemoteSnapshot { files: Vec::new(), directories: Vec::new(), retained: Default::default() };
        let mut stack = vec![(std::path::PathBuf::new(), remote)];
        let mut entries = 0usize;
        let mut batches = 0usize;
        let mut authority_bytes = 0usize;
        while let Some((relative, absolute)) = stack.pop() {
            crate::file_ops::check(stop)?;
            let guard = directory_guard(&s.raw, &absolute).await?;
            authority_bytes=authority_bytes.saturating_add(guard.authority_bytes()+absolute.len()+relative.as_os_str().len()*2);
            if authority_bytes > 16*1024*1024 { return Err("Remote mirror authority memory limit reached; deletion refused".into()); }
            if !relative.as_os_str().is_empty() { snapshot.directories.push((relative.clone(), guard.clone())); }
            let handle = s.raw.opendir(absolute.clone()).await.map_err(|_| "Remote mirror inventory open failed; deletion refused")?.handle;
            let mut seen = std::collections::HashSet::new();
            loop {
                batches += 1;
                if batches > 20000 { return Err("Remote mirror listing budget exceeded; deletion refused".into()); }
                match s.raw.readdir(handle.clone()).await {
                    Ok(batch) => for entry in batch.files {
                        if entry.filename == "." || entry.filename == ".." { continue; }
                        entries += 1;
                        if entries > 10000 { return Err("Remote mirror inventory exceeds 10,000 entries; deletion refused".into()); }
                        if !seen.insert(entry.filename.to_lowercase()) { return Err("Duplicate or case-ambiguous remote mirror entry; deletion refused".into()); }
                        if crate::file_ops::validate_creation_name(&entry.filename, crate::file_ops::Side::Local).is_err() {
                            snapshot.retained.retain(&relative)?; continue;
                        }
                        let child = relative.join(&entry.filename);
                        authority_bytes=authority_bytes.saturating_add(child.as_os_str().len()*4+entry.filename.len());
                        if authority_bytes > 16*1024*1024 { return Err("Remote mirror authority memory limit reached; deletion refused".into()); }
                        let dir = entry.attrs.file_type().is_dir() && !entry.attrs.is_symlink();
                        if rules.excludes(&child, dir)? || entry.attrs.is_symlink() || (!dir && !entry.attrs.file_type().is_file()) || (!recursive && dir) {
                            snapshot.retained.retain(&relative)?; continue;
                        }
                        if dir {
                            if child.components().count() > 64 { return Err("Remote mirror directory depth exceeds 64; deletion refused".into()); }
                            stack.push((child, format!("{}/{}", absolute.trim_end_matches('/'), entry.filename)));
                        } else if let Ok(mut stamp) = remote_stamp(&entry.attrs) {
                            stamp.parent = Some(guard.clone()); snapshot.files.push((child, stamp));
                        } else { snapshot.retained.retain(&relative)?; }
                    },
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                    Err(_) => return Err("Remote mirror inventory read failed; deletion refused".into()),
                }
            }
            s.raw.close(handle).await.map_err(|_| "Remote mirror inventory close failed; deletion refused")?;
            if directory_guard(&s.raw,&absolute).await? != guard { return Err("Remote mirror directory changed during inventory; deletion refused".into()); }
        }
        Ok(snapshot)
    })
}
// SFTPv3 has no inode or conditional RMDIR. These session-scoped guards detect
// observable path/type/permission changes, not indistinguishable same-path swaps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteDirectoryStamp {
    chain: Arc<Vec<(String, Option<u32>, Option<u32>, u32)>>,
}
impl RemoteDirectoryStamp {
    pub fn authority_bytes(&self) -> usize { self.chain.iter().map(|entry|entry.0.len()+32).sum() }
}
async fn directory_guard(
    raw: &RawSftpSession,
    target: &str,
) -> Result<RemoteDirectoryStamp, String> {
    let mut chain = Vec::new();
    let mut current = String::from("/");
    let mut paths = vec![current.clone()];
    for part in target.split('/').filter(|p| !p.is_empty()) {
        if current != "/" {
            current.push('/');
        }
        current.push_str(part);
        paths.push(current.clone());
    }
    for path in paths {
        let attrs = raw
            .lstat(path.clone())
            .await
            .map_err(|_| "Remote directory guard lookup failed; deletion refused")?
            .attrs;
        if !attrs.file_type().is_dir() || attrs.is_symlink() {
            return Err(
                "Remote directory/ancestor changed type or is a symlink; deletion refused".into(),
            );
        }
        chain.push((
            path,
            attrs.uid,
            attrs.gid,
            attrs
                .permissions
                .ok_or("Remote directory permissions unavailable")?,
        ));
    }
    let names = raw
        .realpath(target)
        .await
        .map_err(|_| "Remote canonical directory lookup failed")?
        .files;
    if names.len() != 1 || names[0].filename != target {
        return Err("Remote directory canonical path changed; deletion refused".into());
    }
    Ok(RemoteDirectoryStamp { chain: Arc::new(chain) })
}
pub fn authorize_directory(
    s: &mut Connection,
    remote: &str,
    relative: &Path,
    stop: &AtomicBool,
    verify_local: &dyn Fn() -> Result<(), String>,
) -> Result<RemoteDirectoryStamp, String> {
    authorize_directory_observed(s,remote,relative,stop,verify_local).map(|(stamp,_)|stamp)
}
pub fn authorize_directory_observed(
    s: &mut Connection, remote: &str, relative: &Path, stop: &AtomicBool,
    verify_local: &dyn Fn() -> Result<(), String>,
) -> Result<(RemoteDirectoryStamp, bool), String> {
    let target = recorded_target(remote, relative)?;
    let root = normalize(remote)?;
    s.run(stop, async {
        verify_local()?;
        checked_directory(&s.raw, &root, false).await?;
        let created = match s.raw.lstat(target.clone()).await {
            Ok(_) => false,
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => true,
            Err(_) => return Err("Remote directory lookup failed".into()),
        };
        checked_directory(&s.raw, &target, true).await?;
        let stamp = directory_guard(&s.raw, &target).await?;
        verify_local()?;
        crate::file_ops::check(stop)?;
        Ok((stamp, created))
    })
}
pub fn delete_owned_directory(
    s: &mut Connection,
    remote: &str,
    relative: &Path,
    expected: &RemoteDirectoryStamp,
    stop: &AtomicBool,
    verify_local_absence: &dyn Fn() -> Result<(), String>,
) -> Result<bool, String> {
    let target = recorded_target(remote, relative)?;
    s.run(stop,async {
        if &directory_guard(&s.raw,&target).await? != expected { return Err("Remote directory guard changed since authorization; deletion refused".into()); }
        let handle=s.raw.opendir(target.clone()).await.map_err(|_| "Remote directory cannot be read; deletion refused")?.handle;
        let mut empty=false;
        for _ in 0..1024 {
            match s.raw.readdir(handle.clone()).await {
                Ok(batch) if batch.files.iter().all(|entry| entry.filename=="." || entry.filename=="..") => (),
                Ok(_) => {
                    s.raw.close(handle).await.map_err(|_| "Remote directory close failed")?;
                    return Ok(false);
                }
                Err(SftpError::Status(status)) if status.status_code==StatusCode::Eof => {empty=true;break;},
                Err(_) => return Err("Remote directory read failed; deletion refused".into()),
            }
        }
        s.raw.close(handle).await.map_err(|_| "Remote directory close failed; deletion refused")?;
        if !empty { return Err("Remote directory emptiness could not be verified".into()); }
        if &directory_guard(&s.raw,&target).await? != expected { return Err("Remote directory changed during empty check; deletion refused".into()); }
        // Cross-host absence cannot be atomic: check as late as possible. RMDIR
        // itself protects every child created after READDIR, without recursion.
        verify_local_absence()?;
        crate::file_ops::check(stop)?;
        s.raw.rmdir(target).await.map_err(|_| "Remote directory removal failed or outcome is uncertain; authority suspended until a verified local counterpart exists")?;
        Ok(true)
    })
}

pub fn upload_recorded(
    s: &mut Connection,
    root: &Path,
    relative: &Path,
    remote: &str,
    stop: &AtomicBool,
    id: &str,
) -> Result<(u64, RemoteStamp), String> {
    let target = recorded_target(remote, relative)?;
    let bytes = upload(s, root, relative, remote, stop, id)?;
    let stamp=s.run(stop,async {
        let parent=target.rsplit_once('/').map(|(parent,_)|if parent.is_empty(){"/"}else{parent}).ok_or("Invalid owned target")?;
        checked_directory(&s.raw,parent,false).await?;
        let attrs=s.raw.lstat(target.clone()).await.map_err(|_|"Upload completed but ownership metadata is unavailable; deletion ownership was not recorded")?.attrs;
        let mut stamp=remote_stamp(&attrs)?;
        if stamp.size!=bytes {return Err("Remote file changed after upload; deletion ownership was not recorded".into());}
        let local=std::fs::metadata(root.join(relative)).map_err(|_|"Local source changed after upload")?;
        if stamp.mtime != local.modified().ok().and_then(protocol_seconds).ok_or("Local source mtime unavailable")? { return Err("Remote timestamp changed after upload; deletion ownership was not recorded".into()); }
        stamp.parent=Some(directory_guard(&s.raw,parent).await?);
        Ok(stamp)
    })?;
    Ok((bytes, stamp))
}
pub fn delete_uploaded_file(
    s: &mut Connection,
    remote: &str,
    relative: &Path,
    expected: &RemoteStamp,
    stop: &AtomicBool,
    verify_local_absence: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let target = recorded_target(remote, relative)?;
    let root = normalize(remote)?;
    s.run(stop, async {
        checked_directory(&s.raw, &root, false).await?;
        let parent = target
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .ok_or("Invalid owned target")?;
        checked_directory(&s.raw, parent, false).await?;
        let parent_guard=directory_guard(&s.raw,parent).await?;
        if expected.parent.as_ref()!=Some(&parent_guard) { return Err("Remote file parent changed since verification; deletion refused".into()); }
        let attrs = s
            .raw
            .lstat(target.clone())
            .await
            .map_err(|_| "Owned remote file unavailable; no removal attempted")?
            .attrs;
        let current = remote_stamp(&attrs)?;
        if current.size != expected.size || current.mtime != expected.mtime {
            return Err("Remote file changed since verification; deletion refused".into());
        }
        if directory_guard(&s.raw,parent).await? != parent_guard { return Err("Remote file parent changed during verification; deletion refused".into()); }
        verify_local_absence()?;
        crate::file_ops::check(stop)?;
        // This is deliberately REMOVE for one known regular file. There is no
        // recursive directory removal or delete fallback.
        s.raw.remove(target).await.map_err(|_| {
            "Owned remote deletion failed or outcome is uncertain; refresh before retrying"
        })?;
        Ok(())
    })
}
pub fn upload(
    s: &mut Connection,
    root: &Path,
    relative: &Path,
    remote: &str,
    stop: &AtomicBool,
    id: &str,
) -> Result<u64, String> {
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Unsafe relative path".into());
    }
    let source = root.join(relative);
    let canonical = source
        .canonicalize()
        .map_err(|_| "Local source unavailable")?;
    if !canonical.starts_with(root) {
        return Err("Local path escaped root".into());
    }
    let mut check = root.to_path_buf();
    for part in relative.components() {
        check.push(part);
        if std::fs::symlink_metadata(&check)
            .map_err(|_| "Local metadata unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("Local symlink refused".into());
        }
    }
    let relative = relative
        .to_str()
        .ok_or("Unsupported filename")?
        .replace('\\', "/");
    let target = normalize(&format!("{remote}/{relative}"))?;
    let (parent, _) = target.rsplit_once('/').ok_or("Invalid remote path")?;
    let parent = if parent.is_empty() { "/" } else { parent };
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_nanos();
    let stage = format!("{parent}/.syncfiles-{id}-{stamp}-{unique}.part");
    s.run(stop,async {
        checked_directory(&s.raw,parent,true).await?;
        let existing=match s.raw.lstat(target.clone()).await {
            Ok(a)=>{if !a.attrs.file_type().is_file()||a.attrs.is_symlink(){return Err("Remote target is not a regular file".into());}true},
            Err(SftpError::Status(status)) if status.status_code==StatusCode::NoSuchFile=>false,
            Err(_)=>return Err(remote_error("target lookup")),
        };
        if existing && !s.posix_rename{return Err("Server lacks posix-rename@openssh.com; safe overwrite is unavailable. The existing target was not deleted.".into());}
        let mut input=tokio::fs::File::open(canonical).await.map_err(|_|"Local source unavailable")?;
        let before=input.metadata().await.map_err(|_|"Local metadata unavailable")?;
        if !before.is_file(){return Err("Local source is not a regular file".into());}
        let source_mtime=before.modified().ok().and_then(protocol_seconds).ok_or("Local source timestamp unsupported by SFTPv3; upload was not committed")?;
        let handle=s.raw.open(stage.clone(),OpenFlags::CREATE|OpenFlags::EXCLUDE|OpenFlags::WRITE,FileAttributes::empty()).await.map_err(|_|remote_error("staging open"))?.handle;
        let mut offset=0u64;
        loop {
            let mut chunks=Vec::new();
            for _ in 0..8 {
                let mut chunk=vec![0u8;32768];let n=input.read(&mut chunk).await.map_err(|_|"Local read failed")?;
                if n==0{break;}chunk.truncate(n);chunks.push((offset,chunk));offset+=n as u64;
            }
            if chunks.is_empty(){break;}
            let writes=chunks.into_iter().map(|(at,data)|s.raw.write(handle.clone(),at,data));
            futures_util::future::try_join_all(writes).await.map_err(|_|remote_error("upload"))?;
        }
        let mut times=FileAttributes::empty();
        times.atime=Some(before.accessed().ok().and_then(protocol_seconds).unwrap_or(source_mtime));
        times.mtime=Some(source_mtime);
        let status=s.raw.fsetstat(handle.clone(),times).await.map_err(|_|"SFTP source timestamp preservation failed; staging was not committed")?;
        if status.status_code != StatusCode::Ok { return Err("SFTP source timestamp preservation refused; staging was not committed".into()); }
        let staged=s.raw.fstat(handle.clone()).await.map_err(|_|"SFTP staging timestamp verification failed; staging was not committed")?.attrs;
        if staged.mtime!=Some(source_mtime) || staged.size!=Some(offset) { return Err("SFTP staging timestamp or size was not preserved; staging was not committed".into()); }
        s.raw.close(handle).await.map_err(|_|remote_error("staging close"))?;
        let after=input.metadata().await.map_err(|_|"Local source changed")?;
        let current=tokio::fs::metadata(source).await.map_err(|_|"Local source changed")?;
        if before.len()!=after.len()||before.modified().ok()!=after.modified().ok()||before.len()!=offset||current.len()!=after.len()||current.modified().ok()!=after.modified().ok(){return Err("Local source changed during upload; staging was not committed".into());}
        if stop.load(Ordering::Relaxed){return Err("Stopped before final rename; staging retained".into());}
        checked_directory(&s.raw,parent,false).await?;
        if s.posix_rename {
            let mut data=Vec::new();for value in [&stage,&target]{data.extend_from_slice(&(value.len() as u32).to_be_bytes());data.extend_from_slice(value.as_bytes());}
            match s.raw.extended("posix-rename@openssh.com",data).await.map_err(|_|remote_error("final rename"))? {
                Packet::Status(status) if status.status_code==StatusCode::Ok=>{},
                _=>return Err(remote_error("final rename")),
            }
        }else{s.raw.rename(stage,target.clone()).await.map_err(|_|remote_error("final rename"))?;}
        Ok(offset)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_directory_authority_is_bounded_across_distinct_lifetime_paths() {
        let mut retained=RetainedDirectories::default();
        for n in 0..10000 {retained.retain(Path::new(&format!("retained-{n}"))).unwrap();}
        assert!(retained.retain(Path::new("one-more/child")).is_err(),"Repeated nonempty removals cannot accumulate unbounded lifetime retention paths");
        assert_eq!(retained.paths.len(),10000,"Budget failure must not publish partial new ancestors");
        assert!(retained.exhausted());
        retained.retain(Path::new("retained-1")).unwrap();
    }
    #[test]
    fn retained_directory_bytes_are_bounded_without_partial_ancestor_adoption() {
        let mut retained=RetainedDirectories::default();
        let prefix=("a".repeat(250)+"/").repeat(16);
        for n in 0..5000 {
            let path=format!("{prefix}retained-{n}/new-child");
            let count=retained.paths.len();let bytes=retained.bytes;
            if retained.retain(Path::new(&path)).is_err() {
                assert_eq!(retained.paths.len(),count);assert_eq!(retained.bytes,bytes);
                assert!(retained.bytes<=16*1024*1024);assert!(retained.paths.len()<10000);
                assert!(retained.exhausted());return;
            }
        }
        panic!("Distinct deep lifetime paths must hit the byte budget before the count budget");
    }
    #[test]
    fn metadata_comparison_floors_subseconds_and_refuses_unknown_protocol_times() {
        let mut attrs=FileAttributes::empty();attrs.permissions=Some(0o100644);attrs.size=Some(5);attrs.mtime=Some(1700000000);
        assert!(matching_metadata(5,Some(UNIX_EPOCH+Duration::new(1700000000,999999999)),&attrs));
        assert!(!matching_metadata(6,Some(UNIX_EPOCH+Duration::from_secs(1700000000)),&attrs));
        assert!(!matching_metadata(5,Some(UNIX_EPOCH+Duration::from_secs(1700000001)),&attrs));
        for time in [None,Some(UNIX_EPOCH),Some(UNIX_EPOCH-Duration::from_secs(1)),Some(UNIX_EPOCH+Duration::from_secs(u32::MAX as u64+1))] { assert!(!matching_metadata(5,time,&attrs)); }
        attrs.mtime=None;assert!(!matching_metadata(5,Some(UNIX_EPOCH+Duration::from_secs(1700000000)),&attrs));
        attrs.mtime=Some(1700000000);attrs.permissions=Some(0o120777);
        assert!(!matching_metadata(5,Some(UNIX_EPOCH+Duration::from_secs(1700000000)),&attrs));
    }
    #[test]
    fn host_probe_is_cancelled_without_loading_a_private_key_or_authenticating() {
        let p = Profile {
            id: "generated".into(),
            name: "generated".into(),
            host: "127.0.0.1".into(),
            port: 1,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: "this-key-must-never-be-opened.ppk".into(),
            host_key: String::new(),
        };
        let error = probe_host_key(&p, &AtomicBool::new(true)).unwrap_err();
        assert!(error.contains("stopped"));
        assert_eq!(
            canonical_fingerprint(&format!("ssh-ed25519 256 SHA256:{}=", "A".repeat(43))).unwrap(),
            format!("SHA256:{}", "A".repeat(43))
        );
        assert!(canonical_fingerprint("").is_err());
    }
    #[test]
    fn listing_timestamps_are_optional_and_old_entry_payloads_remain_readable() {
        let legacy: Entry =
            serde_json::from_str(r#"{"name":"fixture.txt","dir":false,"size":7}"#).unwrap();
        assert!(legacy.modified_at.is_none());
        assert!(serde_json::to_value(&legacy)
            .unwrap()
            .get("modifiedAt")
            .is_none());
        let dated = Entry {
            modified_at: Some(1_700_000_000),
            ..legacy
        };
        assert_eq!(
            serde_json::to_value(dated).unwrap()["modifiedAt"],
            1_700_000_000u64
        );
    }
    #[test]
    fn owned_deletion_target_rejects_roots_and_traversal() {
        for relative in ["", ".", "..", "../outside", "nested/../../outside"] {
            assert!(recorded_target("/upload", Path::new(relative)).is_err());
        }
        assert_eq!(
            recorded_target("/upload", Path::new("nested/file.txt")).unwrap(),
            "/upload/nested/file.txt"
        );
    }
    #[test]
    fn deletion_stamp_refuses_unknown_metadata_links_and_changed_files() {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(0o100644);
        attrs.size = Some(5);
        attrs.mtime = Some(100);
        let stamp = remote_stamp(&attrs).unwrap();
        assert_eq!(
            stamp,
            RemoteStamp {
                size: 5,
                mtime: 100,
                parent: None,
            }
        );
        attrs.size = Some(6);
        assert_ne!(remote_stamp(&attrs).unwrap(), stamp);
        attrs.mtime = None;
        assert!(remote_stamp(&attrs).is_err());
        attrs.mtime = Some(0);
        assert!(remote_stamp(&attrs).is_err());
        attrs.mtime = Some(100);
        attrs.permissions = Some(0o120777);
        assert!(remote_stamp(&attrs).is_err());
        attrs.permissions = Some(0o040755);
        assert!(remote_stamp(&attrs).is_err());
    }
    #[test]
    fn opaque_sftp_handles_preserve_every_byte() {
        use russh_sftp::protocol::{Packet, Write};
        let handle: Vec<u8> = (0..=255).collect();
        let mut reply = vec![102, 0, 0, 0, 7];
        reply.extend_from_slice(&(handle.len() as u32).to_be_bytes());
        reply.extend_from_slice(&handle);
        let decoded = Packet::try_from(&mut bytes::Bytes::from(reply)).unwrap();
        let Packet::Handle(decoded) = decoded else {
            panic!("Expected handle")
        };
        let wire = bytes::Bytes::try_from(Packet::Write(Write {
            id: 8,
            handle: decoded.handle,
            offset: 0,
            data: vec![],
        }))
        .unwrap();
        assert_eq!(
            &wire[13..13 + handle.len()],
            handle.as_slice(),
            "Opaque handles must never pass through UTF-8 conversion"
        );
    }
    #[test]
    fn invalid_utf8_server_names_are_rejected_without_aliasing_real_names() {
        fn name_packet(name: &[u8]) -> bytes::Bytes {
            let mut packet = vec![104, 0, 0, 0, 7, 0, 0, 0, 1];
            packet.extend_from_slice(&(name.len() as u32).to_be_bytes());
            packet.extend_from_slice(name);
            packet.extend_from_slice(&[0; 8]); // empty longname and empty attributes
            bytes::Bytes::from(packet)
        }
        assert!(
            Packet::try_from(&mut name_packet(&[0xff])).is_err(),
            "Never alias an unsupported byte name to a real replacement-character filename"
        );
        let Packet::Name(valid) = Packet::try_from(&mut name_packet("�".as_bytes())).unwrap()
        else {
            panic!("Expected NAME")
        };
        assert_eq!(valid.files[0].filename, "�");
    }
    #[test]
    fn unencrypted_ppk_v2_v3_are_decoded_in_memory_without_plaintext_files() {
        use hmac::{digest::KeyInit, Hmac, Mac};
        use sha1::{Digest, Sha1};
        use sha2::Sha256;
        fn part(value: &[u8]) -> Vec<u8> {
            let mut out = (value.len() as u32).to_be_bytes().to_vec();
            out.extend_from_slice(value);
            out
        }
        fn lines(value: &[u8]) -> Vec<String> {
            base64::engine::general_purpose::STANDARD
                .encode(value)
                .as_bytes()
                .chunks(64)
                .map(|c| String::from_utf8(c.to_vec()).unwrap())
                .collect()
        }
        let encrypted = include_str!("../tests/fixtures/generated-encrypted-v2.ppk");
        let key = russh::keys::decode_secret_key(encrypted, Some("fixture-only-not-a-user-secret"))
            .unwrap();
        let rsa = key.key_data().rsa().unwrap();
        let secret = rsa.private();
        let private = zeroize::Zeroizing::new(
            [
                secret.d().as_bytes(),
                secret.p().as_bytes(),
                secret.q().as_bytes(),
                secret.iqmp().as_bytes(),
            ]
            .into_iter()
            .flat_map(part)
            .collect::<Vec<_>>(),
        );
        let public = key.public_key().to_bytes().unwrap();
        let mac_data = zeroize::Zeroizing::new(
            [
                b"ssh-rsa".as_slice(),
                b"none",
                b"memory-only-fixture",
                public.as_slice(),
                private.as_slice(),
            ]
            .into_iter()
            .flat_map(part)
            .collect::<Vec<_>>(),
        );
        for version in [2, 3] {
            let mac = if version == 2 {
                let mut h = <Hmac<Sha1> as KeyInit>::new_from_slice(&Sha1::digest(
                    b"putty-private-key-file-mac-key",
                ))
                .unwrap();
                h.update(&mac_data);
                h.finalize().into_bytes().to_vec()
            } else {
                let mut h = <Hmac<Sha256> as KeyInit>::new_from_slice(&[]).unwrap();
                h.update(&mac_data);
                h.finalize().into_bytes().to_vec()
            };
            let public_lines = lines(&public);
            let private_lines = lines(&private);
            let text=zeroize::Zeroizing::new(format!("PuTTY-User-Key-File-{version}: ssh-rsa\nEncryption: none\nComment: memory-only-fixture\nPublic-Lines: {}\n{}\nPrivate-Lines: {}\n{}\nPrivate-MAC: {}\n",public_lines.len(),public_lines.join("\n"),private_lines.len(),private_lines.join("\n"),mac.iter().map(|b|format!("{b:02x}")).collect::<String>()));
            let decoded = russh::keys::decode_secret_key(&text, None).unwrap();
            assert_eq!(
                decoded.public_key().fingerprint(HashAlg::Sha256),
                key.public_key().fingerprint(HashAlg::Sha256)
            );
            let mut damaged = text.trim_end().to_owned();
            let last = damaged.pop().unwrap();
            damaged.push(if last == '0' { '1' } else { '0' });
            let error = key_error_fixture(&damaged, "fixture-secret-is-irrelevant-for-unencrypted")
                .unwrap_err();
            let wire = serde_json::to_value(ConnectError::from(error)).unwrap();
            assert_eq!(
                wire["kind"], "other",
                "A genuinely unencrypted key with damaged MAC is not an unlock failure"
            );
        }
    }
    #[test]
    fn encrypted_ppk_v2_v3_auth_material_and_mac_are_verified() {
        let mut public = None;
        for filename in ["generated-encrypted-v2.ppk", "generated-encrypted-v3.ppk"] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(filename);
            let key = runtime()
                .block_on(load_key(
                    path.to_string_lossy().into_owned(),
                    zeroize::Zeroizing::new("fixture-only-not-a-user-secret".into()),
                ))
                .unwrap();
            let encoded = key.public_key().to_openssh().unwrap();
            if let Some(expected) = &public {
                assert_eq!(expected, &encoded);
            } else {
                public = Some(encoded);
            }
            let text = std::fs::read_to_string(path).unwrap();
            assert!(russh::keys::decode_secret_key(&text, Some("wrong-fixture-secret")).is_err());
            let mut damaged = text.trim_end().to_owned();
            let last = damaged.pop().unwrap();
            damaged.push(if last == '0' { '1' } else { '0' });
            assert!(russh::keys::decode_secret_key(
                &damaged,
                Some("fixture-only-not-a-user-secret")
            )
            .is_err());
        }
    }
    fn key_error_fixture(text: &str, secret: &str) -> Result<russh::keys::PrivateKey, String> {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "nearly-key-errors-{:x}",
            u128::from_ne_bytes(nonce)
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("generated.ppk");
        std::fs::write(&path, text).unwrap();
        let result = runtime().block_on(load_key(
            path.to_string_lossy().into_owned(),
            zeroize::Zeroizing::new(secret.into()),
        ));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            text,
            "Decoder must not modify generated key"
        );
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            1,
            "No plaintext or secret file may be created"
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
        result
    }
    fn change_ppk_field(text: &str, key: &str, value: &str) -> String {
        text.lines()
            .map(|line| {
                if line.starts_with(&format!("{key}: ")) {
                    format!("{key}: {value}")
                } else {
                    line.into()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }
    #[test]
    fn key_unlock_wrong_secret_and_authenticated_damage_share_ambiguous_error() {
        for text in [
            include_str!("../tests/fixtures/generated-encrypted-v2.ppk"),
            include_str!("../tests/fixtures/generated-encrypted-v3.ppk"),
        ] {
            assert!(key_error_fixture(text, "fixture-only-not-a-user-secret").is_ok());
            for secret in ["wrong-generated-secret", ""] {
                assert_eq!(
                    key_error_fixture(text, secret).unwrap_err(),
                    "Check the passphrase or key file"
                );
            }
            let mac = text
                .lines()
                .find_map(|line| line.strip_prefix("Private-MAC: "))
                .unwrap();
            let changed_mac = format!(
                "{}{}",
                if mac.starts_with('0') { '1' } else { '0' },
                &mac[1..]
            );
            let mut cipher_lines = text.lines().map(str::to_owned).collect::<Vec<_>>();
            let index = cipher_lines
                .iter()
                .position(|line| line.starts_with("Private-Lines: "))
                .unwrap()
                + 1;
            let first = if cipher_lines[index].starts_with('A') {
                "B"
            } else {
                "A"
            };
            cipher_lines[index].replace_range(..1, first);
            for damaged in [
                change_ppk_field(text, "Comment", "generated changed authenticated comment"),
                change_ppk_field(text, "Private-MAC", &changed_mac),
                cipher_lines.join("\n"),
            ] {
                assert_eq!(
                    key_error_fixture(&damaged, "fixture-only-not-a-user-secret").unwrap_err(),
                    "Check the passphrase or key file"
                );
            }
        }
    }
    #[test]
    fn key_unlock_malformed_unsupported_and_unencrypted_inputs_are_not_password_errors() {
        let text = include_str!("../tests/fixtures/generated-encrypted-v3.ppk");
        let cases = [
            "not a key".into(),
            text.replace("PuTTY-User-Key-File-3", "PuTTY-User-Key-File-4"),
            text.replace("ssh-rsa", "ssh-unsupported-generated"),
            text.replace("ssh-rsa", "ssh-dss"),
            text.replace("ssh-rsa", "ssh-ed25519"), // Supported header but mismatched public blob.
            change_ppk_field(text, "Encryption", "unsupported-generated"),
            change_ppk_field(text, "Key-Derivation", "unsupported-generated"),
            change_ppk_field(text, "Argon2-Memory", "65537"),
            change_ppk_field(text, "Argon2-Passes", "65"),
            change_ppk_field(text, "Argon2-Parallelism", "9"),
            change_ppk_field(text, "Private-MAC", "zz"),
            change_ppk_field(text, "Private-MAC", "01"),
            change_ppk_field(text, "Encryption", "none"),
            format!("{text}Encryption: aes256-cbc\n"),
            format!("{text}Comment: generated duplicate\n"),
            text.replace("Public-Lines: ", "Public-Lines: 999999"),
            text.lines().take(5).collect::<Vec<_>>().join("\n"),
            text.lines()
                .enumerate()
                .map(|(i, line)| if i == 4 { "!bad-base64!" } else { line })
                .collect::<Vec<_>>()
                .join("\n"),
        ];
        for (index, malformed) in cases.iter().enumerate() {
            let error = key_error_fixture(malformed, "generated-secret-not-for-logs").unwrap_err();
            assert_ne!(
                error, "Check the passphrase or key file",
                "Malformed case {index} must remain generic"
            );
            assert!(!error.contains("generated-secret-not-for-logs"));
            assert!(!error.contains("generated duplicate"));
        }
        // Duplicate metadata must fail even when it repeats a valid value with the correct secret.
        let repeated = format!("{text}Encryption: aes256-cbc\n");
        assert!(key_error_fixture(&repeated, "fixture-only-not-a-user-secret").is_err());
    }
    #[test]
    fn key_unlock_wire_category_is_narrow_and_never_contains_submitted_secret_or_decoder_text() {
        let text = include_str!("../tests/fixtures/generated-encrypted-v2.ppk");
        let error = key_error_fixture(text, "generated-password-MUST-NOT-LEAK").unwrap_err();
        let wire = serde_json::to_value(ConnectError::from(error)).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({"kind":"keyUnlockFailed","message":"Check the passphrase or key file"})
        );
        assert!(!wire
            .to_string()
            .contains("generated-password-MUST-NOT-LEAK"));
        for message in [
            "SSH server refused this key or username",
            "SSH key authentication timed out",
            "Host key does not match the pinned SHA256 fingerprint",
            "Operation stopped; staging may remain and an issued final rename may have completed. Restart to reconcile.",
            "The key is encrypted", // Missing secret is not a wrong supplied secret.
            "incorrect MAC", // No dependency string alone can create the wire category.
            "path: Check the passphrase or key file",
            "Check the passphrase or key file (server text)",
        ] {
            let wire = serde_json::to_value(ConnectError::from(message.to_owned())).unwrap();
            assert_eq!(wire["kind"], "other");
            assert_eq!(wire["message"], message);
        }
        // A parser's Syntax value may embed arbitrary input. It must never reach the wire.
        let malicious = "PuTTY-User-Key-File-2: ssh-rsa\nEncryption: aes256-cbc\nPrivate-MAC: 0000000000000000000000000000000000000000\ngenerated-PRIVATE-MATERIAL-MUST-NOT-LEAK\n";
        let error = key_error_fixture(malicious, "generated-password-MUST-NOT-LEAK").unwrap_err();
        let wire = serde_json::to_value(ConnectError::from(error)).unwrap();
        assert_eq!(wire["kind"], "other");
        assert!(!wire.to_string().contains("MUST-NOT-LEAK"));
    }
    #[test]
    fn paths() {
        assert_eq!(normalize("/a//b/../c").unwrap(), "/a/c");
        assert!(normalize("relative").is_err());
        assert!(overlap("/a", "/a/b"));
        assert!(!overlap("/a", "/ab"));
    }
    #[test]
    fn host_key_is_required_and_cannot_be_bypassed() {
        assert!(!valid_host_key("*"));
        assert!(!valid_host_key("ssh-rsa 2048 *"));
        assert!(!valid_host_key(""));
        assert!(valid_host_key(&format!(
            "ssh-ed25519 255 {}",
            "A".repeat(43)
        )));
    }
    #[test]
    fn accepts_standard_sha256_fingerprint() {
        assert!(valid_host_key(&format!("SHA256:{}", "A".repeat(43))));
    }
    #[test]
    fn rejects_expensive_or_duplicate_ppk_costs() {
        assert!(
            validate_key_input("PuTTY-User-Key-File-3: ssh-rsa\nArgon2-Memory: 65537").is_err()
        );
        assert!(validate_key_input(
            "PuTTY-User-Key-File-3: ssh-rsa\nArgon2-Passes: 1\nArgon2-Passes: 1"
        )
        .is_err());
    }
}
// One-shot uploads never adopt an existing target and never clean up by pathname.
pub fn upload_new(
    s: &mut Connection,
    remote: &str,
    entries: &mut [crate::upload::Entry],
    stop: &AtomicBool,
) -> Result<crate::upload::UploadOutcome, String> {
    use crate::file_ops::check;
    fn upload_error(operation:&str)->String{format!("SFTP {operation} failed; check connection and permissions.")}
    let mut completed = 0;
    let mut bytes = 0u64;
    let mut transferred_bytes = 0u64;
    let mut attempted = false;
    let result = s.run(stop, async {
        checked_directory(&s.raw, remote, false).await?;
        // Inventory existing destination siblings, bounded and case-insensitive.
        let handle = s
            .raw
            .opendir(remote)
            .await
            .map_err(|_| upload_error("upload destination inventory"))?
            .handle;
        let mut existing = std::collections::HashSet::new();
        let mut count = 0;
        loop {
            check(stop)?;
            match s.raw.readdir(handle.clone()).await {
                Ok(batch) => {
                    for item in batch.files {
                        if item.filename == "." || item.filename == ".." {
                            continue;
                        }
                        count += 1;
                        if count > 10000 {
                            return Err("Destination inventory exceeds 10,000 entries".into());
                        }
                        existing.insert(item.filename.to_uppercase());
                    }
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(_) => return Err(upload_error("upload destination inventory")),
            }
        }
        s.raw
            .close(handle)
            .await
            .map_err(|_| upload_error("upload inventory close"))?;
        for entry in entries.iter() {
            crate::upload::revalidate(entry)?;
            if existing.contains(&entry.relative.split('/').next().unwrap().to_uppercase()) {
                return Err(
                    "Destination collision or case-ambiguous name; no writes attempted".into(),
                );
            }
        }
        for entry in entries.iter_mut() {
            check(stop)?;
            crate::upload::revalidate(entry)?;
            let target = format!("{}/{}", remote.trim_end_matches('/'), entry.relative);
            let parent = target.rsplit_once('/').unwrap().0;
            let parent = if parent.is_empty() { "/" } else { parent };
            checked_directory(&s.raw, parent, false).await?;
            match s.raw.lstat(target.clone()).await {
                Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {}
                Ok(_) => return Err("Destination appeared; overwrite refused".into()),
                Err(_) => return Err(upload_error("upload target lookup")),
            }
            check(stop)?;
            attempted = true;
            if entry.directory {
                s.raw
                    .mkdir(target.clone(), FileAttributes::empty())
                    .await
                    .map_err(|_| "Directory creation failed or outcome uncertain")?;
                let attrs = s
                    .raw
                    .lstat(target)
                    .await
                    .map_err(|_| "Created directory verification failed")?
                    .attrs;
                if !attrs.is_dir() || attrs.is_symlink() {
                    return Err("Created directory changed during upload".into());
                }
                completed += 1;
                continue;
            }
            let handle = s
                .raw
                .open(
                    target,
                    OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    FileAttributes::empty(),
                )
                .await
                .map_err(|_| "Exclusive upload creation failed or outcome uncertain")?
                .handle;
            let transfer = async {
                use std::io::Read;
                let mut offset = 0;
                loop {
                    check(stop)?;
                    let mut data = vec![0u8; 32768];
                    let n = entry
                        .file
                        .read(&mut data)
                        .map_err(|_| "Local upload read failed")?;
                    if n == 0 {
                        break;
                    }
                    if offset + n as u64 > entry.size {
                        return Err("Source size changed".into());
                    }
                    data.truncate(n);
                    s.raw
                        .write(handle.clone(), offset, data)
                        .await
                        .map_err(|_| "Upload write failed or acknowledgement uncertain")?;
                    offset += n as u64;
                    transferred_bytes += n as u64;
                }
                if offset != entry.size {
                    return Err("Source size changed".into());
                }
                crate::upload::revalidate(entry)?;
                Ok::<(), String>(())
            }
            .await;
            let close = s
                .raw
                .close(handle)
                .await
                .map_err(|_| "Upload close acknowledgement uncertain".to_owned());
            transfer?;
            close?;
            completed += 1;
            bytes += entry.size;
        }
        Ok::<(), String>(())
    });
    match result{Ok(())=>Ok(crate::upload::UploadOutcome{status:crate::upload::UploadStatus::Completed,completed,bytes,transferred_bytes,skipped:0,message:"Upload complete; local sources retained. Refresh destination.".into()}),Err(error) if attempted=>Ok(crate::upload::UploadOutcome{status:if stop.load(Ordering::SeqCst){crate::upload::UploadStatus::Cancelled}else{crate::upload::UploadStatus::Partial},completed,bytes,transferred_bytes,skipped:0,message:format!("{error}. Upload incomplete; new partial targets may remain. Preexisting targets were not replaced; local sources retained. Refresh before retrying.")}),Err(error)=>Err(error)}
}
