; Nearly per-user installer. Derived from Tauri CLI tauri-cli-v2.12.3:
; crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi and utils.nsh.
; Copyright (c) 2017 - Present Tauri Apps Contributors. MIT license retained
; in upstream/LICENSE-MIT. See README.md for provenance and deliberate changes.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
SetCompressor /SOLID "{{compression}}"
!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include nsDialogs.nsh
!include "Win\COM.nsh"
!include "Win\RestartManager.nsh"

!define PRODUCTNAME "{{product_name}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!searchparse "${VERSION}" "" VERSIONMAJOR "." VERSIONMINOR "." VERSIONPATCH
!define PUBLICVERSION "r${VERSIONMAJOR}.${VERSIONMINOR}"
!define MANUFACTURER "{{manufacturer}}"
!define COPYRIGHT "{{copyright}}"
!define ARCH "{{arch}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BUNDLEID}"
!define PREFSKEY "Software\${BUNDLEID}\Installer"
!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define MUI_ICON "{{installer_icon}}"
!define MUI_UNICON "{{installer_icon}}"
!addplugindir "{{additional_plugins_path}}"

; These are packaging invariants, not user-selectable installation modes.
!if "{{install_mode}}" != "currentUser"
  !error "Nearly requires a currentUser installer."
!endif
; Tauri CLI 2.12.3 maps Skip to an empty install_webview2_mode context value.
; The checked build configuration separately requires webviewInstallMode.type=skip.
!if "{{install_webview2_mode}}" != ""
  !error "Nearly must not install or download WebView2 automatically."
