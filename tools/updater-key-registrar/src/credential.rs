//! Existing Git credential only; invoke and fully join BEFORE any key generation.
use zeroize::Zeroizing;
pub struct Credential(Zeroizing<String>);
impl Credential {
    pub fn into_api(self) -> Result<crate::transport::GitHubApi, &'static str> {
        crate::transport::GitHubApi::new(self.0)
    }
}
pub fn parse(bytes: &[u8]) -> Result<Credential, &'static str> {
    if bytes.len() > 65536 {
        return Err("credential response exceeds limit");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid credential response")?;
    let (mut protocol, mut host, mut password) = (None, None, None);
    for line in text.lines().filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once('=').ok_or("invalid credential response")?;
        let target = match name {
            "protocol" => Some(&mut protocol),
            "host" => Some(&mut host),
            "password" => Some(&mut password),
            _ => None,
        };
        if let Some(target) = target {
            if target.replace(value).is_some() {
                return Err("duplicate credential field");
            }
        }
    }
    if protocol != Some("https") || host != Some("github.com") {
        return Err("credential host mismatch");
    }
    let password = password
        .filter(|s| !s.is_empty() && s.len() <= 4096 && s.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or("invalid credential response")?;
    Ok(Credential(Zeroizing::new(password.to_owned())))
}
#[cfg(not(windows))]
pub fn existing() -> Result<Credential, &'static str> {
    Err("Windows credential source required")
}
#[cfg(windows)]
pub fn existing() -> Result<Credential, &'static str> {
    use std::{
        io::{Read, Write},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let mut command = Command::new(r"C:\Program Files\Git\cmd\git.exe");
    command
        .args(["credential", "fill"])
        .current_dir(r"D:\Codex\Nearly")
        .env_clear();
    for name in [
        "SystemRoot",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "PATH",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "credential source unavailable")?;
    let written = child
        .stdin
        .take()
        .ok_or("credential input unavailable")?
        .write_all(b"protocol=https\nhost=github.com\n\n");
    if written.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("credential input failed");
    }
    let stdout = child.stdout.take().ok_or("credential output unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Zeroizing::new(Vec::new());
        stdout
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| "credential read failed")?;
        if bytes.len() > 65536 {
            return Err("credential output exceeds limit");
        }
        Ok(bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("credential source did not finish");
            }
        }
    };
    let bytes = reader.join().map_err(|_| "credential read failed")??;
    if !status?.success() {
        return Err("credential source unavailable");
    }
    parse(&bytes)
}
