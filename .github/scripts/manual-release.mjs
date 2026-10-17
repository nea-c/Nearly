import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseRequest, auditSource, createPackage, verifyPackage} from './release-contract.mjs';
import {publishRelease, githubApi, downloadPublic} from './release-publish.mjs';

export async function main(args, env = process.env) {
  const request = parseRequest(env), [command, source, output] = args;
  async function outputs(values) {
    if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));
  }
  if (command === 'inputs') {
    await outputs({commit:request.commit, tag:request.tag, mode:request.mode});
  } else if (command === 'preflight') {
    await auditSource(path.resolve(source), request);
  } else if (command === 'package') {
    const root = path.resolve(source), tree = await auditSource(root, request);
    if (!env.CARGO_TARGET_DIR) throw Error('Explicit owned Cargo target required');
    const result = await createPackage(root, path.resolve(output), request, {tree, payloadPath:path.join(env.CARGO_TARGET_DIR, 'release/Nearly.exe')});
    await outputs({'manifest-sha256':result.manifestHash});
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, `Validated Nearly ${request.tag} at \`${request.commit}\`. Manifest SHA256: \`${result.manifestHash}\`. ${request.mode === 'validate' ? 'Validation only: no tag, Release or downloadable Actions artifact is created.' : 'Audited distribution is ready for the separate publication job.'}\n`);
  } else if (command === 'publish') {
    // No target-source scripts/dependencies are executed in the write-permission job.
    const bundle = await verifyPackage(path.resolve(source), request, {manifestHash:env.RELEASE_MANIFEST_SHA256});
    const notes = await fs.readFile(new URL(`../release-notes/${request.tag}.md`, import.meta.url), 'utf8');
    const result = await publishRelease({request,bundle,notes,api:githubApi(env.GH_TOKEN),download:downloadPublic});
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, `Published [Nearly ${request.tag}](${result.url}) from \`${result.commit}\`. Public installer/checksum bytes verified.\n`);
    console.log(result.url);
  } else throw Error('Unknown manual release operation');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
