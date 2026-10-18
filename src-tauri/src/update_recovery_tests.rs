use super::*;

fn record(phase: RecoveryPhase) -> RecoveryRecord {
    RecoveryRecord {
        sequence: 1,
        phase,
        step: None,
    }
}
fn facts() -> LiveFacts {
    LiveFacts {
        parent: ParentState::AuthorizedExited,
        worker: WorkerState::ExitedZero,
        child: ChildState::NotStarted,
        root_and_lease_verified: true,
        snapshots_verified: true,
        candidates_verified: true,
        no_other_users: true,
        failure_requested: false,
        settings_compatible: true,
        child_idle_and_settings_settled: true,
        cooperative_exit_requested: false,
        child_exit_timed_out: false,
        recovery_only: false,
        restored_this_session: false,
        old_restart_attempted: false,
    }
}
fn tuple(value: ObservedObject) -> ObservedTuple {
    ObservedTuple {
        objects: [value; 5],
    }
}

#[test]
fn apply_effect_requires_durable_intent_and_observation_before_progress() {
    let f = facts();
    let old = tuple(ObservedObject::Old);
    let RecoveryAction::Publish(intent) = next_action(&record(RecoveryPhase::Applying), &old, &f)
    else {
        panic!("intent required")
    };
    assert_eq!(
        intent.step,
        Some(MutationStep {
            object: InstallObject::Image,
            direction: Direction::Apply,
            status: StepStatus::Intent
        })
    );
    assert_eq!(
        next_action(&intent, &old, &f),
        RecoveryAction::Mutate {
            object: InstallObject::Image,
            direction: Direction::Apply
        }
    );
    let mut after = old;
    after.objects[0] = ObservedObject::New;
    let RecoveryAction::Publish(observed) = next_action(&intent, &after, &f) else {
        panic!("observe required")
    };
    assert_eq!(observed.step.unwrap().status, StepStatus::Observed);
    let RecoveryAction::Publish(next) = next_action(&observed, &after, &f) else {
        panic!("next intent required")
    };
    assert_eq!(next.step.unwrap().object, InstallObject::Uninstaller);
}

#[test]
fn failure_after_each_apply_object_restores_exact_reverse_order() {
    for changed in 1..=5 {
        let mut objects = [ObservedObject::Old; 5];
        objects[..changed].fill(ObservedObject::New);
        let observed = ObservedTuple { objects };
        let mut f = facts();
        f.failure_requested = true;
        let RecoveryAction::Publish(restoring) =
            next_action(&record(RecoveryPhase::Applying), &observed, &f)
        else {
            panic!("restore entry")
        };
        assert_eq!(restoring.phase, RecoveryPhase::Restoring);
        let RecoveryAction::Publish(intent) = next_action(&restoring, &observed, &f) else {
            panic!("reverse intent")
        };
        assert_eq!(intent.step.unwrap().object, APPLY_ORDER[changed - 1]);
        assert_eq!(
            next_action(&intent, &observed, &f),
            RecoveryAction::Mutate {
                object: APPLY_ORDER[changed - 1],
                direction: Direction::Restore
            }
        );
    }
}

#[test]
fn live_child_is_never_restored_or_closed_while_busy_and_exit_is_bounded() {
    let mut f = facts();
    f.child = ChildState::LiveUnhealthy;
    f.failure_requested = true;
    assert_eq!(
        next_action(
            &record(RecoveryPhase::AwaitingHealth),
            &tuple(ObservedObject::New),
            &f
        ),
        RecoveryAction::RequestChildExit
    );
    f.cooperative_exit_requested = true;
    assert_eq!(
        next_action(
            &record(RecoveryPhase::AwaitingHealth),
            &tuple(ObservedObject::New),
            &f
        ),
        RecoveryAction::Wait
    );
    f.child_exit_timed_out = true;
    assert_eq!(
        next_action(
            &record(RecoveryPhase::AwaitingHealth),
            &tuple(ObservedObject::New),
            &f
        ),
        RecoveryAction::ManualRepair
    );
    f.child_exit_timed_out = false;
    f.cooperative_exit_requested = false;
    f.child_idle_and_settings_settled = false;
    assert_eq!(
        next_action(
            &record(RecoveryPhase::AwaitingHealth),
            &tuple(ObservedObject::New),
            &f
        ),
        RecoveryAction::ManualRepair
    );
}

