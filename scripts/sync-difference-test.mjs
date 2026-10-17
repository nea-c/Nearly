import { createFixture } from './sftp-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const output = path.resolve('test-results/sync-difference-' + Date.now());
let disconnected = false;
const readCalls = new Map();
const fixture = await createFixture(output, {
  beforeStat(op, p) {
    if (p==='/difference-real-link') {
      const link=path.join(fixture.remote,'difference-real-link/link');
      if (!fs.existsSync(link)) {
        fs.writeFileSync(path.join(fixture.remote,'other/link-sentinel.txt'),'generated out-of-selected-root sentinel');
        fs.symlinkSync(path.join(fixture.remote,'other'),link,'junction');
      }
    }
    if (p.endsWith('/trigger.txt') && !disconnected && fs.existsSync(path.join(output, 'inject-disconnect'))) {
      disconnected = true; return 4;
    }
    if (p.endsWith('/difference-mutated/orphan.txt')) fs.writeFileSync(path.join(output,'remote/difference-mutated/orphan.txt'),'generated remote mutation after snapshot');
    if (p.endsWith('/difference-root-race/orphan.txt')) {
      const local = path.join(output,'difference-root-race');
      if (fs.existsSync(local)) fs.renameSync(local,local+'-original');
      fs.mkdirSync(local,{recursive:true});
    }
    if (p.endsWith('/cancel.txt') && fs.existsSync(path.join(output,'hold-stop-transfer'))) {
      fs.writeFileSync(path.join(output,'stop-transfer-observed'),'generated');
      return new Promise(resolve => setTimeout(() => resolve(4), 3000));
    }
  },
  beforeReadDir(p) {
    if (p && path.basename(p)==='difference-stop-inventory') {
      fs.writeFileSync(path.join(output,'inventory-stop-observed'),'generated');
      return new Promise(resolve=>setTimeout(()=>resolve(4),3000));
    }
    if (p && path.basename(p) === 'denied') return 3;
    if (p && path.basename(p) === 'difference-partial') {
      const count = (readCalls.get(p)||0)+1; readCalls.set(p,count);
      if (count > 1) return 4;
    }
  },
  mapReadDir(p,names) {
    if (path.basename(p)==='difference-unsupported') {
      for (const name of names) if (name.filename === 'link.txt') name.attrs.mode = 0o120777;
      names.push({filename:'CON.txt',longname:'',attrs:{mode:0o100644,size:7,atime:1700000000,mtime:1700000000}});
      names.push({filename:'bad:stream',longname:'',attrs:{mode:0o100644,size:7,atime:1700000000,mtime:1700000000}});
    }
    return names;
  },
  beforeSetStat(op,p) {
    if (p.includes('difference-timestamp-refused')) return 8;
    if (p.includes('difference-timestamp-lying')) return 0;
  },
  beforeRmdir(p, local) {
    if (p.endsWith('/race-child')) fs.writeFileSync(path.join(local, 'concurrent.txt'), 'generated concurrent child');
    if (p.endsWith('/uncertain')) { fs.rmdirSync(local); return 4; }
  },
});
const manifest = path.join(output, 'generated-fixture.json');
fs.writeFileSync(manifest, JSON.stringify({ root: output, remote: fixture.remote,
  port: fixture.port, key: fixture.ppk3, passphrase: fixture.passphrase, fingerprint: fixture.fingerprint }));
try {
  const filter = process.argv[2] || 'sync_difference_generated_localhost';
  if (!['sync_difference_generated_localhost', 'directory_deletion_generated_localhost'].includes(filter)) throw Error('Unsupported generated-only test filter');
  const child = spawn('cargo', ['test', '--offline', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    '--target-dir', process.env.CARGO_TARGET_DIR || path.resolve('src-tauri/target'), filter, '--', '--ignored', '--nocapture', '--test-threads=1'],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NEARLY_DIRECTORY_FIXTURE: manifest } });
  const log = fs.createWriteStream(path.join(output, 'native.log'));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { process.stdout.write(data); log.write(data); });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  log.end();
  const paths=fixture.requestPaths;
  if (paths.some(entry=>entry.operation==='OPENDIR' && entry.path.startsWith('/difference-shallow/'))) throw Error('Recursive-OFF must not inventory nested remote directories');
  if (paths.some(entry=>entry.operation==='OPENDIR' && entry.path.startsWith('/difference-real-link/link'))) throw Error('Remote symlink must never be traversed');
  if (paths.some(entry=>['REMOVE','RMDIR'].includes(entry.operation) && /CON\.txt|bad:stream|link\.txt/.test(entry.path))) throw Error('Unsupported remote entries must never receive a delete request');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ code, requests: fixture.requestCounts, paths }, null, 2));
  process.exitCode = code ?? 1;
  console.log('Generated fixture results:', output);
} finally { await fixture.close(); }
