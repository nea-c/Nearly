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
Var NearlySecurity
Var NearlyOwnerSid
Var NearlyDacl
Var NearlyTokenBuffer
Var NearlyUserSid
Var NearlySystemSid
Var NearlyAdminSid
Var NearlyInstallerSid
Var NearlyTestSid
Var NearlyAceCount
Var NearlyAceIndex
Var NearlyMask
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
Var NearlyCreatorSid
Var NearlyPendingBuffer
Var NearlyPolicyPath
Var NearlyPolicyImage
Var NearlyPolicyGuardHead
Var NearlyConsentPath
Var NearlyConsentToken
Var NearlyPreservedRoot
Var NearlyPolicyChecking
Var NearlyPolicySavedRoot

; Shared guard implementation. The NSIS/System ABI is 32-bit even for x64 payloads.
; Every existing ancestor is opened without FILE_SHARE_DELETE until all mutations
; finish. ACLs are queried from those exact handles; security is never rewritten.
!macro NearlyRootFunctions prefix
Function ${prefix}NearlyRejectRoot
  StrCmp $NearlyPolicyChecking 1 0 nearly_reject_context_done
  StrCpy $INSTDIR $NearlyPolicySavedRoot
  StrCpy $NearlyPolicyChecking 0
  nearly_reject_context_done:
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

Function ${prefix}NearlyTrustedSid
  System::Call 'advapi32::EqualSid(p $NearlyTestSid, p $NearlyUserSid) i.r0'
  StrCmp $0 1 nearly_sid_good
  System::Call 'advapi32::EqualSid(p $NearlyTestSid, p $NearlySystemSid) i.r0'
  StrCmp $0 1 nearly_sid_good
  System::Call 'advapi32::EqualSid(p $NearlyTestSid, p $NearlyAdminSid) i.r0'
  StrCmp $0 1 nearly_sid_good
  System::Call 'advapi32::EqualSid(p $NearlyTestSid, p $NearlyInstallerSid) i.r0'
  StrCmp $0 1 nearly_sid_good
  StrCpy $0 0
  Return
  nearly_sid_good:
  StrCpy $0 1
FunctionEnd

Function ${prefix}NearlyCheckAcl
  StrCpy $NearlySecurity 0
  System::Call 'advapi32::GetSecurityInfo(p $NearlyHandle, i 1, i 5, *p .r1, p 0, *p .r2, p 0, *p .r3) i.r0'
  StrCpy $NearlyOwnerSid $1
  StrCpy $NearlyDacl $2
  StrCpy $NearlySecurity $3
  StrCmp $0 0 0 nearly_acl_bad
  StrCmp $NearlyOwnerSid 0 nearly_acl_bad
  StrCmp $NearlyDacl 0 nearly_acl_bad
  StrCpy $NearlyTestSid $NearlyOwnerSid
  Call ${prefix}NearlyTrustedSid
  StrCmp $0 1 0 nearly_acl_bad
  System::Call 'advapi32::IsValidAcl(p $NearlyDacl) i.r0'
  StrCmp $0 1 0 nearly_acl_bad
  ; ACL header: revision/reserved/size then WORD AceCount.
  System::Call '*$NearlyDacl(i, &i2 .s)'
  Pop $NearlyAceCount
  StrCpy $NearlyAceIndex 0
  nearly_acl_loop:
  IntCmp $NearlyAceIndex $NearlyAceCount nearly_acl_done
  System::Call 'advapi32::GetAce(p $NearlyDacl, i $NearlyAceIndex, *p .r1) i.r0'
  StrCmp $0 1 0 nearly_acl_bad
  System::Call '*$1(&i1 .r2, &i1 .r3, &i2 .r4, i .r5)'
  ; Only ordinary allow/deny ACEs supported. Fail closed for object/callback ACEs.
  IntCmp $2 1 nearly_acl_next 0 nearly_acl_bad
  IntOp $6 $3 & 8
  ; Root descendants must also stay private: inherit-only writable ACEs can
  ; grant foreign access to newly extracted payload/state children.
  StrCmp $NearlyMask 0x500D0156 nearly_acl_effective
  StrCmp $6 8 nearly_acl_next
  nearly_acl_effective:
  IntOp $5 $5 & $NearlyMask
  StrCmp $5 0 nearly_acl_next
  IntOp $NearlyTestSid $1 + 8
  Call ${prefix}NearlyTrustedSid
  StrCmp $0 1 nearly_acl_next
  ; CREATOR OWNER may safely control only future children owned by their creator.
  ; Never treat it as a trusted effective owner or effective write ACE.
  IntOp $6 $3 & 8
  StrCmp $6 8 0 nearly_acl_bad
  IntOp $6 $3 & 3
  StrCmp $6 0 nearly_acl_bad
  System::Call 'advapi32::EqualSid(p $NearlyTestSid, p $NearlyCreatorSid) i.r0'
  StrCmp $0 1 0 nearly_acl_bad
  nearly_acl_next:
  IntOp $NearlyAceIndex $NearlyAceIndex + 1
  Goto nearly_acl_loop
  nearly_acl_done:
  System::Call 'kernel32::LocalFree(p $NearlySecurity)'
  StrCpy $NearlySecurity 0
  Return
  nearly_acl_bad:
  StrCmp $NearlySecurity 0 +2
    System::Call 'kernel32::LocalFree(p $NearlySecurity)'
  Call ${prefix}NearlyRejectRoot
