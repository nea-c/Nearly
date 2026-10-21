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
Var NearlyProtocol
Var NearlyCommitHandle
Var NearlyStageDirectory
Var NearlyReadyHandle
Var NearlyMutationHandle
Var NearlyWorkerPid
Var NearlyWorkerCreated
Var NearlyRequestedRoot
Var NearlyRegisteredRoot
Var NearlyDefaultRoot
Var NearlyGuardHead
Var NearlyLeafNode
Var NearlyWalk
Var NearlyIndex
Var NearlyHandle
Var NearlyPayload
Var NearlyRootMissing
Var NearlyEnum
Var NearlyEntry
Var NearlyFindData
Var NearlyImageHandle
Var NearlyRegisteredImageHandle
Var NearlyImageBuffer
Var NearlyOtherBuffer
Var NearlyImageRemaining
Var NearlyImageSize
Var NearlyImageChunk
Var NearlyPendingBuffer
Var NearlySnapshot
Var NearlyMainSnapshot
Var NearlyUninstallerSnapshot
Var NearlyIoSource
Var NearlyIoDest
Var NearlyIoMain
Var NearlyIoUninstaller
Var NearlyIoDestNew
Var NearlyIoMainNew
Var NearlyIoUninstallerNew
Var NearlyIoWriteHandle
Var NearlyIoBuffer
Var NearlyIoInfo
Var NearlyIoSize
Var NearlyIoTotal
Var NearlyIoRemaining
Var NearlyIoChunk
Var NearlyIoExpected
Var NearlyIoDisposition
Var NearlyImageDeleteMode
Var NearlyImageAccess
Var NearlyImageShare
Var NearlyRootIdentityHandle
Var NearlyRootIdentity
Var NearlyUninstallRootIdentity
Var NearlyRemoveAll
Var NearlyRemoveCheckbox
Var NearlyWholeRoot
Var NearlyWholeTop
Var NearlyWholeHandle
Var NearlyWholeInfo
Var NearlyWholePath
Var NearlyWholeEntry
Var NearlyWholeDepth
Var NearlyWholeCount
Var NearlyWholeExpectedKind
Var NearlyWholeProtected
Var NearlyWholeStarted
Var NearlyWholeCursor
Var NearlyWholeNext
Var NearlyWholeAttributes
Var NearlyWholeAncestorIdentity

; Shared guard implementation. The NSIS/System ABI is 32-bit even for x64 payloads.
; Every existing ancestor is opened without FILE_SHARE_DELETE until all mutations
; finish. Actual access is enforced by Windows. Existing ACLs are never rewritten.
!macro NearlyRootFunctions prefix
Function ${prefix}NearlyRejectRoot
  StrCmp $NearlyHandle 0 nearly_reject_buffer
  StrCmp $NearlyHandle -1 nearly_reject_buffer
  System::Call 'kernel32::CloseHandle(p $NearlyHandle)'
  StrCpy $NearlyHandle 0
  nearly_reject_buffer:
  StrCmp $NearlyPendingBuffer 0 nearly_reject_guards
  System::Free $NearlyPendingBuffer
  StrCpy $NearlyPendingBuffer 0
  nearly_reject_guards:
  StrCmp $NearlyEnum 0 nearly_reject_find_buffer
  StrCmp $NearlyEnum -1 nearly_reject_find_buffer
  System::Call 'kernel32::FindClose(p $NearlyEnum)'
  nearly_reject_find_buffer:
  StrCpy $NearlyEnum 0
  StrCmp $NearlyFindData 0 nearly_reject_all_guards
  System::Free $NearlyFindData
  StrCpy $NearlyFindData 0
  nearly_reject_all_guards:
  Call ${prefix}NearlyReleaseGuards
  SetErrorLevel 5
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "$(NearlyCannotWrite)"
  Abort "$(NearlyCannotWrite)"
FunctionEnd

Function ${prefix}NearlyValidatePath
  StrLen $0 $INSTDIR
  IntCmp $0 176 0 0 nearly_path_bad
  IntCmp $0 3 nearly_path_bad nearly_path_bad
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0x80, w "$INSTDIR", i -1, p 0, i 0, p 0, p 0) i.r0'
  StrCmp $0 0 nearly_path_bad
  IntCmp $0 513 0 0 nearly_path_bad
  StrCpy $1 $INSTDIR 1
  System::Call 'kernel32::lstrcmpiW(w r1, w "A") i.r2'
  IntCmp $2 0 0 nearly_path_bad
  System::Call 'kernel32::lstrcmpiW(w r1, w "Z") i.r2'
  IntCmp $2 0 0 0 nearly_path_bad
  StrCpy $1 $INSTDIR 2 1
  StrCmp $1 ":\" 0 nearly_path_bad
  StrCpy $0 3
  StrCpy $3 ""
  nearly_path_character:
  StrCpy $1 $INSTDIR 1 $0
  StrCmp $1 "" nearly_path_component
  StrCmp $1 "\" nearly_path_component
  StrCmp $1 "/" nearly_path_bad
  StrCmp $1 ":" nearly_path_bad
  StrCmp $1 "?" nearly_path_bad
  StrCmp $1 "*" nearly_path_bad
  StrCmp $1 '$\"' nearly_path_bad
  StrCmp $1 "<" nearly_path_bad
  StrCmp $1 ">" nearly_path_bad
  StrCmp $1 "|" nearly_path_bad
  System::Call 'kernel32::GetStringTypeW(i 1, w r1, i 1, *i .r2) i.r4'
  StrCmp $4 0 nearly_path_bad
  IntOp $2 $2 & 0x20
  StrCmp $2 0 0 nearly_path_bad
  StrCpy $3 "$3$1"
  IntOp $0 $0 + 1
  Goto nearly_path_character
  nearly_path_component:
  StrCmp $3 "" nearly_path_bad
  StrCpy $2 $3 1 -1
  StrCmp $2 "." nearly_path_bad
  StrCmp $2 " " nearly_path_bad
  StrCpy $2 $3 1
  StrCmp $2 " " nearly_path_bad
  StrCpy $4 0
  nearly_path_stem:
  StrCpy $2 $3 1 $4
  StrCmp $2 "" nearly_path_stem_done
  StrCmp $2 "." nearly_path_stem_done
  IntOp $4 $4 + 1
  Goto nearly_path_stem
  nearly_path_stem_done:
  StrCpy $2 $3 $4
  StrCmp $2 "CON" nearly_path_bad
  StrCmp $2 "PRN" nearly_path_bad
  StrCmp $2 "AUX" nearly_path_bad
  StrCmp $2 "NUL" nearly_path_bad
  StrCmp $2 "CONIN$$" nearly_path_bad
  StrCmp $2 "CONOUT$$" nearly_path_bad
  StrLen $4 $2
  StrCmp $4 4 0 nearly_path_not_device
  StrCpy $4 $2 3
  StrCmp $4 "COM" nearly_path_device_digit
  StrCmp $4 "LPT" nearly_path_device_digit nearly_path_not_device
  nearly_path_device_digit:
  StrCpy $4 $2 1 3
  StrCmp $4 "1" nearly_path_bad
  StrCmp $4 "2" nearly_path_bad
  StrCmp $4 "3" nearly_path_bad
  StrCmp $4 "4" nearly_path_bad
  StrCmp $4 "5" nearly_path_bad
  StrCmp $4 "6" nearly_path_bad
  StrCmp $4 "7" nearly_path_bad
  StrCmp $4 "8" nearly_path_bad
  StrCmp $4 "9" nearly_path_bad
  StrCmp $4 "¹" nearly_path_bad
  StrCmp $4 "²" nearly_path_bad
  StrCmp $4 "³" nearly_path_bad
  nearly_path_not_device:
  StrCmp $1 "" nearly_path_canonical
  StrCpy $3 ""
  IntOp $0 $0 + 1
  Goto nearly_path_character
  nearly_path_canonical:
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
  StrCmp $0 0 nearly_path_bad
  StrCmp $1 $INSTDIR 0 nearly_path_bad
  StrCpy $1 $INSTDIR 3
  System::Call 'kernel32::GetDriveTypeW(w r1) i.r0'
  StrCmp $0 3 0 nearly_path_bad
  ; Fail closed on filesystems without the NTFS identity/ACL guarantees used here.
  System::Call 'kernel32::GetVolumeInformationW(w r1, p 0, i 0, p 0, p 0, p 0, w .r2, i ${NSIS_MAX_STRLEN}) i.r0'
  StrCmp $0 1 0 nearly_path_bad
  StrCmp $2 "NTFS" 0 nearly_path_bad
  Return
  nearly_path_bad:
  Call ${prefix}NearlyRejectRoot
FunctionEnd

Function ${prefix}NearlyPinDirectory
  ; OPEN_REPARSE_POINT | BACKUP_SEMANTICS. Share read/write, never delete.
  System::Call 'kernel32::CreateFileW(w "$NearlyWalk", i 0x81, i 3, p 0, i 3, i 0x02200000, p 0) p.s'
  Pop $NearlyHandle
  StrCmp $NearlyHandle -1 nearly_pin_bad
  System::Alloc 52
  Pop $0
  StrCpy $NearlyPendingBuffer $0
  StrCmp $0 0 nearly_pin_bad
  System::Call 'kernel32::GetFileInformationByHandle(p $NearlyHandle, p r0) i.r1'
  System::Call '*$0(i .r2)'
  System::Free $0
  StrCpy $NearlyPendingBuffer 0
  StrCmp $1 1 0 nearly_pin_bad
  IntOp $2 $2 & 0x410
  IntCmp $2 0x10 0 nearly_pin_bad nearly_pin_bad
  ; Reject SUBST, short-name aliases and namespace redirects, using this handle.
  System::Call 'kernel32::GetFinalPathNameByHandleW(p $NearlyHandle, w .r1, i ${NSIS_MAX_STRLEN}, i 0) i.r0'
  StrCmp $0 0 nearly_pin_bad
  StrCmp $1 "\\?\$NearlyWalk" 0 nearly_pin_bad
  System::Alloc 8
  Pop $0
  StrCmp $0 0 nearly_pin_bad
  System::Call '*$0(p $NearlyGuardHead, p $NearlyHandle)'
  StrCpy $NearlyGuardHead $0
  StrCpy $NearlyHandle 0
  StrCpy $NearlyPendingBuffer 0
  Return
  nearly_pin_bad:
  Call ${prefix}NearlyRejectRoot
FunctionEnd

