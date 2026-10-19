# Native update handoff

Production handoff is enabled after separate activation approval. The fixed
registered public key and all protocol3 admission checks remain mandatory.
Hosted QA-feature installation, restart and rollback evidence is recorded in
windows-installer-qa.md; it does not qualify an ordinary-PC production installation.

The coordinator retains the verified sibling installer and ancestor locks,
seals global work admission and settles settings. Only the fixed registered
LocalAppData/Nearly installation with adjacent settings is supported. A portable
D: copy or external SYNCFILES_CONFIG_DIR cannot silently switch installations.

A verified immutable old-image copy dispatches as a restricted helper before
Tauri, settings initialization or ordinary single-instance handling. It signals
Ready without holding the mutation lease. The parent durably binds Armed under
the lease, releases it, signals Commit and exits. The helper waits for that exact
retained parent identity to exit, acquires the lease and reloads the bound record.
Cancellation is not proof of child exit. No process is forcibly terminated.

The signed package must authenticate exactly one updater-protocol:3 field.
The NSIS worker accepts only fixed canonical helper PID, creation FILETIME and
nonce arguments. Worker-specific authorization events bind its exact PID and
creation time. Its bounded stage branch writes candidate Nearly.exe and
uninstall.exe into the exclusive transaction directory, with no live files,
registration, shortcuts, settings or restart effects. The helper verifies both
candidates before applying them.

The helper is the sole schema2 root-bound DPAPI journal writer. It records intent
and observation for each file rename and for the three raw registry values
DisplayVersion, NearlyInternalVersion and EstimatedSize. Together with Nearly.exe
and uninstall.exe these form the narrow installation tuple. New cooperating
manual installers, uninstallers and helpers share the Global application mutation
mutex across sessions. Legacy installers and external registry writers do not;
registry comparison is not atomic CAS.

New application health runs behind a native probation gate. Initial settings/UI
readiness supplies an idle proof, not permission to connect or write. The helper
publishes durable Succeeded and sends Success; the child verifies the exact live
helper and fresh success, sends SuccessAck and releases admission. Durable success
is irreversible even if a subsequent acknowledgment or process is lost.

On failure, restoration requires exact owned objects and no conflicting users.
A live child can receive cooperative exit only after atomic admission sealing,
idle checks and settings settlement. Busy, unknown or timed-out child state
requires manual repair. Settings and shortcuts are never restored. Old restart
requires a fresh consumed restoration proof, unchanged compatible actual settings
and a durable at-most-once attempt. Offline recovery without retained live exit
proofs reports uncertainty rather than inferring safety from persisted flags.
Cleanup likewise requires fresh native proofs and never uses wildcard deletion.

Tests use generated owned files, isolated registry keys and harmless copied test
children. Source interpreters and cached NSIS compilation do not execute setup.
Hosted isolated Windows run 39202794997 passed signed setup/reinstall/uninstall,
settings and shortcut preservation, and QA-feature success/health-failure rollback.
The production-enabled variant is validated separately without local execution.
Power interruption and long-duration stability remain unqualified. Key creation,
ACL changes, secret registration and release publication require separate approval.
