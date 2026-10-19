# Manual signed Windows releases

Current activation status (2026-10-19): the approved production gate is enabled with the unchanged registered public key. Hosted isolated QA run 39202794997 passed signed installation, restart health, rollback and uninstall in separate fresh Windows guests. This is QA-feature evidence; the production-enabled variant receives separate build/test validation. No ordinary PC installation, power-loss qualification, real SFTP or long-duration result is claimed. Production builders reject QA inputs and QA-marked payloads. The signed controller uses the explicit registered-production trust profile; historical signed-bootstrap still requires a disabled gate. Validation mode never signs or publishes.

The earlier implementation/status notes below describe their recorded stage.

The signed release workflow is implemented in .github/workflows/release-signed-windows.yml.
Local test results alone do not qualify Actions: inspect the exact manual run and
its artifacts. Build/sign verification never executes setup or replaces the normal EXE.
HANDOFF_RELEASE_VALIDATED is now true after separate activation approval. The source version is still 2.0.0; r2.0 already
exists, so a future signed release needs a separately selected new version and notes.

## Registered trust and custody

Production registration was separately approved and completed on 2026-10-18.
The Environment nearly-updater-production contains NEARLY_UPDATER_PRIVATE_KEY and
NEARLY_UPDATER_PRIVATE_KEY_PASSWORD, each newly created with HTTP201. Repository
Secrets remain empty. The key was generated once in memory, verified locally, then
encrypted and registered without a persistent private backup. No secret value was
read back. Current implementation work only reads the public key and metadata.

The public key ID is 32F9C8E24AEF3CCC; .github/updater-public-key.pub has SHA256
2592845a518adb9df5b7773dd58672ea411b3038758bfaf2808a3cb13dcc8695.
The native verifier embeds its exact 42 bytes; controller checks bind the public
file, native bytes and false installation gate. Existing r1/r2 applications contain
no production trust anchor; the initial signed bootstrap needs manual installation.

Evidence: task/updater-production-registration-verification.json and the metadata-only
registration receipt. The registrar is not part of the release workflow and must
not be rerun merely to test publication. Lost GitHub secrets cannot be read back;
replacement trust may require a manually installed bootstrap. No backup is implied.

## Protection and reviewer responsibility

Approved main protection requires PRs, zero mandatory approvals for this single-owner
repository, admin enforcement, and no force push/deletion. The Environment permits
only main (no tags), requires nea-c (45559303), allows self-review, and forbids admin
bypass. This is an explicit single-owner arrangement, not independent two-person review.

Environment names do not restrict which main workflow may request their secrets.
Before approval, the owner must inspect the exact workflow/controller SHA, source
SHA, run/attempt, producer artifacts and full main PR/admin/force/delete settings.
The read-only job checks public protected=true and exact Environment policy. Full
branch-protection GET requires elevated repository permissions: no admin PAT is
added to CI. These public checks do not claim to verify all main protection fields.
CODEOWNERS routes review for the trusted closure and does not itself change GitHub settings. With approvals=0 it does not enforce independent
code-owner approval. Compromised owner/admin accounts remain outside this boundary.

## Manual workflow and artifact contracts

Only workflow_dispatch from nea-c/Nearly main is accepted. Validate is the default.
Inputs require the exact 40-character source commit and canonical rX.Y. Release
additionally requires the exact string `release rX.Y SOURCE_SHA`. The source must be
in main/controller history, its files must declare X.Y.0, and the tag/release must
not exist before the signing step. Run attempt and exact workflow path are bound.
No PR, fork, moving tag checkout, supplied artifact URL or arbitrary artifact ID is used.

1. policy checks the clean controller, public key, request, server run, source
   ancestry/version and public protection/Environment policy. Release rejects
   existing tags/releases before secrets are available.
2. trusted-signer builds/tests only the controller's locked signing tool on a fresh
   secret-free Windows runner. It pins Rust1.97.1 and the portable reader. Its exact
   source closure, dependency lock, executable/DLL hashes and manifest are bound to
   the controller/run/attempt. No target checkout or shared cache is present.
3. unsigned-build checks out the exact reviewed source on a separate secret-free
   runner. It audits source/history/privacy/version/gates, runs model/native/UI and
   generated localhost tests, builds NSIS without executing setup, then reaudits
   and packages final setup/checksum, final loose Nearly.exe and an unsigned manifest.
