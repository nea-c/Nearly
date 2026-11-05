// Owned, isolated WebView2 process and generated localhost SFTP credentials only.
import {chromium, expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {packSettings} from './storage-fixture.mjs';
import {createFixture} from './sftp-fixture.mjs';

const exe = path.resolve(process.env.NEARLY_FOCUS_QA_EXE ?? '.native-target/release/NearlyStartupFocusQA.exe');
const output = path.resolve('test-results/startup-focus-native-' + Date.now());
await fs.mkdir(output, {recursive:true});
const endpoint = await createFixture(path.join(output, 'generated-endpoint'));
const evidence = {exe, sha256:createHash('sha256').update(await fs.readFile(exe)).digest('hex'), startup:[], checks:[], errors:[]};
const profile = {id:'focus-generated',name:'Generated focus QA',host:'127.0.0.1',port:endpoint.port,user:'fixture',auth:'key',mode:'sftp',keyFile:endpoint.ppk3,hostKey:endpoint.fingerprint};
const columns = {order:['name','size','type','modified'],hidden:[],widths:{name:280,size:100,type:100,modified:170}};
const settings = {schemaVersion:1,revision:1,
  connections:{profiles:[profile],history:{},tree:{version:1,nodes:[{kind:'profile',id:profile.id,profileId:profile.id,parentId:null}]}},
  appearance:{theme:'dark',language:'en',compactExplorer:false,localPaneRatio:0.5,localTreeRatio:0.28,remoteTreeRatio:0.28},
  explorer:{folderBookmarks:[],folderPairHistory:[],paneColumns:{local:columns,remote:columns},bookmarkTree:{version:1,nodes:[]}},
  browse:{browseLocations:{},paneSorts:{local:{column:'name',direction:'ascending'},remote:{column:'name',direction:'ascending'}}},
  sync:{exclusions:{},syncOptions:{},syncPresets:[],retainedSyncs:[]},trust:{version:1,pins:{[JSON.stringify([profile.host,profile.port])]:'SHA256:'+endpoint.fingerprint.split(' ').at(-1)}}};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser;
try {
  for (let run = 0; run < 3; run++) {
    const root = path.join(output, 'launch-' + run), config = path.join(root, 'config');
    await fs.mkdir(config, {recursive:true});
    for (const [name, bytes] of Object.entries(packSettings(settings))) await fs.writeFile(path.join(config, name), bytes);
    const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    child = spawn(exe, [], {cwd:root,windowsHide:true,env:{...process.env,SYNCFILES_CONFIG_DIR:config,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
    child.stderr.on('data', bytes => fs.appendFile(path.join(root, 'stderr.log'), bytes));
    child.stdout.on('data', bytes => fs.appendFile(path.join(root, 'stdout.log'), bytes));
    const url = 'http://127.0.0.1:' + port;
    await expect.poll(async () => {try {return (await fetch(url+'/json/version')).ok;} catch {return false;}}, {timeout:30000}).toBe(true);
    browser = await chromium.connectOverCDP(url);
    const page = browser.contexts().flatMap(context => context.pages()).find(page => !page.url().startsWith('devtools:'));
    assert(page, 'Owned WebView page is available');
    page.on('pageerror', error => evidence.errors.push(String(error)));
    const input = page.locator('#connect-form [name=passphrase]');
    await expect(input).toBeVisible();
    // Observe settled startup without focusing or clicking any application node.
    await delay(1000);
    evidence.startup.push(await page.evaluate(() => ({focused:document.activeElement?.getAttribute('name'),documentFocused:document.hasFocus(),tabs:document.querySelectorAll('[data-tab]').length})));
    await expect(input).toBeFocused();
    if (run === 0) {
      await page.screenshot({path:path.join(output,'startup.png')});
      await input.fill('generated draft');
      await page.locator('#settings-toggle').click();
      await page.keyboard.press('Escape');
      await expect(input).toHaveValue('generated draft');
      await expect(page.locator('#settings-toggle')).toBeFocused();
      evidence.checks.push('Settings redraw preserves draft and user-selected focus');
      await page.locator('#add-tab').click(); await expect(input).toBeFocused();
      for (let index = 0; index < 6; index++) {
        await page.locator('[data-tab]').nth(index % 2).click(); await expect(input).toBeFocused();
      }
      evidence.checks.push('New tab and six disconnected tab switches focus passphrase');
      await input.fill(endpoint.passphrase); await page.locator('#connect-form .primary').click();
      await expect(page.locator('#connect-form')).toHaveCount(0);
      await page.locator('#add-tab').click(); await expect(input).toBeFocused();
      await page.locator('#settings-toggle').focus(); await page.keyboard.press('Control+Shift+Tab');
      await expect(page.locator('#connect-form')).toHaveCount(0);
      await expect(page.locator('#settings-toggle')).toBeFocused();
      await page.keyboard.press('Control+Tab'); await expect(input).toBeFocused();
      evidence.checks.push('Real localhost SFTP connection and connected-tab return preserve toolbar focus');
    }
    await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()).catch(error => {
      if (!/Target.*closed|Execution context was destroyed/i.test(String(error))) throw error;
    });
    await expect.poll(() => child.exitCode, {timeout:10000}).not.toBe(null);
    await browser.close(); browser = undefined; child = undefined;
  }
  assert.deepEqual(evidence.errors, []);
  evidence.pass = true;
} catch (error) {
  evidence.pass = false; evidence.failure = String(error); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  await browser?.close().catch(() => {});
  await endpoint.close();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({output,...evidence}, null, 2));
}