Function ${prefix}NearlyPinRoot
  Call ${prefix}NearlyValidatePath
  StrCpy $NearlyRootMissing 0
  StrCpy $NearlyLeafNode 0
  StrCpy $NearlyWalk $INSTDIR 3
  ; Namespace admission is independent from inherited OS access permissions.
  System::Call 'kernel32::GetVolumeNameForVolumeMountPointW(w "$NearlyWalk", w .r0, i ${NSIS_MAX_STRLEN}) i.r1'
  StrCmp $1 1 0 nearly_root_bad
  Call ${prefix}NearlyPinDirectory
  StrCpy $NearlyIndex 3
  nearly_root_character:
  StrCpy $0 $INSTDIR 1 $NearlyIndex
  StrCmp $0 "" nearly_root_final
  StrCmp $0 "\" nearly_root_ancestor
  StrCpy $NearlyWalk "$NearlyWalk$0"
  IntOp $NearlyIndex $NearlyIndex + 1
  Goto nearly_root_character
  nearly_root_ancestor:
  Call ${prefix}NearlyPinDirectory
  StrCpy $NearlyWalk "$NearlyWalk\"
  IntOp $NearlyIndex $NearlyIndex + 1
  Goto nearly_root_character
  nearly_root_final:
  System::Call 'kernel32::GetFileAttributesW(w "$NearlyWalk") i.r0 ?e'
  Pop $1
  StrCmp $0 -1 0 nearly_root_present
  StrCpy $0 $1
  StrCmp $0 2 0 nearly_root_bad
  StrCpy $NearlyRootMissing 1
  Return
  nearly_root_present:
  Call ${prefix}NearlyPinDirectory
  StrCpy $NearlyLeafNode $NearlyGuardHead
  Return
  nearly_root_bad:
  Call ${prefix}NearlyRejectRoot
FunctionEnd

Function ${prefix}NearlyReleaseLeaf
  StrCmp $NearlyLeafNode 0 nearly_leaf_done
  StrCmp $NearlyLeafNode $NearlyGuardHead 0 nearly_leaf_done
  System::Call '*$NearlyGuardHead(p .r0, p .r1)'
  System::Call 'kernel32::CloseHandle(p r1)'
  System::Free $NearlyGuardHead
  StrCpy $NearlyGuardHead $0
  StrCpy $NearlyLeafNode 0
  nearly_leaf_done:
FunctionEnd
Function ${prefix}NearlyReleaseGuards
  Call ${prefix}NearlyReleaseLeaf
  nearly_release_loop:
  StrCmp $NearlyGuardHead 0 nearly_release_done
  System::Call '*$NearlyGuardHead(p .r0, p .r1)'
  System::Call 'kernel32::CloseHandle(p r1)'
  System::Free $NearlyGuardHead
  StrCpy $NearlyGuardHead $0
  Goto nearly_release_loop
  nearly_release_done:
  StrCpy $NearlyLeafNode 0
FunctionEnd

Function ${prefix}NearlyValidatePayload
  StrCpy $NearlySnapshot ""
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i 0x80, i 3, p 0, i 3, i 0x00200000, p 0) p.r0 ?e'
  Pop $1
  StrCmp $0 -1 nearly_payload_absent
  StrCpy $NearlyHandle $0
  System::Alloc 52
  Pop $1
  StrCpy $NearlyPendingBuffer $1
  StrCmp $1 0 nearly_payload_bad
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p r1) i.r2'
  StrCmp $2 1 0 nearly_payload_bad
  System::Call '*$1(i .r2)'
  IntOp $3 $1 + 40
  System::Call '*$3(i .r4)' ; NumberOfLinks must be single-link.
  IntOp $3 $1 + 28
  System::Call '*$3(i .r5)'
  IntOp $3 $1 + 44
  System::Call '*$3(i .r6, i .r7)'
  StrCpy $NearlySnapshot "$5:$6:$7"
  System::Free $1
  StrCpy $NearlyPendingBuffer 0
  IntOp $2 $2 & 0x410
  StrCmp $2 0 0 nearly_payload_bad
  StrCmp $4 1 0 nearly_payload_bad
  System::Call 'kernel32::CloseHandle(p $NearlyHandle)'
  StrCpy $NearlyHandle 0
  Return
  nearly_payload_absent:
  StrCpy $0 $1
  StrCmp $0 2 0 nearly_payload_bad
  Return
  nearly_payload_bad:
  Call ${prefix}NearlyRejectRoot
FunctionEnd
Function ${prefix}NearlyValidatePayloads
  StrCpy $NearlyPayload "$INSTDIR\${MAINBINARYNAME}.exe"
  Call ${prefix}NearlyValidatePayload
  StrCpy $NearlyMainSnapshot $NearlySnapshot
  StrCpy $NearlyPayload "$INSTDIR\uninstall.exe"
  Call ${prefix}NearlyValidatePayload
  StrCpy $NearlyUninstallerSnapshot $NearlySnapshot
FunctionEnd
Function ${prefix}NearlyCaptureRootIdentity
  StrCmp $NearlyLeafNode 0 nearly_capture_bad
  System::Call '*$NearlyLeafNode(p .r0, p .r1)'
  StrCpy $NearlyRootIdentityHandle $1
  Call ${prefix}NearlyRootIdentityForHandle
  Return
  nearly_capture_bad:
  Call ${prefix}NearlyRejectRoot
FunctionEnd
Function ${prefix}NearlyRootIdentityForHandle
  System::Alloc 52
  Pop $NearlyPendingBuffer
  StrCmp $NearlyPendingBuffer 0 nearly_identity_bad
  System::Call 'kernel32::GetFileInformationByHandle(p $NearlyRootIdentityHandle, p $NearlyPendingBuffer) i.r0'
  StrCmp $0 1 0 nearly_identity_bad
  System::Call '*$NearlyPendingBuffer(i .r0)'
  IntOp $0 $0 & 0x410
  IntCmp $0 0x10 0 nearly_identity_bad nearly_identity_bad
  IntOp $0 $NearlyPendingBuffer + 28
  System::Call '*$0(i .r1)'
  IntOp $0 $NearlyPendingBuffer + 44
  System::Call '*$0(i .r2, i .r3)'
  IntFmt $4 "%08X" $1
  IntFmt $5 "%08X" $2
  IntFmt $6 "%08X" $3
  StrCpy $NearlyRootIdentity "$4:$5:$6"
  System::Free $NearlyPendingBuffer
  StrCpy $NearlyPendingBuffer 0
  Return
  nearly_identity_bad:
  Call ${prefix}NearlyRejectRoot
FunctionEnd
!macroend
!insertmacro NearlyRootFunctions ""
!insertmacro NearlyRootFunctions "un."

; NSIS File/WriteUninstaller are used only in standard NSIS temporary storage.
; Live payloads are opened without truncation, inspected and changed through
; that SAME exclusive handle. Pins alone do not stop child-file substitution.
!macro NearlyIoFunctions prefix
Function ${prefix}NearlyIoCleanup
  StrCmp $NearlyIoSource 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyIoSource)'
  StrCmp $NearlyIoDest 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyIoDest)'
  StrCmp $NearlyIoMain 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyIoMain)'
  StrCmp $NearlyIoUninstaller 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyIoUninstaller)'
  StrCmp $NearlyIoBuffer 0 +2
    System::Free $NearlyIoBuffer
  StrCmp $NearlyIoInfo 0 +2
    System::Free $NearlyIoInfo
  StrCpy $NearlyIoSource 0
  StrCpy $NearlyIoDest 0
  StrCpy $NearlyIoMain 0
  StrCpy $NearlyIoUninstaller 0
  StrCpy $NearlyIoBuffer 0
  StrCpy $NearlyIoInfo 0
FunctionEnd
Function ${prefix}NearlyIoInit
  StrCpy $NearlyIoSource 0
  StrCpy $NearlyIoDest 0
  StrCpy $NearlyIoMain 0
  StrCpy $NearlyIoUninstaller 0
  StrCpy $NearlyIoBuffer 0
  StrCpy $NearlyIoInfo 0
  StrCpy $NearlyIoDestNew 0
  StrCpy $NearlyIoMainNew 0
  StrCpy $NearlyIoUninstallerNew 0
FunctionEnd
Function ${prefix}NearlyIoFail
  ; Remove only files that THIS invocation successfully CREATE_NEW'd, through
  ; still-held handles. Never fall back to path deletion on cleanup failure.
  System::Alloc 4
  Pop $0
  StrCmp $0 0 nearly_io_fail_close
  System::Call '*$0(i 1)'
  StrCmp $NearlyIoDestNew 1 0 +2
    System::Call 'kernel32::SetFileInformationByHandle(p $NearlyIoDest, i 4, p r0, i 1)'
  StrCmp $NearlyIoMainNew 1 0 +2
    System::Call 'kernel32::SetFileInformationByHandle(p $NearlyIoMain, i 4, p r0, i 1)'
  StrCmp $NearlyIoUninstallerNew 1 0 +2
    System::Call 'kernel32::SetFileInformationByHandle(p $NearlyIoUninstaller, i 4, p r0, i 1)'
  System::Free $0
  nearly_io_fail_close:
  Call ${prefix}NearlyIoCleanup
  Call ${prefix}NearlyReleaseGuards
  SetErrorLevel 6
  Abort "$(NearlyPayloadError)"
FunctionEnd
Function ${prefix}NearlyIoInspect
  ; Input NearlyIoWriteHandle, output identity snapshot and bounded size.
  System::Call 'kernel32::GetFileType(p $NearlyIoWriteHandle) i.r0'
  StrCmp $0 1 0 nearly_io_inspect_bad
  System::Alloc 52
  Pop $NearlyIoInfo
  StrCmp $NearlyIoInfo 0 nearly_io_inspect_bad
  System::Call 'kernel32::GetFileInformationByHandle(p $NearlyIoWriteHandle, p $NearlyIoInfo) i.r0'
  StrCmp $0 1 0 nearly_io_inspect_bad
  System::Call '*$NearlyIoInfo(i .r0)'
  IntOp $0 $0 & 0x410
  StrCmp $0 0 0 nearly_io_inspect_bad
  IntOp $0 $NearlyIoInfo + 28
  System::Call '*$0(i .r1, i .r2, i .r3, i .r4, i .r5, i .r6)'
  StrCmp $2 0 0 nearly_io_inspect_bad
  StrCmp $4 1 0 nearly_io_inspect_bad
  IntCmp $3 0 0 nearly_io_inspect_bad
  IntCmp $3 67108864 0 0 nearly_io_inspect_bad
  StrCpy $NearlyIoSize $3
  StrCpy $NearlySnapshot "$1:$5:$6"
  System::Free $NearlyIoInfo
  StrCpy $NearlyIoInfo 0
  Return
  nearly_io_inspect_bad:
  Call ${prefix}NearlyIoFail
FunctionEnd
!if "${prefix}" == ""
Function ${prefix}NearlyIoOpenDestination
  StrCpy $NearlyIoDestNew 0
  StrCpy $NearlyIoDisposition 3
  StrCmp $NearlyIoExpected "" 0 nearly_io_open
  StrCpy $NearlyIoDisposition 1
  nearly_io_open:
  ; GENERIC_WRITE|READ_ATTRIBUTES|DELETE, share NONE, OPEN_REPARSE_POINT.
  ; CREATE_NEW collisions and OPEN_EXISTING misses always fail, never fallback.
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i 0x40010080, i 0, p 0, i $NearlyIoDisposition, i 0x00200000, p 0) p.r0'
  StrCmp $0 -1 nearly_io_open_bad
  StrCpy $NearlyIoDest $0
  StrCmp $NearlyIoDisposition 1 0 +2
    StrCpy $NearlyIoDestNew 1
  StrCpy $NearlyIoWriteHandle $NearlyIoDest
  Call ${prefix}NearlyIoInspect
  StrCmp $NearlyIoExpected "" nearly_io_open_done
  StrCmp $NearlySnapshot $NearlyIoExpected 0 nearly_io_open_bad
  nearly_io_open_done:
  Return
  nearly_io_open_bad:
  Call ${prefix}NearlyIoFail
