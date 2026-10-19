# Isolated Windows installer qualification

`installer-qa-windows.yml` is a manual, read-only workflow. Dispatch main with
the exact reviewed controller SHA and confirmation `installer-qa <sha>`.
Each matrix case receives a separate fresh GitHub-hosted Windows VM. It refuses
self-hosted execution, existing Nearly state, an unavailable interactive desktop,
or an unavailable WebView2 runtime. It never downloads a missing runtime, publishes
binaries/releases, accesses signing Secrets, or enables the production update gate.

The historical signed production setup is pinned to run 39185149137, attempt 1,
commit b56f01ddff9698ef316dfa775c1e8a441965674f and artifact 12158897824.
The controller checks GitHub provenance, ZIP/manifest/package hashes, and the
registered fixed public key. Expired or missing artifacts fail without fallback.
Ordinary setup/reinstall/uninstall checks all four shortcut choices and preserves
five generated offline settings documents and backups.

For native update qualification, isolated source copies build versions 1.9.0 and
2.0.0 with the opt-in `installer-qa` Cargo feature. A per-run Ed25519 private key
exists only in the Node signer closure. Only its public key, a run token, and the
controller SHA are compiled into these disposable binaries. Startup refuses
missing/mismatched hosted context before helper dispatch. The native fixture
route accepts only bounded local files in the exact run directory and launches
the ordinary signed staging, settings barrier, native helper, installation,
restart-health and recovery code. It adds no renderer-controlled URL/path/key.

The success case requires native health success. The health-failure case
deliberately withholds the target UI-health acknowledgement while retaining
cooperative shutdown, then requires authenticated protocol3 restoration and
real source frontend bootstrap. The guest independently verifies installed
payload hashes, versions, registration, shortcuts, settings and backups, closes
the real frontend, and uninstalls. Outcome files are atomically published and
cannot themselves establish a passing installation.

Two shared correctness fixes are exercised: staging uses the canonical signed
asset name required by recovery, and ordinary startup observes protocol3 state
instead of opening the legacy protocol2 store. Canonical staging uses exclusive
creation and pinned file/ancestor handles; an existing package is preserved and
causes a closed failure. Retained files are never overwritten or broadly cleaned.

Default builds omit the QA module and embedded QA values. The production key and
`HANDOFF_RELEASE_VALIDATED=false` remain unchanged. Passing this workflow is not
authorization to enable production updates or publish QA fixtures. Local unit
tests and compilation do not qualify real installation, restart, or rollback;
only completed hosted cases establish those results, and do not establish
long-duration stability or interrupted-power recovery.
