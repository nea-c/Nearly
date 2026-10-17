use super::codec::{self, Binding, Identity, Receipt, Root, State, MAX_ATTEMPTS, MAX_TIME_MS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    Owned,
    HandedOff,
    Installed,
    Healthy,
}
/// Implement only from independent native ownership, authenticated installer
/// outcome, and restarted-process health evidence. Receipt fields are not evidence.
/// Healthy must also establish every preceding requirement and the exact Binding.
pub trait Authority {
    fn verify(&mut self, binding: &Binding, evidence: Evidence) -> Result<(), String>;
}
pub struct DenyAll;
impl Authority for DenyAll {
    fn verify(&mut self, _: &Binding, _: Evidence) -> Result<(), String> {
        Err("Native evidence adapter is absent".into())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitError {
    NotCommitted,
    Uncertain,
    Busy,
    Stale,
}
/// An Ok commit must atomically replace and durably publish the entire receipt.
/// An adapter must report Uncertain after any possibly published failure.
/// The Windows adapter is in update_transaction and remains behind the existing
/// release-validation and signing-key gates; records alone never authorize it.
pub trait Journal {
    /// Acquire an EXCLUSIVE backing-store transaction, then compare the current
    /// receipt with expected (None requires an absent journal). Hold exclusivity
    /// until end, including across all commits and exact-handle deletion.
    /// Busy/Stale never grant a lease. This must coordinate processes, not merely
    /// one wrapper object. update_transaction implements this with a native
    /// exclusive file lease; this policy remains independent of that adapter.
    fn begin(&mut self, expected: Option<&Receipt>) -> Result<(), CommitError>;
    fn commit(&mut self, receipt: &Receipt) -> Result<(), CommitError>;
    fn end(&mut self);
}
struct Lease<'a, J: Journal>(&'a mut J);
impl<J: Journal> Journal for Lease<'_, J> {
    fn begin(&mut self, _: Option<&Receipt>) -> Result<(), CommitError> {
        Err(CommitError::Busy)
    }
    fn commit(&mut self, r: &Receipt) -> Result<(), CommitError> {
        self.0.commit(r)
    }
    fn end(&mut self) {}
}
impl<J: Journal> Drop for Lease<'_, J> {
    fn drop(&mut self) {
        self.0.end();
    }
}
#[derive(Clone, Debug)]
pub struct Observation {
    pub root: Root,
    pub root_reparse: bool,
    pub parent_reparse: bool,
    pub basename: String,
    pub file_identity: Identity,
    pub length: u64,
    pub sha256: String,
    pub regular_file: bool,
    pub links: u32,
}
#[derive(Clone, Debug)]
pub struct Absence {
    pub root: Root,
    pub root_reparse: bool,
    pub parent_reparse: bool,
}
pub struct Opened<H> {
    pub handle: H,
    pub observation: Observation,
}
#[derive(Clone, Debug)]
pub enum OpenError {
    Locked,
    Missing(Absence),
    Refused,
}
#[derive(Clone, Debug)]
pub enum DeleteError {
    Locked,
    Refused,
    Uncertain,
}
/// Open only the exact installer basename WITHIN the independently trusted
/// installation root, beside Nearly.exe. Never step up to root's parent.
/// Pin root/parent/target identities while observing; hash the opened target.
/// Keep that same object stable through delete_exact. Refuse symlinks/reparse,
/// multiple hardlinks, ambiguous identities and unsafe filesystem semantics.
/// delete_exact consumes the verified handle, NEVER a pathname.
/// Ok means the handle has closed and the exact original object is confirmed
/// absent. Delete-pending/held handles must return Locked or Uncertain, not Ok.
/// Missing must attest absence while the trusted root and its parent are pinned.
/// update_transaction provides the Windows exact-handle adapter. Production
/// construction stays disabled unless the existing release/key gates both pass.
pub trait Files {
    type Handle;
    fn open_exact(&mut self, binding: &Binding) -> Result<Opened<Self::Handle>, OpenError>;
    fn delete_exact(&mut self, handle: Self::Handle) -> Result<(), DeleteError>;
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Codec(String),
    Evidence(String),
    NotReady,
    Fenced,
    Preserve,
    Journal(CommitError),
    UncertainDelete,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Cleaned,
    AlreadyCleaned,
    Deferred { until_ms: u64 },
    RetryExhausted,
}
pub struct Lifecycle {
    receipt: Receipt,
    fenced: bool,
}
impl Lifecycle {
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    pub fn prepare(
        binding: Binding,
        authority: &mut impl Authority,
        journal: &mut impl Journal,
    ) -> Result<Self, Error> {
        codec::validate_binding(&binding).map_err(Error::Codec)?;
        journal.begin(None).map_err(Error::Journal)?;
        let mut journal = Lease(journal);
        authority
            .verify(&binding, Evidence::Owned)
            .map_err(Error::Evidence)?;
        let receipt = Receipt {
            version: 1,
            binding,
            state: State::Prepared,
            sequence: 0,
            attempts: 0,
            next_retry_ms: None,
        };
        journal.commit(&receipt).map_err(Error::Journal)?;
        Ok(Self {
            receipt,
            fenced: false,
        })
    }
    pub fn recover(bytes: &[u8]) -> Result<Self, Error> {
        Ok(Self {
            receipt: codec::decode(bytes).map_err(Error::Codec)?,
            fenced: false,
        })
    }
    fn persist(&mut self, next: Receipt, journal: &mut impl Journal) -> Result<(), Error> {
        if let Err(error) = codec::encode(&next) {
            self.fenced = true;
            return Err(Error::Codec(error));
        }
        if let Err(error) = journal.commit(&next) {
            self.fenced = true;
            return Err(Error::Journal(error));
        }
        self.receipt = next;
        Ok(())
    }
    pub fn advance(
        &mut self,
        target: State,
        authority: &mut impl Authority,
        journal: &mut impl Journal,
    ) -> Result<(), Error> {
        if self.fenced {
            return Err(Error::Fenced);
        }
        let evidence = match (self.receipt.state, target) {
            (State::Prepared, State::HandoffCommitted) => Evidence::HandedOff,
            (State::HandoffCommitted, State::InstallationSucceeded) => Evidence::Installed,
            (State::InstallationSucceeded, State::RestartHealthy)
            | (State::RestartHealthy, State::CleanupPending) => Evidence::Healthy,
            _ => return Err(Error::NotReady),
        };
        if let Err(error) = journal.begin(Some(&self.receipt)) {
            self.fenced = true;
            return Err(Error::Journal(error));
        }
        let mut journal = Lease(journal);
        authority
            .verify(&self.receipt.binding, evidence)
            .map_err(Error::Evidence)?;
        let mut next = self.receipt.clone();
        next.state = target;
        next.sequence += 1;
        self.persist(next, &mut journal)
    }
    fn root_matches(&self, root: &Root, root_reparse: bool, parent_reparse: bool) -> bool {
        !root_reparse && !parent_reparse && root == &self.receipt.binding.root
    }
    fn observation_matches(&self, value: &Observation) -> bool {
        let expected = &self.receipt.binding.installer;
        self.root_matches(&value.root, value.root_reparse, value.parent_reparse)
            && value.regular_file
            && value.links == 1
            && value.basename == expected.basename
            && value.file_identity == expected.identity
            && value.length == expected.length
            && value.sha256 == expected.sha256
    }
    fn cleaned(&mut self, journal: &mut impl Journal) -> Result<Outcome, Error> {
        let mut next = self.receipt.clone();
        next.state = State::Cleaned;
        next.sequence += 1;
        next.next_retry_ms = None;
        self.persist(next, journal)?;
        Ok(Outcome::Cleaned)
    }
    fn locked(&mut self, now_ms: u64, journal: &mut impl Journal) -> Result<Outcome, Error> {
        let mut next = self.receipt.clone();
        next.sequence += 1;
        next.attempts += 1;
        let until_ms = now_ms
            .checked_add(100u64 << (next.attempts - 1))
            .filter(|n| *n <= MAX_TIME_MS)
            .ok_or(Error::Preserve)?;
        next.next_retry_ms = if next.attempts < MAX_ATTEMPTS {
            Some(until_ms)
        } else {
            None
        };
        self.persist(next, journal)?;
        Ok(if self.receipt.attempts < MAX_ATTEMPTS {
            Outcome::Deferred { until_ms }
        } else {
            Outcome::RetryExhausted
        })
    }
    pub fn cleanup(
        &mut self,
        now_ms: u64,
        authority: &mut impl Authority,
        journal: &mut impl Journal,
        files: &mut impl Files,
    ) -> Result<Outcome, Error> {
        if self.fenced {
            return Err(Error::Fenced);
        }
        if !matches!(self.receipt.state, State::CleanupPending | State::Cleaned) {
            return Err(Error::NotReady);
        }
        // Reserve one durable pre-delete checkpoint and one completion commit.
        if self.receipt.state == State::CleanupPending && self.receipt.sequence > 62 {
            return Err(Error::Preserve);
        }
        if now_ms > MAX_TIME_MS {
            return Err(Error::Preserve);
        }
        if let Err(error) = journal.begin(Some(&self.receipt)) {
            self.fenced = true;
            return Err(Error::Journal(error));
        }
        let mut journal = Lease(journal);
        // ALWAYS re-establish independent ownership/success/health, including
        // recovered Cleaned records and deferred retries. Recovery grants nothing.
        authority
            .verify(&self.receipt.binding, Evidence::Healthy)
            .map_err(Error::Evidence)?;
        if self.receipt.attempts >= MAX_ATTEMPTS {
            return Ok(Outcome::RetryExhausted);
        }
        if let Some(until_ms) = self.receipt.next_retry_ms {
            if now_ms < until_ms {
                return Ok(Outcome::Deferred { until_ms });
            }
        }
        let opened = match files.open_exact(&self.receipt.binding) {
            Ok(opened) => opened,
            Err(OpenError::Locked) => return self.locked(now_ms, &mut journal),
            Err(OpenError::Refused) => return Err(Error::Preserve),
            Err(OpenError::Missing(proof)) => {
                if !self.root_matches(&proof.root, proof.root_reparse, proof.parent_reparse) {
                    return Err(Error::Preserve);
                }
                return if self.receipt.state == State::Cleaned {
                    Ok(Outcome::AlreadyCleaned)
                } else {
                    self.cleaned(&mut journal)
                };
            }
        };
        if self.receipt.state == State::Cleaned || !self.observation_matches(&opened.observation) {
            return Err(Error::Preserve);
        }
        // Recovered bytes do not establish that any journal durably recorded
        // intent. Require a fresh acknowledged checkpoint before EVERY delete.
        let mut checkpoint = self.receipt.clone();
        checkpoint.sequence += 1;
        self.persist(checkpoint, &mut journal)?;
        authority
            .verify(&self.receipt.binding, Evidence::Healthy)
            .map_err(Error::Evidence)?;
        match files.delete_exact(opened.handle) {
            Ok(()) => self.cleaned(&mut journal),
            Err(DeleteError::Locked) => self.locked(now_ms, &mut journal),
            Err(DeleteError::Refused) => Err(Error::Preserve),
            Err(DeleteError::Uncertain) => {
                self.fenced = true;
                Err(Error::UncertainDelete)
            }
        }
    }
}
