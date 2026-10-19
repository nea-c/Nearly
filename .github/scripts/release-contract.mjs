import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyBootstrapTrust,verifyProductionTrust} from './release-trust.mjs';

export const repository = 'nea-c/Nearly';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (re, value) => typeof value === 'string' && re.exec(value)?.[0] === value;
const oid = value => exact(/[a-f0-9]{40}/, value);
const digest = value => exact(/[a-f0-9]{64}/, value);
const fail = message => {throw Error(message);};
export function parseRequest(env) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') fail('Only a main-branch manual dispatch in the official repository is accepted');
  if (!oid(env.RELEASE_COMMIT) || !oid(env.GITHUB_WORKFLOW_SHA) || !exact(/[1-9][0-9]*/, env.GITHUB_RUN_ID)) fail('Exact lowercase commit SHA and workflow/run identity required');
  const tag = env.RELEASE_TAG, m = typeof tag === 'string' && /r(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/.exec(tag);
  if (!m || m[0] !== tag || !m.slice(1).every(n => Number.isSafeInteger(+n) && +n <= 65535)) fail('Canonical Windows-compatible rX.Y required');
  const mode = env.RELEASE_MODE || 'validate';
  if (!['validate', 'release'].includes(mode)) fail('Unknown release mode');
  if (mode === 'release' && env.RELEASE_CONFIRM !== `release ${tag} ${env.RELEASE_COMMIT}`) fail('Exact release/version/commit confirmation required');
  return {repository, commit: env.RELEASE_COMMIT, tag, version: `${m[1]}.${m[2]}.0`, mode, workflowCommit: env.GITHUB_WORKFLOW_SHA, runId: env.GITHUB_RUN_ID};
}