!endif
{{#if resources}}
  !error "Nearly is self-contained; external resources could overwrite user settings."
{{/if}}
{{#if binaries}}
  !error "Nearly's installer only owns its main EXE and generated uninstaller."
{{/if}}

RequestExecutionLevel user
Name "${PRODUCTNAME} ${PUBLICVERSION}"
Caption "${PRODUCTNAME} ${PUBLICVERSION} Setup"
UninstallCaption "${PRODUCTNAME} ${PUBLICVERSION} Uninstall"
BrandingText "${PRODUCTNAME} ${PUBLICVERSION}"
OutFile "{{out_file}}"
InstallDir "$LOCALAPPDATA\${PRODUCTNAME}"
VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} ${PUBLICVERSION} Setup"
VIAddVersionKey "FileVersion" "${PUBLICVERSION}"
VIAddVersionKey "ProductVersion" "${PUBLICVERSION}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
ShowInstDetails show
ShowUninstDetails show

Var NearlyPassive
Var NearlyNoShortcuts
Var NearlyOwnedUpgrade
Var NearlyStartMenu
Var NearlyDesktop
Var NearlyStartMenuCheckbox
Var NearlyDesktopCheckbox
Var NearlyDialog
Var NearlyUpdateMode
Var NearlyParent
Var NearlyCreated
Var NearlyReady
Var NearlyParentHandle
Var NearlyAbortHandle
Var NearlyInstalledHandle
Var NearlyHealthyHandle
Var NearlyProtocol
Var NearlyCommitHandle
Var NearlyWaitTicks

; This path performs no mutations before the exact parent exits. The native
; caller holds a verified sibling EXE lock and only exits after our ready event.
Function NearlyWaitUpdateParent
  StrCpy $NearlyUpdateMode 0
  StrCpy $NearlyParentHandle 0
  StrCpy $NearlyAbortHandle 0
  StrCpy $NearlyCommitHandle 0
  StrCpy $NearlyInstalledHandle 0
  StrCpy $NearlyHealthyHandle 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NEARLYUPDATE" $1
  ${If} ${Errors}
    Return
  ${EndIf}
  StrCmp $1 "" 0 nearly_update_reject
  ClearErrors
  ${GetOptions} $0 "/NEARLYPROTOCOL=" $NearlyProtocol
  ${If} ${Errors}
    Goto nearly_update_reject
  ${EndIf}
  StrCmp $NearlyProtocol "2" 0 nearly_update_reject
  StrCpy $NearlyUpdateMode 1
  ; Update mode cannot select shortcuts, a new directory or a portable copy.
  StrCpy $NearlyNoShortcuts 0
  StrCpy $NearlyPassive 1
  SetSilent silent
  StrCmp $NearlyOwnedUpgrade 1 0 nearly_update_reject
  GetFullPathName $1 "$EXEDIR"
  StrCmp $1 "$INSTDIR" 0 nearly_update_reject
  ${GetOptions} $0 "/NEARLYPARENT=" $NearlyParent
  ${GetOptions} $0 "/NEARLYCREATED=" $NearlyCreated
  ${GetOptions} $0 "/NEARLYREADY=" $NearlyReady
  StrLen $1 $NearlyReady
  StrCmp $1 32 0 nearly_update_reject
  StrCpy $2 0
  nearly_update_nonce_loop:
    StrCpy $3 $NearlyReady 1 $2
    StrCmp $3 "" nearly_update_nonce_done
    StrCpy $4 0
    nearly_update_hex_loop:
      StrCpy $5 "0123456789abcdef" 1 $4
      StrCmp $5 "" nearly_update_reject
      StrCmp $3 $5 nearly_update_hex_ok
      IntOp $4 $4 + 1
      Goto nearly_update_hex_loop
    nearly_update_hex_ok:
    IntOp $2 $2 + 1
    Goto nearly_update_nonce_loop
  nearly_update_nonce_done:
  ; SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, never termination rights.
  System::Call 'kernel32::OpenProcess(i 0x00101000, i 0, i $NearlyParent) p.s'
  Pop $NearlyParentHandle
  StrCmp $NearlyParentHandle 0 nearly_update_reject
  System::Call 'kernel32::GetProcessTimes(p $NearlyParentHandle, *l .r1, *l .r2, *l .r3, *l .r4) i.r5'
  StrCmp $5 0 nearly_update_reject
  StrCmp $1 $NearlyCreated 0 nearly_update_reject
  StrCpy $1 ${NSIS_MAX_STRLEN}
  System::Call 'kernel32::QueryFullProcessImageNameW(p $NearlyParentHandle, i 0, w .r2, *i r1) i.r3'
  StrCmp $3 0 nearly_update_reject
  GetFullPathName $2 "$2"
  StrCmp $2 "$INSTDIR\${MAINBINARYNAME}.exe" 0 nearly_update_reject
  ; Retain cancellation before readiness: late initialization after the native
  ; timeout cannot start an installation on a later ordinary application exit.
  System::Call 'kernel32::OpenEventW(i 0x00100000, i 0, w "Local\NearlyUpdateAbort-$NearlyReady") p.s'
  Pop $NearlyAbortHandle
  StrCmp $NearlyAbortHandle 0 nearly_update_reject
  System::Call 'kernel32::WaitForSingleObject(p $NearlyAbortHandle, i 0) i.r1'
  StrCmp $1 258 0 nearly_update_reject
  System::Call 'kernel32::OpenEventW(i 0x00100000, i 0, w "Local\NearlyUpdateCommit-$NearlyReady") p.s'
  Pop $NearlyCommitHandle
  StrCmp $NearlyCommitHandle 0 nearly_update_reject
  ; Hold both phase events before Ready; the old parent may close its copies.
  System::Call 'kernel32::OpenEventW(i 0x00100002, i 0, w "Local\NearlyUpdateInstalled-$NearlyReady") p.s'
  Pop $NearlyInstalledHandle
  StrCmp $NearlyInstalledHandle 0 nearly_update_reject
  System::Call 'kernel32::WaitForSingleObject(p $NearlyInstalledHandle, i 0) i.r1'
  StrCmp $1 258 0 nearly_update_reject
  System::Call 'kernel32::OpenEventW(i 0x00100000, i 0, w "Local\NearlyUpdateHealthy-$NearlyReady") p.s'
  Pop $NearlyHealthyHandle
  StrCmp $NearlyHealthyHandle 0 nearly_update_reject
  System::Call 'kernel32::WaitForSingleObject(p $NearlyHealthyHandle, i 0) i.r1'
  StrCmp $1 258 0 nearly_update_reject
  System::Call 'kernel32::OpenEventW(i 2, i 0, w "Local\NearlyUpdateReady-v2-$NearlyReady") p.r1'
  StrCmp $1 0 nearly_update_reject
  System::Call 'kernel32::SetEvent(p r1) i.r2'
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCmp $2 0 nearly_update_reject
  StrCpy $NearlyWaitTicks 0
  nearly_update_wait_loop:
    System::Call 'kernel32::WaitForSingleObject(p $NearlyAbortHandle, i 0) i.r1'
    StrCmp $1 258 0 nearly_update_reject
    System::Call 'kernel32::WaitForSingleObject(p $NearlyParentHandle, i 200) i.r1'
    StrCmp $1 0 nearly_update_parent_exited
    StrCmp $1 258 0 nearly_update_reject
    IntOp $NearlyWaitTicks $NearlyWaitTicks + 1
    IntCmp $NearlyWaitTicks 300 nearly_update_reject nearly_update_wait_loop nearly_update_reject
  nearly_update_parent_exited:
  ; A parent crash before settled-settings commit must not authorize mutation.
  System::Call 'kernel32::WaitForSingleObject(p $NearlyCommitHandle, i 0) i.r1'
  StrCmp $1 0 0 nearly_update_reject
  System::Call 'kernel32::CloseHandle(p $NearlyParentHandle)'
  StrCpy $NearlyParentHandle 0
  StrCmp $1 0 nearly_update_wait_done
  nearly_update_reject:
    StrCmp $NearlyParentHandle 0 +2
      System::Call 'kernel32::CloseHandle(p $NearlyParentHandle)'
    StrCpy $NearlyParentHandle 0
    StrCmp $NearlyAbortHandle 0 +2
      System::Call 'kernel32::CloseHandle(p $NearlyAbortHandle)'
    StrCpy $NearlyAbortHandle 0
    StrCmp $NearlyCommitHandle 0 +2
      System::Call 'kernel32::CloseHandle(p $NearlyCommitHandle)'
    StrCpy $NearlyCommitHandle 0
    StrCmp $NearlyInstalledHandle 0 +2
      System::Call 'kernel32::CloseHandle(p $NearlyInstalledHandle)'
    StrCpy $NearlyInstalledHandle 0
    StrCmp $NearlyHealthyHandle 0 +2
      System::Call 'kernel32::CloseHandle(p $NearlyHealthyHandle)'
    StrCpy $NearlyHealthyHandle 0
    SetErrorLevel 8
    Abort "Update handoff was rejected or timed out. No installation changes were made. Open Nearly normally and retry the update."
  nearly_update_wait_done:
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_PRE NearlySkipPassive
!insertmacro MUI_PAGE_WELCOME
Page custom NearlyShortcutPage NearlyShortcutPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_FUNCTION NearlyRun
!define MUI_PAGE_CUSTOMFUNCTION_PRE NearlySkipPassive
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_RESERVEFILE_LANGDLL
LangString NearlyShortcutTitle ${LANG_ENGLISH} "Shortcuts"
LangString NearlyShortcutTitle ${LANG_JAPANESE} "ショートカット"
LangString NearlyShortcutSubtitle ${LANG_ENGLISH} "Choose where Nearly appears. Your choices are kept for upgrades."
LangString NearlyShortcutSubtitle ${LANG_JAPANESE} "Nearly の表示場所を選んでください。更新時もこの選択を保持します。"
LangString NearlyStartMenuText ${LANG_ENGLISH} "Create a Start menu shortcut"
LangString NearlyStartMenuText ${LANG_JAPANESE} "スタートメニューにショートカットを作成する"
LangString NearlyDesktopText ${LANG_ENGLISH} "Create a desktop shortcut"
LangString NearlyDesktopText ${LANG_JAPANESE} "デスクトップにショートカットを作成する"
LangString NearlyDataNotice ${LANG_ENGLISH} "Nearly installs for this Windows user only. Settings beside Nearly.exe are preserved during upgrades and uninstall."
LangString NearlyDataNotice ${LANG_JAPANESE} "この Windows ユーザー専用にインストールします。Nearly.exe と同じ場所の設定は、更新時・アンインストール時にも残ります。"
LangString NearlyCloseApp ${LANG_ENGLISH} "Nearly is running. Stop its syncs and close all Nearly windows, then run Setup again. Setup will not stop the app."
LangString NearlyCloseApp ${LANG_JAPANESE} "Nearly が起動しています。同期を停止してすべての Nearly ウィンドウを閉じてから、もう一度実行してください。セットアップがアプリを強制終了することはありません。"
LangString NearlyCannotCheck ${LANG_ENGLISH} "Setup could not verify that Nearly is closed. Nothing was changed. Close Nearly and try again."
LangString NearlyCannotCheck ${LANG_JAPANESE} "Nearly が終了していることを確認できませんでした。変更は行っていません。Nearly を閉じて、もう一度実行してください。"
LangString NearlyWebViewMissing ${LANG_ENGLISH} "Microsoft Edge WebView2 Runtime is required. Install the runtime separately from Microsoft's official website, then run Nearly Setup again. Nearly and its settings have not been changed."
LangString NearlyWebViewMissing ${LANG_JAPANESE} "Microsoft Edge WebView2 Runtime が必要です。Microsoft の公式サイトから別途インストールし、このセットアップを再実行してください。Nearly と設定は変更していません。"
LangString NearlyCannotWrite ${LANG_ENGLISH} "Nearly must be installed in its writable per-user folder under LocalAppData. Check this folder's permissions and try again."
LangString NearlyCannotWrite ${LANG_JAPANESE} "Nearly は LocalAppData 内の書き込み可能なユーザー専用フォルダーにインストールする必要があります。フォルダーのアクセス権を確認してください。"
LangString NearlyPayloadError ${LANG_ENGLISH} "Setup could not replace Nearly.exe. Close Nearly and try again. Your settings have not been removed."
LangString NearlyPayloadError ${LANG_JAPANESE} "Nearly.exe を更新できませんでした。Nearly を閉じて再実行してください。設定は削除していません。"
LangString NearlyWrongFolder ${LANG_ENGLISH} "This uninstaller only manages this user's original Nearly installation folder. No files were removed."
LangString NearlyWrongFolder ${LANG_JAPANESE} "このアンインストーラーは、このユーザーの元の Nearly インストール先のみを管理します。ファイルは削除していません。"
LangString NearlyExistingFiles ${LANG_ENGLISH} "The Nearly folder contains an EXE or uninstaller from an unrecognized installation. Move that existing installation or use its own uninstaller before trying again. Nothing was overwritten."
LangString NearlyExistingFiles ${LANG_JAPANESE} "Nearly フォルダーに、このセットアップが管理していない EXE またはアンインストーラーがあります。既存のアプリを別の場所に移すか、元のアンインストーラーを使用してから再実行してください。上書きは行っていません。"

!macro NearlyContext
  SetShellVarContext current
  ${If} ${RunningX64}
    !if "${ARCH}" == "x64"
      SetRegView 64
    !else if "${ARCH}" == "arm64"
      SetRegView 64
    !else
      SetRegView 32
    !endif
  ${Else}
    SetRegView 32
  ${EndIf}
!macroend

; A junction/symlink must not redirect this fixed per-user directory to foreign
; files. Missing target is valid for a fresh install; other query errors abort.
!macro NearlyRequireTargetDirectory
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r5'
  ${If} $5 = -1
    System::Call 'kernel32::GetLastError() i.r6'
    ${If} $6 != 2
    ${AndIf} $6 != 3
      SetErrorLevel 5
      Abort "$(NearlyCannotWrite)"
    ${EndIf}
  ${Else}
    IntOp $6 $5 & 0x400
    IntOp $7 $5 & 0x10
    ${If} $6 != 0
    ${OrIf} $7 = 0
      SetErrorLevel 5
      Abort "$(NearlyCannotWrite)"
    ${EndIf}
  ${EndIf}
!macroend

Function NearlyCheckInstallOwnership
  StrCpy $NearlyOwnedUpgrade 0
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyOwner"
  StrCmp $0 "${BUNDLEID}" 0 nearly_ownership_inspect_files
  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  StrCmp $0 "" nearly_ownership_inspect_files 0
  GetFullPathName $0 "$0"
  StrCmp $0 "$INSTDIR" 0 nearly_ownership_inspect_files
  StrCpy $NearlyOwnedUpgrade 1
  nearly_ownership_inspect_files:
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" nearly_ownership_files_present 0
  IfFileExists "$INSTDIR\uninstall.exe" nearly_ownership_files_present nearly_ownership_done
  nearly_ownership_files_present:
  StrCmp $NearlyOwnedUpgrade 1 nearly_ownership_done 0
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "$(NearlyExistingFiles)"
  SetErrorLevel 7
  Abort
  nearly_ownership_done:
FunctionEnd

Function NearlyInferMissingShortcuts
  ; Existing owned installation only: a user may have removed a previously
  ; enabled link. Preserve that absence for silent/passive upgrades. The visible
  ; page can explicitly re-enable it; a fresh reinstall still honors saved prefs.
  StrCmp $NearlyOwnedUpgrade 1 0 nearly_missing_done
  StrCmp $NearlyStartMenu 1 0 nearly_missing_desktop
  IfFileExists "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk" nearly_missing_desktop 0
  StrCpy $NearlyStartMenu 0
  nearly_missing_desktop:
  StrCmp $NearlyDesktop 1 0 nearly_missing_done
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" nearly_missing_done 0
  StrCpy $NearlyDesktop 0
  nearly_missing_done:
FunctionEnd

; Query only. Never invoke Restart Manager shutdown/restart or process killing.
; All errors fail closed, including silent/passive upgrade and uninstall.
!macro NearlyRequireClosed
  !define NearlyCheckDone "nearly_check_done_${__LINE__}"
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 ${NearlyCheckDone}
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 == ""
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyCannotCheck)"
    SetErrorLevel 2
    Abort
  ${EndIf}
  !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} $0 != 0
    !insertmacro RestartManager_EndSession $R0
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyCannotCheck)"
    SetErrorLevel 2
    Abort
  ${EndIf}
  StrCpy $1 0
  StrCpy $2 0
  StrCpy $3 0
  System::Call 'rstrtmgr::RmGetList(i R0, *i .r1, *i r2, p 0, *i .r3) i.r0'
  System::Call 'rstrtmgr::RmEndSession(i R0) i.r4'
  ${If} $0 == 234
  ${OrIf} $1 > 0
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyCloseApp)"
    SetErrorLevel 2
    Abort
  ${ElseIf} $0 != 0
  ${OrIf} $4 != 0
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyCannotCheck)"
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${NearlyCheckDone}:
  !undef NearlyCheckDone
