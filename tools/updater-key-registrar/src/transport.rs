//! Fixed-target HTTPS adapter. No constructor performs network requests.
use crate::{Api, ENV, NAMES, REPO};
use std::{io::Read, time::Duration};
use zeroize::Zeroizing;
pub fn endpoint(path: &str, write: bool) -> Result<String, &'static str> {
    let allowed = if write {
        NAMES
            .iter()
            .any(|name| path == format!("{ENV}/secrets/{name}"))
    } else {
        [
            "/user".into(),
            REPO.into(),
            format!("{REPO}/branches/main/protection"),
            ENV.into(),
            format!("{ENV}/deployment-branch-policies?per_page=100"),
            format!("{REPO}/actions/secrets?per_page=100"),
            format!("{ENV}/secrets?per_page=100"),
            format!("{ENV}/secrets/public-key"),
        ]
        .iter()
        .any(|p| p == path)
    };
    if !allowed {
        return Err("endpoint rejected");
    }
    Ok(format!("https://api.github.com{path}"))
}
pub fn bounded_json(reader: impl Read) -> Result<serde_json::Value, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(262145)
        .read_to_end(&mut bytes)
        .map_err(|_| "metadata read failed")?;
    if bytes.len() > 262144 {
        return Err("metadata exceeds limit");
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid metadata response")
}
pub struct GitHubApi {
    client: reqwest::blocking::Client,
    token: Zeroizing<String>,
}
impl GitHubApi {
    pub fn new(token: Zeroizing<String>) -> Result<Self, &'static str> {
        if token.is_empty() || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("invalid credential input");
        }
        // reqwest's no-provider feature requires explicit in-process setup.
        // Enabling rustls's ring Cargo feature alone does not register it.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .http1_only()
            .pool_max_idle_per_host(0)
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "HTTPS initialization failed")?;
        Ok(Self { client, token })
    }
    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::blocking::RequestBuilder, &'static str> {
        let url = endpoint(path, method == reqwest::Method::PUT)?;
        let bearer = Zeroizing::new(format!("Bearer {}", self.token.as_str()));
        let mut auth = reqwest::header::HeaderValue::from_str(&bearer)
            .map_err(|_| "invalid credential input")?;
        auth.set_sensitive(true);
        Ok(self
            .client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, auth)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2026-03-10")
            .header("User-Agent", "Nearly-key-registrar"))
    }
}
impl Api for GitHubApi {
    fn get(&mut self, path: &str) -> Result<serde_json::Value, &'static str> {
        let response = self
            .request(reqwest::Method::GET, path)?
            .send()
            .map_err(|_| "metadata request failed")?;
        if response.status().as_u16() != 200 {
            return Err("metadata response rejected");
        }
        bounded_json(response)
    }
    fn put(&mut self, path: &str, body: &str) -> Result<u16, &'static str> {
        if body.len() > 65536 {
            return Err("request body exceeds limit");
        }
        // Owned request copies contain only sealed ciphertext, never plaintext.
        let response = self
            .request(reqwest::Method::PUT, path)?
            .header("Content-Type", "application/json")
            .body(body.to_owned())
            .send()
            .map_err(|_| "write outcome uncertain")?;
        // Do not read/log a write-response body. No retry, even for 5xx/timeout.
        Ok(response.status().as_u16())
    }
}
