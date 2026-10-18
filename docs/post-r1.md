# Explorer improvements and local qualification

The post-R1 build adds these explorer features:

- The main window remembers its normal position, size and maximized state. On startup its complete normal frame is fitted into an available monitor work area. Additional windows do not replace the main window preference.
- Drag local file icons or names onto a remote folder or empty remote list space to upload copies. Confirm the destination first; folders require recursive upload. Existing destinations are refused, local sources stay in place, and overlapping synchronization must stop first. A cancelled or failed upload can leave newly created partial targets; refresh before retrying.
- File actions show dismissible progress/results after confirmation. Duplicate asks for a new name; Move asks for an existing destination folder. Local ZIP compression can combine selected siblings; extraction requires one ZIP file. Remote copy streams through this computer. Remote ZIP remains unsupported: SFTP does not supply a general archive command, and this build neither runs server shell commands nor downloads and reuploads archives as a fallback.
- Each explorer has its own bookmark bar. Local bookmarks are shared locally; remote bookmarks belong to their connection. These navigate only their own side. Right-click a bookmark to edit or delete it, or right-click empty bar space to add one. The paired bar keeps registration, history and organizing-folder actions in the same context menu. Focus a bar or item and press Shift+F10 or the context-menu key for keyboard access. Overflow appears only when needed; pointer opening leaves items unselected and keyboard opening focuses the first item. Paired tooltips show both paths.
- The tree toggle sits to the right of each path. Showing a tree focuses and scrolls the current visible directory or its nearest visible ancestor without expanding or navigating; focused tree controls have a visible outline after pointer use too. The redundant Folder heading is removed. The center divider preserves intended tree widths; temporary narrow layouts recover those widths when space returns.
- Input fields suppress app/browser historical suggestions, including new dialogs. WebView2 general autofill and password autosave are disabled where supported and checked with native getters. Saved profiles, bookmarks, paths and existing user/browser data are retained. Previously saved password suggestions may still appear. OS file-picker history and physical IME candidate windows are outside this policy.

## Launch

The unsigned, installer-free local production artifact is `build/post-r1/Nearly.exe`. From the project directory, after the reviewed build has been copied there:

```powershell
& .\build\post-r1\Nearly.exe
```

Windows and WebView2 Runtime are required. Close an existing production Nearly normally before launching a different build: the production identifier remains `local.syncfiles.native`. Settings normally live beside the executable. Keep personal settings and credentials out of distributed build folders. The qualification process builds this artifact but never launches it or overwrites an existing released executable. Normal source builds remain available through `npm run build:windows -- --offline` after dependencies are cached.

## Verification limits

Model and Edge tests use synthetic data/mocked IPC. Separate native tests use generated localhost SFTP and an isolated QA identifier, config and WebView profile. An internal pointer gesture through a real WebView is distinct from a physical Explorer/OLE drop. Current-monitor geometry and restart checks do not establish physical mixed-DPI movement or display hotplug behavior. Physical Explorer drops, physical Japanese IME candidates, real servers and long-duration soak require separate manual verification. Unsupported native getters are reported as unverified; they are never treated as enforcement proof.

See [window placement](window-size.md), [synchronization](synchronization.md), and [native lifecycle QA](native-lifecycle-manual-qa.md).