FunctionEnd
Function ${prefix}NearlyIoCopy
  ; Source is held against writes/deletion; destination is the verified
  ; exclusive handle. Short reads/writes are failures, never successful installs.
  StrCpy $NearlyIoTotal $NearlyIoSize
  StrCpy $NearlyIoRemaining $NearlyIoSize
  IntCmp $NearlyIoRemaining 0 nearly_io_copy_bad nearly_io_copy_bad
  ; Link metadata can be changed independently of data-sharing locks on some
  ; filesystems/APIs. Recheck the held object before changing any bytes, too.
  Call ${prefix}NearlyIoInspect
  System::Call 'kernel32::SetFilePointerEx(p $NearlyIoWriteHandle, l 0, p 0, i 0) i.r0'
  StrCmp $0 1 0 nearly_io_copy_bad
  System::Call 'kernel32::SetEndOfFile(p $NearlyIoWriteHandle) i.r0'
  StrCmp $0 1 0 nearly_io_copy_bad
  System::Alloc 65536
  Pop $NearlyIoBuffer
  StrCmp $NearlyIoBuffer 0 nearly_io_copy_bad
  nearly_io_copy_loop:
  StrCmp $NearlyIoRemaining 0 nearly_io_copy_done
  StrCpy $NearlyIoChunk $NearlyIoRemaining
  IntCmp $NearlyIoChunk 65536 nearly_io_copy_chunk nearly_io_copy_chunk
  StrCpy $NearlyIoChunk 65536
  nearly_io_copy_chunk:
  System::Call 'kernel32::ReadFile(p $NearlyIoSource, p $NearlyIoBuffer, i $NearlyIoChunk, *i .r1, p 0) i.r0'
  StrCmp $0 1 0 nearly_io_copy_bad
  StrCmp $1 $NearlyIoChunk 0 nearly_io_copy_bad
  System::Call 'kernel32::WriteFile(p $NearlyIoWriteHandle, p $NearlyIoBuffer, i $NearlyIoChunk, *i .r1, p 0) i.r0'
  StrCmp $0 1 0 nearly_io_copy_bad
  StrCmp $1 $NearlyIoChunk 0 nearly_io_copy_bad
  IntOp $NearlyIoRemaining $NearlyIoRemaining - $NearlyIoChunk
  Goto nearly_io_copy_loop
  nearly_io_copy_done:
  System::Call 'kernel32::FlushFileBuffers(p $NearlyIoWriteHandle) i.r0'
  StrCmp $0 1 0 nearly_io_copy_bad
  Call ${prefix}NearlyIoInspect
  StrCmp $NearlyIoSize $NearlyIoTotal 0 nearly_io_copy_bad
  System::Free $NearlyIoBuffer
  StrCpy $NearlyIoBuffer 0
  System::Call 'kernel32::CloseHandle(p $NearlyIoSource)'
  StrCpy $NearlyIoSource 0
  Return
  nearly_io_copy_bad:
  Call ${prefix}NearlyIoFail
FunctionEnd
!else
Function ${prefix}NearlyIoDelete
  ; FILE_DISPOSITION_INFO is one BOOLEAN byte. DELETE access was acquired
  ; on this same verified handle; never reopen the name to perform deletion.
  System::Alloc 4
  Pop $NearlyIoInfo
  StrCmp $NearlyIoInfo 0 nearly_io_delete_bad
  System::Call '*$NearlyIoInfo(i 1)'
  System::Call 'kernel32::SetFileInformationByHandle(p $NearlyIoWriteHandle, i 4, p $NearlyIoInfo, i 1) i.r0'
  System::Free $NearlyIoInfo
  StrCpy $NearlyIoInfo 0
  StrCmp $0 1 0 nearly_io_delete_bad
  Return
  nearly_io_delete_bad:
  Call ${prefix}NearlyIoFail
FunctionEnd
!endif
!macroend
!insertmacro NearlyIoFunctions ""
!insertmacro NearlyIoFunctions "un."

Function NearlyWritePayloads
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  Call NearlyExtractApplication
  IfErrors nearly_write_bad
  WriteUninstaller "$PLUGINSDIR\uninstall.exe"
  IfErrors nearly_write_bad
  ; Capture each expected live identity, then retain both destination handles
  ; before the first truncation. Existing-file substitution is never accepted.
  Call NearlyValidatePayloads
  StrCpy $NearlyPayload "$INSTDIR\${MAINBINARYNAME}.exe"
  StrCpy $NearlyIoExpected $NearlyMainSnapshot
  Call NearlyIoOpenDestination
  StrCpy $NearlyIoMain $NearlyIoDest
  StrCpy $NearlyIoMainNew $NearlyIoDestNew
  StrCpy $NearlyIoDest 0
  StrCpy $NearlyIoDestNew 0
  StrCpy $NearlyPayload "$INSTDIR\uninstall.exe"
  StrCpy $NearlyIoExpected $NearlyUninstallerSnapshot
  Call NearlyIoOpenDestination
  StrCpy $NearlyIoUninstaller $NearlyIoDest
  StrCpy $NearlyIoUninstallerNew $NearlyIoDestNew
  StrCpy $NearlyIoDest 0
  StrCpy $NearlyIoDestNew 0
  StrCpy $NearlyPayload "$PLUGINSDIR\${MAINBINARYNAME}.exe"
  Call NearlyOpenCopySource
  StrCpy $NearlyIoWriteHandle $NearlyIoMain
  Call NearlyIoCopy
  StrCpy $NearlyPayload "$PLUGINSDIR\uninstall.exe"
  Call NearlyOpenCopySource
  StrCpy $NearlyIoWriteHandle $NearlyIoUninstaller
  Call NearlyIoCopy
  Return
  nearly_write_bad:
  Call NearlyIoFail
FunctionEnd
Function NearlyOpenCopySource
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i 0x80000080, i 1, p 0, i 3, i 0x00200000, p 0) p.r0'
  StrCmp $0 -1 nearly_copy_source_bad
  StrCpy $NearlyIoSource $0
  StrCpy $NearlyIoWriteHandle $0
  Call NearlyIoInspect
  Return
  nearly_copy_source_bad:
  Call NearlyIoFail
FunctionEnd

!macro NearlyUserFunctions prefix
Function ${prefix}NearlyRequireStandardUser
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i.r0'
  StrCmp $0 1 0 nearly_user_bad
  System::Call 'advapi32::GetTokenInformation(p r1, i 20, *i .r2, i 4, *i .r3) i.r0'
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCmp $0 1 0 nearly_user_bad
  StrCmp $2 0 nearly_user_done
  nearly_user_bad:
  SetErrorLevel 8
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "$(NearlyNoElevation)"
  Abort "$(NearlyNoElevation)"
  nearly_user_done:
FunctionEnd
!macroend
!insertmacro NearlyUserFunctions ""
!insertmacro NearlyUserFunctions "un."

; NSIS GetFullPathName requires the final filesystem entry to exist. The
; default may be absent when an owned installation uses a custom directory.
; Win32 computes the lexical absolute name without creating any directory.
Function NearlySetDefaultRoot
  System::Call 'kernel32::GetFullPathNameW(w "$LOCALAPPDATA\${PRODUCTNAME}", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
  StrCmp $0 0 nearly_default_bad
  IntCmp $0 ${NSIS_MAX_STRLEN} nearly_default_bad nearly_default_good nearly_default_bad
  nearly_default_good:
  StrCmp $1 "" nearly_default_bad
  StrCpy $NearlyDefaultRoot $1
  Return
  nearly_default_bad:
  Call NearlyRejectRoot
FunctionEnd

Function NearlyResolveRegistration
  StrCpy $NearlyRegisteredRoot ""
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyOwner"
  ReadRegStr $1 HKCU "${UNINSTKEY}" "InstallLocation"
  StrCmp $0 "" 0 nearly_resolve_owned
  StrCmp $1 "" 0 nearly_resolve_bad
  Return
  nearly_resolve_owned:
  StrCmp $0 "${BUNDLEID}" 0 nearly_resolve_bad
  StrCmp $1 "" nearly_resolve_bad
  StrCpy $NearlyRegisteredRoot $1
  ; /D is NSIS's special last argument; it is not exposed by GetParameters.
  ; A fresh UI choice updates RequestedRoot; owned registration never migrates.
  StrCmp $NearlyRequestedRoot $NearlyDefaultRoot nearly_resolve_use
  StrCmp $NearlyRequestedRoot $NearlyRegisteredRoot 0 nearly_resolve_bad
  nearly_resolve_use:
  StrCpy $INSTDIR $NearlyRegisteredRoot
  ReadRegStr $0 HKCU "${UNINSTKEY}" "UninstallString"
  StrCmp $0 '"$INSTDIR\uninstall.exe"' 0 nearly_resolve_bad
  Call NearlyPinRoot
  StrCmp $NearlyRootMissing 0 0 nearly_resolve_bad
  Return
  nearly_resolve_bad:
  Call NearlyRejectRoot
FunctionEnd

