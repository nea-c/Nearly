//! Pure recovery planning. Observations are not native execution authority.
//! No path, process handle, cleanup permission or signing key lives here.

use serde::{Deserialize, Serialize};

pub(crate) const MAX_SEQUENCE: u32 = 64;
const MAX_RECORD: usize = 2048;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum InstallObject {
    Image,
    Uninstaller,
    DisplayVersion,
    InternalVersion,
    EstimatedSize,
}
pub(crate) const APPLY_ORDER: [InstallObject; 5] = [
    InstallObject::Image,
    InstallObject::Uninstaller,
    InstallObject::DisplayVersion,
    InstallObject::InternalVersion,
    InstallObject::EstimatedSize,
];
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum RecoveryPhase {
    Prepared,
    Armed,
    Staging,
    CandidatesVerified,
    Applying,
    AwaitingHealth,
    Succeeded,
    Restoring,
    Restored,
    ManualRepair,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum Direction {
    Apply,
    Restore,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum StepStatus {
    Intent,
    Observed,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MutationStep {
    pub object: InstallObject,
    pub direction: Direction,
    pub status: StepStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecoveryRecord {
    pub sequence: u32,
    pub phase: RecoveryPhase,
    pub step: Option<MutationStep>,
}

/// Unchanged matches both expected values (e.g. an identical EstimatedSize).
/// RecoverablePartial requires native identity/substep/backup proof; absence
/// alone must never be classified this way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObservedObject {
    Old,
    New,
    Unchanged,
    RecoverablePartial,
    Foreign,
    Uncertain,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ObservedTuple {
    pub objects: [ObservedObject; 5],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParentState {
    Waiting,
    AuthorizedExited,
    Aborted,
    Uncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkerState {
    NotStarted,
    Live,
    ExitedZero,
    ExitedNonzero,
    Uncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChildState {
    NotStarted,
    LiveUnhealthy,
    LiveHealthy,
    Exited,
    Uncertain,
}
/// Constructed by the native supervisor, never deserialized or sent by a renderer.
/// Booleans describe already checked facts, not permission to execute an action.
#[derive(Clone, Debug)]
pub(crate) struct LiveFacts {
    pub parent: ParentState,
    pub worker: WorkerState,
    pub child: ChildState,
    pub root_and_lease_verified: bool,
    pub snapshots_verified: bool,
    pub candidates_verified: bool,
    pub no_other_users: bool,
    pub failure_requested: bool,
    pub settings_compatible: bool,
    pub child_idle_and_settings_settled: bool,
    pub cooperative_exit_requested: bool,
    pub child_exit_timed_out: bool,
    pub recovery_only: bool,
    pub restored_this_session: bool,
    pub old_restart_attempted: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    Wait,
    Publish(RecoveryRecord),
    StartStaging,
    VerifyCandidates,
    Mutate {
        object: InstallObject,
        direction: Direction,
    },
    LaunchNew,
    RequestChildExit,
    RestartOld,
    Complete,
    ManualRepair,
}

pub(crate) fn validate(record: &RecoveryRecord) -> Result<(), &'static str> {
    if record.sequence > MAX_SEQUENCE {
        return Err("recovery sequence out of bounds");
    }
    if record.phase != RecoveryPhase::Prepared && record.sequence == 0 {
        return Err("recovery sequence missing");
    }
    if let Some(step) = record.step {
        if !matches!(
            (record.phase, step.direction),
            (RecoveryPhase::Applying, Direction::Apply)
                | (RecoveryPhase::Restoring, Direction::Restore)
        ) {
            return Err("invalid recovery step phase");
        }
    }
    Ok(())
}
pub(crate) fn encode(record: &RecoveryRecord) -> Result<Vec<u8>, &'static str> {
    validate(record)?;
    let bytes = serde_json::to_vec(record).map_err(|_| "invalid recovery record")?;
    if bytes.len() > MAX_RECORD {
        return Err("recovery record too large");
    }
    Ok(bytes)
}
pub(crate) fn decode(bytes: &[u8]) -> Result<RecoveryRecord, &'static str> {
    if bytes.len() > MAX_RECORD {
        return Err("recovery record too large");
    }
    let record = serde_json::from_slice(bytes).map_err(|_| "invalid recovery record")?;
    validate(&record)?;
    Ok(record)
}
fn old(value: ObservedObject) -> bool {
    matches!(value, ObservedObject::Old | ObservedObject::Unchanged)
}
fn new(value: ObservedObject) -> bool {
    matches!(value, ObservedObject::New | ObservedObject::Unchanged)
}
fn publish(
    record: &RecoveryRecord,
    phase: RecoveryPhase,
    step: Option<MutationStep>,
) -> RecoveryAction {
    let Some(sequence) = record
        .sequence
        .checked_add(1)
        .filter(|v| *v <= MAX_SEQUENCE)
    else {
        return RecoveryAction::ManualRepair;
    };
    RecoveryAction::Publish(RecoveryRecord {
        sequence,
        phase,
        step,
    })
}

/// One recommendation only. Native execution rechecks opaque authority before
/// each effect, durably records every file rename substep, and stops on failed or
/// uncertain publication/mutation. `Complete` never authorizes cleanup.
pub(crate) fn next_action(
    record: &RecoveryRecord,
    observed: &ObservedTuple,
    facts: &LiveFacts,
) -> RecoveryAction {
    use RecoveryAction as A;
    use RecoveryPhase as P;
    if validate(record).is_err() {
        return A::ManualRepair;
    }
    // Success is irreversible even if a later process/event/evidence is lost.
    if record.phase == P::Succeeded {
        return if observed.objects.iter().copied().all(new) {
            A::Complete
        } else {
            A::ManualRepair
        };
    }
    if record.phase == P::ManualRepair {
        return A::ManualRepair;
    }
    // Never perform an effect when its required observation cannot be committed.
    if record.sequence >= MAX_SEQUENCE {
        return A::ManualRepair;
    }
    if observed
        .objects
        .iter()
        .any(|v| matches!(v, ObservedObject::Foreign | ObservedObject::Uncertain))
        || !facts.root_and_lease_verified
        || !facts.snapshots_verified
        || !facts.no_other_users
        || facts.worker == WorkerState::Uncertain
        || facts.child == ChildState::Uncertain
    {
        return A::ManualRepair;
    }
    if facts.parent == ParentState::Waiting {
        return if matches!(record.phase, P::Prepared | P::Armed) {
            A::Wait
        } else {
            A::ManualRepair
        };
    }
    if facts.parent != ParentState::AuthorizedExited {
        return A::ManualRepair;
    }
    if facts.worker == WorkerState::Live {
        return if matches!(record.phase, P::Staging | P::Restoring) {
            A::Wait
        } else {
            A::ManualRepair
        };
    }
    let failed = facts.failure_requested
        || (record.phase == P::AwaitingHealth && facts.child == ChildState::Exited)
        || facts.worker == WorkerState::ExitedNonzero
        || facts.recovery_only;
    if matches!(
        facts.child,
        ChildState::LiveHealthy | ChildState::LiveUnhealthy
    ) {
        if record.phase == P::AwaitingHealth && !failed {
            return if facts.child == ChildState::LiveHealthy
                && observed.objects.iter().copied().all(new)
            {
                publish(record, P::Succeeded, None)
            } else {
                A::Wait
            };
        }
        if !matches!(record.phase, P::AwaitingHealth | P::Restoring)
            || !facts.child_idle_and_settings_settled
            || facts.child_exit_timed_out
        {
            return A::ManualRepair;
        }
        return if facts.cooperative_exit_requested {
            A::Wait
        } else {
            A::RequestChildExit
        };
    }
    if failed && !matches!(record.phase, P::Restoring | P::Restored) {
        return publish(record, P::Restoring, None);
    }
    match record.phase {
        P::Prepared => A::ManualRepair, // An unarmed record never authorizes install.
        P::Armed => publish(record, P::Staging, None),
        P::Staging => match facts.worker {
            WorkerState::NotStarted => A::StartStaging,
            WorkerState::ExitedZero => {
                if facts.candidates_verified {
                    publish(record, P::CandidatesVerified, None)
                } else {
                    A::VerifyCandidates
                }
            }
            _ => A::ManualRepair,
        },
        P::CandidatesVerified => {
            if facts.candidates_verified
                && facts.worker == WorkerState::ExitedZero
                && observed.objects.iter().copied().all(old)
            {
                publish(record, P::Applying, None)
            } else {
                A::ManualRepair
            }
        }
        P::Applying => {
            if facts.candidates_verified && facts.worker == WorkerState::ExitedZero {
                object_step(record, observed, Direction::Apply)
            } else {
                A::ManualRepair
            }
        }
        P::AwaitingHealth => {
            if observed.objects.iter().copied().all(new) {
                A::LaunchNew
            } else {
                A::ManualRepair
            }
        }
        P::Restoring => object_step(record, observed, Direction::Restore),
        P::Restored => {
            if !observed.objects.iter().copied().all(old) || !facts.settings_compatible {
                return A::ManualRepair;
            }
            if facts.recovery_only || !facts.restored_this_session || facts.old_restart_attempted {
                A::Complete
            } else {
                A::RestartOld
            }
        }
        P::Succeeded | P::ManualRepair => unreachable!(),
    }
}

fn object_step(
    record: &RecoveryRecord,
    observed: &ObservedTuple,
    direction: Direction,
) -> RecoveryAction {
    let desired = if direction == Direction::Apply {
        new
    } else {
        old
    };
    let target = if let Some(step) = record.step {
        let index = APPLY_ORDER
            .iter()
            .position(|o| *o == step.object)
            .expect("fixed enum member");
        let prior_ok = if direction == Direction::Apply {
            observed.objects[..index].iter().copied().all(new)
        } else {
            observed.objects[index + 1..].iter().copied().all(old)
        };
        if !prior_ok {
            return RecoveryAction::ManualRepair;
        }
        if direction == Direction::Apply && !observed.objects[index + 1..].iter().copied().all(old)
        {
            return RecoveryAction::ManualRepair;
        }
        if step.status == StepStatus::Intent {
            if desired(observed.objects[index]) {
                return publish(
                    record,
                    record.phase,
                    Some(MutationStep {
                        status: StepStatus::Observed,
                        ..step
                    }),
                );
            }
            return RecoveryAction::Mutate {
                object: step.object,
                direction,
            };
        }
        if !desired(observed.objects[index]) {
            return RecoveryAction::ManualRepair;
        }
        if direction == Direction::Apply {
            (index + 1..5).find(|i| !desired(observed.objects[*i]))
        } else {
            (0..index).rev().find(|i| !desired(observed.objects[*i]))
        }
    } else if direction == Direction::Apply {
        let target = (0..5).find(|i| !new(observed.objects[*i]));
        if let Some(i) = target {
            if !observed.objects[i + 1..].iter().copied().all(old) {
                return RecoveryAction::ManualRepair;
            }
        }
        target
    } else {
        (0..5).rev().find(|i| !old(observed.objects[*i]))
    };
    match target {
        Some(index) => publish(
            record,
            record.phase,
            Some(MutationStep {
                object: APPLY_ORDER[index],
                direction,
                status: StepStatus::Intent,
            }),
        ),
        None => publish(
            record,
            if direction == Direction::Apply {
                RecoveryPhase::AwaitingHealth
            } else {
                RecoveryPhase::Restored
            },
            None,
        ),
    }
}

#[cfg(test)]
#[path = "update_recovery_tests.rs"]
mod tests;
