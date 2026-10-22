import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {assertPeIconMatches} from '../scripts/inspect-pe-icons.mjs';
import {encodeIco} from '../scripts/generate-uninstall-icon.mjs';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root));

test('installer and generated uninstaller select separate icon assets', () => {
  const nsis = JSON.parse(read('src-tauri/tauri.conf.json')).bundle.windows.nsis;
  assert.equal(nsis.installerIcon, 'icons/icon.ico');
  assert.equal(nsis.uninstallerIcon, 'icons/uninstall.ico');
  const template = read('src-tauri/windows/installer.nsi').toString();
  assert.match(template, /^!define MUI_UNICON "\{\{uninstaller_icon\}\}"$/m);
});

test('ICO encoder preserves alpha, bottom-up BGRA and the legacy transparency mask', () => {
  const bytes = encodeIco([{size: 2, rgba: [255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 255, 255, 255, 255]}]);
  const dib = bytes.subarray(bytes.readUInt32LE(18));
  assert.deepEqual([...dib.subarray(40, 56)], [255, 0, 0, 128, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 0]);
  assert.deepEqual([...dib.subarray(56)], [0, 0, 0, 0, 64, 0, 0, 0]);
  assert.throws(() => encodeIco([{size: 16, rgba: []}]), /RGBA/);
});

test('cached NSIS embeds each new uninstaller icon resource without executing setup or uninstall', {skip: process.platform !== 'win32'}, () => {
  const project = fileURLToPath(root);
  const nsis = process.env.NEARLY_NSIS_ROOT ?? path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS');
  const compiler = path.join(nsis, 'Bin', 'makensis.exe');
  assert.ok(fs.existsSync(compiler), 'existing cached NSIS compiler required; never download tools');
  const parent = path.join(project, 'test-results');
  fs.mkdirSync(parent, {recursive: true});
  const output = fs.mkdtempSync(path.join(parent, 'uninstall-icon-'));
  const setup = path.join(output, 'fixture-setup-DO-NOT-RUN.exe');
  const uninstall = path.join(output, 'fixture-uninstall-DO-NOT-RUN.exe');
  const capture = path.join(output, 'capture.mjs');
  fs.writeFileSync(capture, `import fs from 'node:fs'; fs.copyFileSync(process.argv[2], ${JSON.stringify(uninstall)}, fs.constants.COPYFILE_EXCL);`);
  const config = JSON.parse(read('src-tauri/tauri.conf.json')).bundle.windows.nsis;
  const values = {installer_icon: path.join(project, 'src-tauri', config.installerIcon), uninstaller_icon: path.join(project, 'src-tauri', config.uninstallerIcon)};
  const defines = read('src-tauri/windows/installer.nsi').toString().match(/^!define MUI_(?:UN)?ICON .+$/gm).join('\n').replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
  const script = `Unicode true\nRequestExecutionLevel user\nOutFile "${setup}"\n${defines}\n!include MUI2.nsh\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_UNPAGE_INSTFILES\n!insertmacro MUI_LANGUAGE English\n!uninstfinalize '\"${process.execPath}\" \"${capture}\" \"%1\"' = 0\nSection\nWriteUninstaller "$TEMP\\NEVER-EXECUTED-uninstall.exe"\nSectionEnd\nSection Uninstall\nSectionEnd\n`;
  const file = path.join(output, 'fixture.nsi');
  fs.writeFileSync(file, script);
  const result = spawnSync(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', file], {encoding: 'utf8', windowsHide: true, timeout: 30000, env: {...process.env, NSISDIR: nsis}});
  fs.writeFileSync(path.join(output, 'compile.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(assertPeIconMatches(fs.readFileSync(uninstall), read('src-tauri/icons/uninstall.ico')), [16, 24, 32, 48, 64, 256]);
  assert.throws(() => assertPeIconMatches(fs.readFileSync(uninstall), read('src-tauri/icons/icon.ico')), /icon group frame count|icon resource matches source/);
  assertPeIconMatches(fs.readFileSync(setup), read('src-tauri/icons/icon.ico'));
});

test('uninstaller icon supplies distinct opaque 32-bit images at all Explorer sizes', () => {
  const ico = read('src-tauri/icons/uninstall.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 6);
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    sizes.push(size);
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const start = ico.readUInt32LE(entry + 12);
    const bytes = ico.readUInt32LE(entry + 8);
    assert.ok(start + bytes <= ico.length);
    const dib = ico.subarray(start, start + bytes);
    assert.equal(dib.readUInt32LE(0), 40);
    assert.equal(dib.readUInt32LE(4), size);
    assert.equal(dib.readUInt32LE(8), size * 2);
    // The red removal badge must survive at 16px, not just a different filename.
    let red = 0, green = 0;
    for (let p = 40; p < 40 + size * size * 4; p += 4) {
      const [b, g, r, a] = dib.subarray(p, p + 4);
      if (a > 200 && r > 150 && r > g * 1.4 && r > b * 1.4) red++;
      if (a > 200 && g > r * 1.1 && g > b * 1.4) green++;
    }
    assert.ok(red > size * size * 0.04, `${size}px removal badge remains visible`);
    assert.ok(green > size * size * 0.1, `${size}px retains the green family`);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 256]);
  assert.notDeepEqual(ico, read('src-tauri/icons/icon.ico'));
});
