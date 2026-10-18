# Signing tool dependency boundary

The manual workflow builds the signer on a fresh secret-free Windows runner from
the exact controller SHA. It explicitly selects cargo +1.97.1, uses the checked-in
Cargo.lock, and builds/tests offline after locked fetching. Actions use full commit
SHA pins. No shared cache or target-source checkout belongs in the signing job.

The manifest binds the complete tracked .github tree, signer sources/lockfile, and
the native verifier compiled by build.rs. The receiving job recomputes that closure
from the trusted controller checkout and verifies exact artifact ID/digest, server
run/repository identity, run attempt, manifest digest and executable/DLL bytes before
execution or secrets. The local key registrar is not built or run by CI.

## Portable reader

.github/signing-dependencies.json pins the official full 7-Zip 26.04 distribution:

| File | SHA256 |
| --- | --- |
| 7z2604-x64.exe | d54bf805f9f3704d1e8db2fa3498ae7ef2df0312b40b558e7c71c734430a665d |
| 7zr.exe | 256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282 |
| extracted 7z.exe | 95fff19b73eff77c87c0d7bd32822e43fb90dd2932459f962eb532d8dfb6ba53 |
| extracted 7z.dll | 899cd73d7fc60e1c1c35c7de0f5bed3dc69bfe2cecbd48014d868a347970a0b1 |

The secret-free setup downloads both files and checks hashes before running the
pinned bootstrap reader. The distribution EXE is inert archive input; setup extracts
only 7z.exe and 7z.dll and checks both hashes. It never launches the distribution
installer, installs software or changes PATH/ACLs. Standalone 7za lacks NSIS support.

The native signer accepts the coherent reviewed 22.01 local pair or 26.04 CI pair,
never a mixed pair. NEARLY_UPDATER_EXTRACTOR selects a path, not a hash exemption.
The same selected/pinned path is used for listing and streaming. The extractor has
a cleared environment. All dependency preparation precedes the secret step.

## Qualification boundary

Official download hashes and the extracted 26.04 pair were inspected using the
existing 22.01 reader. Downloaded 26.04/bootstrap executables have not run locally.
Generated NSIS compilation, single-member inspection and content comparison passed
with existing 22.01 without executing setup. Signer tests use disposable keys and
fixtures. The workflow has not run in Actions: hosted runner/bootstrap/26.04 behavior
and artifact service integration remain unqualified. Installed NSIS, reboot/recovery
and long-duration operation require a separately approved disposable Windows host.
Application installation remains disabled pending qualification and a reviewed gate change.