!macroend

; COM target comparison derived from pinned upstream IsShortcutTarget.
; No shortcut is overwritten/deleted unless it targets our exact main EXE.
!macro NearlyIsShortcutTarget shortcut
  StrCpy $3 0
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${shortcut}",${STGM_READ}).r3'
      ${If} $3 = 0
        ${IShellLink::GetPath} $0 '(.r2,${NSIS_MAX_STRLEN},p0,0x4).r3'
        ${If} $3 = 0
        ${AndIf} $2 == "$INSTDIR\${MAINBINARYNAME}.exe"
          StrCpy $3 1
        ${Else}
          StrCpy $3 0
        ${EndIf}
      ${Else}
        StrCpy $3 0
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  Push $3
!macroend

Function NearlyLoadPreferences
  ; Distinguish an absent DWORD from saved 0. Each preference is independent.
  ClearErrors
  ReadRegDWORD $NearlyStartMenu HKCU "${PREFSKEY}" "StartMenuShortcut"
  ${If} ${Errors}
    StrCpy $NearlyStartMenu 1
  ${ElseIf} $NearlyStartMenu != 1
    StrCpy $NearlyStartMenu 0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $NearlyDesktop HKCU "${PREFSKEY}" "DesktopShortcut"
  ${If} ${Errors}
    StrCpy $NearlyDesktop 0
  ${ElseIf} $NearlyDesktop != 1
    StrCpy $NearlyDesktop 0
  ${EndIf}
