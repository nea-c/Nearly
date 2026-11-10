# Remote ZIP operations

Remote selections can be compressed to ZIP; one selected regular file with a case-insensitive .zip extension can be extracted. Output is a new sibling ZIP or directory, never an overwrite or merge. Local ZIP operations retain their existing implementation.

## Supported endpoints

This implementation supports Linux with SSH command execution, Python 3.8 or newer (standard-library zipfile and zlib), and libc/filesystem support for renameat2 with RENAME_NOREPLACE. It does not install software or silently download data for local processing. ZIP bytes remain on the server; only control messages and a small namespace marker are read through SSH/SFTP.

The first explicitly requested archive operation probes static OS/runtime commands. Successful capability checks are reused on the session's existing serialized file-operation connection. Browsing, connecting and opening a context menu do not execute shell commands. SFTP-only accounts, unavailable Python, unsupported Linux safe-publication primitives, and Windows/macOS/other operating systems fail with a clear reason. Windows is detected but not supported: plain Expand-Archive or path-based .NET publication would not preserve the required staging ownership and no-replace guarantees.

The normal request uses the connected tab's immutable credentials and verified host identity, never a supplied profile/password. All selected items and the output must share one absolute, normalized parent. Before accessing source contents, the helper creates a random private stage and emits a challenge. Nearly reads that marker through SFTP and confirms only if it matches. This rejects different shell/SFTP namespaces, including incompatible chroot mappings, rather than guessing host paths.

## Safety and behavior

- Paths and filenames are base64 JSON on stdin, never interpolated into a shell command. The only dynamic shell argument is the numeric length of the application's own helper source.
- Source traversal uses retained no-follow directory descriptors, refuses symlinks and special files, and detects observed source changes. Archive member names must be portable: traversal, absolute paths, backslashes, control characters, Windows-special names, ambiguous case duplicates, and file/directory prefix collisions are refused. The output leaf itself may use valid POSIX characters.
- Extraction accepts non-encrypted stored/deflated ZIP entries. Corrupt content, unsupported encodings/formats/codecs, and oversized archives are refused. ZIP64 central-directory records are currently unsupported.
- Work is staged in the destination parent, then published atomically without replacement. A destination created by another process wins the race and remains untouched. Staging overlaps active synchronization and file operations are reserved through the existing engine.
- Limits: 500 selected siblings, 10,000 archive entries (including implicit directories), depth 40, 512 MiB archive/input file, 2 GiB expanded/selected content, 16 MiB central directory, and 300 seconds helper work. Serialized request metadata is limited to 256 KiB of base64 JSON. Files are streamed in bounded chunks; progress is throttled to at most four updates per second and has no invented percentage.
- Cancellation sends SSH TERM and waits briefly for the helper's terminal result. Acknowledged published success is retained even if cancellation/disconnect follows. A missing terminal result is reported as an uncertain outcome: refresh the destination before retrying. Mutations are never automatically replayed. A lost connection or refused cleanup may leave a reported .nearly-zip-* stage; inspect it before removal. The helper deadline is cooperative and cannot bound a kernel filesystem stall.
- No portable ZIP operation provides a snapshot against all concurrent external writers. Stop applications changing the selected files. The helper checks source identities/metadata and keeps its own output private, but does not promise crash-durable filesystem transactions or protection against a privileged/same-account process actively manipulating every syscall.

## Verification

Generated Python fixtures run with Python 3 on Linux: python3 tests/test_remote_zip.py. They use temporary generated content and exercise real compression/extraction and atomic Linux publication.

Generated SSH transport fixtures run on the Windows development computer with node scripts/remote-zip-test.mjs and a freshly compiled NEARLY_NATIVE_TEST_MANIFEST. They validate refusal, handshake, progress, cancellation, connection reuse and no replay using a fake localhost executor. They do not run archive commands or prove a real server's SSH policy.

Frontend coverage lives in tests/archive-actions.test.mjs and tests/ui/archive-entry.spec.ts. Native unit tests cover request validation, protocol bounds, namespace marker paths, and admission ownership. No saved remote profile, installed Nearly application, installer, release or live server is used by these checks.

A real end-to-end server qualification remains separate and requires an explicitly authorized generated directory/endpoint.

Final generated-fixture verification: 20 Linux helper tests, 12 mocked localhost SSH cases, 825 native unit/integration tests plus three version-resource tests, 563 Node tests (four skipped), 11 archive browser tests, 33 copy/transfer progress browser regressions, and nine existing warm-session fixtures passed. Frontend build and offline native compilation passed. The explicitly prohibited recovery test was excluded and verified absent from selected-test lists and execution logs. Evidence and hashes are retained locally under test-results/remote-zip-20261111/.
