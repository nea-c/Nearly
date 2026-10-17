# SyncFiles opaque SFTP handle patch

Upstream: russh-sftp 3.0.1, https://github.com/AspectUnk/russh-sftp . Apache-2.0 license is retained in LICENSE. Vendored from the exact published crate source, not from a development branch.

Modified by SyncFiles on 2026-10-16. The upstream handle fields used String and the wire deserializer converted invalid UTF-8 with replacement characters. SFTP handles are opaque byte strings. A generated server returning four-byte handle 128 therefore caused WRITE to receive a different handle; the soak recovered via reconnect but recorded an upload error. A byte-for-byte regression using every byte value failed before this patch.

Changes cover handle representation and strict decoding of textual fields:

- Protocol HANDLE/CLOSE/READ/WRITE/FSTAT/FSETSTAT/READDIR and fsync extension use Vec<u8> with serde_bytes. Borrowed WRITE uses &[u8] with serde_bytes.
- Raw client methods, buffered-file internals, server handler signatures and its example carry byte vectors/slices. Text paths and names retain their String representation.
- Text decoding rejects invalid UTF-8 with BadMessage, instead of replacing bytes. Replacement could alias a different valid filename during a destructive operation. A packet regression rejects invalid 0xff while accepting the actual UTF-8 replacement character. This stricter decoding was added after the frozen 60-minute transport run began and is covered by final Explorer tests separately.
- The borrowed-versus-owned WRITE unit fixture uses byte literals.

This local API change is intentional. SyncFiles only consumes the patched client API and does not expose it as a public SDK. No authentication, cryptography, host-key verification or packet framing was changed.

Product regression: src/sftp.rs::tests::opaque_sftp_handles_preserve_every_byte verifies decoding a 256-byte opaque handle and re-encoding it unchanged in WRITE. Native SFTP tests deliberately start generated handle numbering at 127 to cross the old failure boundary immediately. The new long run must use a rebuilt executable with this patch.