FunctionEnd

Function ${prefix}NearlyInitSids
  StrCmp $NearlyUserSid 0 0 nearly_sids_done
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'advapi32::OpenProcessToken(p r0, i 8, *p .r1) i.r0'
  StrCmp $0 1 0 nearly_sids_bad
  System::Alloc 4096
  Pop $NearlyTokenBuffer
  StrCmp $NearlyTokenBuffer 0 nearly_sids_bad
  System::Call 'advapi32::GetTokenInformation(p r1, i 1, p $NearlyTokenBuffer, i 4096, *i .r2) i.r0'
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCmp $0 1 0 nearly_sids_bad
  System::Call '*$NearlyTokenBuffer(p .s)'
  Pop $NearlyUserSid
  System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-5-18", *p .s) i.r0'
  Pop $NearlySystemSid
  StrCmp $0 1 0 nearly_sids_bad
  System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-5-32-544", *p .s) i.r0'
  Pop $NearlyAdminSid
  StrCmp $0 1 0 nearly_sids_bad
  System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", *p .s) i.r0'
  Pop $NearlyInstallerSid
  StrCmp $0 1 0 nearly_sids_bad
  System::Call 'advapi32::ConvertStringSidToSidW(w "S-1-3-0", *p .s) i.r0'
  Pop $NearlyCreatorSid
  StrCmp $0 1 0 nearly_sids_bad
  nearly_sids_done:
  Return
  nearly_sids_bad:
  Call ${prefix}NearlyRejectRoot
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
  System::Call 'kernel32::CreateFileW(w "$NearlyWalk", i 0x20081, i 3, p 0, i 3, i 0x02200000, p 0) p.s'
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
  Call ${prefix}NearlyCheckAcl
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
  Call ${prefix}NearlyInitSids
  Call ${prefix}NearlyValidatePath
  StrCpy $NearlyRootMissing 0
  StrCpy $NearlyLeafNode 0
  StrCpy $NearlyWalk $INSTDIR 3
  ; A verified volume root cannot itself be renamed/deleted as an ordinary
  ; directory. Keep child-delete and security-takeover checks fully enabled.
  System::Call 'kernel32::GetVolumeNameForVolumeMountPointW(w "$NearlyWalk", w .r0, i ${NSIS_MAX_STRLEN}) i.r1'
  StrCmp $1 1 0 nearly_root_bad
  StrCpy $NearlyMask 0x500C0040 ; volume: child-delete/security takeover
  Call ${prefix}NearlyPinDirectory
  StrCpy $NearlyMask 0x500D0040 ; ordinary parent: also reject DELETE
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
  StrCpy $NearlyMask 0x500D0156 ; root also rejects foreign file writes
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
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i 0x20080, i 3, p 0, i 3, i 0x00200000, p 0) p.r0 ?e'
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
  System::Free $1
  StrCpy $NearlyPendingBuffer 0
  IntOp $2 $2 & 0x410
  StrCmp $2 0 0 nearly_payload_bad
  StrCmp $4 1 0 nearly_payload_bad
  StrCpy $NearlyMask 0x500D0156
  Call ${prefix}NearlyCheckAcl
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
  StrCpy $NearlyPayload "$INSTDIR\uninstall.exe"
  Call ${prefix}NearlyValidatePayload
