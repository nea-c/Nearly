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