4. sign starts after Environment approval. Before downloads it checks server artifact
   IDs/digests/repository/run/attempt. It recomputes the trusted tool closure, verifies
   bundle bytes and creates a new signing plan with the now-known artifact ID. Native
   preflight pins all inputs, checks a single embedded Nearly.exe against the final
   loose file and verifies architecture/hashes. The sole secret-bearing step repeats
   preflight then signs. Node independently verifies cryptography and packages the
   three public assets plus a nonsecret signed provenance manifest.
5. publish has contents:write on a separate Ubuntu runner, without signing secrets
   or Environment. It validates the exact signed artifact, all producer bindings and
   public cryptography before any write. It publishes setup/checksum/.sig only, never
   the loose app. It refuses foreign tags/releases/assets, resumes its own exact-run
   uncertain upload by readback, and redownloads all public assets to verify hashes. This recovery is within the exact run/attempt only. An Actions rerun increments the attempt and intentionally rejects old artifacts or partial release provenance; inspect retained state before deciding how to recover.

Artifact manifests cannot contain their own eventual upload IDs. Job outputs and
GitHub's immutable artifact metadata bind ID/digest; the receiving controller creates
the signing plan only after verifying both. Names alone are insufficient. Canonical
manifests use closed schemas and file sets; extra files, directories, wrong attempt,
producer binding, payload bytes, key, signature or checksum are rejected.

## Secrets and portable tools

Only the native sign --ci step maps the two Environment secrets. That step's
PowerShell launcher and native process both receive them; this is not native-only
isolation. Native preflight precedes key reads; tool-owned strings are zeroized and
panic/error output is redacted. The extractor child gets a cleared environment.
Upstream minisign internal allocations are not guaranteed to be zeroized. Later
steps do not inherit step-scoped secrets. No secret is written to args, GITHUB_ENV,
outputs, summaries or files. GitHub masking is supplementary, not a security proof.
No caches, tracing, dumps or workspace-wide artifact uploads are configured.

prepare-signing-tools.ps1 downloads hash-pinned official 7-Zip26.04 and 7zr files
in a secret-free job. After hash checks the bootstrap reader extracts only the
full reader EXE/DLL from the inert distribution. It does not launch setup/install
software or change PATH/ACLs. The native signer independently pins the complete
reader pair. Details and hashes: tools/updater-signer/CI-DEPENDENCIES.md.

## Verification and remaining approvals

Local tests cover public/native trust agreement, false install gate, minisign
compatibility, independent Node proof verification, manifest/source/run/attempt
bindings, artifact metadata rejection, pinned tool closure and mixed reader rejection,
publisher refusal/resumption, and generated NSIS single-member byte comparison.
Tests use disposable keys and fixtures; no production secret or real installer runs.

The official26.04 distribution/output hashes were inspected using existing22.01.
Downloaded new reader/bootstrap binaries have not run locally. New Actions job/API,
bootstrap/26.04 behavior, actual signed NSIS installation, clean installed Windows,
reboot/recovery and long-duration stability are unqualified. No automatic installation
claim follows from local signing/packaging tests. At that historical signing stage, the source gate remained false.

Separate authorization is needed before committing/pushing or opening integration
work, dispatching validate/release, publishing a new version, executing NSIS in a
specified disposable Windows environment, replacing the normal EXE, or enabling the
installation gate. An actual release also requires the owner's exact Environment
approval after inspecting the concrete controller/source/run/artifact evidence.

References: [GitHub environments](https://docs.github.com/en/rest/deployments/environments),
[branch protection](https://docs.github.com/en/rest/branches/branch-protection),
[secure use](https://docs.github.com/en/actions/reference/security/secure-use).

## Nonpublishing signature verification

The approved follow-up adds verify-signature alongside validate/release. It requires
`verify-signature rX.Y EXACT_SOURCE_SHA`, runs trusted-tool/build/protected-sign jobs,
and retains the verified public bundle as a one-day Actions artifact. All manifests
bind mode. The contents-write publisher job is release-only; both its controller
entry point and signed publisher independently reject verification requests/artifacts
before API access. Existing tags/releases are not read or changed by verification
policy, so currentr2.0 can be used without a version bump or new release notes.

Integration is through a dedicated public branch, draft PR inspection and normal
protected merge into main. Workflow dispatch remains manual and main-only. The owner
approves nearly-updater-production after reviewing exact source/controller/run/attempt
and tool/unsigned artifact IDs/digests. Approval grants use of the existing Secrets
in the sole signing step; no key regeneration or Secret change is involved.

This mode creates no GitHub Release. Public repository code, logs and nonsecret
Actions artifacts may be viewed/downloaded by others. No real installer is executed,
normal EXE replaced or installation gate enabled by this workflow.