FunctionEnd

Function NearlyShortcutPage
  ${If} ${Silent}
  ${OrIf} $NearlyPassive = 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(NearlyShortcutTitle)" "$(NearlyShortcutSubtitle)"
  nsDialogs::Create 1018
  Pop $NearlyDialog
  ${If} $NearlyDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 16u "$(NearlyStartMenuText)"
  Pop $NearlyStartMenuCheckbox
  ${NSD_SetState} $NearlyStartMenuCheckbox $NearlyStartMenu
  ${NSD_CreateCheckbox} 0 40u 100% 16u "$(NearlyDesktopText)"
  Pop $NearlyDesktopCheckbox
  ${NSD_SetState} $NearlyDesktopCheckbox $NearlyDesktop
  ${NSD_CreateLabel} 0 80u 100% 50u "$(NearlyDataNotice)"
  Pop $0
  ${If} $NearlyNoShortcuts = 1
    ${NSD_SetState} $NearlyStartMenuCheckbox 0
    ${NSD_SetState} $NearlyDesktopCheckbox 0
    EnableWindow $NearlyStartMenuCheckbox 0
    EnableWindow $NearlyDesktopCheckbox 0
  ${EndIf}
  nsDialogs::Show
FunctionEnd
Function NearlyShortcutPageLeave
  ${If} $NearlyNoShortcuts != 1
    ${NSD_GetState} $NearlyStartMenuCheckbox $NearlyStartMenu
    ${NSD_GetState} $NearlyDesktopCheckbox $NearlyDesktop
  ${EndIf}
