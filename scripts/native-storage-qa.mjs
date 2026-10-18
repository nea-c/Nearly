// Actual Tauri/WebView UI and generated storage files; no IPC replacement.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {expect} from '@playwright/test';
export async function verifyNativeStorage(page,{config,profile,saved,evidence,screenshot}){
 await page.locator('[data-connection-select='+JSON.stringify(profile.id)+']').click();
 const stableNames=['history.json','bookmarks.json','sync-profiles.json'];
 const before=Object.fromEntries(await Promise.all(stableNames.map(async n=>[n,await fs.readFile(path.join(config,n))])));
 const trust=(await saved()).trust;
 for(const name of ['Generated storage rename 1','Generated storage rename 2',profile.name]){
  await page.locator('#edit-profile').click();await page.locator('#profile-form [name="name"]').fill(name);await page.locator('#profile-form .primary').click();
  await expect(page.locator('#profile-form')).toHaveCount(0);
  await expect.poll(async()=>(await saved()).connections.profiles.find(p=>p.id===profile.id)?.name).toBe(name);
 }
 const after=await saved();assert.deepEqual(after.trust,trust);assert.equal(after.connections.profiles.length,1);assert.equal(after.connections.profiles[0].id,profile.id);
 for(const n of stableNames)assert.deepEqual(await fs.readFile(path.join(config,n)),before[n],'Profile edits do not rewrite '+n);
 const root=JSON.parse(await fs.readFile(path.join(config,'settings.json'),'utf8'));assert.equal(root.kind,'settings');assert.equal(root.connections,undefined);assert.equal(Object.keys(root.manifest).length,4);
 evidence.push({check:'Actual native profile editor saves three repeated edits in connections.json while history/bookmarks/sync parts keep exact bytes and IDs/trust remain stable',pass:true,cycles:3,storageFormat:'five-files'});
 await screenshot(page,'storage-profile-edits-five-files');
}
