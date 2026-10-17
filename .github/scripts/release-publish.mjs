import {repository, sha256, auditBytes} from './release-contract.mjs';

const fail = message => {throw Error(message);};
const releasePath = id => {
  if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid GitHub release identity');
  return `/releases/${id}`;
};
function checkTag(tag, request) {
  if (tag && (tag.object?.type !== 'commit' || tag.object.sha !== request.commit)) fail('Existing tag targets another commit or is not an owned lightweight tag; never retag');
}
function checkAssets(release, expected, complete = false) {
  if (!Array.isArray(release.assets) || release.assets.length > 2) fail('Unexpected existing release assets');
  const seen = new Set();
  for (const a of release.assets) {
    const e = expected.find(x => x.name === a.name);
    if (seen.has(a.name) || !e || a.state !== 'uploaded' || a.size !== e.bytes || a.digest !== `sha256:${e.sha256}`) fail('Existing asset conflicts; never overwrite or delete it');
    seen.add(a.name);
  }
  if (complete && seen.size !== 2) fail('Release assets are incomplete');
}
export async function publishRelease({request, bundle, notes, api, download}) {
  if (request.mode !== 'release') fail('Validation mode cannot publish');
  const m = bundle.manifest;
  if (['repository','commit','tag','version','workflowCommit','runId'].some(k => m[k] !== request[k]) || bundle.assets.length !== 2 || bundle.assets.some((a,i) => a.name !== m.assets[i]?.name || a.sha256 !== m.assets[i]?.sha256 || a.bytes !== m.assets[i]?.bytes || a.bytes !== a.data.length || sha256(a.data) !== a.sha256)) fail('Publish request/artifact binding mismatch');
  auditBytes(Buffer.from(notes));
  const repo = await api.get('');
  if (repo.full_name !== repository || repo.private !== false) fail('Unexpected repository identity or visibility');
  const source = await api.get(`/git/commits/${request.commit}`);
  const version = await api.get(`/contents/version.json?ref=${request.commit}`);
  if (source.sha !== request.commit || source.tree?.sha !== m.tree || version.encoding !== 'base64' || JSON.parse(Buffer.from(version.content, 'base64')).version !== request.version) fail('GitHub source/version differs from tested artifact');
  const marker = `<!-- nearly-manual-release ${JSON.stringify(m)} -->`;
  const body = `${notes.trim()}\n\n${marker}\n`;
  const name = `Nearly ${request.tag}`;
  let release;
  for (let page = 1; page <= 10; page++) {
    const list = await api.get(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(list)) fail('Invalid GitHub release listing');
    for (const candidate of list.filter(r => r.tag_name === request.tag)) {
      if (release) fail('Multiple releases for requested tag');
      release = candidate;
    }
    if (list.length < 100) break;
    if (page === 10) fail('Release-list audit budget exceeded');
  }
  const tag = await api.get(`/git/ref/tags/${request.tag}`);
  checkTag(tag, request);
  if (release) {
    if (release.body !== body || release.name !== name || release.prerelease !== false || !tag) fail('Existing release is not this exact run/artifact; preserve it');
    checkAssets(release, bundle.assets, !release.draft);
  }
  // Every write has a preceding state read. Never retry network writes here.
  if (!tag) await api.create('/git/refs', {ref: `refs/tags/${request.tag}`, sha: request.commit});
  if (!release) release = await api.create('/releases', {tag_name: request.tag, target_commitish: request.commit, name, body, draft: true, prerelease: false, generate_release_notes: false});
  const id = release.id;
  if (release.draft) {
    for (const asset of bundle.assets) {
      release = await api.get(releasePath(id));
      if (!release.draft || release.body !== body || release.tag_name !== request.tag || release.prerelease !== false) fail('Draft changed during publication');
      checkAssets(release, bundle.assets);
      if (!release.assets.some(a => a.name === asset.name)) {
        const uploaded = await api.upload(release, asset);
        checkAssets({assets: [uploaded]}, bundle.assets);
      }
    }
    release = await api.get(releasePath(id));
    if (!release.draft || release.body !== body || release.tag_name !== request.tag || release.prerelease !== false) fail('Draft changed before publication');
    checkAssets(release, bundle.assets, true);
    const beforePublishTag = await api.get(`/git/ref/tags/${request.tag}`);
    if (!beforePublishTag) fail('Tag disappeared before publication; retain the draft');
    checkTag(beforePublishTag, request);
    release = await api.patch(releasePath(id), {draft: false, prerelease: false, make_latest: 'true'});
  }
  release = await api.get(releasePath(id));
  if (release.draft || release.prerelease || release.tag_name !== request.tag || release.body !== body) fail('Stable publication not confirmed; inspect remote state');
  checkAssets(release, bundle.assets, true);
  const finalTag = await api.get(`/git/ref/tags/${request.tag}`); if (!finalTag) fail('Published tag missing'); checkTag(finalTag, request);
  for (const asset of release.assets) {
    const data = await download(asset);
    if (data.length !== asset.size || sha256(data) !== bundle.assets.find(a => a.name === asset.name).sha256) fail('Public downloaded bytes differ; inspect release, never overwrite');
  }
  return {url: `https://github.com/${repository}/releases/tag/${request.tag}`, commit: request.commit};
}

async function bytes(response, limit) {
  if (!response.body) fail('GitHub response has no body');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {size += chunk.length; if (size > limit) {await response.body.cancel().catch(()=>{}); fail('GitHub response exceeds budget');} chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export function githubApi(token) {
  if (!token) fail('Ephemeral GitHub token required for release mode');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
  async function call(method, suffix, body) {
    if (!suffix.startsWith('/') && suffix !== '') fail('Invalid GitHub API path');
    const response = await fetch(base + suffix, {method, redirect: 'error', headers: {...headers, ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000)});
    if (method === 'GET' && response.status === 404 && suffix.startsWith('/git/ref/tags/')) return null;
    if (!response.ok) fail(`GitHub ${method} failed (${response.status}); inspect state before retrying`);
    return JSON.parse(await bytes(response, 4 * 1024 * 1024));
  }
  return {get: p => call('GET', p), create: (p,b) => call('POST',p,b), patch: (p,b) => call('PATCH',p,b),
    async upload(release, asset) {
      releasePath(release.id);
      const expected = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets`;
      if (release.upload_url?.split('{')[0] !== expected) fail('Unexpected upload endpoint');
      const response = await fetch(`${expected}?name=${encodeURIComponent(asset.name)}`, {method:'POST', redirect:'error', headers:{...headers, 'Content-Type':'application/octet-stream', 'Content-Length':String(asset.bytes)}, body:asset.data, signal:AbortSignal.timeout(120000)});
      if (!response.ok) fail(`GitHub upload failed (${response.status}); inspect draft before retrying`);
      return JSON.parse(await bytes(response, 1024 * 1024));
    }};
}
export async function downloadPublic(asset) {
  const prefix = `https://github.com/${repository}/releases/download/`;
  let url = new URL(asset.browser_download_url);
  if (!url.href.startsWith(prefix) || !url.pathname.endsWith('/' + asset.name)) fail('Unexpected public asset URL');
  for (let redirects = 0; redirects < 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)) fail('Unexpected public download redirect');
    const response = await fetch(url, {redirect:'manual', signal:AbortSignal.timeout(120000)});
    if ([301,302,303,307,308].includes(response.status)) {url = new URL(response.headers.get('location'), url); continue;}
    if (!response.ok) fail(`Public asset download failed (${response.status}); publication may already be complete`);
    return bytes(response, 64 * 1024 * 1024);
  }
  fail('Public asset redirect budget exceeded');
}
