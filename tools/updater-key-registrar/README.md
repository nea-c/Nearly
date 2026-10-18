# Memory-only updater key registration preparation

The authorized one-time registration completed on 2026-10-18: both Environment
Secret creations returned201, final names/timestamps and protection were independently
verified, and the process exited0. Public key ID `32F9C8E24AEF3CCC` is saved in the
isolated `.github/updater-public-key.pub`; no private backup was created. Do not
repeat the register command: its existing receipt/public record intentionally block
it. See the task's `updater-production-registration-verification.json` for evidence.

This library now has an explicitly invoked Windows CLI. Human approval was
received for the concrete nea-c/Nearly Environment/main policy and one-time key
registration. It does not authorize publication, workflow activation, installation
or later key replacement. There is no automatic invocation or secret input file.
Use only within an exclusive administrator change window; the API cannot make
two create-or-update writes atomic or enforce a compare-and-create condition.

`register` pins nea-c/Nearly, the authenticated owner ID, main protection with no
PR bypass allowances, the exact one-person Environment policy and main-only branch
policy. It checks repo/environment Secret **names**, rejects incomplete metadata,
existing intended names and local key/public-record paths, and validates the
service's X25519 public key before generating anything. Organization owners are
rejected; an organization migration requires a separately reviewed org-name check.
GitHub omits bypass-list metadata for this personal repository (adding bypass
actors is organization-only). After requiring owner.type=User, omission is accepted;
a present null, malformed or nonempty list still rejects. The live readback is
recorded in the task's approved-protection result, with enforce_admins=true.

The generated minisign key is encrypted with 32 random bytes encoded as a
passphrase. A decrypted roundtrip, public signature probe and actual native
protocol-3 verifier probe on generated PE-shaped data run in memory.
Owned key-box/passphrase buffers use `Zeroizing`; upstream minisign temporaries,
HTTP authentication copies, OS paging and crash dumps cannot be guaranteed erased.
No logging, file, environment variable, child process or command argument receives
private material. The launcher gets existing authentication from the fixed installed
Git credential helper **before** generation, bounds/validates its output, suppresses
stderr and fully joins it before registration. The Git parent has a 30-second
deadline; a helper descendant retaining stdout can delay the reader join. This
availability limitation occurs before key generation and is not a claim of an
end-to-end 30-second credential timeout. No child process runs after generation.
The CLI installs a redacted panic hook, and does not enable tracing or dumps.

The public record is validated as a minisign public key, saved create-new and
flushed before the first PUT. Its configured parent directories must be trusted
and stable, and `forbidden` must include all intended existing private/public key
paths. No directory, ACL, secret backup, replacement, deletion or cleanup is done.
Parent checks are not protection against a concurrent hostile filesystem writer.
A failed public write may leave a partial public file: preserve and inspect it.
The CLI uses a Local named mutex against another copy in the same Windows session,
and a create-new public JSONL receipt before credential acquisition. It journals
public paths, metadata, PUT intents/statuses and redacted final counts only. An
existing receipt or public record blocks a repeat invocation. This local mutex
does not lock another administrator or another computer out of GitHub.

Each value is sealed with RustCrypto `crypto_box`'s libsodium-compatible sealed
box. Non-contributory X25519 service keys are rejected with maintained curve
arithmetic. `GitHubApi` only permits exact fixed HTTPS api.github.com endpoints,
uses normal system certificate/hostname validation, disables redirects/proxies and
request retries, bounds response reads/timeouts, and marks Authorization sensitive.
It never reads a PUT response body. Errors contain stages/counts, never response
bodies, credentials, passphrases or keys. GET endpoints return metadata, not values.

GitHub PUT is **create-or-update**, with no atomic create-only condition. Both
names/policy are rechecked before each PUT; this does not close the race with
another administrator. Exactly 201 counts as confirmed creation. A 204, error
status or timeout stops without retries, overwrite attempts, regenerated keys or
rollback. Partial/uncertain outcomes retain the public binding. Two writes are
not atomic, and final metadata confirmation is not a readback of secret values.

The Environment is not scoped to a workflow. Any eligible main workflow may
request approval. The owner must inspect workflow path, controller/source SHA,
run/attempt and immutable artifact IDs/hashes at approval; one-person selfapproval
is not independent review. These controls cannot prevent a malicious administrator.

Run disposable offline checks from the repository root:

```powershell
cargo test --locked --offline --manifest-path tools/updater-key-registrar/Cargo.toml -- --test-threads=1
cargo clippy --locked --offline --manifest-path tools/updater-key-registrar/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path tools/updater-key-registrar/Cargo.toml -- --check
```

Tests use generated disposable keys, an in-memory API and public-only temporary
records. They verify sealed-box decryption/tamper rejection, native protocol-3
signature compatibility, no-overwrite, policy/collision/incomplete-list rejection,
201/204/errors/timeouts, between-write conflicts, partial results, bounded parsing
and redacted error canaries. They do **not** qualify live HTTPS/GitHub writes,
production credentials, Actions execution, actual NSIS installs or long-term use.
The read-only CLI preflight has separately been exercised against the approved live
policy. A constructor regression verifies explicit in-process ring provider setup
before reqwest builds its TLS client; TLS validation is retained.

Explicit commands (public paths and target confirmation only):

```powershell
nearly-updater-key-registrar.exe inspect --public-key ABS.pub
nearly-updater-key-registrar.exe register --public-key ABS.pub --receipt ABS.jsonl --confirm-target nea-c/Nearly:nearly-updater-production
```

Never retry registration after a receipt/public record exists without inspecting
remote metadata and the public journal first. The CLI does not contain a recovery,
overwrite, secret readback or private-file fallback command.

References: [GitHub Secrets API](https://docs.github.com/en/rest/actions/secrets),
[RustCrypto crypto_box](https://github.com/RustCrypto/nacl-compat/tree/master/crypto_box),
[libsodium sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes).
