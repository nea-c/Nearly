# Uninstaller icon

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