FunctionEnd
!macroend
!insertmacro NearlyRootFunctions ""
!insertmacro NearlyRootFunctions "un."

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

Function NearlyCleanupPolicyHelper
  Push $0
  Push $1
  StrCmp $NearlyPolicyImage 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyPolicyImage)'
  StrCpy $NearlyPolicyImage 0
  nearly_policy_release_loop:
  StrCmp $NearlyPolicyGuardHead 0 nearly_policy_release_done
  System::Call '*$NearlyPolicyGuardHead(p .r0, p .r1)'
  System::Call 'kernel32::CloseHandle(p r1)'
  System::Free $NearlyPolicyGuardHead
  StrCpy $NearlyPolicyGuardHead $0
  Goto nearly_policy_release_loop
  nearly_policy_release_done:
  StrCpy $NearlyPolicyPath ""
  Pop $1
  Pop $0
FunctionEnd

Function NearlyEnsurePolicyHelper
  StrCmp $NearlyPolicyPath "" 0 nearly_policy_done
  ; Callers release target guards first. Keep a separate namespace chain
  ; for the helper through every pathname-based process launch.
  StrCmp $NearlyGuardHead 0 0 nearly_policy_bad
  InitPluginsDir
  ; Canonicalize this internally-created temporary directory's 8.3 spelling.
  ; User-selected installation paths still reject aliases and redirects.
  System::Call 'kernel32::GetLongPathNameW(w "$PLUGINSDIR", w .r0, i ${NSIS_MAX_STRLEN}) i.r1'
  StrCmp $1 0 nearly_policy_bad
  IntCmp $1 ${NSIS_MAX_STRLEN} nearly_policy_bad nearly_policy_path_good nearly_policy_bad
  nearly_policy_path_good:
  StrCpy $NearlyPolicySavedRoot $INSTDIR
  StrCpy $NearlyPolicyChecking 1
  StrCpy $INSTDIR $0
  Call NearlyPinRoot
  ClearErrors
  File /oname=$PLUGINSDIR\Nearly-install-policy.exe "${MAINBINARYSRCPATH}"
  IfErrors nearly_policy_restore_bad
  StrCpy $NearlyPayload "$INSTDIR\Nearly-install-policy.exe"
  Call NearlyValidatePayload
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i 0x80000080, i 1, p 0, i 3, i 0x00200000, p 0) p.r0'
  StrCmp $0 -1 nearly_policy_restore_bad
  StrCpy $NearlyPolicyImage $0
  StrCpy $NearlyPolicyPath $NearlyPayload
  StrCpy $NearlyPolicyGuardHead $NearlyGuardHead
  StrCpy $NearlyGuardHead 0
  StrCpy $NearlyLeafNode 0
  StrCpy $INSTDIR $NearlyPolicySavedRoot
  StrCpy $NearlyPolicyChecking 0
  nearly_policy_done:
  Return
  nearly_policy_restore_bad:
  StrCpy $INSTDIR $NearlyPolicySavedRoot
  StrCpy $NearlyPolicyChecking 0
  nearly_policy_bad:
  Call NearlyCleanupPolicyHelper
  Call NearlyRejectRoot
FunctionEnd

Function NearlyCheckFreshPlan
  StrCmpS $NearlyConsentPath $INSTDIR 0 nearly_plan_check
  StrCmp $NearlyConsentToken "" 0 nearly_plan_done
  nearly_plan_check:
  StrCpy $NearlyConsentPath ""
  StrCpy $NearlyConsentToken ""
  StrCpy $NearlyPreservedRoot ""
  Call NearlyEnsurePolicyHelper
  nsExec::ExecToStack '"$NearlyPolicyPath" --nearly-install-check "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 0 nearly_plan_ready
  StrCmp $0 10 0 nearly_plan_bad
  IfSilent nearly_plan_bad
  StrCmp $NearlyPassive 1 nearly_plan_bad
  StrCpy $2 $1 4
  StrCmp $2 "new." nearly_plan_new
  StrCpy $2 $1 6
  StrCmp $2 "empty." 0 nearly_plan_bad
  StrCpy $2 $1 32 6
  ${GetParent} "$INSTDIR" $NearlyPreservedRoot
  StrCpy $NearlyPreservedRoot "$NearlyPreservedRoot\.Nearly-preserved-$2"
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$(NearlyProtectExisting)" IDYES nearly_plan_accept
  Abort
  nearly_plan_new:
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$(NearlyProtectNew)" IDYES nearly_plan_accept
  Abort
  nearly_plan_ready:
  StrCpy $2 $1 6
  StrCmp $2 "ready." 0 nearly_plan_bad
  nearly_plan_accept:
  StrCpy $NearlyConsentPath $INSTDIR
  StrCpy $NearlyConsentToken $1
  nearly_plan_done:
  Return
  nearly_plan_bad:
  Call NearlyCleanupPolicyHelper
  Call NearlyRejectRoot
