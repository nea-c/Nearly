# Updater recovery in r4.4

## Scope

This change follows r4.3. Development and verification use isolated, generated fixtures rather than modifying an existing user installation.

The existing Nearly executable prepares and supervises automatic updates. Its verified old-image copy is the recovery helper. The protocol-3 NSIS installer only stages candidate files. Therefore the first automatic update from an old version still uses that old version's helper. These changes protect subsequent updates after the corrected application has been installed; publishing a corrected target alone does not retroactively replace an already-running old helper.

The current scope is practical: prepare the replacement in an update subfolder under the installation directory, switch it in one rename, and allow manual reinstall when retained recovery state cannot safely be resumed. It does not introduce a stable bootstrap executable, a version-directory layout, or automatic reconstruction after reboot.

## Replacement and retry

- Restart Manager file-use reports and enumeration errors are diagnostic hints, not global vetoes. Root, mutation lease, retained process, immutable file, signature, backup, registration and settings checks remain.
- Candidates are authenticated and flushed before switching. Previous-version backups are retained. A new transaction stages the replacement in the existing `.Nearly-update-state/<nonce>/candidate` subfolder on the same volume, then uses one native `NtSetInformationFile` call with `FileRenameInformationEx` (65) and `REPLACE_IF_EXISTS | POSIX_SEMANTICS` (3). It no longer deliberately renames Nearly.exe away before putting the replacement in its place.
- Immutable read pins permit delete sharing so the pinned old object can remain readable across replacement. This is not a bypass of every Windows lock: a strict handle denying delete sharing blocks the operation in native tests. Nor is replacement a destination-file-ID compare-and-swap. Ownership checks and the cooperating mutation lease still matter.
- Actual native sharing/lock errors receive at most six attempts with 100 ms between attempts. Access denied and generic I/O errors are not treated as transient locks. A retry requires the expected unchanged endpoints; an exact completed outcome can be recognized without repeating the mutation. Ambiguous endpoints and uncertain journal publication are never blindly replayed.
- Legacy partial transactions remain supported. Removing the intentional Nearly.exe rename gap in new transactions does not make the entire two-file/registry update atomic or turn older partial journals into completed updates.

## Launch and startup

A definite failure to create the new process automatically enters verified old-tuple restoration after bounded retry. Errors after process creation are uncertain and do not authorize rollback under an untracked child. Known partial replacement can enter reverse restoration; actual restoration locks preserve phase and intent and permit retry while the helper still owns its original capabilities.

Success remains irreversible. The child can acknowledge fresh durable success after the exact retained helper has exited, if the success event is valid, exit request is absent, and helper-image and journal proofs still pass. The automatic old-version restart's durable at-most-once marker remains. Failure after publishing that marker does not reset it; a later user-requested ordinary startup is distinct from automatic replay.

Ordinary startup waits up to about 1.9 seconds for the helper's mutex handoff before reporting a blocker. If admission remains blocked, it displays native diagnostics with a read-only admission retry; that button does not perform offline restoration. A successful manual installer releases its gate before the optional application launch.

Best-effort, append-only, bounded diagnostic logs record nonce, phase, object/substep, native lock code, retry attempt, and stop site in the owned transaction directory. Logs contain no user file contents and never supply mutation authority.

## Manual reinstall and limits

If recovery cannot proceed safely, manual reinstall is the supported practical fallback. After payload installation, registration and shortcut preferences have all succeeded, the installer archives the entire pinned `.Nearly-update-state` directory by its exact directory handle to a no-overwrite sibling. It retains the recovery evidence and settings rather than deleting or selectively rewriting the old transaction. An archive failure must not be presented as a completed recovery reset. Manual setup remains non-atomic: a later failure can leave an already written owned payload changed.

This implementation is not an arbitrary-crash recovery tool. Restarting the PC, killing the helper, losing peer proofs, or an uncertain journal write can still require manual reinstall or diagnosed repair. No offline resume is authorized by a persisted PID, a phase, or content equality alone. There is no automatic after-reboot reconstruction.

A transient sharing lock is retried. A persistent lock does not become an ownership proof. Unknown files, foreign registry values, missing unproven copies, busy controlled children and changed settings remain protected. No force-unlock, process killing, ACL weakening, elevation, or general security bypass was added.

## Verification

Pre-release local checks (the JavaScript, installer, build and selected native checks were repeated after r4.4 version preparation):

- `npm test`: 563 passed, 4 skipped, 0 failed. This includes the existing startup update/settlement, health probation and cleanup contracts.
- Frontend TypeScript/Vite build passed. Normal native test compilation and the installer-QA feature check passed; existing repository compiler warnings remain.
- Selected Windows updater suite: 172 passed, 9 ignored, 0 failed. This is the update-related selection, not a claim that every native repository test ran.
- Two explicitly selected generated-process qualifications passed: successful health completion and failed-health old-tuple restoration. The latter deliberately uses incompatible fixture settings and verifies that unsafe old-version restart remains blocked; it is not an actual installed UI restart test.
- Same-folder tests cover 48 apply and 48 restore interruption boundaries, including completed operations, live-path preservation, retained backup bytes, old open-handle identity, actual destination-open lock retry, persistent deny-delete locks, startup/helper handoff and automatic rollback after a definite launch failure.
- Installer suite: 67 passed, 9 gated skips, 0 failed. The cached NSIS compiler built installer and uninstaller successfully; neither was executed. Legacy owned registrations without a root-identity marker remain repairable; a nonempty mismatching marker remains rejected.
- Independent source review found three handoff/retry issues, all fixed and regression-tested. Final focused review found no additional actionable issues. `git diff --check` passed.

The original two-rename implementation failed the new regression with Nearly.exe absent at boundary 4. The one-step implementation passes it. These are injected process-boundary observations, not genuine reboot or power-loss tests. An ordinary legacy rename with an open destination pin failed on the tested Windows system, while the documented extended rename worked with delete-sharing pins; strict deny-delete locks still blocked it. No unsupported-operation fallback reintroduces the intentional filename gap.

The prohibited `update_recovery_windows::tests::cleanup_reparse_candidate_parent_is_refused_without_touching_external_files` was present in the unfiltered test list and absent from the selected list before execution. It was not run. Final listings, binary hash and exclusion proof are in `test-results/final-native-exclusion.json`; all build/test logs are in `test-results`.

Tests use generated files and separate fixture registry keys, not the real installation. Native dialog presentation, actual manual-reinstall repair, genuine reboot/power-loss recovery and a signed end-to-end installed update of this implementation remain untested. Release builds and signing are validated separately by the manual signed Windows workflow; publishing does not install the application.
