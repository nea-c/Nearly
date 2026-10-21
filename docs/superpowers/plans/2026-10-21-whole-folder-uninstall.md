# Whole Folder Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Inline implementation; fresh independent whole-change reviewer.

**Goal:** Safe, explicit optional removal of the registered installation folder and its contents, preserving default settings retention.

**Architecture:** Extend the existing NSIS uninstaller with a default-off page and path-bound confirmation. Record root identity during installation, then use retained root/directory/file handles for bounded tree deletion. Keep cryptographic update/recovery gates unchanged.

**Tech Stack:** NSIS3.13/System/Win32, Node model and native fixture tests, hosted Windows2025 QA.

**Spec:** docs/superpowers/specs/2026-10-21-whole-folder-uninstall-design.md

## Global Constraints

No real PC install or deletion, no ACL/network-policy changes, main merge or Release. Only isolated guest fixtures may be removed. Existing code branch/PR34; old artifacts retained. No silent recursive deletion. Keep source/fixture settings and secrets out of public evidence.

## Review Focus

- Corrupt registration or a copied uninstaller must not authorize a different root.
- Protected roots, junctions, aliases and hardlinks must preserve outside sentinels.
- Root/child substitution between observation and deletion must not redirect scope.
- OFF and confirmation cancellation must preserve all prior settings/content.
- Partial failure and interruption must report remaining state without recursive fallback.

### Task1: Verify ordinary installer baseline

- [ ] Complete run39532081621 candidate build and lifecycle results; classify historical source404 separately.
- [ ] Fix demonstrated baseline failures before destructive feature acceptance.
- [ ] Extend real path-validator model with D:\Nearly and E:\Nearly, and distinguish available hosted drives from actual E qualification.

### Task2: Root authority and uninstall choice

Files: src-tauri/windows/installer.nsi; src-tauri/windows/whole-folder.test.mjs; existing template/UI contract tests.

Interfaces: install writes NearlyRootIdentity to UNINSTKEY from held root; un.NearlyWholeValidate binds recorded identity to the pinned actual root. un.NearlyRemovePage/Leave store NearlyRemoveAll default0 and require path-bearing default-No confirmation. Legacy missing binding rejects ON only.

- [ ] Write and run failing UI/default/root-authority tests.
- [ ] Implement identity persistence and protected-root policy, then localized page/confirmation.
- [ ] Test OFF/cancel, modified registration, protected targets and silent retention.

### Task3: Same-handle bounded tree removal

Files: installer.nsi; new NSIS-body model/native fixture tests.

Interfaces: un.NearlyRemoveTree consumes only a confirmed root bound by Task2. It retains root/ancestor pins, rejects unsupported entries, preserves the held uninstaller until final deletion, and uses existing same-handle disposition primitives. Success returns only after root removal; failure returns nonzero with partial-state wording.

- [ ] Write RED tests for nested contents, outside link targets, substitution and partial failure.
- [ ] Implement bounded enumeration/handle ownership/cleanup; no RMDir /r or path reopen for file effects.
- [ ] Run model and native generated tests through approved execution, then independent review.

### Task4: Hosted real UI and lifecycle qualification

Files: scripts/installer-qa-guest.ps1, installer-qa.mjs, new guest uninstall UI driver/tests, existing workflow/evidence contracts and documentation.

- [ ] Add exact guest-only OFF/ON/decline cases with outside sentinels; assert result, root and registration state.
- [ ] Run appropriate Node/native/template checks; report pre-existing failures explicitly.
- [ ] Commit/push approved branch only; reuse existing same-SHA run or dispatch new exact SHA once.
- [ ] Review actual jobs/proofs/artifacts. Do not claim unexecuted stability, E drive, crash recovery or real PC installation.
