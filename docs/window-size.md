# Remembered main-window size

Nearly remembers the original main window's last normal size in logical pixels and whether it was maximized. On the next launch, it restores that normal size and then maximizes when requested. Minimized and fullscreen dimensions are ignored. Position, monitor identity, fullscreen state, and secondary-window dimensions are not saved.

Only the native window named `main` writes this preference, after its settings load succeeds. Secondary windows cannot compete to determine the next launch size, even after the original main window closes. A single worker debounces changes for 350 ms; an authorized main-window close also attempts a final flush. A save failure leaves the previous preference intact and does not interrupt sync jobs or block ordinary window closing.

The optional native-only `appearance.windowSize` field contains `width`, `height`, and `maximized`. It is absent from renderer settings DTOs. Native writes use the existing settings mutex, reread the latest unified document, increment its revision, and preserve unrelated settings. Ordinary renderer saves retain the current native window-size field. Older documents without the field load without migration or a write.

The main window starts hidden while its size is restored. Available dimensions come from its current monitor's work area, excluding Windows taskbars and the window frame. Requested logical dimensions are clamped to that area. The normal minimum is 800 by 650 logical pixels; when the available work area is smaller, its usable dimensions take precedence. No saved window position is restored.

The Windows implementation follows [MonitorFromWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-monitorfromwindow), [GetMonitorInfoW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmonitorinfow), and [MONITORINFO.rcWork](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-monitorinfo), using the nearest monitor and converting physical work-area dimensions through the current scale factor.

Pure policy and generated settings-file fixtures cover size clamps, small work areas, logical-pixel restoration, main-only writes, startup gating, normal-size preservation while maximized, minimized/fullscreen exclusion, stale settings revisions, concurrent renderer saves, no-op saves, and failed-write preservation. Physical mixed-DPI monitor movement and visual startup behavior still require desktop verification; these tests do not substitute for real mouse or display evidence.
