# Upload comparison and deletion

Sync uses the local folder currently shown when its confirmation is opened. Resume uses the source, destination, and options from that tab's last successful session and starts a fresh scan. Browsing elsewhere does not move an active sync root. The location link only navigates both explorers; it never starts a sync.

## Comparison

The native engine compares regular-file size and UTC modification time. SFTP v3 carries modification time in whole seconds, so local subsecond timestamps are floored to that precision. Matching metadata skips the upload. This is a metadata optimization, not a content hash or a guarantee of equal content: edits preserving both size and the same whole-second timestamp can be missed.

Different metadata uses the existing source-authoritative upload policy. A same-name remote file is overwritten from local even if its remote timestamp is newer. The confirmation explains this policy before starting. Uploads retain exclusive sibling staging and safe rename, and preserve the source modification time so another scan need not resend unchanged files. Servers that cannot safely overwrite or preserve the required timestamp report failure rather than pretending success.

## Delete OFF and ON

Delete is initially OFF. OFF never removes destination files or directories. Turning it ON and explicitly starting or confirming Resume enables deletion within the selected sync root and options, including remote-only files discovered at startup. The visible warning describes this scope; an older saved ON preset must still pass through that start confirmation.

A complete successful local scan and bounded remote listing are required before planning initial deletions. Exclusions apply to both uploads and deletion. With subdirectories disabled, only regular files immediately under the chosen root are compared and considered for deletion. Remote symlinks, unsupported names, and excluded entries are retained. Directories are removed child-first only after a successful empty-directory check; excluded or unsupported children keep their ancestors.

Missing or unreadable source roots, failed entry reads, partial remote listings, changed roots, and uncertain metadata do not mean an empty source. Destructive actions recheck readable local absence and the remote file/directory guards. Concurrent remote changes can refuse deletion. SFTP v3 metadata does not provide a cryptographic file identity, so indistinguishable remote changes are a protocol limitation. Failures retain data and require an explicit retry or a new verified session as indicated by the message.

Logs distinguish skipped unchanged files, uploaded files, and verified deletions. Queue counts, detection-to-transfer latency, and transfer speed remain available. Logs and scan/tracking limits remain bounded; normal watcher events do not trigger a full remote-tree scan.

## Validation boundary

`scripts/sync-difference-test.mjs` uses generated keys, host pins, temporary files, and a localhost-only SFTP fixture. It is an opt-in test harness and never connects to a saved user profile. Test results do not establish long-duration stability or qualification against a user's real server. The build process does not run the harness or start synchronization.

Protocol references: [SFTP v3 file attributes and SETSTAT/FSETSTAT](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02). The pinned vendored `russh-sftp` source is the implementation reference for the checked status-returning APIs.
