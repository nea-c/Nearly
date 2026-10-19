# R2 interaction refinements

Current activation status (2026-10-19): the approved production gate is enabled with the unchanged registered public key. Hosted isolated QA run 39202794997 passed signed installation, restart health, rollback and uninstall in separate fresh Windows guests. This is QA-feature evidence; the production-enabled variant receives separate build/test validation. No ordinary PC installation, power-loss qualification, real SFTP or long-duration result is claimed. Production builders reject QA inputs and QA-marked payloads. The signed controller uses the explicit registered-production trust profile; historical signed-bootstrap still requires a disabled gate. Validation mode never signs or publishes.

The earlier implementation/status notes below describe their recorded stage.

## Scope
Persist the main window's normal logical size, make a multi-tab drag detach into a real window during the gesture, and distinguish Sync of the current local explorer folder from Resume of the tab's previous sync.

## Accepted behavior
- Buttons: 同期 / 再開 (Sync / Resume). Resume immediately follows Sync with the same visual style. Keyboard focus and hover expose the previous immutable local/remote roots.
- Sync captures the current local explorer folder at activation; the source remains fixed throughout confirmation. Destination and destructive-operation confirmations remain explicit.
- Resume uses the previous pair/options and a fresh scan. Background work and single-owner checks remain authoritative.
- Stopped context is for the current app session and transfers with its tab. Restart does not restore it.
- Save only window size/maximized state, never position or fullscreen. One deterministic main-window native writer preserves unrelated settings.
- A one-tab drag moves the existing window; a multi-tab drag creates a real workspace window before release. Only the actual accepting destination shows a merge insertion cue.

## Delivery boundaries
The subsequent gated updater integration is described in startup-updates.md. At that recorded implementation stage, production signing and handoff gates remained disabled. Browser checks and generated native fixtures do not qualify a real update installation.

Real physical pointer, mixed-DPI, Aero Snap, long-duration SFTP and real installer qualification require separate manual validation. Browser mocks and native policy fixtures must not be described as those checks.

