# Isolated Windows installer qualification

## Selectable-destination qualification

The manual workflow now creates four independent hosted Windows guests: success
and health-failure rollback, each at the default and a derived custom destination.
The custom path contains spaces and Japanese characters. Its controller SHA and
explicit `installer-qa <sha>` confirmation must match protected main. Native QA
authorization and outcomes bind the destination kind; no arbitrary path grants
fixture trust. Production trust/key/gates remain unchanged.

Each guest drives the actual English/Japanese language, directory and independent
shortcut controls for all four choices, exercises Back and cancellation, then
verifies installed files, registration, shortcut targets, saved choices and five
generated settings documents/backups across reinstall and uninstall. A separate
D-drive UI boundary either installs safely or must show the exact localized
refusal; unsafe roots are not repaired or bypassed. The final source installation
uses choices off/on so native update/rollback can verify independent retention.

Only validated, bounded UI PNGs and typed result JSON are retained as Actions
artifacts. Export strips PNG ancillary metadata and rejects unknown paths, keys,
captions, file types and links. Fixture binaries, ephemeral tokens, authorization,
settings and raw logs remain on the disposable guest. Screenshots and summaries
are evidence, not a substitute for installed-state assertions. A failed or
unavailable desktop is a failure, never a skipped pass.

Run [39270738277](https://github.com/nea-c/Nearly/actions/runs/39270738277),
attempt 1, qualified controller `2c459dcc40e76889850132e2e65af60adeccc0ab`
in all four conditions: default/custom destination and success/health-failure.
Its 52 cases, 48 UI reports and 484 normalized PNGs were checked against artifact
digests and strict native causal proofs. Both destinations reached target 2.0.0;
the unhealthy target cases restored and restarted source 1.9.0. English/Japanese
independent shortcut combinations, Back/cancel, reinstall, settings/backups and
uninstall passed. The D-drive boundary refused the unsafe root and cancelled;
it did not establish successful installation on another drive.

These are QA-feature builds with ephemeral keys, not a literal production-signed
r3.0-to-r3.1 installation. No setup runs on the developer PC. The checklist below
is broader than this passing run; arbitrary external destinations, path attacks,
power-loss recovery and ordinary-PC installation must not inherit qualification
from it. Historical passing runs below cover fixed-destination source.

- Exercise English and Japanese welcome, destination, independent shortcut and
  finish pages. Test Back/Next and cancellation. Confirm existing owned installs
  skip destination selection and keep the registered path.
- Install into an empty private folder outside LocalAppData, with spaces and
  Japanese characters, and repeat on a second fixed drive. Confirm registry,
  uninstaller command, application and both shortcut targets use the selected root.
- Exercise all four shortcut combinations, then reinstall/update. Saved unchecked
  choices and links manually deleted in the guest must remain absent. Test `/NS`.
- Refuse UNC/device/relative/root/stream/dot-component paths, junctions in each
  ancestor, unsafe shared-write folders, nonexistent parents and nonempty foreign
  folders. Verify refusal preserves sentinels. Do not modify guest ACLs as a setup
  workaround; use separately approved generated fixtures for permission cases.
- Refuse payload symlinks/hardlinks and attempted directory replacement during
  validation/mutation. Verify no foreign target changes and handles are released
  on cancel/failure/exit. Inspect setup's System-plugin calls at runtime.
- Upgrade an existing default-path r3.0 installation without moving it. Preserve
  all five settings documents, backups and independent shortcut choices.
- Run signed protocol3 success and health-failure rollback from a custom root.
  Verify helper/stage identity checks, registered root, current image, journal root
  binding, unchanged settings/shortcuts, restart gate and mismatch refusal.
- Uninstall from a custom root, including a nonempty settings folder. Remove only
  owned payload/links/registration; retain settings and unknown files. Refuse a
  stale/modified copied uninstaller, changed registration, links and a running
  application. Check executing-image equivalence against the registered
  uninstaller: NSIS's normal temporary copy and an identical byte-for-byte copy
  are equivalent; this is not proof of the original launch path.

Do not treat contract tests, inert NSIS compilation or unit tests as these runtime
results. No new release or production signing is performed by this QA workflow.

## Historical fixed-destination qualification

`installer-qa-windows.yml` is a manual, read-only workflow. Dispatch main with
the exact reviewed controller SHA and confirmation `installer-qa <sha>`.
Each matrix case receives a separate fresh GitHub-hosted Windows VM. It refuses
self-hosted execution, existing Nearly state, an unavailable interactive desktop,
or an unavailable WebView2 runtime. It never downloads a missing runtime, publishes
binaries/releases, accesses signing Secrets, or changes the production update gate.

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

For failed hosted cases, compile-QA-only breadcrumbs record fixed role, phase,
action and error categories in at most 64 JSON lines per process, 256 bytes per
line. Each process creates its own run-owned file without adopting an existing
file. The controller reads at most eight regular trace files and prints only
whitelisted event/code/version/PID fields. Tokens, keys, paths, settings and raw
native records are excluded. These diagnostic writes never authorize recovery
or change a failed outcome into a passing one.

Restart Manager observations use a two-second retry budget for a foreign user to
clear while an exact retained child is live or exited; Windows API calls can add
their own latency. Every poll revalidates
the pinned root and retained process; an uncertain observation fails immediately,
and a persistent foreign user still refuses recovery. File effects keep their
independent final checks. QA traces may include each of four fixed foreign-user
hints once per process (scanner, WebView, child identity mismatch, unknown).
Hints never authorize exclusions and never contain raw process/service names.

If a retained process exits between the live wait and a failed image-path query,
one wait with a one-second timeout on the same held handle allows teardown to
finish. Exit is accepted only after signaled termination, revalidated exact
creation identity and a valid exit code. A still-live query failure,
mismatching successful path, changed identity or uncertain result still refuses.
QA diagnostics include fixed failure-site and exit-race codes. This handling
does not bypass file-user, root, snapshot or mutation checks.

Default builds omit the QA module and embedded QA values. The production key is unchanged.
Production handoff activation was separately approved after run 39202794997
passed both success and health-failure rollback in fresh hosted Windows guests.
The production-enabled variant receives its own build/test validation; this
QA-feature evidence does not qualify a production install on an ordinary PC.
Passing QA alone does not authorize activation or publication. Long-duration
stability and interrupted-power recovery remain unqualified.