export function auditBytes(bytes, prefixes = [], reviewedExamples = []) {
  for (const [encoding,text] of [['utf8',bytes.toString('utf8')], ['utf16le',bytes.toString('utf16le')], ['utf16le-offset1',bytes.subarray(1).toString('utf16le')]]) {
    let normalized = text.replace(/\\+/g, '/').toLowerCase();
    for (const example of reviewedExamples) normalized = normalized.replaceAll(example, 'reviewed-public-source-example');
    const userPath = /[a-z]:\/+users\/+[^/\s\0]+/.test(normalized);
    const prefixIndex = prefixes.findIndex(p => p && normalized.includes(p.replace(/\\+/g, '/').toLowerCase()));
    if (userPath || prefixIndex >= 0) fail(`Release privacy check failed: personal build path (encoding=${encoding}; path=${userPath ? 'windows-user' : 'known-prefix-'+prefixIndex})`);
    // SSH/crypto parsers legitimately embed format markers. A marker alone is
    // not key material; reject PEM bodies, including JSON-escaped key strings.
    const pem = text.replace(/\\r\\n|\\n/g, '\n');
    if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[ \t]*\r?\n(?:(?:Proc-Type|DEK-Info):[^\r\n]*\r?\n){0,4}[\r\n]*[A-Za-z0-9+/=]{32,}/.test(pem) || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)) fail('Release privacy check failed: credential-like data');
  }
}
export function assertSafeSourcePath(name) {
  if (!name || name.includes('..') || name.includes('\\') || path.posix.isAbsolute(name) || /(?:^|\/)(?:build|dist|target|node_modules|diagnostics|backups|test-results|playwright-report|\.ssh|\.aws|\.codex|\.agents|\.superpowers|private|qa)(?:\/|$)/i.test(name) || /(?:^|\/)(?:\.env(?:\..*)?|settings(?:\.backup)?\.json|host-pins\.json|id_rsa|id_ed25519)$/i.test(name) || /\.(?:exe|dll|pdb|ppk|pem|p12|pfx|key|log|bak)$/i.test(name)) fail('Forbidden source/history path');
}
const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], {maxBuffer: 128 * 1024 * 1024, windowsHide: true, ...options});
export function auditGitObjects(raw) {
  let offset = 0, count = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(10, offset); if (end < 0) fail('Truncated history audit');
    const header = raw.subarray(offset, end).toString('ascii').split(' '), size = Number(header[2]);
    if (!oid(header[0]) || !['blob', 'tree', 'commit', 'tag'].includes(header[1]) || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= raw.length) fail('Invalid history audit object');
    const body = raw.subarray(end + 1, end + 1 + size);
    if (header[1] === 'blob') {
      // Only these byte-identical, already-public source blobs contain reviewed
      // synthetic/public-folder examples. Payload audit never uses exceptions.
      const examples = {
        e4ba4a3e32f236b5037afc0951bc01301eeb7f986b4764f026f7c82b9c04b92e: [['c:', 'users', 'fixture', 'appdata', 'local', 'nearly'].join('/')],
        '78272bd40b8a783c0ab94e4bcb400fd947ba306a7575f2bbbbccb7478f40447f': [['c:', 'users', 'public', 'desktop', 'app.lnk'].join('/')],
      };
      auditBytes(body, [], examples[sha256(body)] || []); count++;
    }
    offset = end + size + 2;
    if (raw[offset - 1] !== 10) fail('Invalid history audit separator');
  }
  return count;
}
export async function verifyVersionAndGates(root, request, {profile='legacy'}={}) {
  const v = JSON.parse(await fs.readFile(path.join(root, 'version.json'), 'utf8'));
  if (JSON.stringify(Object.keys(v)) !== '["version"]' || v.version !== request.version) fail('Requested release and source version differ');
  if(profile==='registered-production'){await verifyProductionTrust(root);return;}
  if(profile==='signed-bootstrap'){await verifyBootstrapTrust(root);return;}
  if(profile!=='legacy')fail('Unknown release trust profile');
  const key = await fs.readFile(path.join(root, 'src-tauri/src/update_package.rs'), 'utf8');
  const gate = await fs.readFile(path.join(root, 'src-tauri/src/startup_update.rs'), 'utf8');
  if (!/production_key\(\)\s*->\s*Option<TrustedKey>\s*\{\s*None\s*\}/.test(key) || !/HANDOFF_RELEASE_VALIDATED\s*:\s*bool\s*=\s*false/.test(gate)) fail('Production updater must remain disabled');
}
export async function auditSource(root, request, options={}) {
  if (git(root, ['rev-parse', 'HEAD']).toString().trim() !== request.commit || git(root, ['status', '--porcelain', '--untracked-files=all']).length) fail('Source checkout is not clean at the exact requested commit');
  git(root, ['merge-base', '--is-ancestor', request.commit, 'refs/remotes/origin/main']);
  await verifyVersionAndGates(root, request, options);
  const names = git(root, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const name of names) assertSafeSourcePath(name);
  const identities = git(root, ['log', '--format=%ae%n%ce', request.commit]).toString('utf8').trim().split(/\r?\n/);
  // Ordinary protected PR merges use GitHub's public web-flow committer.
  // Authors still require an account's public noreply identity; do not allow a
  // general github.com domain exception or a private owner address.
  if (identities.some((e,i) => !exact(/[a-zA-Z0-9+_.-]+@users\.noreply\.github\.com/, e) && !(i%2===1 && e==='noreply@github.com'))) fail('History uses a non-public commit email; review it before release');
  const objects = git(root, ['rev-list', '--objects', request.commit]).toString('utf8').trim().split('\n');
  if (objects.length > 100000) fail('History audit object budget exceeded');
  for (const line of objects) {const n = line.indexOf(' '); if (n >= 0 && line.slice(n + 1)) assertSafeSourcePath(line.slice(n + 1));}
  const input = objects.map(line => line.split(' ')[0]).join('\n') + '\n';
  auditGitObjects(git(root, ['cat-file', '--batch'], {input}));
  return git(root, ['rev-parse', 'HEAD^{tree}']).toString('utf8').trim();
}