Function NearlyRequireFreshContents
  StrCmp $NearlyOwnedUpgrade 1 nearly_contents_done
  StrCmp $NearlyRootMissing 1 nearly_contents_done
  System::Alloc 592
  Pop $NearlyFindData
  StrCmp $NearlyFindData 0 nearly_contents_bad
  System::Call 'kernel32::FindFirstFileW(w "$INSTDIR\*", p $NearlyFindData) p.r0 ?e'
  Pop $1
  StrCpy $NearlyEnum $0
  StrCmp $NearlyEnum -1 0 nearly_contents_loop
  StrCpy $0 $1
  StrCmp $0 2 nearly_contents_free nearly_contents_bad
  nearly_contents_loop:
  IntOp $0 $NearlyFindData + 44
  System::Call '*$0(&w260 .s)'
  Pop $NearlyEntry
  StrCmp $NearlyEntry "" nearly_contents_close
  StrCmp $NearlyEntry "." nearly_contents_next
  StrCmp $NearlyEntry ".." nearly_contents_next
  ; Only known data leaves may survive an unregistered reinstall at any root.
  StrCmp $NearlyEntry "build-info.json" nearly_contents_file
  StrCmp $NearlyEntry "settings.json" nearly_contents_file
  StrCmp $NearlyEntry "settings.backup.json" nearly_contents_file
  StrCmp $NearlyEntry "history.json" nearly_contents_file
  StrCmp $NearlyEntry "history.backup.json" nearly_contents_file
  StrCmp $NearlyEntry "bookmarks.json" nearly_contents_file
  StrCmp $NearlyEntry "bookmarks.backup.json" nearly_contents_file
  StrCmp $NearlyEntry "sync-profiles.json" nearly_contents_file
  StrCmp $NearlyEntry "sync-profiles.backup.json" nearly_contents_file
  StrCmp $NearlyEntry "connections.json" nearly_contents_file
  StrCmp $NearlyEntry "connections.backup.json" nearly_contents_file
  StrCmp $NearlyEntry "Nearly.exe.WebView2" nearly_contents_webview nearly_contents_bad
  nearly_contents_webview:
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\$NearlyEntry") i.r0'
  IntOp $0 $0 & 0x410
  IntCmp $0 0x10 nearly_contents_next nearly_contents_bad nearly_contents_bad
  nearly_contents_file:
  StrCpy $NearlyPayload "$INSTDIR\$NearlyEntry"
  Call NearlyValidatePayload
  nearly_contents_next:
  System::Call 'kernel32::FindNextFileW(p $NearlyEnum, p $NearlyFindData) i.r0 ?e'
  Pop $1
  StrCmp $0 1 nearly_contents_loop
  StrCpy $0 $1
  StrCmp $0 18 0 nearly_contents_bad
  nearly_contents_close:
  System::Call 'kernel32::FindClose(p $NearlyEnum)'
  nearly_contents_free:
  System::Free $NearlyFindData
  StrCpy $NearlyFindData 0
  StrCpy $NearlyEnum 0
  nearly_contents_done:
  Return
  nearly_contents_bad:
  StrCmp $NearlyEnum 0 nearly_contents_free_error
  StrCmp $NearlyEnum -1 nearly_contents_free_error
  System::Call 'kernel32::FindClose(p $NearlyEnum)'
  StrCpy $NearlyEnum 0
  nearly_contents_free_error:
  StrCmp $NearlyFindData 0 nearly_contents_release_error
  System::Free $NearlyFindData
  StrCpy $NearlyFindData 0
  nearly_contents_release_error:
  StrCpy $NearlyEnum 0
  Call NearlyReleaseGuards
  SetErrorLevel 7
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "$(NearlyExistingFiles)"
  Abort "$(NearlyExistingFiles)"
FunctionEnd

Function NearlyDirectoryPre
  ${If} ${Silent}
  ${OrIf} $NearlyPassive = 1
  ${OrIf} $NearlyOwnedUpgrade = 1
    Abort
  ${EndIf}
FunctionEnd
Function NearlyDirectoryLeave
  Call NearlyReleaseGuards
  StrCpy $NearlyRequestedRoot $INSTDIR
  Call NearlyValidatePath
  ; Browse/Next only pins and inspects the selected namespace.
  Call NearlyPinRoot
  Call NearlyCheckInstallOwnership
  Call NearlyRequireFreshContents
  Call NearlyReleaseGuards
FunctionEnd

; Validate canonical unsigned decimal before System converts PID/FILETIME input.
; Compare equal-length decimal strings digit-by-digit: never parse a possibly
; overflowing 64-bit string with NSIS's signed 32-bit integer instructions.
!macro NearlyStageDecimal value maximum label
  StrLen $1 "${value}"
  StrLen $2 "${maximum}"
  IntCmp $1 $2 ${label}_digits ${label}_digits nearly_stage_reject
  ${label}_digits:
  StrCmp $1 0 nearly_stage_reject
  StrCpy $3 "${value}" 1
  StrCmp $3 "0" nearly_stage_reject
  StrCpy $3 0
  ${label}_digit_loop:
    StrCpy $4 "${value}" 1 $3
    StrCmp $4 "" ${label}_digits_done
    StrCpy $5 0
    ${label}_find_digit:
      StrCpy $6 "0123456789" 1 $5
      StrCmp $6 "" nearly_stage_reject
      StrCmp $4 $6 ${label}_digit_ok
      IntOp $5 $5 + 1
      Goto ${label}_find_digit
    ${label}_digit_ok:
    IntOp $3 $3 + 1
    Goto ${label}_digit_loop
  ${label}_digits_done:
  IntCmp $1 $2 ${label}_bound_start ${label}_done nearly_stage_reject
  ${label}_bound_start:
  StrCpy $3 0
  ${label}_bound_loop:
    StrCpy $4 "${value}" 1 $3
    StrCmp $4 "" ${label}_done
    StrCpy $5 "${maximum}" 1 $3
    IntCmp $4 $5 ${label}_bound_equal ${label}_done nearly_stage_reject
    ${label}_bound_equal:
    IntOp $3 $3 + 1
    Goto ${label}_bound_loop
  ${label}_done:
!macroend

; Protocol 2 cannot enter ordinary setup in a protocol-3 package.
Function NearlyWaitUpdateParent
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NEARLY" $1
  ${IfNot} ${Errors}
    SetErrorLevel 8
    Abort "Unsupported or malformed update mode. No installation changes were made."
  ${EndIf}
FunctionEnd

; The helper owns the mutation mutex. Its exact retained identity and fresh
; authorization event are required before the worker can write staging output.
Function NearlyStageUpdate
  StrCpy $NearlyUpdateMode 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NEARLYSTAGE" $1
  ${If} ${Errors}
    Return
  ${EndIf}
  StrCmp $1 "" 0 nearly_stage_reject
  ${GetOptions} $0 "/NEARLYPROTOCOL=" $NearlyProtocol
  StrCmp $NearlyProtocol "3" 0 nearly_stage_reject
  ${GetOptions} $0 "/NEARLYHELPER=" $NearlyParent
  ${GetOptions} $0 "/NEARLYCREATED=" $NearlyCreated
  ${GetOptions} $0 "/NEARLYNONCE=" $NearlyReady
  ; Exact ordered grammar rejects duplicates, /D, mixed modes, and extra args.
  StrCpy $1 "/NEARLYSTAGE /NEARLYPROTOCOL=3 /NEARLYHELPER=$NearlyParent /NEARLYCREATED=$NearlyCreated /NEARLYNONCE=$NearlyReady"
  StrCmp $0 $1 0 nearly_stage_reject
  !insertmacro NearlyStageDecimal $NearlyParent "4294967295" nearly_stage_parent
  !insertmacro NearlyStageDecimal $NearlyCreated "18446744073709551615" nearly_stage_created
  StrLen $1 $NearlyReady
  StrCmp $1 32 0 nearly_stage_reject
  StrCpy $2 0
  nearly_stage_nonce_loop:
    StrCpy $3 $NearlyReady 1 $2
    StrCmp $3 "" nearly_stage_nonce_done
    StrCpy $4 0
    nearly_stage_hex_loop:
      StrCpy $5 "0123456789abcdef" 1 $4
      StrCmp $5 "" nearly_stage_reject
      StrCmpS $3 $5 nearly_stage_hex_ok
      IntOp $4 $4 + 1
      Goto nearly_stage_hex_loop
    nearly_stage_hex_ok:
    IntOp $2 $2 + 1
    Goto nearly_stage_nonce_loop
  nearly_stage_nonce_done:
  System::Call 'kernel32::OpenProcess(i 0x00101000, i 0, i $NearlyParent) p.s'
  Pop $NearlyParentHandle
  StrCmp $NearlyParentHandle 0 nearly_stage_reject
  System::Call 'kernel32::GetProcessTimes(p $NearlyParentHandle, *l .r1, *l .r2, *l .r3, *l .r4) i.r5'
  StrCmp $5 0 nearly_stage_reject
  StrCmp $1 $NearlyCreated 0 nearly_stage_reject
  StrCpy $1 ${NSIS_MAX_STRLEN}
  System::Call 'kernel32::QueryFullProcessImageNameW(p $NearlyParentHandle, i 0, w .r2, *i r1) i.r3'
  StrCmp $3 0 nearly_stage_reject
  GetFullPathName $2 "$2"
  StrCmp $2 "$INSTDIR\.Nearly-update-state\$NearlyReady\previous-image.exe" 0 nearly_stage_reject
  System::Call 'kernel32::WaitForSingleObject(p $NearlyParentHandle, i 0) i.r1'
  StrCmp $1 258 0 nearly_stage_reject
  System::Call 'kernel32::GetCurrentProcessId() i.s'
  Pop $NearlyWorkerPid
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'kernel32::GetProcessTimes(p r0, *l .r1, *l .r2, *l .r3, *l .r4) i.r5'
  StrCmp $5 0 nearly_stage_reject
  StrCpy $NearlyWorkerCreated $1
  ; Helper can derive this exact worker identity only after CreateProcess.
  ; Bound event discovery/authorization without trusting a relayed descendant.
  StrCpy $7 100
  nearly_stage_authorize_wait:
  System::Call 'kernel32::WaitForSingleObject(p $NearlyParentHandle, i 0) i.r1'
  StrCmp $1 258 0 nearly_stage_reject
  System::Call 'kernel32::OpenEventW(i 0x00100000, i 0, w "Local\NearlyStageAuthorize-$NearlyReady-$NearlyWorkerPid-$NearlyWorkerCreated") p.s'
  Pop $NearlyCommitHandle
  StrCmp $NearlyCommitHandle 0 nearly_stage_authorize_retry
  System::Call 'kernel32::WaitForSingleObject(p $NearlyCommitHandle, i 0) i.r1'
  StrCmp $1 0 nearly_stage_authorized
  StrCmp $1 258 0 nearly_stage_reject
  System::Call 'kernel32::CloseHandle(p $NearlyCommitHandle)'
  StrCpy $NearlyCommitHandle 0
  nearly_stage_authorize_retry:
  IntOp $7 $7 - 1
  IntCmp $7 0 nearly_stage_reject nearly_stage_reject 0
  Sleep 50
  Goto nearly_stage_authorize_wait
  nearly_stage_authorized:
  System::Call 'kernel32::OpenEventW(i 0x00100002, i 0, w "Local\NearlyStageReady-$NearlyReady-$NearlyWorkerPid-$NearlyWorkerCreated") p.s'
  Pop $NearlyReadyHandle
  StrCmp $NearlyReadyHandle 0 nearly_stage_reject
  System::Call 'kernel32::WaitForSingleObject(p $NearlyReadyHandle, i 0) i.r1'
  StrCmp $1 258 0 nearly_stage_reject
  StrCpy $NearlyStageDirectory "$INSTDIR\.Nearly-update-state\$NearlyReady\candidate"
  System::Call 'kernel32::GetFileAttributesW(w "$NearlyStageDirectory") i.r5'
  IntOp $6 $5 & 0x410
  IntCmp $6 0x10 0 nearly_stage_reject nearly_stage_reject
  System::Call 'kernel32::SetEvent(p $NearlyReadyHandle) i.r1'
  StrCmp $1 0 nearly_stage_reject
  StrCpy $NearlyUpdateMode 3
  StrCpy $NearlyPassive 1
  SetSilent silent
  Return
  nearly_stage_reject:
    SetErrorLevel 8
    Abort "Protocol-3 stage authentication failed; live installation was not changed."