FunctionEnd

Function NearlyRequireWebView
  ; Microsoft documents these Evergreen Runtime registration keys. Read both
  ; registry views; never download, execute, update, or install the runtime.
  SetRegView 32
  ReadRegStr $4 HKLM "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${If} $4 == ""
    ReadRegStr $4 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
  ${AndIf} ${RunningX64}
    SetRegView 64
    ReadRegStr $4 HKLM "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
    ${If} $4 == ""
      ReadRegStr $4 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
    ${EndIf}
  ${EndIf}
  !insertmacro NearlyContext
  ${If} $4 == ""
  ${OrIf} $4 == "0.0.0.0"
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyWebViewMissing)"
    SetErrorLevel 3
    Abort
  ${EndIf}
FunctionEnd

; Keep the displayed rX.Y separate from the numeric downgrade comparison.
; Older Nearly installers registered only a numeric DisplayVersion. Validate
; either source before calling SemverCompare; an incomplete public registration
; must fail closed rather than guessing a comparable version.
Function NearlyReadInstalledVersion
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyInternalVersion"
  StrCmp $0 "" 0 nearly_version_validate
  ReadRegStr $0 HKCU "${UNINSTKEY}" "DisplayVersion"
  StrCmp $0 "" nearly_version_done
nearly_version_validate:
  StrCpy $1 0
  StrCpy $2 0
  StrCpy $3 0
  StrCpy $6 0