const namesFor = tag => [`Nearly_${tag}_x64-setup.exe`, `Nearly_${tag}_x64-setup.exe.sha256`];
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) fail('Release input is not a bounded regular file');
  return fs.readFile(file);
}
function pe(bytes, machine) {
  if (bytes.length < 72 || bytes.readUInt16LE(0) !== 0x5a4d) fail('Invalid release PE');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== machine) fail('Invalid release PE architecture');
}
export async function createPackage(root, output, request, {payloadPath, tree}) {
  await verifyVersionAndGates(root, request);
  if (!oid(tree)) fail('Exact source tree required');
  const [name, checksumName] = namesFor(request.tag);
  const installer = await regular(path.join(root, 'build', name)), payload = await regular(payloadPath);
  const metadata = JSON.parse(await regular(path.join(root, 'build/installer-build-info.json')));
  pe(installer, 0x14c); pe(payload, 0x8664);
  if (metadata.version !== request.version || metadata.displayVersion !== request.tag || metadata.identifier !== 'local.syncfiles.native' || metadata.payloadArchitecture !== 'x64' || metadata.installMode !== 'currentUser' || metadata.settingsIncluded !== false || metadata.adjacentSettingsPreserved !== true || metadata.updaterInstallationEnabled !== false || metadata.signed !== false || metadata.bytes !== installer.length || metadata.sha256 !== sha256(installer) || metadata.embeddedApplicationSha256 !== sha256(payload)) fail('Installer source/payload metadata mismatch');
  const prefixes = [process.env.USERPROFILE, process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP, root];
  try {auditBytes(installer, prefixes);} catch(error) {fail('Installer: '+error.message);}
  try {auditBytes(payload, prefixes);} catch(error) {fail('Payload: '+error.message);}
  const checksum = Buffer.from(`${sha256(installer)}  ${name}\n`, 'utf8');
  const assets = [{name, data: installer}, {name: checksumName, data: checksum}].map(a => ({name: a.name, bytes: a.data.length, sha256: sha256(a.data)}));
  const manifest = {schemaVersion: 1, repository, commit: request.commit, tree, tag: request.tag, version: request.version, workflowCommit: request.workflowCommit, runId: request.runId, assets};
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  auditBytes(manifestBytes, prefixes);
  await fs.mkdir(output); // Existing directories are not reused or cleaned.
  await fs.writeFile(path.join(output, name), installer, {flag: 'wx'});
  await fs.writeFile(path.join(output, checksumName), checksum, {flag: 'wx'});
  await fs.writeFile(path.join(output, 'manifest.json'), manifestBytes, {flag: 'wx'});
  return {manifestHash: sha256(manifestBytes)};
}
export async function verifyPackage(dir, request, {manifestHash}) {
  if (!digest(manifestHash)) fail('Trusted manifest digest required');
  const [name, checksum] = namesFor(request.tag), expectedNames = [name, checksum, 'manifest.json'].sort();
  const rootStat = await fs.lstat(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || JSON.stringify((await fs.readdir(dir)).sort()) !== JSON.stringify(expectedNames)) fail('Unexpected release package files');
  const bytes = await regular(path.join(dir, 'manifest.json')); if (sha256(bytes) !== manifestHash) fail('Release manifest digest mismatch');
  auditBytes(bytes);
  const m = JSON.parse(bytes);
  if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(['schemaVersion','repository','commit','tree','tag','version','workflowCommit','runId','assets'].sort()) || m.schemaVersion !== 1 || !oid(m.tree) || ['repository','commit','tag','version','workflowCommit','runId'].some(k => m[k] !== request[k])) fail('Release manifest/request binding mismatch');
  if (!Array.isArray(m.assets) || m.assets.length !== 2) fail('Invalid release asset manifest');
  const assets = [];
  for (const [i, a] of m.assets.entries()) {
    if (JSON.stringify(Object.keys(a).sort()) !== '["bytes","name","sha256"]' || a.name !== [name, checksum][i] || !digest(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes <= 0) fail('Invalid release asset descriptor');
    const data = await regular(path.join(dir, a.name));
    if (data.length !== a.bytes || sha256(data) !== a.sha256) fail('Release asset bytes differ');
    auditBytes(data); assets.push({...a, data});
  }
  if (!assets[1].data.equals(Buffer.from(`${assets[0].sha256}  ${name}\n`))) fail('Release checksum content mismatch');
  pe(assets[0].data, 0x14c);
  return {manifest: m, assets};
}
