import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {createHash} from 'node:crypto';

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
  const vars = { INSTDIR: "C:\\Fixture\\AppData\\Local\\Nearly", SMPROGRAMS: "C:\\Fixture\\Start", DESKTOP: "C:\\Fixture\\Desktop", ...variables };
  const constants = { PRODUCTNAME: "Nearly", MAINBINARYNAME: "Nearly", BUNDLEID: "local.nearly.compile.only", UNINSTKEY: "owned-uninstall-key" };
  const expand = text => text.replace(/^("|')(.*)\1$/, "$2").replace(/\$\{(\w+)\}/g, (_, key) => constants[key] ?? "").replace(/\$(\w+)/g, (_, key) => String(vars[key] ?? ""));
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
      case "Call": {
        if (args[0] === 'NearlyRejectRoot') return {variables:vars,aborted:true,errorLevel:5};
        assert.ok(['NearlyReleaseGuards','NearlyPinRoot'].includes(args[0]));
        if(args[0] === 'NearlyPinRoot')vars.pinCalls=(vars.pinCalls??0)+1;
        pc++;break;
      }
      case "Return": return {variables:vars,aborted:false,errorLevel};
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
  const target = "C:\\Fixture\\AppData\\Local\\Nearly";
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
  assert.ok(install.indexOf("CreateFileW") < install.indexOf('Call NearlyExtractApplication'));
});

test("per-user selected private writable install, manual WebView prerequisite, no userdata removal", () => {
  assert.match(template, /RequestExecutionLevel user/);
  assert.doesNotMatch(template, /RequestExecutionLevel (?:admin|highest)|WriteReg\w+ HKLM|DeleteReg\w+ HKLM/);
  assert.doesNotMatch(template, /DeleteAppData|RmDir\s+\/(?:r|REBOOTOK)|Delete\s+[^\r\n]*\*|File\s+[^\r\n]*settings\.json/i);
  assert.match(template, /GetFullPathName \$NearlyDefaultRoot "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/);
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

test("cached NSIS compiles both installer and automatic uninstaller without executing either", { skip: process.platform !== "win32" }, () => {
  const nsisRoot = process.env.NEARLY_NSIS_ROOT ?? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS");
  const compiler = fs.existsSync(path.join(nsisRoot, "Bin", "makensis.exe")) ? path.join(nsisRoot, "Bin", "makensis.exe") : path.join(nsisRoot, "makensis.exe");
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
  // Inspect generated bytes with a reviewed reader; NEVER launch setup/uninstall.
  const reader=process.env.NEARLY_UPDATER_EXTRACTOR||'C:\\Program Files\\7-Zip\\7z.exe';
  const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const pair=[digest(reader),digest(path.join(path.dirname(reader),'7z.dll'))].join(':');
  assert.ok([
    '254cf6411d38903b2440819f7e0a847f0cfee7f8096cfad9e90fea62f42b0c23:73578f14d50f747efa82527a503f1ad542f9db170e2901eddb54d6bce93fc00e',
    '95fff19b73eff77c87c0d7bd32822e43fb90dd2932459f962eb532d8dfb6ba53:899cd73d7fc60e1c1c35c7de0f5bed3dc69bfe2cecbd48014d868a347970a0b1',
  ].includes(pair),'reviewed coherent archive-reader pair');
  const listing=spawnSync(reader,['l','-slt','-bd','--',exe],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(listing.status,0,listing.stderr);
  const members=listing.stdout.split(/\r?\n/).filter(l=>l.startsWith('Path = ')).map(l=>l.slice(7)).filter(n=>n.replaceAll('\\','/').split('/').at(-1).toLowerCase()==='nearly.exe');
  assert.deepEqual(members,['Nearly.exe'],'single exact member matches the signing-plan contract');
  const extracted=spawnSync(reader,['x','-so','-spd','-bd','-y','--',exe,'Nearly.exe'],{windowsHide:true,timeout:30000});
  assert.equal(extracted.status,0);assert.ok(extracted.stdout.equals(fs.readFileSync(payload)));
});

test('actual registered root resolution locks owned upgrades and rejects migration or partial registration',()=>{
 const def='C:\\Fixture\\AppData\\Local\\Nearly',custom='D:\\Private Apps\\Nearly';
 const base={NearlyRequestedRoot:def,NearlyDefaultRoot:def,NearlyRootMissing:0};
 for(const requested of [def,custom]){
  const result=runDecision('NearlyResolveRegistration',{variables:{...base,NearlyRequestedRoot:requested},registry:{NearlyOwner:'local.nearly.compile.only',InstallLocation:custom,UninstallString:`"${custom}\\uninstall.exe"`}});
  assert.equal(result.aborted,false);assert.equal(result.variables.INSTDIR,custom);assert.equal(result.variables.pinCalls,1);
 }
 for(const [registry,variables] of [
  [{NearlyOwner:'foreign',InstallLocation:custom},base],
  [{InstallLocation:custom},base],
  [{NearlyOwner:'local.nearly.compile.only'},base],
  [{NearlyOwner:'local.nearly.compile.only',InstallLocation:custom,UninstallString:'"D:\\Foreign\\uninstall.exe"'},base],
  [{NearlyOwner:'local.nearly.compile.only',InstallLocation:custom,UninstallString:`"${custom}\\uninstall.exe"`},{...base,NearlyRequestedRoot:'D:\\Migrate'}],
  [{NearlyOwner:'local.nearly.compile.only',InstallLocation:custom,UninstallString:`"${custom}\\uninstall.exe"`},{...base,NearlyRootMissing:1}],
 ])assert.equal(runDecision('NearlyResolveRegistration',{registry,variables}).aborted,true,JSON.stringify({registry,variables}));
 assert.equal(runDecision('NearlyResolveRegistration',{variables:base}).aborted,false,'no registration leaves fresh root selectable');
});
