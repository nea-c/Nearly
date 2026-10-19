# Startup updates

The native process checks the latest stable `nea-c/Nearly` release once per launch. Draft, prerelease and beta versions are excluded. Canonical public `rX.Y` tags map to internal `X.Y.0`; numeric SemVer precedence handles multi-digit versions. Patch, prerelease and build aliases are rejected (see versioning.md). Metadata requests use HTTPS, reject redirects, and have an eight-second/128 KiB budget. Offline failures leave the app usable.

The localized Update now/Later UI, verified package staging and native handoff coordinator are implemented. **Production handoff is enabled** after explicit activation approval and isolated signed NSIS installation/rollback/restart-health QA. The fixed registered public key remains mandatory. Only a newer release with a valid matching signature and payload can be installed, after the existing global idle/settings checks. No new release is published by this change. Later is process-only; no snooze setting is saved.

## Trust and staging

Candidates require a canonical stable `rX.Y` tag with internal `<version>` equal to `X.Y.0`, exact repository URLs and exact `Nearly_rX.Y_<x64|arm64>-setup.exe` and `.sig` assets. Downloads allow at most two HTTPS redirects to GitHub's release-asset host/path. Headers and body reads support cancellation, timeouts and size limits: 256 MiB for packages, 16 KiB for signatures.

Tauri's base64 minisign document is verified with maintained ring Ed25519 and RustCrypto BLAKE2b primitives. Both file and global comment signatures must verify. Exactly one authenticated `version:`, `file:` and `payload-sha256:` must match the candidate and running payload, preventing replay and architecture relabelling. The NSIS bootstrapper is PE32/x86; its payload architecture is bound by the signed exact filename. Sign releases using the canonical public filename (for example `file:Nearly_r1.0_x64-setup.exe`), while the authenticated version field remains internal (`version:1.0.0`).

Verified bytes are saved with its authenticated canonical filename in an exclusively created random transaction directory beside the actual Nearly.exe. There is no fallback to Temp or elevation. Reparse checks, ancestor locks, native file identity and handle-based re-verification protect creation and launch. Unrelated paths are never overwritten or deleted. Downloads currently buffer the bounded package in memory.

## Shutdown and handoff

Installation reserves the whole native process and refuses active jobs, starts, connection attempts, operations, host approvals, tab transfers, pending window creation and closing windows. It never stops an active sync to update. Every window freezes interaction and acknowledges stable, successful settings write queues. Missing acknowledgments time out without closing windows. Final sealing blocks late writes and work.

Only owned transient stopped-tab contexts are removed before exit. Profiles, folder history, mappings, presets, trust, foreign records and shortcut choices remain. Launch, readiness or commit failure restores captured context against the latest settings and releases the seal. A portable copy cannot silently migrate into the registered installation.

Safe retry is narrower than settings rollback. A native launch failure can abandon
its prepared transaction only with nonce-bound proof that the installer was never
spawned. The durable Abandoned state permits a fresh verified attempt and does not
authorize deletion of recovery material. Existing journal admission precedes backup
creation. Once a child was spawned, readiness, binding, commit or uncertain failures
remain fenced; cancelling a child is not proof that it exited or cannot mutate.
No ordinary startup or renderer flag can reset an incomplete transaction.

Authenticated `updater-protocol:3` is mandatory. A verified copy of the old application starts as a restricted helper before Tauri or settings initialization. Helper readiness precedes the parent's durable binding and explicit commit. The helper waits for that exact parent to exit before acquiring the mutation lease and reloading the bound transaction. NSIS receives only native-generated helper PID, creation time and nonce; its protocol3 branch writes two candidates into the transaction directory and performs no live installation. The helper validates the candidate application and uninstaller before replacing the registered installation.

The helper owns a strict schema2, root-bound DPAPI journal. It records intent and observation for each file rename and registry mutation. Its narrow installation tuple is Nearly.exe, uninstall.exe, DisplayVersion, NearlyInternalVersion and EstimatedSize. Settings, shortcuts and unrelated registry values are preserved. A Global application mutex coordinates the new manual installer, uninstaller and helper across sessions; legacy installers and external registry writers do not participate. Registry comparison is not atomic CAS.

The new application starts under a native probation gate. Settings load and UI readiness provide an initial idle proof; they do not release the gate. The helper durably records Succeeded, sends authenticated Success and waits for SuccessAck. The child verifies the exact helper and fresh durable success before admitting normal work. Restart never restores tabs, authentication or syncs.

## Limits and release prerequisites

Pre-exit settings rollback and a conditional post-exit binary/registry inverse are implemented with the enabled production installation gate and fixed trust checks. Restoration requires exact owned file/value proofs and no unknown users. A live failed child may receive a cooperative exit request only after atomic admission sealing, idle checks and settled settings; it is never killed. Busy, unknown, timed-out or conflicting state retains recovery material for manual repair. Succeeded is irreversible. Old-version restart additionally requires fresh restoration proof, unchanged compatible actual settings and a durable at-most-once attempt. External `SYNCFILES_CONFIG_DIR` locations are unsupported by this updater.

Cleanup requires fresh native ownership and process-exit evidence; persisted flags alone never authorize it. Unknown files are retained and no wildcard cleanup is used. Offline recovery without retained live worker/helper exit proofs conservatively reports uncertainty rather than continuing or restarting. The generated tests do not establish recovery from arbitrary power loss or qualify actual NSIS execution.

Production key registration, public-key embedding and separately approved gate activation are complete. Existing r1/r2 copies lack this production trust anchor, so the first supported signed release must be installed manually. Published r3.0 uses the default registered per-user location. The r3.1 source keeps the same application identity, trust key and protocol3 contract. It resolves the owned registered location, pins its local directory chain and checks the actual running image before admitting updates. Existing installations keep their registered root; destination selection applies only to fresh installations and never relocates an existing copy. Admission remains conditional on the local NTFS, path and ownership safety checks.

The isolated hosted QA-feature success/restart and health-failure rollback results in [windows-installer-qa.md](windows-installer-qa.md) now cover both the default and a Japanese/space-containing custom destination at controller `2c459dcc40e76889850132e2e65af60adeccc0ab`. Those ephemeral signed 1.9.0-to-2.0.0 builds are not a literal production-signed r3.0-to-r3.1 installation, ordinary-PC installation, arbitrary power-loss recovery or long-duration stability qualification. See the [r3.1 notes](../.github/release-notes/r3.1.md) for the update and destination limits.

Tests use ephemeral in-memory fixture keys, an upstream minisign vector, loopback HTTP servers and harmless owned test-runner processes. NSIS is compiled without executing setup. See [the design](update-installer-design.md) and [native handoff](../src-tauri/windows/UPDATE-HANDOFF.md).

Primary sources: [Tauri updater](https://v2.tauri.app/plugin/updater/), [official signed-comment format](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-cli/src/helpers/updater_signature.rs), [minisign verifier](https://github.com/jedisct1/rust-minisign-verify), [ring Ed25519](https://docs.rs/ring/0.17.14/ring/signature/index.html).
