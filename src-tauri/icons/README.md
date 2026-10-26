# Icons

## Application icon provenance

On 2026-10-23, the user stated that they drew the application icon themselves,
using an earlier ChatGPT-generated green N-shaped folder concept as a reference.
This records the user's account of its origin, not a legal determination of
copyrightability or non-infringement. The project's Apache-2.0 licensing scope
includes `icon-source.png` and its derived application icon files, as directed
by the user. See the root `LICENSE` and `LICENSING.md`.

## Uninstaller icon

`uninstall-source.svg` is an original vector drawing. The lime tile and dark
green outline retain Nearly's icon family; the wastebasket and large red minus
badge distinguish removal at small Explorer sizes. The application icon assets
are unchanged.

Regenerate the six 32-bit DIB frames (16, 24, 32, 48, 64 and 256px) with:

```powershell
node scripts/generate-uninstall-icon.mjs
```

The generator uses the existing Playwright dependency and installed Microsoft
Edge on Windows. Set `NEARLY_ICON_BROWSER` to an existing Chromium executable to
select another renderer. It never fetches a browser or edits application assets.
For byte-identical reproduction, use the same browser version and source SVG.
An optional positional argument writes the ICO to a separate verification path.

`tauri.conf.json` selects the new ICO and the custom NSIS template passes the
bundler's `uninstaller_icon` value to `MUI_UNICON`. Both settings are required.

`tests/uninstaller-icon.test.mjs` compiles a generated fixture using the cached
NSIS compiler, captures its uninstaller through the compile-time
`!uninstfinalize` hook, and statically compares every PE icon resource to the ICO.
No installer or uninstaller is executed. Set `NEARLY_NSIS_ROOT` if the compiler
cache is outside `%LOCALAPPDATA%\tauri\NSIS`.

For a generated actual uninstaller, static verification is also available with:

```powershell
node scripts/inspect-pe-icons.mjs <uninstall.exe> src-tauri/icons/uninstall.ico
```

## Runtime state badges (adopted A)

`icons/badges/{sync,done,error,paused}.png` are full 32px icon composites,
not shell overlay-only images. Each keeps the original `icon-source.png` and
places the same half-width badge in its upper-right corner. Bright backgrounds
and bold dark symbols are shared across themes; sync points clockwise.

Regenerate with `node scripts/generate-status-badges.mjs` (optional output
folder). It uses the same existing-browser/`NEARLY_ICON_BROWSER` policy as the
uninstaller generator. No downloads or changes to the base icon/installer ICO.
Browser rasterizer versions can affect antialiasing; inspect regenerated images
and update the explicit RGBA hashes in the Rust artwork tests when intentional.

Windows chooses shell overlay placement, so the adapter clears that old overlay
and sets both the small and taskbar window icon slots to the composite. Five
native HICONs are shared for the process lifetime; state changes allocate no new
handles. Idle restores the original icon. Job aggregation and progress color
are unchanged. Attention acknowledgement does not erase an error badge.
Pinned/grouped taskbar rendering and DPI scaling still require OS visual
qualification; generated previews do not prove shell rendering.