FunctionEnd

; One File instruction produces one archive member, shared by both paths.
; Callers establish and validate OUTDIR before invoking this function.
Function NearlyExtractApplication
  File "/oname=${MAINBINARYNAME}.exe" "${MAINBINARYSRCPATH}"
FunctionEnd

Function NearlyExtractStage
  ; Native helper pins every ancestor and verifies exact worker exit and all
  ; output identities before promotion. This section never touches live files.
  System::Call 'kernel32::WaitForSingleObject(p $NearlyParentHandle, i 0) i.r0'
  StrCmp $0 258 0 nearly_stage_extract_reject
  ClearErrors
  SetOutPath "$NearlyStageDirectory"
  ${If} ${Errors}
    Goto nearly_stage_extract_reject
  ${EndIf}
  ClearErrors
  Call NearlyExtractApplication
  ${If} ${Errors}
    Goto nearly_stage_extract_reject
  ${EndIf}
  WriteUninstaller "$NearlyStageDirectory\uninstall.exe"
  ${If} ${Errors}
    Goto nearly_stage_extract_reject
  ${EndIf}
  SetErrorLevel 0
  Return
  nearly_stage_extract_reject:
    SetErrorLevel 6
    Abort "Staging failed; retained recovery evidence requires inspection."
FunctionEnd

; Cross-session cooperative exclusion for new setup, uninstall, and helper.
; One Global application mutex conservatively serializes different users too.
; Older/external registry writers do not participate in this mutex protocol.
!macro NearlyAcquireMutationBody
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "Global\NearlyInstallMutation-local.syncfiles.native-v3") p.r0 ?e'
  Pop $1
  StrCpy $NearlyMutationHandle $0
  StrCpy $0 $1
  ${If} $NearlyMutationHandle P= 0
  ${OrIf} $0 = 183
    SetErrorLevel 8
    Abort "Another Nearly installation transaction is active."
  ${EndIf}
!macroend
Function NearlyAcquireMutation
  !insertmacro NearlyAcquireMutationBody
FunctionEnd
Function un.NearlyAcquireMutation
  !insertmacro NearlyAcquireMutationBody
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_PRE NearlySkipPassive
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE NearlyDirectoryPre
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE NearlyDirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
Page custom NearlyShortcutPage NearlyShortcutPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_FUNCTION NearlyRun
!define MUI_PAGE_CUSTOMFUNCTION_PRE NearlySkipPassive
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.NearlyRemovePage un.NearlyRemovePageLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_RESERVEFILE_LANGDLL
LangString NearlyShortcutRemovalError ${LANG_ENGLISH} "An owned Nearly shortcut could not be removed. Removal is incomplete; the installation registration was kept."
LangString NearlyShortcutRemovalError ${LANG_JAPANESE} "Nearly のショートカットを削除できませんでした。削除は完了していません。インストール登録は保持されています。"
LangString NearlyShortcutTitle ${LANG_ENGLISH} "Shortcuts"
LangString NearlyRemoveTitle ${LANG_ENGLISH} "Remove Nearly"
LangString NearlyRemoveTitle ${LANG_JAPANESE} "Nearly の削除"
LangString NearlyRemoveSubtitle ${LANG_ENGLISH} "Choose whether to keep the installation folder and your settings."
LangString NearlyRemoveSubtitle ${LANG_JAPANESE} "インストールフォルダーと設定を残すか選んでください。"
LangString NearlyRemoveLabel ${LANG_ENGLISH} "Delete the installation folder and ALL its contents (including settings and other files)"
LangString NearlyRemoveLabel ${LANG_JAPANESE} "インストールフォルダーと中身をすべて削除する（設定・その他のファイルも含む）"
LangString NearlyKeepNotice ${LANG_ENGLISH} "Leave this unchecked to keep settings and other files. Selected installation folder:"
LangString NearlyKeepNotice ${LANG_JAPANESE} "チェックしない場合、設定やその他のファイルは残します。対象のインストールフォルダー:"
LangString NearlyWholeConfirm ${LANG_ENGLISH} "Delete this installation folder itself and EVERYTHING inside it?$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nSettings, history and other files inside will be permanently removed. Interrupted or failed removal may leave only part of the contents. This cannot be undone."
LangString NearlyWholeConfirm ${LANG_JAPANESE} "次のインストールフォルダー自体と中身をすべて削除しますか？$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\n設定・履歴・その他のファイルも完全に削除します。中断や失敗で一部だけ削除される場合があります。元には戻せません。"
LangString NearlyWholeRefused ${LANG_ENGLISH} "The installation folder could not be verified for complete removal. Nothing has been removed by this operation. Keep the option unchecked to uninstall while preserving data."
LangString NearlyWholeRefused ${LANG_JAPANESE} "フォルダー全体を削除するための確認ができませんでした。この操作では削除していません。チェックを外すと、データを残してアンインストールできます。"
LangString NearlyWholePartial ${LANG_ENGLISH} "Complete folder removal stopped. Some files may already have been removed; remaining files and installation records were retained where possible. No outside folder was recursively removed."
LangString NearlyWholePartial ${LANG_JAPANESE} "フォルダー全体の削除を停止しました。一部のファイルは削除済みの可能性があります。残りのファイルと登録情報は可能な限り保持しています。外側のフォルダーを再帰的に削除する処理は行いません。"
LangString NearlyShortcutTitle ${LANG_JAPANESE} "ショートカット"
LangString NearlyShortcutSubtitle ${LANG_ENGLISH} "Choose where Nearly appears. Your choices are kept for upgrades."
LangString NearlyShortcutSubtitle ${LANG_JAPANESE} "Nearly の表示場所を選んでください。更新時もこの選択を保持します。"
LangString NearlyStartMenuText ${LANG_ENGLISH} "Create a Start menu shortcut"
LangString NearlyStartMenuText ${LANG_JAPANESE} "スタートメニューに登録する"
LangString NearlyDesktopText ${LANG_ENGLISH} "Create a desktop shortcut"
LangString NearlyDesktopText ${LANG_JAPANESE} "デスクトップショートカットを作成する"
LangString NearlyDataNotice ${LANG_ENGLISH} "Nearly installs for this Windows user only. Settings beside Nearly.exe are preserved during upgrades and uninstall."
LangString NearlyDataNotice ${LANG_JAPANESE} "この Windows ユーザー専用にインストールします。Nearly.exe と同じ場所の設定は、更新時・アンインストール時にも残ります。"
LangString NearlyCloseApp ${LANG_ENGLISH} "Nearly is running. Stop its syncs and close all Nearly windows, then run Setup again. Setup will not stop the app."
LangString NearlyCloseApp ${LANG_JAPANESE} "Nearly が起動しています。同期を停止してすべての Nearly ウィンドウを閉じてから、もう一度実行してください。セットアップがアプリを強制終了することはありません。"
LangString NearlyCannotCheck ${LANG_ENGLISH} "Setup could not verify that Nearly is closed. Nothing was changed. Close Nearly and try again."
LangString NearlyCannotCheck ${LANG_JAPANESE} "Nearly が終了していることを確認できませんでした。変更は行っていません。Nearly を閉じて、もう一度実行してください。"
LangString NearlyWebViewMissing ${LANG_ENGLISH} "Microsoft Edge WebView2 Runtime is required. Install the runtime separately from Microsoft's official website, then run Nearly Setup again. Nearly and its settings have not been changed."
LangString NearlyWebViewMissing ${LANG_JAPANESE} "Microsoft Edge WebView2 Runtime が必要です。Microsoft の公式サイトから別途インストールし、このセットアップを再実行してください。Nearly と設定は変更していません。"
LangString NearlyCannotWrite ${LANG_ENGLISH} "Choose a writable application folder on a local fixed drive, with an existing parent (path up to 176 characters). Redirected or ambiguous paths cannot be used. Check access permissions if writing fails."
LangString NearlyNoElevation ${LANG_ENGLISH} "Run Nearly Setup normally, without Run as administrator. Installation and updates use your current user account."
LangString NearlyNoElevation ${LANG_JAPANESE} "このセットアップは管理者として実行せず、通常の方法で起動してください。導入と更新は現在のユーザー権限で行います。"
LangString NearlyCannotWrite ${LANG_JAPANESE} "ローカル固定ドライブ上の、書き込み可能なアプリ用フォルダーを選択してください。親フォルダーは既存である必要があり、パスは176文字以内にしてください。転送先や曖昧なパスは使用できません。書き込めない場合はアクセス権限を確認してください。"
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
  Call NearlyReleaseGuards
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
  ; Capture choices on Back as well as Next before nsDialogs destroys controls.
  ${NSD_OnBack} NearlyShortcutPageLeave
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
  Call NearlyIoInit
  StrCpy $NearlyGuardHead 0
  StrCpy $NearlyLeafNode 0
  StrCpy $NearlyHandle 0
  StrCpy $NearlyPendingBuffer 0
  StrCpy $NearlyEnum 0
  StrCpy $NearlyFindData 0
  Call NearlyRequireStandardUser
  !insertmacro NearlyContext
  StrCpy $NearlyRequestedRoot $INSTDIR
  Call NearlySetDefaultRoot
  Call NearlyResolveRegistration
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/NEARLYSTAGE" $1
  ${IfNot} ${Errors}
    StrCmp $NearlyRegisteredRoot "" 0 +3
      SetErrorLevel 8
      Abort "Stage mode requires an owned registered installation."
  ${EndIf}
  Call NearlyStageUpdate
  ${If} $NearlyUpdateMode = 3
    Return
  ${EndIf}
  Call NearlyWaitUpdateParent
  Call NearlyAcquireMutation
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
  StrCpy $NearlyOwnedUpgrade 0
  StrCmp $NearlyRegisteredRoot "" +2
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
  ${If} $NearlyUpdateMode = 3
    Return
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  Call NearlyIoCleanup
  Call NearlyReleaseGuards
  StrCmp $NearlyParentHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyParentHandle)'
  StrCmp $NearlyCommitHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyCommitHandle)'
  StrCmp $NearlyReadyHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyReadyHandle)'
  StrCmp $NearlyMutationHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyMutationHandle)'