nearly_version_character:
  StrCpy $4 $0 1 $1
  StrCmp $4 "" nearly_version_finish
  StrCmp $4 "." nearly_version_dot
  StrCmp $4 "0" nearly_version_digit
  StrCmp $4 "1" nearly_version_digit
  StrCmp $4 "2" nearly_version_digit
  StrCmp $4 "3" nearly_version_digit
  StrCmp $4 "4" nearly_version_digit
  StrCmp $4 "5" nearly_version_digit
  StrCmp $4 "6" nearly_version_digit
  StrCmp $4 "7" nearly_version_digit
  StrCmp $4 "8" nearly_version_digit
  StrCmp $4 "9" nearly_version_digit nearly_version_invalid
nearly_version_digit:
  StrCmp $3 0 nearly_version_first_digit
  StrCmp $5 "0" nearly_version_invalid
  Goto nearly_version_append_digit
nearly_version_first_digit:
  StrCpy $5 $4
nearly_version_append_digit:
  IntOp $3 $3 + 1
  IntCmp $3 5 nearly_version_accumulate nearly_version_accumulate nearly_version_invalid
nearly_version_accumulate:
  IntOp $6 $6 * 10
  IntOp $6 $6 + $4
  IntCmp $6 65535 nearly_version_advance nearly_version_advance nearly_version_invalid
nearly_version_dot:
  StrCmp $3 0 nearly_version_invalid
  IntOp $2 $2 + 1
  StrCpy $3 0
  StrCpy $6 0
