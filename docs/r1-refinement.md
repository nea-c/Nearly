# r1.0 refinements

Nearly now remembers the ID of the last saved connection you selected. A new window selects that connection when it still exists; otherwise it falls back to the first available saved connection. Restoring this selection does not connect, authenticate, start a sync, or restore a running job. Choosing Connect remains an explicit action. The remembered value is an ID, so renaming or reordering saved connections does not change which connection is selected.

Settings shows **r1.0** immediately to the left of its close button. Update notices use the same public `rX.Y` labels. The published Setup filename, installer captions, and visible installer version strings also use `r1.0` (`Nearly_r1.0_x64-setup.exe`). Numeric application/Windows versions and authenticated signed-version fields use `X.Y.0`; see [versioning.md](versioning.md) for the authoritative source and release mapping. This first refinement batch remains r1.0.

The Jade theme applies its palette across the workspace, including Settings, tabs, connection and bookmark trees, local and remote file panes, menus, dialogs, logs, and sync controls. Theme selection remains a saved appearance preference.

Dragging the only tab of a window moves the original window through the application's drag loop. Dropping it into another window still uses the guarded workspace handoff, preserving the source until the target is ready. Moving this way does not enter the Windows Aero Snap drag loop. Multi-tab detachment continues to use the existing transfer path.

An incoming tab can be dropped on the empty title-bar strip to append it after the target window's tabs. The add-tab button, Settings button, window controls, and page content are excluded from this blank drop region.

Automated model, browser, and native protocol checks support these changes, but they do not establish physical desktop gesture behavior. Real mouse dragging, mixed-DPI monitor transitions, negative desktop coordinates, and the absence of Aero Snap during a physical gesture still require manual verification. Follow the evidence requirements in [native-lifecycle-manual-qa.md](native-lifecycle-manual-qa.md); its previously recorded executable results describe that exact earlier build, not this r1 build. Do not mark the r1 physical cases as passed from browser simulation or direct IPC alone.