FunctionEnd

Function NearlyPrepareFreshRoot
  StrCmpS $NearlyConsentPath $INSTDIR 0 nearly_prepare_bad
  StrCmp $NearlyConsentToken "" nearly_prepare_bad
  ; A private root needs no directory mutation. Keep the default-only
  ; preserved-settings whitelist for reinstalls after uninstall.
  StrCpy $0 $NearlyConsentToken 6
  StrCmp $0 "ready." nearly_prepare_admit
  Call NearlyEnsurePolicyHelper
  nsExec::ExecToStack '"$NearlyPolicyPath" --nearly-install-prepare "$INSTDIR" "$NearlyConsentToken"'
  Pop $0
  Pop $1
  StrCmp $0 0 0 nearly_prepare_bad
  StrCmp $1 "" 0 nearly_prepare_bad
  nearly_prepare_admit:
  StrCpy $NearlyConsentToken ""
  Call NearlyPinRoot
  StrCmp $NearlyRootMissing 0 0 nearly_prepare_bad
  Call NearlyRequireFreshContents
  Return
  nearly_prepare_bad:
  Call NearlyCleanupPolicyHelper
  Call NearlyRejectRoot
FunctionEnd

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
  StrCmp $INSTDIR $NearlyDefaultRoot 0 nearly_contents_bad
  ; Only known settings/backup leaves may survive an unregistered default reinstall.
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
  ; This planner performs no directory creation, permission or payload writes.
  Call NearlyCheckFreshPlan
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
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_RESERVEFILE_LANGDLL
LangString NearlyShortcutTitle ${LANG_ENGLISH} "Shortcuts"
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
LangString NearlyCannotWrite ${LANG_ENGLISH} "Choose a dedicated private writable folder on a local fixed drive, with an existing parent (path up to 176 characters). Shared, redirected, ambiguous or unrelated nonempty folders cannot be used."
LangString NearlyNoElevation ${LANG_ENGLISH} "Run Nearly Setup normally, without Run as administrator. Installation and updates use your current user account."
LangString NearlyNoElevation ${LANG_JAPANESE} "このセットアップは管理者として実行せず、通常の方法で起動してください。導入と更新は現在のユーザー権限で行います。"
LangString NearlyProtectNew ${LANG_ENGLISH} "Install Nearly.exe in:$\r$\n$INSTDIR$\r$\n$\r$\nAfter you click Install, create this folder so only your account, Administrators and SYSTEM can change it. Other users will not have access. The drive and other folders are not changed. Continue?"
LangString NearlyProtectNew ${LANG_JAPANESE} "Nearly.exe のインストール先:$\r$\n$INSTDIR$\r$\n$\r$\n［インストール］を押した後、このフォルダーを現在のユーザー・管理者・SYSTEMだけが変更できる専用フォルダーとして作成します。他のユーザーはアクセスできません。ドライブ全体や他のフォルダーは変更しません。続けますか？"
LangString NearlyProtectExisting ${LANG_ENGLISH} "Install Nearly.exe in:$\r$\n$INSTDIR$\r$\n$\r$\nThis folder is empty but other users can change it. After you click Install, preserve the empty original at:$\r$\n$NearlyPreservedRoot$\r$\nThen create a dedicated replacement for your account, Administrators and SYSTEM. Other users will not have access. No existing files or drive permissions are changed. The preserved empty folder is kept for you to review. Continue?"
LangString NearlyProtectExisting ${LANG_JAPANESE} "Nearly.exe のインストール先:$\r$\n$INSTDIR$\r$\n$\r$\nこの空フォルダーは他のユーザーも変更できます。［インストール］を押した後、元の空フォルダーを次の場所へ退避します:$\r$\n$NearlyPreservedRoot$\r$\nその後、現在のユーザー・管理者・SYSTEMだけの専用フォルダーを作り直します。他のユーザーはアクセスできません。既存ファイルやドライブ全体の権限は変更しません。退避した空フォルダーは確認用に残します。続けますか？"
LangString NearlyCannotWrite ${LANG_JAPANESE} "ローカル固定ドライブ上の、このユーザー専用の書き込み可能なフォルダーを選択してください。親フォルダーは既存である必要があり、パスは176文字以内にしてください。共有・転送先・不明なファイルがあるフォルダーは使用できません。"
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
  StrCpy $NearlyPolicyPath ""
  StrCpy $NearlyPolicyImage 0
  StrCpy $NearlyPolicyGuardHead 0
  StrCpy $NearlyPolicyChecking 0
  StrCpy $NearlyConsentPath ""
  StrCpy $NearlyConsentToken ""
  StrCpy $NearlyPreservedRoot ""
  StrCpy $NearlyUserSid 0
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
  Call NearlyCleanupPolicyHelper
  ${If} $NearlyUpdateMode = 3
    Return
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  Call NearlyCleanupPolicyHelper
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
  Call NearlyCleanupPolicyHelper
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
  ; Silent/passive fresh installs may proceed only when no preparation is needed.
  StrCmpS $NearlyConsentPath $INSTDIR nearly_install_prepare
  Call NearlyCheckFreshPlan
  nearly_install_prepare:
  Call NearlyPrepareFreshRoot
  nearly_install_registered:
  Call NearlyCheckInstallOwnership
  Call NearlyRequireFreshContents
  !insertmacro NearlyRequireClosed
  ; Preparation has already created and verified the exact private leaf.
  StrCmp $NearlyRootMissing 0 +2
    Call NearlyRejectRoot
  Call NearlyValidatePayloads
  System::Call 'kernel32::GetCurrentProcessId() i.r8'
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\.nearly-installer-probe-$8.tmp", i 0x40010000, i 0, p 0, i 1, i 0x04000100, p 0) p.r9'
  ${If} $9 P= -1
    SetErrorLevel 5
    Abort "$(NearlyCannotWrite)"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r9)'
  SetOutPath "$INSTDIR"
  ClearErrors
  Call NearlyExtractApplication
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
  System::Call 'kernel32::CreateFileW(w "$NearlyPayload", i 0x80000080, i 1, p 0, i 3, i 0x00200000, p 0) p.s'
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
  Call un.NearlyOpenImage
  StrCpy $NearlyImageHandle $NearlyHandle
  StrCpy $NearlyHandle 0
  StrCpy $NearlyImageRemaining $NearlyImageSize
  StrCpy $NearlyPayload "$INSTDIR\uninstall.exe"
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
  ; Keep the proven image handles until immediately before self-deletion.
  System::Free $NearlyImageBuffer
  System::Free $NearlyOtherBuffer
  StrCpy $NearlyImageBuffer 0
  StrCpy $NearlyOtherBuffer 0
  Return
  nearly_image_mismatch:
  Call un.NearlyImageReject
