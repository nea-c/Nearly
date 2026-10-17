# Native update handoff

`update_handoff::launch_verified_sibling` accepts only a native staged path. Its
caller retains `StagedInstaller`'s verified file and ancestor-directory locks,
reverifies that handle immediately before launch, and holds the global idle seal.
The native current executable must match both the owned HKCU registration and
the fixed Windows Known Folder LocalAppData/Nearly/Nearly.exe location.

The fixed silent command includes this process's PID, native creation FILETIME,
and a fresh 128-bit nonce. No renderer or release-supplied command is accepted.
Setup opens that PID with query/synchronize rights, validates creation time and
the exact installed image path, and opens both nonce events before signaling
ready. Rust waits at most ten seconds. Setup waits at most sixty seconds for the
identified process handle to signal, polling cancellation every 200 milliseconds.
It also retains a third commit event before readiness and requires that event to
be signaled after parent exit. A crash before explicit commit cannot install.
No process is terminated. Setup repeats the running-file guard before mutation.

Dropping an uncommitted `LaunchedInstaller` signals cancellation. Missing or
signaled cancellation events reject setup, including a setup which initializes
after the native timeout. Setup checks cancellation again before its install
section. After successful sealed settings/session cleanup only, the coordinator
calls fallible `commit()` immediately before controlled application exit. Commit
signals the third event; a later process crash is past this deliberate commit
point and installation may proceed. A commit signaling failure cancels setup.
The caller must
retain the staged locks until process exit; dropping staging early could mark
the running setup image for deletion.

Update mode keeps the fixed install directory and loads both persisted shortcut
preferences, including false. Existing missing shortcuts remain absent. Settings
and backups are neither payloads nor deletion targets. Only `.onInstSuccess`
restarts an update; timeout, cancellation, rejected ownership, busy-app checks,
replacement errors, registration errors and shortcut errors do not restart.

## Recovery and validation boundary

Before parent exit, every launch/handshake/cleanup failure leaves Nearly open;
the coordinator releases its idle seal and setup is cancelled. Retry is explicit.
After parent exit, a failed replacement may leave a partially replaced EXE or
registration. The installer reports recovery instructions to open Nearly directly
or retry a trusted setup, with settings left adjacent. There is **no transactional
binary/registration rollback or health-confirmed restart**. A production signing
key remains absent, so the application must continue to fail closed on installation.

Native tests exercise temporary fixture layouts and owned fake child processes:
readiness success, early child exit, timeout without killing, delayed setup
cancellation, and an exact process-handle wait through natural child exit.
Template tests inspect ownership, all shortcut combinations, wait/cancel ordering
and success-only restart. Cached NSIS compilation validates syntax without
executing the generated installer. Actual install/cancel/upgrade/uninstall,
registry/shortcut effects, interrupted replacement and restart health require an
isolated Windows VM and remain unverified. No host installer is run by these tests.
