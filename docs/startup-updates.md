# Startup updates

The native process checks the latest stable `nea-c/Nearly` release once per launch. Draft, prerelease and beta versions are excluded. Canonical public `rX.Y` tags map to internal `X.Y.0`; numeric SemVer precedence handles multi-digit versions. Patch, prerelease and build aliases are rejected (see versioning.md). Metadata requests use HTTPS, reject redirects, and have an eight-second/128 KiB budget. Offline failures leave the app usable.

The localized Update now/Later UI, verified package staging and native handoff coordinator are implemented. **Self-update remains disabled in this build:** `production_key()` returns None and `HANDOFF_RELEASE_VALIDATED` is false. A newer release shows a clear signing explanation with Update now disabled. Install IPC rejects these missing prerequisites before settings changes or process launch. Later is process-only; no snooze setting is saved.

## Trust and staging

Candidates require a canonical stable `rX.Y` tag with internal `<version>` equal to `X.Y.0`, exact repository URLs and exact `Nearly_rX.Y_<x64|arm64>-setup.exe` and `.sig` assets. Downloads allow at most two HTTPS redirects to GitHub's release-asset host/path. Headers and body reads support cancellation, timeouts and size limits: 256 MiB for packages, 16 KiB for signatures.

Tauri's base64 minisign document is verified with maintained ring Ed25519 and RustCrypto BLAKE2b primitives. Both file and global comment signatures must verify. Exactly one authenticated `version:`, `file:` and `payload-sha256:` must match the candidate and running payload, preventing replay and architecture relabelling. The NSIS bootstrapper is PE32/x86; its payload architecture is bound by the signed exact filename. Sign releases using the canonical public filename (for example `file:Nearly_r1.0_x64-setup.exe`), while the authenticated version field remains internal (`version:1.0.0`).

Verified bytes are saved under a random, exclusively created sibling name beside the actual Nearly.exe. There is no fallback to Temp or elevation. Reparse checks, ancestor locks, native file identity and handle-based re-verification protect creation and launch. Unrelated paths are never overwritten or deleted. Downloads currently buffer the bounded package in memory.

## Shutdown and handoff

Installation reserves the whole native process and refuses active jobs, starts, connection attempts, operations, host approvals, tab transfers, pending window creation and closing windows. It never stops an active sync to update. Every window freezes interaction and acknowledges stable, successful settings write queues. Missing acknowledgments time out without closing windows. Final sealing blocks late writes and work.

Only owned transient stopped-tab contexts are removed before exit. Profiles, folder history, mappings, presets, trust, foreign records and shortcut choices remain. Launch, readiness or commit failure restores captured context against the latest settings and releases the seal. A portable copy cannot silently migrate into the registered installation.

The installer receives only native-generated PID, creation time and a strict 32-character nonce through the version 2 protocol. NSIS opens cancellation and commit handles before READY, waits up to 60 seconds for the exact parent without killing, checks cancellation before mutation, and requires explicit commit after parent exit. Native readiness wait is ten seconds. Timeout and pre-commit crashes fail closed. After commit, a crash may continue the already-authorized installation. After replacement, NSIS starts the new application with the nonce and waits for native settings loading plus main UI readiness. The restarted app reauthenticates the signed running payload and exact live installer, signals health, then requires that same installer to exit with code zero before cleanup. Restart never restores tabs, authentication or syncs.

## Limits and release prerequisites

Pre-exit settings rollback is implemented and tested. Native restart health and bounded cleanup are now connected behind both disabled production gates. **Automatic post-exit binary or registry rollback is not implemented.** Missing evidence, process failure, timeout, or exhausted cleanup retries retain the installer and previous application and show RecoveryRequired. Interrupted installation may require manual repair using a trusted setup. No journal flag alone authorizes cleanup.

A fully authenticated healthy restart followed by exact installer exit zero permits deletion of only that transaction’s nonce-named setup file, using the same verified native handle and at most three attempts. The previous executable backup remains. Cancellation and ordinary pre-handoff failures delete only handle-owned staging files. A failed read-only reopen can leave a file rather than risk deleting an unknown replacement. There is no wildcard cleanup.

Before production enablement: separately approve signing-key creation/storage; embed the reviewed public key; produce compatible signed stable artifacts; validate actual install, cancellation, upgrade, uninstall, interrupted recovery, settings/shortcuts and restart health in disposable Windows; then review the release-validation gate. No production key, ACL change, host installation, Git push or Release publication occurred here.

Tests use ephemeral in-memory fixture keys, an upstream minisign vector, loopback HTTP servers and harmless owned test-runner processes. NSIS is compiled without executing setup. See [the design](update-installer-design.md) and [native handoff](../src-tauri/windows/UPDATE-HANDOFF.md).

Primary sources: [Tauri updater](https://v2.tauri.app/plugin/updater/), [official signed-comment format](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-cli/src/helpers/updater_signature.rs), [minisign verifier](https://github.com/jedisct1/rust-minisign-verify), [ring Ed25519](https://docs.rs/ring/0.17.14/ring/signature/index.html).