FunctionEnd
Function .onInstFailed
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
  ${If} $NearlyUpdateMode = 3
    Call NearlyExtractStage
    Return
  ${EndIf}
  ; Registration and filesystem are checked again immediately before mutation.
  Call NearlyReleaseGuards
  Call NearlyResolveRegistration
  !insertmacro NearlyRequireClosed
  StrCmp $NearlyRegisteredRoot "" 0 nearly_install_registered
  Call NearlyPinRoot
  nearly_install_registered:
  Call NearlyCheckInstallOwnership
  Call NearlyRequireFreshContents
  !insertmacro NearlyRequireClosed
  ; Create only a missing final leaf with normal inherited OS permissions.
  ; Existing ancestor pins remain live while the successor root is captured.
  StrCmp $NearlyRootMissing 0 nearly_install_root_ready
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors nearly_install_create_bad
  Call NearlyPinRoot
  StrCmp $NearlyRootMissing 0 0 nearly_install_create_bad
  Call NearlyRequireFreshContents
  Goto nearly_install_root_ready
  nearly_install_create_bad:
    Call NearlyRejectRoot
  nearly_install_root_ready:
  Call NearlyCaptureRootIdentity
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyRootIdentity"
  StrCmp $0 "" nearly_install_identity_ready
  StrCmp $0 $NearlyRootIdentity nearly_install_identity_ready
  Call NearlyRejectRoot
  nearly_install_identity_ready:
  Call NearlyIoInit
  Call NearlyValidatePayloads
  System::Call 'kernel32::GetCurrentProcessId() i.r8'
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\.nearly-installer-probe-$8.tmp", i 0x40010000, i 0, p 0, i 1, i 0x04000100, p 0) p.r9'
  ${If} $9 P= -1
    SetErrorLevel 5
    Abort "$(NearlyCannotWrite)"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r9)'
  Call NearlyWritePayloads
  ; Restore the installed working directory for shortcuts; extraction above
  ; always selected PLUGINSDIR internally and never uses this live OUTDIR.
  SetOutPath "$INSTDIR"
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
  WriteRegStr HKCU "${UNINSTKEY}" "NearlyRootIdentity" "$NearlyRootIdentity"
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
  Call NearlyIoCleanup
  ${If} $NearlyPassive = 1
    SetAutoClose true
  ${EndIf}
  ; A corrected destination may have left a prior admission error level.
  ; Only this fully completed path may report successful installation.
  SetErrorLevel 0
SectionEnd

; NSIS normally executes a byte-for-byte Temp self-copy. INSTDIR alone is not
; origin proof because _?= can override it. Compare the actual mapped image's
; file with the owned registered uninstaller while both regular files are held
; without write/delete sharing. A same-byte copy is intentionally equivalent.
Function un.NearlyImageCleanup
  StrCmp $NearlyImageHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyImageHandle)'
  StrCmp $NearlyRegisteredImageHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyRegisteredImageHandle)'
  StrCmp $NearlyImageBuffer 0 +2
    System::Free $NearlyImageBuffer
  StrCmp $NearlyOtherBuffer 0 +2
    System::Free $NearlyOtherBuffer
  StrCpy $NearlyImageHandle 0
  StrCpy $NearlyRegisteredImageHandle 0
  StrCpy $NearlyImageBuffer 0
  StrCpy $NearlyOtherBuffer 0
FunctionEnd
Function un.NearlyImageReject
  Call un.NearlyImageCleanup
  Call un.NearlyRejectRoot
FunctionEnd
Function un.NearlyOpenImage
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i $NearlyImageAccess, i $NearlyImageShare, p 0, i 3, i 0x00200000, p 0) p.s'
  Pop $NearlyHandle
  StrCmp $NearlyHandle -1 nearly_image_open_bad
  System::Call 'kernel32::GetFileType(p $NearlyHandle) i.r0'
  StrCmp $0 1 0 nearly_image_open_bad
  System::Alloc 52
  Pop $NearlyPendingBuffer
  StrCmp $NearlyPendingBuffer 0 nearly_image_open_bad
  System::Call 'kernel32::GetFileInformationByHandle(p $NearlyHandle, p $NearlyPendingBuffer) i.r0'
  StrCmp $0 1 0 nearly_image_open_bad
  System::Call '*$NearlyPendingBuffer(i .r0)'
  IntOp $0 $0 & 0x410
  StrCmp $0 0 0 nearly_image_open_bad
  IntOp $0 $NearlyPendingBuffer + 32
  System::Call '*$0(i .r1, i .r2, i .r3)'
  StrCmp $1 0 0 nearly_image_open_bad
  StrCmp $3 1 0 nearly_image_open_bad
  ; Bound every read and allocation; reject empty/oversized images.
  IntCmp $2 0 nearly_image_open_bad nearly_image_open_bad
  IntCmp $2 67108864 0 0 nearly_image_open_bad
  StrCpy $NearlyImageSize $2
  System::Free $NearlyPendingBuffer
  StrCpy $NearlyPendingBuffer 0
  Return
  nearly_image_open_bad:
  Call un.NearlyImageReject
FunctionEnd
Function un.NearlyVerifyUninstallerImage
  StrCpy $NearlyImageHandle 0
  StrCpy $NearlyRegisteredImageHandle 0
  StrCpy $NearlyImageBuffer 0
  StrCpy $NearlyOtherBuffer 0
  System::Call 'kernel32::GetModuleFileNameW(p 0, w .r0, i ${NSIS_MAX_STRLEN}) i.r1'
  StrCmp $1 0 nearly_image_mismatch
  IntCmp $1 ${NSIS_MAX_STRLEN} nearly_image_mismatch 0 nearly_image_mismatch
  StrCpy $NearlyPayload $0
  StrCpy $NearlyImageAccess 0x80000080
  ; Read-lock the actual executing copy. Delete sharing lets an exact in-place
  ; invocation be compared as well; the handle still forbids content writes.
  StrCpy $NearlyImageShare 5
  Call un.NearlyOpenImage
  StrCpy $NearlyImageHandle $NearlyHandle
  StrCpy $NearlyHandle 0
  StrCpy $NearlyImageRemaining $NearlyImageSize
  StrCpy $NearlyPayload "$INSTDIR\uninstall.exe"
  StrCpy $NearlyImageShare 1
  StrCmp $NearlyImageDeleteMode 1 0 +2
    StrCpy $NearlyImageAccess 0x80010080
  Call un.NearlyOpenImage
  StrCpy $NearlyRegisteredImageHandle $NearlyHandle
  StrCpy $NearlyHandle 0
  StrCmp $NearlyImageSize $NearlyImageRemaining 0 nearly_image_mismatch
  System::Alloc 65536
  Pop $NearlyImageBuffer
  StrCmp $NearlyImageBuffer 0 nearly_image_mismatch
  System::Alloc 65536
  Pop $NearlyOtherBuffer
  StrCmp $NearlyOtherBuffer 0 nearly_image_mismatch
  nearly_image_read:
  StrCmp $NearlyImageRemaining 0 nearly_image_equal
  StrCpy $NearlyImageChunk $NearlyImageRemaining
  IntCmp $NearlyImageChunk 65536 0 0 nearly_image_full_chunk
  Goto nearly_image_chunk_ready
  nearly_image_full_chunk:
  StrCpy $NearlyImageChunk 65536
  nearly_image_chunk_ready:
  System::Call 'kernel32::ReadFile(p $NearlyImageHandle, p $NearlyImageBuffer, i $NearlyImageChunk, *i .r1, p 0) i.r0'
  StrCmp $0 1 0 nearly_image_mismatch
  StrCmp $1 $NearlyImageChunk 0 nearly_image_mismatch
  System::Call 'kernel32::ReadFile(p $NearlyRegisteredImageHandle, p $NearlyOtherBuffer, i $NearlyImageChunk, *i .r1, p 0) i.r0'
  StrCmp $0 1 0 nearly_image_mismatch
  StrCmp $1 $NearlyImageChunk 0 nearly_image_mismatch
  System::Call 'ntdll::RtlCompareMemory(p $NearlyImageBuffer, p $NearlyOtherBuffer, i $NearlyImageChunk) i.r0'
  StrCmp $0 $NearlyImageChunk 0 nearly_image_mismatch
  IntOp $NearlyImageRemaining $NearlyImageRemaining - $NearlyImageChunk
  Goto nearly_image_read
  nearly_image_equal:
  ; Keep the proven registered DELETE handle through same-handle deletion.
  System::Free $NearlyImageBuffer
  System::Free $NearlyOtherBuffer
  StrCpy $NearlyImageBuffer 0
  StrCpy $NearlyOtherBuffer 0
  Return
  nearly_image_mismatch:
  Call un.NearlyImageReject
FunctionEnd


; Boundaries are compared case-insensitively at separator boundaries. A target
; containing a protected folder is refused as well as that folder itself.
!macro NearlyWholeProtect path descendants
  StrCpy $NearlyWholeProtected "${path}"
  StrCpy $NearlyWholeExpectedKind ${descendants}
  Call un.NearlyWholeCheckProtected
!macroend
!macro NearlyWholeProtectCommon id
  ; DONT_VERIFY queries the known path without creating a missing directory.
  IntOp $0 ${id} | 0x4000
  System::Call 'shell32::SHGetFolderPathW(p 0, i r0, p 0, i 0, w .r0) i.r1'
  StrCmp $1 0 0 nearly_whole_authority_bad
  StrCpy $NearlyWholeProtected $0
  StrCpy $NearlyWholeExpectedKind 0
  Call un.NearlyWholeCheckProtected
!macroend
Function un.NearlyWholeCheckProtected
  StrCmp $NearlyWholeProtected "" nearly_whole_protected_done
  ; Known folders such as Temp can be supplied as 8.3 aliases by Windows.
  ; Normalize existing aliases before comparing against the canonical target.
  System::Call 'kernel32::GetLongPathNameW(w "$NearlyWholeProtected", w .r2, i ${NSIS_MAX_STRLEN}) i.r0'
  StrCmp $0 0 nearly_whole_protected_compare
  IntCmp $0 ${NSIS_MAX_STRLEN} nearly_whole_invalid 0 nearly_whole_invalid
  StrCpy $NearlyWholeProtected $2
  nearly_whole_protected_compare:
  StrLen $0 $INSTDIR
  StrCpy $1 $NearlyWholeProtected $0
  StrCmp $1 $INSTDIR 0 nearly_whole_check_descendant
  StrCpy $1 $NearlyWholeProtected 1 $0
  StrCmp $1 "" nearly_whole_invalid
  StrCmp $1 "\" nearly_whole_invalid
  nearly_whole_check_descendant:
  StrCmp $NearlyWholeExpectedKind 1 0 nearly_whole_protected_done
  StrLen $0 $NearlyWholeProtected
  StrCpy $1 $INSTDIR $0
  StrCmp $1 $NearlyWholeProtected 0 nearly_whole_protected_done
  StrCpy $1 $INSTDIR 1 $0
  StrCmp $1 "" nearly_whole_invalid
  StrCmp $1 "\" nearly_whole_invalid
  nearly_whole_protected_done:
  Return
  nearly_whole_invalid:
  Call un.NearlyWholeRefuse
FunctionEnd
Function un.NearlyWholeRefuse
  StrCpy $NearlyRemoveAll 0
  SetErrorLevel 9
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "$(NearlyWholeRefused)"
  Abort
