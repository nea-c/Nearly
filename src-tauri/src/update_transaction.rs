//! Native protected updater transaction records and exact-object cleanup.
//! DPAPI protects offline/corrupt records, not arbitrary code running as this
//! user. Recovered metadata NEVER attests installer success or process health.
//! Production construction is gated by the existing release gate and key.
use crate::update_cleanup::{codec, engine};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) const MAX_RECORD: usize = 32 * 1024;
pub(crate) const MAX_SEALED_RECORD: usize = 64 * 1024;
const MAX_SIGNATURE: usize = 16 * 1024;
pub(crate) const STATE_DIRECTORY: &str = ".Nearly-update-state";

#[derive(Debug)]
pub(crate) enum Error {
    Disabled,
    Invalid,
    Unsafe,
    Busy,
    Missing,
    Io,
    Protection,
    Uncertain,
}
pub(crate) type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProcessIdentity {
    pub(crate) pid: u32,
    pub(crate) created: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImageBackup {
    pub(crate) basename: String,
    pub(crate) identity: codec::Identity,
    pub(crate) source_identity: codec::Identity,
    pub(crate) length: u64,
    pub(crate) sha256: String,
    pub(crate) source_version: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct TransactionRecord {
    pub(crate) schema_version: u8,
    pub(crate) receipt: codec::Receipt,
    pub(crate) package_signature: String,
    pub(crate) payload_sha256: String,
    pub(crate) old_image: ImageBackup,
    pub(crate) installer_process: Option<ProcessIdentity>,
    pub(crate) restart_process: Option<ProcessIdentity>,
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl TransactionRecord {
    pub(crate) fn validate(&self) -> Result<()> {
        codec::encode(&self.receipt).map_err(|_| Error::Invalid)?;
        let b = &self.receipt.binding;
        if self.schema_version != 1
            || !lower_hex(&self.payload_sha256, 64)
            || self.package_signature.is_empty()
            || self.package_signature.len() > MAX_SIGNATURE
            || !self
                .package_signature
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"+/=\r\n".contains(&c))
            || self.old_image.basename
                != format!(
                    "Nearly-update-{}-{}-previous.exe",
                    b.release.internal_version, b.nonce
                )
            || !lower_hex(&self.old_image.sha256, 64)
            || !lower_hex(&self.old_image.identity.file_id, 32)
            || !lower_hex(&self.old_image.source_identity.file_id, 32)
            || self.old_image.length == 0
            || self.old_image.length > crate::update_package::MAX_PACKAGE as u64
            || crate::version::release_version(&format!(
                "r{}",
                self.old_image
                    .source_version
                    .strip_suffix(".0")
                    .ok_or(Error::Invalid)?
            ))
            .is_none()
            || [&self.installer_process, &self.restart_process]
                .iter()
                .any(|p| p.as_ref().is_some_and(|p| p.pid == 0 || p.created == 0))
        {
            return Err(Error::Invalid);
        }
        if sha256(self.package_signature.as_bytes()) != b.release.signature_proof_digest {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub(crate) fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let b = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if b.len() > MAX_RECORD {
            return Err(Error::Invalid);
        }
        Ok(b)
    }
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_RECORD {
            return Err(Error::Invalid);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        value.validate()?;
        Ok(value)
    }
}
pub(crate) fn sha256(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) struct ContextInner {
    root_path: PathBuf,
    root: codec::Root,
    image: File,
    image_identity: codec::Identity,
    image_length: u64,
    image_sha256: String,
    _directories: Vec<File>,
}
#[derive(Clone)]
pub(crate) struct NativeContext(Arc<ContextInner>);
impl NativeContext {
    #[cfg(all(test, windows))]
    pub(crate) fn fixture_context(root: &Path) -> Result<Self> {
        if !root.starts_with(std::env::temp_dir())
            || !root
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with("nearly-"))
        {
            return Err(Error::Unsafe);
        }
        windows_impl::capture(root)
    }
    pub(crate) fn capture_current_install() -> Result<Self> {
        if !crate::update_handoff::HANDOFF_RELEASE_VALIDATED
            || crate::update_package::production_key().is_none()
        {
            return Err(Error::Disabled);
        }
        #[cfg(windows)]
        {
            let installed =
                crate::update_handoff::installed_executable().map_err(|_| Error::Unsafe)?;
            let current = std::env::current_exe().map_err(|_| Error::Io)?;
            if dunce::canonicalize(&installed).map_err(|_| Error::Io)?
                != dunce::canonicalize(current).map_err(|_| Error::Io)?
            {
                return Err(Error::Unsafe);
            }
            windows_impl::capture(installed.parent().ok_or(Error::Unsafe)?)
        }
        #[cfg(not(windows))]
        {
            Err(Error::Disabled)
        }
    }
    pub(crate) fn root(&self) -> &codec::Root {
        &self.0.root
    }
    pub(crate) fn installed_image_sha256(&self) -> &str {
        &self.0.image_sha256
    }
    pub(crate) fn root_path(&self) -> &Path {
        &self.0.root_path
    }
}

/// These facts must come from retained native process handles, authenticated
/// package re-verification and current-process native health. Persisted hints
/// (even valid DPAPI hints) cannot implement any of these requirements alone.
pub(crate) trait NativeEvidence {
    fn verify(
        &mut self,
        context: &NativeContext,
        record: &TransactionRecord,
        evidence: engine::Evidence,
    ) -> std::result::Result<(), String>;
}
pub(crate) struct DenyNativeEvidence;
impl NativeEvidence for DenyNativeEvidence {
    fn verify(
        &mut self,
        _: &NativeContext,
        _: &TransactionRecord,
        _: engine::Evidence,
    ) -> std::result::Result<(), String> {
        Err("Live installer and restart-health evidence is absent".into())
    }
}
pub(crate) struct EvidenceAdapter<'a, E: NativeEvidence> {
    pub(crate) context: &'a NativeContext,
    pub(crate) record: &'a TransactionRecord,
    pub(crate) native: &'a mut E,
}
impl<E: NativeEvidence> engine::Authority for EvidenceAdapter<'_, E> {
    fn verify(
        &mut self,
        binding: &codec::Binding,
        evidence: engine::Evidence,
    ) -> std::result::Result<(), String> {
        if binding != &self.record.receipt.binding || &binding.root != self.context.root() {
            return Err("Transaction/native root binding mismatch".into());
        }
        self.native.verify(self.context, self.record, evidence)
    }
}

#[cfg(windows)]
#[path = "update_transaction_windows.rs"]
mod windows_impl;
#[cfg(windows)]
pub(crate) use windows_impl::{
    authenticate_record, verify_running_payload, prepare_transaction, NativeFiles, TransactionStore,
};
#[cfg(all(test, windows))]
#[path = "update_transaction_tests.rs"]
mod tests;