#[test]
fn durable_success_never_rolls_back_even_after_health_or_evidence_loss() {
    let mut f = facts();
    f.failure_requested = true;
    f.recovery_only = true;
    f.child = ChildState::Uncertain;
    f.root_and_lease_verified = false;
    let action = next_action(
        &record(RecoveryPhase::Succeeded),
        &tuple(ObservedObject::New),
        &f,
    );
    assert!(!matches!(
        action,
        RecoveryAction::Mutate { .. } | RecoveryAction::RestartOld | RecoveryAction::Publish(_)
    ));
}

#[test]
fn offline_or_changed_settings_never_restart_previous_app() {
    let mut f = facts();
    f.restored_this_session = true;
    let r = record(RecoveryPhase::Restored);
    let old = tuple(ObservedObject::Old);
    assert_eq!(next_action(&r, &old, &f), RecoveryAction::RestartOld);
    f.recovery_only = true;
    assert_ne!(next_action(&r, &old, &f), RecoveryAction::RestartOld);
    f.recovery_only = false;
    f.settings_compatible = false;
    assert_eq!(next_action(&r, &old, &f), RecoveryAction::ManualRepair);
    f.settings_compatible = true;
    f.old_restart_attempted = true;
    assert_eq!(next_action(&r, &old, &f), RecoveryAction::Complete);
}

#[test]
fn foreign_or_uncertain_objects_and_missing_native_authority_never_mutate() {
    for bad in [ObservedObject::Foreign, ObservedObject::Uncertain] {
        for index in 0..5 {
            let mut t = tuple(ObservedObject::Old);
            t.objects[index] = bad;
            assert_eq!(
                next_action(&record(RecoveryPhase::Restoring), &t, &facts()),
                RecoveryAction::ManualRepair
            );
        }
    }
    for guard in 0..3 {
        let mut f = facts();
        match guard {
            0 => f.root_and_lease_verified = false,
            1 => f.snapshots_verified = false,
            _ => f.no_other_users = false,
        }
        assert_eq!(
            next_action(
                &record(RecoveryPhase::Applying),
                &tuple(ObservedObject::Old),
                &f
            ),
            RecoveryAction::ManualRepair
        );
    }
}

#[test]
fn unchanged_values_can_finish_without_rewriting_and_partial_objects_need_intent() {
    let mut t = tuple(ObservedObject::New);
    t.objects[4] = ObservedObject::Unchanged;
    let RecoveryAction::Publish(done) = next_action(&record(RecoveryPhase::Applying), &t, &facts())
    else {
        panic!("all desired")
    };
    assert_eq!(done.phase, RecoveryPhase::AwaitingHealth);
    let mut t = tuple(ObservedObject::Old);
    t.objects[0] = ObservedObject::RecoverablePartial;
    let RecoveryAction::Publish(intent) =
        next_action(&record(RecoveryPhase::Restoring), &t, &facts())
    else {
        panic!("partial restore intent")
    };
    assert_eq!(
        next_action(&intent, &t, &facts()),
        RecoveryAction::Mutate {
            object: InstallObject::Image,
            direction: Direction::Restore
        }
    );
}