FunctionEnd
Function un.NearlyWholeValidate
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyOwner"
  StrCmp $0 "${BUNDLEID}" 0 nearly_whole_authority_bad
  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  StrCmp $0 $INSTDIR 0 nearly_whole_authority_bad
  ReadRegStr $0 HKCU "${UNINSTKEY}" "UninstallString"
  StrCmp $0 '"$INSTDIR\uninstall.exe"' 0 nearly_whole_authority_bad
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyRootIdentity"
  StrCmp $0 "" nearly_whole_authority_bad
  StrCmp $0 $NearlyUninstallRootIdentity 0 nearly_whole_authority_bad
  !insertmacro NearlyWholeProtect "$WINDIR" 1
  !insertmacro NearlyWholeProtect "$PROGRAMFILES" 1
  !insertmacro NearlyWholeProtect "$PROGRAMFILES64" 1
  !insertmacro NearlyWholeProtect "$COMMONFILES" 1
  !insertmacro NearlyWholeProtect "$COMMONFILES64" 1
  !insertmacro NearlyWholeProtect "$PROFILE" 0
  !insertmacro NearlyWholeProtect "$APPDATA" 0
  !insertmacro NearlyWholeProtect "$LOCALAPPDATA" 0
  !insertmacro NearlyWholeProtect "$DESKTOP" 0
  !insertmacro NearlyWholeProtect "$DOCUMENTS" 0
  !insertmacro NearlyWholeProtect "$SMPROGRAMS" 0
  !insertmacro NearlyWholeProtect "$STARTMENU" 0
  !insertmacro NearlyWholeProtect "$TEMP" 0
  ; Public/common storage roots may be writable but are not app directories.
  !insertmacro NearlyWholeProtectCommon 0x23
  !insertmacro NearlyWholeProtectCommon 0x19
  !insertmacro NearlyWholeProtectCommon 0x2e
  !insertmacro NearlyWholeProtectCommon 0x17
  !insertmacro NearlyWholeProtectCommon 0x16
  ${GetParent} "$PROFILE" $0
  ${GetParent} "$INSTDIR" $1
  StrCmp $0 $1 nearly_whole_authority_bad
  Return
  nearly_whole_authority_bad:
  Call un.NearlyWholeRefuse
FunctionEnd
Function un.NearlyRemovePage
  !insertmacro MUI_HEADER_TEXT "$(NearlyRemoveTitle)" "$(NearlyRemoveSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  StrCmp $0 error nearly_remove_page_bad
  ${NSD_CreateLabel} 0 0 100% 70u "$(NearlyKeepNotice)$\r$\n$\r$\n$INSTDIR"
  Pop $0
  ${NSD_CreateCheckbox} 0 82u 100% 50u "$(NearlyRemoveLabel)"
  Pop $NearlyRemoveCheckbox
  ${NSD_SetState} $NearlyRemoveCheckbox $NearlyRemoveAll
  nsDialogs::Show
  Return
  nearly_remove_page_bad:
  Abort
FunctionEnd
Function un.NearlyRemovePageLeave
  ${NSD_GetState} $NearlyRemoveCheckbox $NearlyRemoveAll
  StrCmp $NearlyRemoveAll 1 0 nearly_remove_page_done
  Call un.NearlyWholeValidate
  MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 "$(NearlyWholeConfirm)" IDYES nearly_remove_page_done
  ; Declining leaves the page visible; no filesystem effects have occurred.
  Abort
  nearly_remove_page_done:
FunctionEnd

; Only this explicit opt-in path traverses user data. Every ancestor and every
; opened directory denies write/delete sharing, preventing rename and reparse
; mutation during traversal. A conflicting existing writer causes refusal.
Function un.NearlyWholeCleanup
  StrCmp $NearlyWholeHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyWholeHandle)'
  StrCpy $NearlyWholeHandle 0
  StrCmp $NearlyWholeInfo 0 +2
    System::Free $NearlyWholeInfo
  StrCpy $NearlyWholeInfo 0
  nearly_whole_cleanup_next:
  StrCmp $NearlyWholeTop 0 nearly_whole_cleanup_root
  System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
  StrCpy $NearlyWholeNext $0
  StrCmp $2 0 +2
    System::Call 'kernel32::FindClose(p r2)'
  StrCmp $1 0 +2
    System::Call 'kernel32::CloseHandle(p r1)'
  StrCmp $3 0 +2
    System::Free $3
  System::Free $NearlyWholeTop
  StrCpy $NearlyWholeTop $NearlyWholeNext
  Goto nearly_whole_cleanup_next
  nearly_whole_cleanup_root:
  ; The tree node owns this handle once enumeration has begun.
  StrCmp $NearlyWholeRoot 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyWholeRoot)'
  StrCpy $NearlyWholeRoot 0
FunctionEnd
Function un.NearlyWholeFail
  Call un.NearlyWholeCleanup
  SetErrorLevel 9
  IfSilent nearly_whole_fail_abort
  StrCmp $NearlyWholeStarted 1 nearly_whole_fail_partial
  MessageBox MB_ICONSTOP|MB_OK "$(NearlyWholeRefused)"
  Goto nearly_whole_fail_abort
  nearly_whole_fail_partial:
  MessageBox MB_ICONSTOP|MB_OK "$(NearlyWholePartial)"
  nearly_whole_fail_abort:
  Abort
FunctionEnd
Function un.NearlyWholeInspect
  System::Alloc 52
  Pop $NearlyWholeInfo
  StrCmp $NearlyWholeInfo 0 nearly_whole_inspect_bad
  System::Call 'kernel32::GetFileInformationByHandle(p $NearlyWholeHandle, p $NearlyWholeInfo) i.r0'
  StrCmp $0 1 0 nearly_whole_inspect_bad
  System::Call '*$NearlyWholeInfo(i .r0)'
  IntOp $NearlyWholeAttributes $0 & 0x410
  StrCmp $NearlyWholeExpectedKind 2 0 nearly_whole_inspect_known
  StrCpy $NearlyWholeExpectedKind 0
  StrCmp $NearlyWholeAttributes 0 nearly_whole_inspect_known
  StrCpy $NearlyWholeExpectedKind 1
  nearly_whole_inspect_known:
  StrCmp $NearlyWholeExpectedKind 1 nearly_whole_inspect_directory
  StrCmp $NearlyWholeAttributes 0 0 nearly_whole_inspect_bad
  IntOp $0 $NearlyWholeInfo + 40
  System::Call '*$0(i .r0)'
  StrCmp $0 1 0 nearly_whole_inspect_bad
  Goto nearly_whole_inspect_good
  nearly_whole_inspect_directory:
  IntCmp $NearlyWholeAttributes 0x10 0 nearly_whole_inspect_bad nearly_whole_inspect_bad
  nearly_whole_inspect_good:
  System::Free $NearlyWholeInfo
  StrCpy $NearlyWholeInfo 0
  Return
  nearly_whole_inspect_bad:
  Call un.NearlyWholeFail
FunctionEnd
Function un.NearlyWholeOpenRoot
  Call un.NearlyReleaseLeaf
  StrCpy $NearlyWholeCursor $NearlyGuardHead
  nearly_whole_strict_ancestor:
  StrCmp $NearlyWholeCursor 0 nearly_whole_open_root
  System::Call '*$NearlyWholeCursor(p .r0, p .r1)'
  StrCpy $NearlyWholeNext $0
  StrCpy $NearlyRootIdentityHandle $1
  Call un.NearlyRootIdentityForHandle
  StrCpy $NearlyWholeAncestorIdentity $NearlyRootIdentity
  System::Call 'kernel32::GetFinalPathNameByHandleW(p $NearlyRootIdentityHandle, w .r2, i ${NSIS_MAX_STRLEN}, i 0) i.r0'
  StrCmp $0 0 nearly_whole_open_bad
  IntCmp $0 ${NSIS_MAX_STRLEN} nearly_whole_open_bad 0 nearly_whole_open_bad
  System::Call 'kernel32::CreateFileW(w r2, i 0x81, i 1, p 0, i 3, i 0x02200000, p 0) p.s'
  Pop $NearlyWholeHandle
  StrCmp $NearlyWholeHandle -1 nearly_whole_open_bad_handle
  StrCpy $NearlyWholeExpectedKind 1
  Call un.NearlyWholeInspect
  StrCpy $NearlyRootIdentityHandle $NearlyWholeHandle
  Call un.NearlyRootIdentityForHandle
  StrCmp $NearlyRootIdentity $NearlyWholeAncestorIdentity 0 nearly_whole_open_bad
  System::Alloc 8
  Pop $0
  StrCmp $0 0 nearly_whole_open_bad
  System::Call '*$0(p $NearlyGuardHead, p $NearlyWholeHandle)'
  StrCpy $NearlyGuardHead $0
  StrCpy $NearlyWholeHandle 0
  StrCpy $NearlyWholeCursor $NearlyWholeNext
  Goto nearly_whole_strict_ancestor
  nearly_whole_open_root:
  System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0x10081, i 1, p 0, i 3, i 0x02200000, p 0) p.s'
  Pop $NearlyWholeHandle
  StrCmp $NearlyWholeHandle -1 nearly_whole_open_bad_handle
  StrCpy $NearlyWholeExpectedKind 1
  Call un.NearlyWholeInspect
  StrCpy $NearlyRootIdentityHandle $NearlyWholeHandle
  Call un.NearlyRootIdentityForHandle
  StrCmp $NearlyRootIdentity $NearlyUninstallRootIdentity 0 nearly_whole_open_bad
  System::Call 'kernel32::GetFinalPathNameByHandleW(p $NearlyWholeHandle, w .r1, i ${NSIS_MAX_STRLEN}, i 0) i.r0'
  StrCmp $0 0 nearly_whole_open_bad
  StrCmp $1 "\\?\$INSTDIR" 0 nearly_whole_open_bad
  StrCpy $NearlyWholeRoot $NearlyWholeHandle
  StrCpy $NearlyWholeHandle 0
  Return
  nearly_whole_open_bad_handle:
  StrCpy $NearlyWholeHandle 0
  nearly_whole_open_bad:
  Call un.NearlyWholeFail
FunctionEnd
Function un.NearlyWholeDisposition
  ; Input: already inspected object handle. No path-based fallback.
  System::Alloc 4
  Pop $NearlyWholeInfo
  StrCmp $NearlyWholeInfo 0 nearly_whole_disposition_bad
  System::Call '*$NearlyWholeInfo(i 1)'
  System::Call 'kernel32::SetFileInformationByHandle(p $NearlyWholeHandle, i 4, p $NearlyWholeInfo, i 1) i.r0'
  StrCmp $0 1 0 nearly_whole_disposition_bad
  System::Free $NearlyWholeInfo
  StrCpy $NearlyWholeInfo 0
  System::Call 'kernel32::CloseHandle(p $NearlyWholeHandle)'
  StrCpy $NearlyWholeHandle 0
  Return
  nearly_whole_disposition_bad:
  Call un.NearlyWholeFail
