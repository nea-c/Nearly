import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const internalVersion = JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8")).version;
const template = fs.readFileSync(path.join(here, "installer.nsi"), "utf8");

// Execute the actual decision functions, using generated registry/filesystem
// facts only. Unsupported NSIS instructions fail rather than assuming success.
function runDecision(name, { registry = {}, files = [], variables = {}, silent = false } = {}) {
  const body = template.match(new RegExp(`Function ${name}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1];
  assert.ok(body, `Missing actual NSIS function ${name}`);
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith(";"));
  const vars = { INSTDIR: "C:\\Users\\Fixture\\AppData\\Local\\Nearly", SMPROGRAMS: "C:\\Fixture\\Start", DESKTOP: "C:\\Fixture\\Desktop", ...variables };
  const constants = { PRODUCTNAME: "Nearly", MAINBINARYNAME: "Nearly", BUNDLEID: "local.nearly.compile.only", UNINSTKEY: "owned-uninstall-key" };
  const expand = text => text.replace(/^"|"$/g, "").replace(/\$\{(\w+)\}/g, (_, key) => constants[key] ?? "").replace(/\$(\w+)/g, (_, key) => String(vars[key] ?? ""));
  const exists = new Set(files.map(file => expand(file).toLowerCase()));
  const jump = (to, pc) => to === "0" || to === undefined ? pc + 1 : /^[+-]\d+$/.test(to) ? pc + Number(to) : lines.indexOf(`${to}:`) + 1;
  let pc = 0, budget = 1000, errorLevel = 0;
  while (pc < lines.length) {
    assert.ok(budget-- > 0, "Unexpected NSIS control-flow loop");
    if (lines[pc].endsWith(":")) { pc++; continue; }
    const [op, ...args] = lines[pc].match(/"[^"]*"|\S+/g);
    switch (op) {
      case "StrCpy": {
        const value=expand(args[1]), start=args[3] === undefined ? 0 : Number(expand(args[3]));
        vars[args[0].slice(1)] = args[2] === undefined ? value : value.slice(start, start + Number(expand(args[2])));
        pc++; break;
      }
      case "IntOp": {
        const left=Number(expand(args[1])), right=Number(expand(args[3]));
        assert.ok(['+','*'].includes(args[2]), `Unsupported integer operation: ${args[2]}`);
        vars[args[0].slice(1)] = args[2] === '+' ? left+right : left*right;
        pc++; break;
      }
      case "IntCmp": {
        const left=Number(expand(args[0])), right=Number(expand(args[1]));
        pc=jump(left===right ? args[2] : left<right ? args[3] : args[4],pc); break;
      }
      case "Goto": pc=jump(args[0],pc); break;
      case "ReadRegStr": vars[args[0].slice(1)] = String(registry[expand(args.at(-1))] ?? ""); pc++; break;
      case "GetFullPathName": vars[args[0].slice(1)] = path.win32.normalize(expand(args[1])); pc++; break;
      case "StrCmp": pc = jump(expand(args[0]).toLowerCase() === expand(args[1]).toLowerCase() ? args[2] : args[3], pc); break;
      case "IfFileExists": pc = jump(exists.has(expand(args[0]).toLowerCase()) ? args[1] : args[2], pc); break;
      case "IfSilent": pc = jump(silent ? args[0] : args[1], pc); break;
      case "MessageBox": pc++; break;
      case "SetErrorLevel": errorLevel = Number(args[0]); pc++; break;
      case "Abort": return { variables: vars, aborted: true, errorLevel };
      default: assert.fail(`Unsupported decision instruction: ${lines[pc]}`);
    }
  }
  return { variables: vars, aborted: false, errorLevel };
}

test("installer shows public release labels while numeric Windows and downgrade fields stay numeric", () => {
  assert.match(template, /!searchparse "\$\{VERSION\}" "" VERSIONMAJOR "\." VERSIONMINOR "\." VERSIONPATCH/);
  assert.match(template, /!define PUBLICVERSION "r\$\{VERSIONMAJOR\}\.\$\{VERSIONMINOR\}"/);
  for (const field of ['Name', 'Caption', 'UninstallCaption', 'BrandingText']) assert.match(template, new RegExp(`^${field} "[^"\\n]*\\$\\{PUBLICVERSION\\}`, 'm'));
  assert.match(template, /VIProductVersion "\$\{VERSIONWITHBUILD\}"/);
  for (const field of ['FileVersion','ProductVersion']) assert.ok(template.includes(`VIAddVersionKey "${field}" "\${PUBLICVERSION}"`));
  assert.ok(template.includes('WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${PUBLICVERSION}"'));
  assert.ok(template.includes('WriteRegStr HKCU "${UNINSTKEY}" "NearlyInternalVersion" "${VERSION}"'));
  const init=template.slice(template.indexOf('Function .onInit'),template.indexOf('Function NearlySkipPassive'));
  assert.ok(init.indexOf('Call NearlyReadInstalledVersion') < init.indexOf('nsis_tauri_utils::SemverCompare "${VERSION}" $0'));
});

test("actual installed version reader prefers internal metadata and validates legacy fallback", () => {
  for (const registry of [{}, {DisplayVersion:'0.2.0'}, {NearlyInternalVersion:'1.10.0',DisplayVersion:'r1.10'}, {NearlyInternalVersion:'2.0.0',DisplayVersion:'0.1.0'}]) {
    const result=runDecision('NearlyReadInstalledVersion',{registry});
    assert.equal(result.aborted,false);
    assert.equal(result.variables['0'],registry.NearlyInternalVersion ?? registry.DisplayVersion ?? '');
  }
  for (const invalid of ['r1.0','1.0','1.0.0-beta','1.0.0+build','01.0.0','1..0','1.0.','1.0.0.0','65536.0.0','99999999999999.0.0']) {
    for (const registry of [{DisplayVersion:invalid}, {NearlyInternalVersion:invalid,DisplayVersion:'1.0.0'}]) {
      const result=runDecision('NearlyReadInstalledVersion',{registry});
      assert.equal(result.aborted,true,invalid);
      assert.equal(result.errorLevel,4);
    }
  }
});

test("actual upgrade decision preserves manually removed links, fresh reinstall respects prefs", () => {
  const start = "$SMPROGRAMS\\${PRODUCTNAME}\\${PRODUCTNAME}.lnk", desktop = "$DESKTOP\\${PRODUCTNAME}.lnk";
  for (const silent of [false, true]) {
    for (const [owned, savedStart, savedDesktop, files, expected] of [
      [1, 1, 1, [], [0, 0]], [1, 1, 1, [start], [1, 0]], [1, 1, 1, [desktop], [0, 1]],
      [1, 1, 1, [start, desktop], [1, 1]], [1, 0, 0, [start, desktop], [0, 0]],
      [0, 1, 1, [], [1, 1]], [0, 0, 0, [], [0, 0]],
    ]) {
      const result = runDecision("NearlyInferMissingShortcuts", { silent, files, variables: { NearlyOwnedUpgrade: owned, NearlyStartMenu: savedStart, NearlyDesktop: savedDesktop } });
      assert.deepEqual([Number(result.variables.NearlyStartMenu), Number(result.variables.NearlyDesktop)], expected);
    }
  }
  const init = template.slice(template.indexOf("Function .onInit"), template.indexOf("Function NearlySkipPassive"));
  assert.ok(init.indexOf("Call NearlyInferMissingShortcuts") > init.indexOf("Call NearlyLoadPreferences"));
  assert.ok(init.indexOf("Call NearlyInferMissingShortcuts") < init.indexOf("MUI_LANGDLL_DISPLAY"));
  // The later visible page reads actual controls back, allowing explicit recheck.
  assert.match(template, /NSD_GetState\} \$NearlyStartMenuCheckbox \$NearlyStartMenu/);
});

test("actual payload ownership decision blocks unknown EXE/uninstaller and mismatched locations", () => {
  const target = "C:\\Users\\Fixture\\AppData\\Local\\Nearly";
  for (const file of ["$INSTDIR\\Nearly.exe", "$INSTDIR\\uninstall.exe"]) {
    for (const registry of [{}, { NearlyOwner: "foreign", InstallLocation: target }, { NearlyOwner: "local.nearly.compile.only", InstallLocation: "C:\\Foreign" }, { NearlyOwner: "local.nearly.compile.only" }]) {
      const result = runDecision("NearlyCheckInstallOwnership", { files: [file], registry });
      assert.equal(result.aborted, true); assert.equal(result.errorLevel, 7);
    }
    const result = runDecision("NearlyCheckInstallOwnership", { files: [file], registry: { NearlyOwner: "local.nearly.compile.only", InstallLocation: target } });
    assert.equal(result.aborted, false); assert.equal(Number(result.variables.NearlyOwnedUpgrade), 1);
  }
  assert.equal(runDecision("NearlyCheckInstallOwnership", { files: ["$INSTDIR\\settings.json"] }).aborted, false);
  const install = template.slice(template.indexOf("Section Install"), template.indexOf("Function un.onInit"));
  assert.ok(install.indexOf("Call NearlyCheckInstallOwnership") < install.indexOf("CreateDirectory"));
  assert.match(template, /GetFileAttributesW/); assert.match(template, /IntOp \$6 \$5 & 0x400/);
});

test("one visible page offers two independent upgrade-persistent choices", () => {
  assert.equal((template.match(/\$\{NSD_CreateCheckbox\}/g) ?? []).length, 2);
  for (const [name, variable] of [["StartMenuShortcut", "NearlyStartMenu"], ["DesktopShortcut", "NearlyDesktop"]]) {
    assert.match(template, new RegExp(`ReadRegDWORD \\$${variable} HKCU "\\$\\{PREFSKEY\\}" "${name}"\\s+\\$\\{If\\} \\$\\{Errors\\}`));
    assert.match(template, new RegExp(`WriteRegDWORD HKCU "\\$\\{PREFSKEY\\}" "${name}" \\$${variable}`));
    assert.match(template, new RegExp(`\\$\\{NSD_GetState\\} \\$${variable}Checkbox \\$${variable}`));
  }
  assert.doesNotMatch(template, /MUI_PAGE_STARTMENU|MUI_FINISHPAGE_SHOWREADME/);
  assert.doesNotMatch(template, /DeleteReg(?:Key|Value).*PREFSKEY/);
  const init = template.slice(template.indexOf("Function .onInit"), template.indexOf("Function NearlySkipPassive"));
  assert.ok(init.indexOf("Call NearlyLoadPreferences") < init.indexOf("Call NearlyRequireWebView"));
  assert.match(template, /\$\{If\} \$NearlyNoShortcuts != 1\s+ClearErrors\s+WriteRegDWORD/);
});

test("running checks block instead of terminating, before installer mutations", () => {
  assert.doesNotMatch(template, /::RmShutdown|::RmRestart|taskkill|KillProcess|CheckIfAppIsRunning|ExecWait|NSISdl::/i);
  const guard = template.slice(template.indexOf("!macro NearlyRequireClosed"), template.indexOf("; COM target comparison"));
  assert.match(guard, /RestartManager_StartSession/);
  assert.match(guard, /RestartManager_RegisterFile/);
  assert.match(guard, /::RmGetList/);
  assert.match(guard, /\$\{ElseIf\} \$0 != 0/);
  assert.match(guard, /\$\{OrIf\} \$4 != 0/);
  assert.ok((guard.match(/SetErrorLevel 2\s+Abort/g) ?? []).length >= 3);
  const install = template.slice(template.indexOf("Section Install"), template.indexOf("Function un.onInit"));
  assert.ok(install.indexOf("!insertmacro NearlyRequireClosed") < install.indexOf("CreateDirectory"));
  assert.ok(install.indexOf("CreateFileW") < install.indexOf('File "/oname='));
});

test("per-user fixed writable install, manual WebView prerequisite, no userdata removal", () => {
  assert.match(template, /RequestExecutionLevel user/);
  assert.doesNotMatch(template, /RequestExecutionLevel (?:admin|highest)|WriteReg\w+ HKLM|DeleteReg\w+ HKLM/);
  assert.doesNotMatch(template, /MUI_PAGE_DIRECTORY|DeleteAppData|RmDir\s+\/(?:r|REBOOTOK)|Delete\s+[^\r\n]*\*|File\s+[^\r\n]*settings\.json/i);
  assert.match(template, /GetFullPathName \$INSTDIR "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/);
  assert.match(template, /"\{\{install_webview2_mode\}\}" != ""/);
  assert.match(template, /Function NearlyRequireWebView/);
  assert.match(template, /WebView2 Runtime is required/);
  assert.match(template, /WriteUninstaller "\$INSTDIR\\uninstall\.exe"/);
  for (const line of template.split(/\r?\n/).filter(line => /^\s*Delete\s/.test(line))) {
    assert.ok(/"\$INSTDIR\\(?:\$\{MAINBINARYNAME\}\.exe|uninstall\.exe)"|"\$\{path\}"/.test(line), `Unexpected delete: ${line}`);
  }
  assert.match(template, /NearlyIsShortcutTarget/);
  assert.match(template, /Existing foreign shortcut left unchanged/);
});

test("updater handshake waits for exact parent before mutation and restarts only on install success", () => {
  const wait = template.match(/Function NearlyWaitUpdateParent\r?\n([\s\S]*?)FunctionEnd/)[1];
  for (const required of ["OpenProcess(i 0x00101000", "GetProcessTimes", "StrCmp $1 $NearlyCreated", "QueryFullProcessImageNameW", 'StrCmp $2 "$INSTDIR\\${MAINBINARYNAME}.exe"', "OpenEventW", "SetEvent", "WaitForSingleObject(p $NearlyParentHandle, i 200)", "IntCmp $NearlyWaitTicks 300", "CloseHandle(p $NearlyParentHandle)", "NearlyUpdateAbort-", "WaitForSingleObject(p $NearlyAbortHandle, i 0)"])
    assert.ok(wait.includes(required), `Missing handoff invariant: ${required}`);
  assert.ok(wait.indexOf("GetProcessTimes") < wait.indexOf("SetEvent"));
  assert.ok(wait.indexOf("QueryFullProcessImageNameW") < wait.indexOf("SetEvent"));
  assert.ok(wait.indexOf("NearlyUpdateAbort-") < wait.indexOf("SetEvent"));
  assert.ok(wait.indexOf("NearlyUpdateCommit-") < wait.indexOf("SetEvent"));
  assert.ok(wait.indexOf("WaitForSingleObject(p $NearlyCommitHandle, i 0)") > wait.indexOf("nearly_update_parent_exited:"));
  assert.doesNotMatch(wait, /WriteReg|CreateDirectory|CreateShortcut|Delete |File \"|TerminateProcess/);
  const init = template.match(/Function \.onInit\r?\n([\s\S]*?)FunctionEnd/)[1];
  assert.ok(init.indexOf("Call NearlyWaitUpdateParent") > init.indexOf("SemverCompare"));
  assert.ok(init.indexOf("!insertmacro NearlyRequireClosed") > init.indexOf("Call NearlyWaitUpdateParent"));
  const success=template.match(/Function \.onInstSuccess\r?\n([\s\S]*?)FunctionEnd/)[1];
  assert.match(success,/\$NearlyUpdateMode = 1/);
  assert.ok(success.includes('"--nearly-update-health=$NearlyReady"'));
  assert.doesNotMatch(template,/Function \.onInstFailed[\s\S]*?RunAsUser/);
});

test("cached NSIS compiles both installer and automatic uninstaller without executing either", { skip: process.platform !== "win32" }, () => {
  const nsisRoot = process.env.NEARLY_NSIS_ROOT ?? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS");
  const compiler = path.join(nsisRoot, "Bin", "makensis.exe");
  assert.ok(fs.existsSync(compiler), "The existing cached NSIS compiler is required; do not install one in this test");
  const output = path.join(root, "test-results", "nsis-template-compile");
  fs.mkdirSync(output, { recursive: true });
  const payload = path.join(output, "generated-payload.exe");
  fs.writeFileSync(payload, Buffer.from("MZ-generated-compile-only-placeholder"));
  const exe = path.join(output, "generated-setup-DO-NOT-RUN.exe");
  const data = {
    compression: "lzma", product_name: "Nearly", main_binary_name: "Nearly", main_binary_path: payload,
    bundle_id: "local.nearly.compile.only", version: internalVersion, version_with_build: `${internalVersion}.0`,
    manufacturer: "Nearly", copyright: "Nearly contributors", arch: "x64",
    installer_icon: path.join(root, "src-tauri", "icons", "icon.ico"),
    additional_plugins_path: path.join(nsisRoot, "Plugins", "x86-unicode", "additional"),
    // Pinned Tauri CLI 2.12.3 nsis/mod.rs maps Skip to "", not the config's "skip".
    install_mode: "currentUser", install_webview2_mode: "", display_language_selector: "true", estimated_size: "1", out_file: exe,
  };
  let rendered = template.replace(/\{\{#if (?:resources|binaries)\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  rendered = rendered.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key) => {
    assert.ok(Object.hasOwn(data, key), `Unknown NSIS template value ${key}`);
    return data[key];
  });
  assert.equal(rendered.includes("{{"), false, "Every template value must be rendered before compilation");
  const script = path.join(output, "installer.generated.nsi");
  fs.writeFileSync(script, rendered, "utf8");
  const result = spawnSync(compiler, ["/V3", "/INPUTCHARSET", "UTF8", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, NSISDIR: nsisRoot }, timeout: 120_000 });
  fs.writeFileSync(path.join(output, "compile.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /warning \d+:/i, "Packaging must not ignore malformed NSIS instructions");
  const bytes = fs.readFileSync(exe);
  assert.equal(bytes.subarray(0, 2).toString(), "MZ");
  assert.ok(bytes.length > 20_000);
});


test("protocol v2 holds phase handles before readiness and rejects older setup handshakes", () => {
  const wait=template.match(/Function NearlyWaitUpdateParent\r?\n([\s\S]*?)FunctionEnd/)[1];
  assert.ok(wait.includes('${GetOptions} $0 "/NEARLYPROTOCOL=" $NearlyProtocol'));
  assert.ok(wait.includes('StrCmp $NearlyProtocol "2" 0 nearly_update_reject'));
  const ready=wait.indexOf('NearlyUpdateReady-v2-');
  assert.ok(ready>0);
  assert.equal(wait.includes('NearlyUpdateReady-$NearlyReady'),false,"old setups cannot signal the version-2 readiness event");
  for(const phase of ['Installed','Healthy']){
    assert.ok(wait.indexOf('NearlyUpdate'+phase+'-')<ready);
    assert.ok(wait.includes('WaitForSingleObject(p $Nearly'+phase+'Handle, i 0)'));
  }
  const success=template.match(/Function \.onInstSuccess\r?\n([\s\S]*?)FunctionEnd/)[1];
  assert.ok(success.indexOf('SetEvent(p $NearlyInstalledHandle)')<success.indexOf('RunAsUser'));
  assert.ok(success.indexOf('RunAsUser')<success.indexOf('WaitForSingleObject(p $NearlyHealthyHandle, i 30000)'));
  assert.match(success,/SetErrorLevel 9/);
  assert.match(success,/RecoveryRequired/);
  assert.doesNotMatch(success,/Delete |RmDir|WriteReg|TerminateProcess/);
  const handoff=fs.readFileSync(path.join(root,'src-tauri','src','update_handoff.rs'),'utf8');
  assert.ok(handoff.includes('fresh_event("Ready-v2",nonce)'));
  assert.ok(handoff.includes('"/NEARLYPROTOCOL=2"'));
});

// Execute the actual callback with modeled kernel return values. Unknown
// instructions fail. This does not execute any generated setup program.
function runUpdateSuccess({updateMode=1,setInstalled=1,waitResult=0}={}) {
  const body=template.match(/Function \.onInstSuccess\r?\n([\s\S]*?)FunctionEnd/)[1];
  const lines=body.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith(';'));
  let enabled=true,pc=0,budget=100,errorLevel=0,launched=0,installedSignals=0,waits=0;
  const vars={};
  const value=s=>s.startsWith('$')?String(vars[s.slice(1)]??''):s.replace(/^"|"$/g,'');
  while(pc<lines.length){
    assert.ok(budget--,'bounded callback control flow');const line=lines[pc];
    if(line==='${If} $NearlyUpdateMode = 1'){enabled=updateMode===1;pc++;continue;}
    if(line==='${EndIf}'){enabled=true;pc++;continue;}
    if(!enabled||line.endsWith(':')){pc++;continue;}
    if(line.startsWith('System::Call ')){
      if(line.includes('SetEvent(p $NearlyInstalledHandle)')){vars['0']=setInstalled;installedSignals++;}
      else if(line.includes('WaitForSingleObject(p $NearlyHealthyHandle, i 30000)')){vars['0']=waitResult;waits++;}
      else assert.fail('Unknown modeled kernel operation: '+line);
      pc++;continue;
    }
    if(line.startsWith('nsis_tauri_utils::RunAsUser ')){assert.ok(line.includes('"--nearly-update-health=$NearlyReady"'));launched++;pc++;continue;}
    if(line.startsWith('StrCmp ')){
      const args=line.match(/"[^"]*"|\S+/g).slice(1);const target=value(args[0])===value(args[1])?args[2]:args[3];
      pc=target&&target!=='0'?lines.indexOf(target+':')+1:pc+1;continue;
    }
    if(line.startsWith('SetErrorLevel ')){errorLevel=Number(line.slice(14));pc++;continue;}
    if(line.startsWith('DetailPrint ')){pc++;continue;}
    if(line==='Return')break;
    assert.fail('Unknown success callback operation: '+line);
  }
  return {errorLevel,launched,installedSignals,waits};
}
test("actual success callback requires Installed then Healthy; failures preserve recovery and never kill", () => {
  assert.deepEqual(runUpdateSuccess(),{errorLevel:0,launched:1,installedSignals:1,waits:1});
  assert.deepEqual(runUpdateSuccess({updateMode:0}),{errorLevel:0,launched:0,installedSignals:0,waits:0});
  assert.deepEqual(runUpdateSuccess({setInstalled:0}),{errorLevel:9,launched:0,installedSignals:1,waits:0});
  for(const waitResult of [258,0xffffffff])assert.deepEqual(runUpdateSuccess({waitResult}),{errorLevel:9,launched:1,installedSignals:1,waits:1});
});