#[test]
fn strict_codec_refuses_unknown_duplicate_fields_wrong_step_and_exhaustion() {
    let bytes = encode(&record(RecoveryPhase::Prepared)).unwrap();
    assert_eq!(decode(&bytes).unwrap(), record(RecoveryPhase::Prepared));
    assert!(decode(br#"{"sequence":1,"phase":"Prepared","step":null,"extra":1}"#).is_err());
    assert!(decode(br#"{"sequence":1,"sequence":2,"phase":"Prepared","step":null}"#).is_err());
    let mut exhausted = record(RecoveryPhase::Applying);
    exhausted.sequence = MAX_SEQUENCE;
    assert_eq!(
        next_action(&exhausted, &tuple(ObservedObject::Old), &facts()),
        RecoveryAction::ManualRepair
    );
    exhausted.step = Some(MutationStep {
        object: InstallObject::Image,
        direction: Direction::Apply,
        status: StepStatus::Intent,
    });
    assert_eq!(
        next_action(&exhausted, &tuple(ObservedObject::Old), &facts()),
        RecoveryAction::ManualRepair,
        "no effect when its observation cannot be published"
    );
    let wrong = RecoveryRecord {
        sequence: 1,
        phase: RecoveryPhase::Applying,
        step: Some(MutationStep {
            object: InstallObject::Image,
            direction: Direction::Restore,
            status: StepStatus::Intent,
        }),
    };
    assert!(encode(&wrong).is_err());
}

#[test]
fn every_apply_checkpoint_failure_reaches_old_tuple_without_forward_effects() {
    // Interrupt before/after intent, effect, and observation for all five objects.
    let mut r = record(RecoveryPhase::Applying);
    let mut observed = tuple(ObservedObject::Old);
    let f = facts();
    let mut checkpoints = Vec::new();
    for _ in 0..40 {
        checkpoints.push((r.clone(), observed.clone()));
        match next_action(&r, &observed, &f) {
            RecoveryAction::Publish(next) => {
                r = next;
            }
            RecoveryAction::Mutate {
                object,
                direction: Direction::Apply,
            } => {
                observed.objects[APPLY_ORDER.iter().position(|o| *o == object).unwrap()] =
                    ObservedObject::New;
            }
            RecoveryAction::LaunchNew => break,
            other => panic!("unexpected forward action {other:?}"),
        }
    }
    assert_eq!(r.phase, RecoveryPhase::AwaitingHealth);
    for (mut r, mut observed) in checkpoints {
        let mut f = facts();
        f.failure_requested = true;
        for iteration in 0..40 {
            match next_action(&r, &observed, &f) {
                RecoveryAction::Publish(next) => r = next,
                RecoveryAction::Mutate {
                    object,
                    direction: Direction::Restore,
                } => {
                    observed.objects[APPLY_ORDER.iter().position(|o| *o == object).unwrap()] =
                        ObservedObject::Old;
                }
                RecoveryAction::Complete => {
                    assert_eq!(observed, tuple(ObservedObject::Old));
                    assert_eq!(r.phase, RecoveryPhase::Restored);
                    break;
                }
                other => panic!("unsafe or nonfinite restore {other:?}, iteration {iteration}"),
            }
            assert!(iteration < 39, "recovery must terminate");
        }
    }
}

#[test]
fn preparation_staging_and_health_require_actual_peer_outcomes() {
    let old = tuple(ObservedObject::Old);
    let mut f = facts();
    f.parent = ParentState::Waiting;
    assert_eq!(
        next_action(&record(RecoveryPhase::Armed), &old, &f),
        RecoveryAction::Wait
    );
    f.parent = ParentState::Aborted;
    assert_eq!(
        next_action(&record(RecoveryPhase::Armed), &old, &f),
        RecoveryAction::ManualRepair
    );
    f.parent = ParentState::AuthorizedExited;
    f.worker = WorkerState::NotStarted;
    assert_eq!(
        next_action(&record(RecoveryPhase::Staging), &old, &f),
        RecoveryAction::StartStaging
    );
    f.worker = WorkerState::Live;
    f.failure_requested = true;
    assert_eq!(
        next_action(&record(RecoveryPhase::Staging), &old, &f),
        RecoveryAction::Wait
    );
    f.worker = WorkerState::ExitedZero;
    f.failure_requested = false;
    f.candidates_verified = false;
    assert_eq!(
        next_action(&record(RecoveryPhase::Staging), &old, &f),
        RecoveryAction::VerifyCandidates
    );
    f.candidates_verified = true;
    f.child = ChildState::LiveHealthy;
    let RecoveryAction::Publish(success) = next_action(
        &record(RecoveryPhase::AwaitingHealth),
        &tuple(ObservedObject::New),
        &f,
    ) else {
        panic!("publish success before cleanup/unblock")
    };
    assert_eq!(success.phase, RecoveryPhase::Succeeded);
}