FunctionEnd


Function un.onInit
  StrCpy $NearlyPolicyChecking 0
  StrCpy $NearlyUserSid 0
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
  Call un.NearlyValidatePayloads
  Call un.NearlyVerifyUninstallerImage
  !insertmacro NearlyRequireClosed
  Return
  nearly_uninstall_wrong:
    SetErrorLevel 5
    Abort "$(NearlyWrongFolder)"
FunctionEnd

Function un.onGUIEnd
  Call un.NearlyImageCleanup
  Call un.NearlyReleaseGuards
  StrCmp $NearlyMutationHandle 0 +2
    System::Call 'kernel32::CloseHandle(p $NearlyMutationHandle)'
FunctionEnd

Section Uninstall
  Call un.NearlyValidatePayloads
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
  Call un.NearlyImageCleanup
  ClearErrors
  Delete "$INSTDIR\uninstall.exe"
  ${If} ${Errors}
    SetErrorLevel 6
    Abort "$(NearlyPayloadError)"
  ${EndIf}
  DeleteRegKey HKCU "${UNINSTKEY}"
  ; Preferences and all user data remain. Nonrecursive removal only succeeds
  ; for an empty folder; settings.json, backups and WebView data prevent it.
  Call un.NearlyReleaseLeaf
  RMDir "$INSTDIR"
SectionEnd