nearly_version_advance:
  IntOp $1 $1 + 1
  Goto nearly_version_character
nearly_version_finish:
  StrCmp $2 2 0 nearly_version_invalid
  StrCmp $3 0 nearly_version_invalid nearly_version_done
nearly_version_invalid:
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Nearly's installed version is invalid. Repair its installation before upgrading."
  SetErrorLevel 4
  Abort
nearly_version_done:
FunctionEnd

Function .onInit
  !insertmacro NearlyContext
  ; Deliberately override /D= and any saved path: settings are EXE-adjacent and
  ; this installer supports only the fixed, writable per-user location.
  GetFullPathName $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
  StrCpy $NearlyPassive 0
  StrCpy $NearlyNoShortcuts 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/P" $1
  ${IfNot} ${Errors}
    StrCpy $NearlyPassive 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/NS" $1
  ${IfNot} ${Errors}
    StrCpy $NearlyNoShortcuts 1
  ${EndIf}
  !insertmacro NearlyRequireTargetDirectory
  Call NearlyCheckInstallOwnership
  Call NearlyLoadPreferences
  Call NearlyInferMissingShortcuts
  !if "{{display_language_selector}}" == "true"
    ${If} $NearlyPassive != 1
      !insertmacro MUI_LANGDLL_DISPLAY
    ${EndIf}
  !endif
  Call NearlyRequireWebView
  Call NearlyReadInstalledVersion
  ${If} $0 != ""
    nsis_tauri_utils::SemverCompare "${VERSION}" $0
    Pop $0
    ${If} $0 = -1
      IfSilent +2
        MessageBox MB_ICONSTOP|MB_OK "A newer Nearly version is already installed."
      SetErrorLevel 4
      Abort
    ${EndIf}
  ${EndIf}
  Call NearlyWaitUpdateParent
  !insertmacro NearlyRequireClosed
FunctionEnd

Function NearlySkipPassive
  ${If} $NearlyPassive = 1
    Abort
  ${EndIf}
FunctionEnd
Function NearlyRun
  ; Explicit unchecked finish-page action only. Silent installs never launch.
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

Function .onInstSuccess
  ; Manual setup behavior is unchanged. Update success additionally requires the
  ; restarted app's authenticated native health and a bounded live handshake.
  ${If} $NearlyUpdateMode = 1
    System::Call 'kernel32::SetEvent(p $NearlyInstalledHandle) i.r0'
    StrCmp $0 0 nearly_update_health_failed
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "--nearly-update-health=$NearlyReady"
    System::Call 'kernel32::WaitForSingleObject(p $NearlyHealthyHandle, i 30000) i.r0'
    StrCmp $0 0 nearly_update_health_complete
    nearly_update_health_failed:
      SetErrorLevel 9
      DetailPrint "Update restart health was not confirmed. RecoveryRequired: verified recovery artifacts were retained. Open Nearly normally or repair Setup manually."
      Return
    nearly_update_health_complete:
      SetErrorLevel 0
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ; Close only handles. Never remove staged installers or recovery artifacts.
  StrCmp $NearlyInstalledHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyInstalledHandle)'
  StrCmp $NearlyHealthyHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyHealthyHandle)'
  StrCmp $NearlyAbortHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyAbortHandle)'
  StrCmp $NearlyCommitHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyCommitHandle)'
FunctionEnd

!macro NearlyApplyShortcut path enabled
  ${If} ${FileExists} "${path}"
    !insertmacro NearlyIsShortcutTarget "${path}"
    Pop $0
    ${If} $0 = 1
      ${If} ${enabled} != 1
        Delete "${path}"
      ${EndIf}
    ${Else}
      DetailPrint "Existing foreign shortcut left unchanged: ${path}"
    ${EndIf}
  ${ElseIf} ${enabled} = 1
    CreateShortcut "${path}" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${EndIf}
!macroend

