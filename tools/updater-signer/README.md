# Nearly updater signer

Windows-only controller tool. Build with the checked-in lockfile:

```powershell
cargo build --locked --manifest-path tools/updater-signer/Cargo.toml
cargo test --locked --manifest-path tools/updater-signer/Cargo.toml
```

The CLI has only `preflight` and `sign`; it cannot generate keys. Neither command executes the installer or application. `preflight` reads no signing key/password. `sign` repeats preflight, then reads the existing encrypted key and writes only `<canonical-installer>.sig` with no overwrite. Paths must be absolute, existing regular files without reparse ancestors. Input and ancestor handles remain pinned against writes/deletion until output is written.

Both commands require:

```
--installer ABSOLUTE_CANONICAL_INSTALLER_PATH
--payload ABSOLUTE_FINAL_NEARLY_EXE_PATH
--manifest ABSOLUTE_MANIFEST_PATH
--manifest-sha256 EXPECTED_MANIFEST_SHA256
--source-commit EXPECTED_FULL_SOURCE_COMMIT
--artifact-id EXPECTED_IMMUTABLE_ARTIFACT_ID
```

Example manifest schema (values are illustrative, not release evidence):

```json
{
  "updaterProtocol": 3,
  "version": "3.1.0",
  "arch": "x64",
  "file": "Nearly_r3.1_x64-setup.exe",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "artifactId": "12345",
  "archiveMember": "Nearly.exe",
  "installerSha256": "<64 lowercase hex characters>",
  "payloadSha256": "<64 lowercase hex characters>"
}
```

Only `Nearly.exe` or `$INSTDIR/Nearly.exe` is accepted as the exact archive member. The archive listing must contain only one application with that basename, including case aliases. Both hashes are recomputed; the final loose application must match the streamed embedded application byte for byte. Application PE machine must agree with x64/arm64; installer must be the x86 NSIS bootstrapper. Stable versions are canonical X.Y.0 with X/Y no larger than 65535. This checks byte identity, not installer behavior.

The tool accepts two complete SHA256-pinned pairs: this PC's existing 7-Zip 22.01, and the official 26.04 x64 reader used by CI. `NEARLY_UPDATER_EXTRACTOR` selects an absolute `7z.exe` path; without it the existing `C:\Program Files\7-Zip\7z.exe` is used. The executable and adjacent DLL must match the same approved pair; selecting a path cannot bypass verification. It neither installs nor searches PATH for an extractor. Listings and streamed output have size limits and a 30-second child deadline. No extraction writes occur. The child has a clean environment without signing secrets, null stdin/stderr and no visible window. See [CI-DEPENDENCIES.md](CI-DEPENDENCIES.md) for pins and qualification limits.

`sign` additionally requires `--public-key ABSOLUTE_REVIEWED_PUBLIC_KEY_PATH` and exactly one of:

- `--key-file ABSOLUTE_EXISTING_ENCRYPTED_KEY_PATH`: enter the nonempty passphrase directly in the local console. rpassword opens `CONIN$`, disables echo through console mode, and restores it on return. Redirected stdin is not a password source.
- `--ci`: the approved signing step injects `NEARLY_UPDATER_PRIVATE_KEY` (encrypted outer-base64 Tauri box or raw minisign box) and `NEARLY_UPDATER_PRIVATE_KEY_PASSWORD`. That step's PowerShell launcher and native process can see the variables. The native process reads/removes them after preflight; the extractor child receives a cleared environment. Later steps do not inherit step-scoped secrets. Do not put values in command arguments, logs, `.env`, a workflow file or chat.

The public key accepts a raw minisign box or outer-base64 Tauri public box. Secret boxes must have encrypted `EdScB2` records, bounded work/memory parameters, and a nonempty passphrase; even boxes decryptable with an empty passphrase are refused. Error text is fixed and excludes upstream errors and key Debug representations. Tool-owned password/key strings use zeroizing wrappers. **minisign 0.9.1 does not guarantee zeroization of its internal secret/password copies**; use an isolated short-lived signing process, without crash dumps or tracing. This tool makes no claim of locked memory or protection from an already compromised owner account.

The authenticated comment contains exactly one of each:

```
version:X.Y.0<TAB>file:Nearly_rX.Y_ARCH-setup.exe<TAB>payload-sha256:HEX<TAB>updater-protocol:3
```

minisign 0.9.1 signs the installer with the standard prehashed signature plus global trusted-comment signature. Standard base64 wraps its four-line document. Before writing, the tool verifies with the expected public key through upstream minisign and the actual checked-out native `verify_proof`/`verify_pe` bodies compiled by `build.rs`. Build markers fail if those source sections are reorganized; no separate tracked verifier copy exists. Output creation uses exclusive `create_new`; a failed write retains partial evidence and never removes/replaces an existing file.

## Trust and remaining qualification

The expected manifest hash, source commit, artifact ID and public key must come from the reviewed trusted controller. The manifest is not independently signed and source identity is not proved merely by its string. The trusted build must truthfully create the manifest after all application byte changes and final installer packaging/signing, bind the immutable artifact, and enforce the stage-only protocol 3 installer design. This tool verifies embedded bytes; it does not establish source reproducibility, run installer behavior, or certify protocol compliance from the number alone. There is no second production signing key.

Tests generate ephemeral keys and synthetic PE/archive data under owned temporary fixtures only, then remove fixtures on scope exit. Tests do not access production keys, change ACLs or GitHub settings, or run an installer. Production custody and Environment registration were completed separately; the registered public key is embedded in the isolated application source. The manual workflow and public cryptographic verifier are implemented locally, but have not run in Actions. Real installed NSIS behavior remains unqualified, and `HANDOFF_RELEASE_VALIDATED` remains false. Public-key presence alone does not enable automatic installation. Released r1/r2 applications have no registered trust anchor; the first signed bootstrap requires a manual installation.

Encryption format references: [tagged secret_key.rs](https://github.com/jedisct1/rust-minisign/blob/0.9.1/src/secret_key.rs), [constants.rs](https://github.com/jedisct1/rust-minisign/blob/0.9.1/src/constants.rs), [keypair.rs](https://github.com/jedisct1/rust-minisign/blob/0.9.1/src/keypair.rs). It uses scrypt with random salt, a derived XOR stream over key ID/Ed25519 secret/BLAKE2b checksum; it is not an AES or AEAD format. Cryptography and decryption remain inside the maintained crate.