FunctionEnd
Function un.NearlyRemoveTree
  ; Input: WholeHandle is the held directory, WholePath its canonical path.
  ; Linked frames retain every parent handle across recursive calls and Abort.
  IntOp $NearlyWholeDepth $NearlyWholeDepth + 1
  IntCmp $NearlyWholeDepth 32 0 0 nearly_whole_tree_bad
  System::Alloc 16
  Pop $0
  StrCmp $0 0 nearly_whole_tree_bad
  System::Call '*$0(p $NearlyWholeTop, p $NearlyWholeHandle, p 0, p 0)'
  StrCpy $NearlyWholeTop $0
  StrCpy $NearlyWholeHandle 0
  System::Alloc 592
  Pop $0
  StrCmp $0 0 nearly_whole_tree_bad
  IntOp $1 $NearlyWholeTop + 12
  System::Call '*$1(p r0)'
  System::Call 'kernel32::FindFirstFileW(w "\\?\$NearlyWholePath\*", p r0) p.r1 ?e'
  Pop $2
  StrCmp $1 -1 nearly_whole_tree_empty
  IntOp $0 $NearlyWholeTop + 8
  System::Call '*$0(p r1)'
  Goto nearly_whole_tree_entry
  nearly_whole_tree_empty:
  StrCmp $2 2 nearly_whole_tree_done nearly_whole_tree_bad
  nearly_whole_tree_entry:
  System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
  IntOp $0 $3 + 44
  System::Call '*$0(&w260 .r1)'
  StrCpy $NearlyWholeEntry $1
  StrCmp $NearlyWholeEntry "." nearly_whole_tree_next
  StrCmp $NearlyWholeEntry ".." nearly_whole_tree_next
  StrCmp $NearlyWholeDepth 1 0 nearly_whole_tree_open
  StrCmp $NearlyWholeEntry "uninstall.exe" nearly_whole_tree_next
  nearly_whole_tree_open:
  IntOp $NearlyWholeCount $NearlyWholeCount + 1
  IntCmp $NearlyWholeCount 100000 0 0 nearly_whole_tree_bad
  StrCpy $1 "$NearlyWholePath\$NearlyWholeEntry"
  StrLen $0 $1
  IntCmp $0 900 0 0 nearly_whole_tree_bad
  ; Open reparse point itself. Directory/file type and link count are checked
  ; on this same handle before enumerating or setting deletion disposition.
  System::Call 'kernel32::CreateFileW(w "\\?\$1", i 0x10081, i 1, p 0, i 3, i 0x02200000, p 0) p.s'
  Pop $NearlyWholeHandle
  StrCmp $NearlyWholeHandle -1 nearly_whole_tree_open_bad
  StrCpy $NearlyWholeExpectedKind 2
  Call un.NearlyWholeInspect
  StrCmp $NearlyWholeExpectedKind 1 nearly_whole_tree_child
  Call un.NearlyWholeDisposition
  Goto nearly_whole_tree_next
  nearly_whole_tree_child:
  Push $NearlyWholePath
  StrCpy $NearlyWholePath "$NearlyWholePath\$NearlyWholeEntry"
  Call un.NearlyRemoveTree
  Pop $NearlyWholePath
  nearly_whole_tree_next:
  System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
  System::Call 'kernel32::FindNextFileW(p r2, p r3) i.r0 ?e'
  Pop $1
  StrCmp $0 1 nearly_whole_tree_entry
  StrCmp $1 18 0 nearly_whole_tree_bad
  nearly_whole_tree_done:
  System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
  StrCmp $2 0 +2
    System::Call 'kernel32::FindClose(p r2)'
  IntOp $0 $NearlyWholeTop + 8
  System::Call '*$0(p 0)'
  ; Root stays held until the byte-proven registered uninstaller is removed.
  StrCmp $NearlyWholeDepth 1 nearly_whole_tree_return
  StrCpy $NearlyWholeHandle $1
  IntOp $0 $NearlyWholeTop + 4
  System::Call '*$0(p 0)'
  Call un.NearlyWholeDisposition
  System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
  StrCpy $NearlyWholeNext $0
  System::Free $3
  System::Free $NearlyWholeTop
  StrCpy $NearlyWholeTop $NearlyWholeNext
  nearly_whole_tree_return:
  IntOp $NearlyWholeDepth $NearlyWholeDepth - 1
  Return
  nearly_whole_tree_open_bad:
  StrCpy $NearlyWholeHandle 0
  nearly_whole_tree_bad:
  Call un.NearlyWholeFail
FunctionEnd

Function un.onInit
  ; Silent invocations never opt in to recursive deletion.
  StrCpy $NearlyRemoveAll 0
  StrCpy $NearlyWholeStarted 0
  StrCpy $NearlyWholeRoot 0
  StrCpy $NearlyWholeTop 0
  StrCpy $NearlyWholeHandle 0
  StrCpy $NearlyWholeInfo 0
  Call un.NearlyIoInit
  StrCpy $NearlyImageDeleteMode 1
  StrCpy $NearlyGuardHead 0
  StrCpy $NearlyLeafNode 0
  StrCpy $NearlyHandle 0
  StrCpy $NearlyPendingBuffer 0
  StrCpy $NearlyEnum 0
  StrCpy $NearlyFindData 0
  StrCpy $NearlyImageHandle 0
  StrCpy $NearlyRegisteredImageHandle 0
  StrCpy $NearlyImageBuffer 0
  StrCpy $NearlyOtherBuffer 0
  Call un.NearlyRequireStandardUser
  Call un.NearlyAcquireMutation
  !insertmacro NearlyContext
  ; NSIS self-copies to Temp; $INSTDIR retains the original image directory.
  StrCpy $NearlyRequestedRoot $INSTDIR
  ReadRegStr $0 HKCU "${UNINSTKEY}" "NearlyOwner"
  ReadRegStr $NearlyRegisteredRoot HKCU "${UNINSTKEY}" "InstallLocation"
  ReadRegStr $1 HKCU "${UNINSTKEY}" "UninstallString"
  StrCmp $0 "${BUNDLEID}" 0 nearly_uninstall_wrong
  StrCmp $NearlyRegisteredRoot "" nearly_uninstall_wrong
  StrCmp $NearlyRegisteredRoot $NearlyRequestedRoot 0 nearly_uninstall_wrong
  StrCmp $1 '"$NearlyRequestedRoot\uninstall.exe"' 0 nearly_uninstall_wrong
  ; $EXEDIR may describe the Temp copy; use original $INSTDIR binding above.
  Call un.NearlyPinRoot
  StrCmp $NearlyRootMissing 0 0 nearly_uninstall_wrong
  Call un.NearlyCaptureRootIdentity
  StrCpy $NearlyUninstallRootIdentity $NearlyRootIdentity
  Call un.NearlyValidatePayloads
  Call un.NearlyVerifyUninstallerImage
  !insertmacro NearlyRequireClosed
  Return
  nearly_uninstall_wrong:
    SetErrorLevel 5
    Abort "$(NearlyWrongFolder)"
FunctionEnd

Function un.onGUIEnd
  Call un.NearlyWholeCleanup
  Call un.NearlyIoCleanup
  Call un.NearlyImageCleanup
  Call un.NearlyReleaseGuards
  StrCmp $NearlyMutationHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyMutationHandle)'
FunctionEnd

Section Uninstall
  !insertmacro NearlyRequireTargetDirectory
  !insertmacro NearlyRequireClosed
  StrCmp $NearlyRemoveAll 1 0 nearly_uninstall_begin
  Call un.NearlyWholeValidate
  Call un.NearlyWholeOpenRoot
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  StrCpy $NearlyWholeStarted 1
  nearly_uninstall_begin:
  ; Open the observed main payload without write/delete sharing. A missing
  ; originally absent file stays absent; identity changes fail before deletion.
  StrCmp $NearlyMainSnapshot "" nearly_uninstall_main_absent
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${MAINBINARYNAME}.exe", i 0x10080, i 1, p 0, i 3, i 0x00200000, p 0) p.r0'
  StrCmp $0 -1 nearly_uninstall_io_bad
  StrCpy $NearlyIoMain $0
  StrCpy $NearlyIoWriteHandle $0
  Call un.NearlyIoInspect
  StrCmp $NearlySnapshot $NearlyMainSnapshot 0 nearly_uninstall_io_bad
  Call un.NearlyIoDelete
  System::Call 'kernel32::CloseHandle(p $NearlyIoMain)'
  StrCpy $NearlyIoMain 0
  nearly_uninstall_main_absent:
  StrCmp $NearlyRemoveAll 1 0 nearly_uninstall_keep_data
  StrCpy $NearlyWholePath $INSTDIR
  StrCpy $NearlyWholeDepth 0
  StrCpy $NearlyWholeCount 0
  StrCpy $NearlyWholeHandle $NearlyWholeRoot
  StrCpy $NearlyWholeRoot 0
  Call un.NearlyRemoveTree
  StrCpy $NearlyWholeHandle $NearlyRegisteredImageHandle
  StrCpy $NearlyRegisteredImageHandle 0
  StrCpy $NearlyWholeExpectedKind 0
  Call un.NearlyWholeInspect
  Call un.NearlyWholeDisposition
  Call un.NearlyImageCleanup
  ; Only after all contents and the exact registered uninstaller are gone may
  ; the held root be removed. Keep registration on any partial failure.
  System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
  StrCpy $NearlyWholeHandle $1
  IntOp $0 $NearlyWholeTop + 4
  System::Call '*$0(p 0)'
  Call un.NearlyWholeDisposition
  Call un.NearlyWholeCleanup
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0 ?e'
  Pop $1
  StrCmp $0 -1 0 nearly_uninstall_whole_bad
  StrCmp $1 2 nearly_uninstall_remove_registration nearly_uninstall_whole_bad
  nearly_uninstall_keep_data:
  StrCpy $NearlyIoWriteHandle $NearlyRegisteredImageHandle
  Call un.NearlyIoDelete
  ; Complete the disposition on the exact byte-proven registered object.
  Call un.NearlyImageCleanup
  nearly_uninstall_remove_registration:
  ClearErrors
  !insertmacro NearlyApplyShortcut "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk" 0
  IfErrors nearly_uninstall_shortcut_bad
  ClearErrors
  !insertmacro NearlyApplyShortcut "$DESKTOP\${PRODUCTNAME}.lnk" 0
  IfErrors nearly_uninstall_shortcut_bad
  RMDir "$SMPROGRAMS\${PRODUCTNAME}"
  ClearErrors
  DeleteRegKey HKCU "${UNINSTKEY}"
  IfErrors nearly_uninstall_registration_bad
  StrCmp $NearlyRemoveAll 1 nearly_uninstall_success
  ; Preferences and all user data remain. Nonrecursive removal only succeeds
  ; for an empty folder; settings.json, backups and WebView data prevent it.
  Call un.NearlyReleaseLeaf
  RMDir "$INSTDIR"
  nearly_uninstall_success:
  SetErrorLevel 0
  ; Let NSIS account for the full section only on the successful path.
  Goto nearly_uninstall_done
  nearly_uninstall_shortcut_bad:
  SetErrorLevel 9
  Abort "$(NearlyShortcutRemovalError)"
  nearly_uninstall_whole_bad:
  Call un.NearlyWholeFail
  nearly_uninstall_registration_bad:
  SetErrorLevel 9
  IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "$(NearlyWholePartial)"
  Abort
  nearly_uninstall_io_bad:
  Call un.NearlyIoFail
  nearly_uninstall_done:
SectionEnd