Section Install
  ${If} $NearlyUpdateMode = 1
    System::Call 'kernel32::WaitForSingleObject(p $NearlyAbortHandle, i 0) i.r0'
    ${If} $0 != 258
      SetErrorLevel 8
      Abort "Update was cancelled before installation. No installation changes were made."
    ${EndIf}
  ${EndIf}
  GetFullPathName $0 "$LOCALAPPDATA\${PRODUCTNAME}"
  ${If} $INSTDIR != $0
    SetErrorLevel 5
    Abort "$(NearlyCannotWrite)"
  ${EndIf}
  ; Recheck immediately before mutation; a running app is never stopped.
  !insertmacro NearlyRequireTargetDirectory
  Call NearlyCheckInstallOwnership
  !insertmacro NearlyRequireClosed
  CreateDirectory "$INSTDIR"
  System::Call 'kernel32::GetCurrentProcessId() i.r8'
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\.nearly-installer-probe-$8.tmp", i 0x40010000, i 0, p 0, i 1, i 0x04000100, p 0) p.r9'
  ${If} $9 P= -1
    SetErrorLevel 5
    Abort "$(NearlyCannotWrite)"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r9)'
  SetOutPath "$INSTDIR"
  ClearErrors
  File "/oname=${MAINBINARYNAME}.exe" "${MAINBINARYSRCPATH}"
  ${If} ${Errors}
    SetErrorLevel 6
    Abort "$(NearlyPayloadError)"
  ${EndIf}
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ${If} ${Errors}
    SetErrorLevel 6
    Abort "$(NearlyPayloadError)"
  ${EndIf}
  ClearErrors
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${PUBLICVERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "NearlyInternalVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINSTKEY}" "NearlyOwner" "${BUNDLEID}"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "{{estimated_size}}"
  ${If} ${Errors}
    SetErrorLevel 6
    Abort "Setup could not finish per-user registration. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped."
  ${EndIf}
  ; /NS is an invocation-only override; keep saved user choices unchanged.
  ${If} $NearlyNoShortcuts != 1
    ClearErrors
    WriteRegDWORD HKCU "${PREFSKEY}" "StartMenuShortcut" $NearlyStartMenu
    WriteRegDWORD HKCU "${PREFSKEY}" "DesktopShortcut" $NearlyDesktop
    CreateDirectory "$SMPROGRAMS\${PRODUCTNAME}"
    !insertmacro NearlyApplyShortcut "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk" $NearlyStartMenu
    !insertmacro NearlyApplyShortcut "$DESKTOP\${PRODUCTNAME}.lnk" $NearlyDesktop
    ${If} ${Errors}
      SetErrorLevel 6
      Abort "Setup could not finish shortcut preferences. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped."
    ${EndIf}
    RMDir "$SMPROGRAMS\${PRODUCTNAME}"
  ${EndIf}
  ${If} $NearlyPassive = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function un.onInit
  !insertmacro NearlyContext
  GetFullPathName $0 "$LOCALAPPDATA\${PRODUCTNAME}"
  GetFullPathName $1 "$INSTDIR"
  ${If} $0 != $1
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyWrongFolder)"
    SetErrorLevel 5
    Abort
  ${EndIf}
  !insertmacro NearlyRequireTargetDirectory
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyOwner"
  ${If} $0 != "${BUNDLEID}"
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyWrongFolder)"
    SetErrorLevel 5
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  ${If} $0 != ""
    GetFullPathName $0 "$0"
  ${EndIf}
  ${If} $0 != $1
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "$(NearlyWrongFolder)"
    SetErrorLevel 5
    Abort
  ${EndIf}
  !insertmacro NearlyRequireClosed
FunctionEnd

Section Uninstall
  !insertmacro NearlyRequireTargetDirectory
  !insertmacro NearlyRequireClosed
  ClearErrors
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} ${Errors}
    SetErrorLevel 6
    Abort "$(NearlyPayloadError)"
  ${EndIf}
  !insertmacro NearlyApplyShortcut "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk" 0
  !insertmacro NearlyApplyShortcut "$DESKTOP\${PRODUCTNAME}.lnk" 0
  RMDir "$SMPROGRAMS\${PRODUCTNAME}"
  Delete "$INSTDIR\uninstall.exe"
  DeleteRegKey HKCU "${UNINSTKEY}"
  ; Preferences and all user data remain. Nonrecursive removal only succeeds
  ; for an empty folder; settings.json, backups and WebView data prevent it.
  RMDir "$INSTDIR"
SectionEnd
