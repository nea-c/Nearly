import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {displayVersion, internalVersion, compareReleaseTags, checkVersions, versionFiles, generatedFrontend, readVersion, projectRoot} from '../scripts/version.mjs';

test('release labels have a lossless stable internal mapping and numeric order', () => {
  for (const [internal, label] of [['1.0.0','r1.0'], ['1.1.0','r1.1'], ['2.0.0','r2.0'], ['1.10.0','r1.10']]) {
    assert.equal(displayVersion(internal), label);
    assert.equal(internalVersion(label), internal);
  }
  assert.equal(compareReleaseTags('r1.10', 'r1.9'), 1);
  assert.equal(compareReleaseTags('r2.0', 'r1.10'), 1);
  assert.equal(compareReleaseTags('r1.0', 'r1.0'), 0);
  assert.equal(compareReleaseTags('r1.9', 'r1.10'), -1);
});

test('Windows autocrlf checkout preserves the canonical generated frontend version bytes', async () => {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'nearly-version-checkout-'));
  const git = args => execFileSync('git', ['-C', root, ...args], {encoding:'utf8',stdio:['pipe','pipe','pipe']});
  try {
    git(['init','-b','main']);git(['config','user.name','Generated fixture']);git(['config','user.email','fixture@users.noreply.github.com']);git(['config','core.autocrlf','true']);
    await fs.mkdir(path.join(root,'src'));
    const expected = generatedFrontend(await readVersion());
    await fs.writeFile(path.join(root,'src/version.ts'), expected);
    const attributes = await fs.readFile(path.join(projectRoot,'.gitattributes'),'utf8').catch(e => {if(e.code==='ENOENT')return '';throw e;});
    await fs.writeFile(path.join(root,'.gitattributes'), attributes);
    git(['add','--','.gitattributes','src/version.ts']);git(['commit','-m','Generated checkout fixture']);
    await fs.unlink(path.join(root,'src/version.ts'));git(['checkout','--','src/version.ts']);
    assert.equal(await fs.readFile(path.join(root,'src/version.ts'),'utf8'), expected);
  } finally {
    const resolved = await fs.realpath(root), stat = await fs.lstat(root);
    assert.equal(stat.isSymbolicLink(),false);assert.equal(path.dirname(resolved).toLowerCase(),base.toLowerCase());assert.match(path.basename(resolved),/^nearly-version-checkout-/);
    await fs.rm(root,{recursive:true,force:true});
  }
});
test('patches, prereleases, ambiguous aliases and incompatible Windows values fail closed', () => {
  for (const value of ['1.0.1','1.0.0-beta.1','1.0.0+build','01.0.0','1.00.0','1.0','65536.0.0','1.0.0\n','../escape']) assert.throws(() => displayVersion(value));
  for (const value of ['v1.0.0','1.0.0','r1.0.0','r01.0','r1.00','r1.0-beta','r1.0+build','r1.0\n','r65536.0']) assert.throws(() => internalVersion(value));
});
test('the repository metadata and frontend label match the authoritative milestone', async () => {
  assert.equal(await checkVersions(), '1.0.0');
  const frontend = await fs.readFile(path.join(projectRoot,'src/version.ts'),'utf8');
  assert.match(frontend, /return "r1\.0"/);
});
test('sync detects every metadata drift and preserves unrelated package/lock data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nearly-version-'));
  try {
    await fs.mkdir(path.join(root,'src-tauri'),{recursive:true});
    await fs.mkdir(path.join(root,'src'));
    await fs.copyFile(path.join(projectRoot,'version.json'), path.join(root,'version.json'));
    const files = await versionFiles();
    for (const [name, content] of files) await fs.writeFile(path.join(root,name),content);
    assert.equal(await checkVersions(root),'1.0.0');
    await fs.writeFile(path.join(root,'version.json'),'{"version":"9.9.0"}');
    const changed = await versionFiles(root);
    await fs.writeFile(path.join(root,'version.json'),'{"version":"1.0.0"}');
    for (const [name, original] of files) {
      const drift = changed.get(name);
      await fs.writeFile(path.join(root,name),drift);
      await assert.rejects(checkVersions(root), new RegExp(name.replaceAll('.','\\.')));
      await fs.writeFile(path.join(root,name),original);
    }
    await fs.writeFile(path.join(root,'version.json'),'{"version":"1.10.0"}');
    const next = await versionFiles(root);
    assert.equal(JSON.parse(next.get('package-lock.json')).packages['node_modules/semver']?.version, JSON.parse(files.get('package-lock.json')).packages['node_modules/semver']?.version);
    for (const [name, content] of next) await fs.writeFile(path.join(root,name),content);
    assert.equal(await checkVersions(root),'1.10.0');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
