import assert from 'node:assert/strict';
import {test} from 'node:test';
import {packSettings,unpackSettings} from '../scripts/storage-fixture.mjs';
const aggregate=()=>({schemaVersion:1,revision:7,connections:{profiles:[{id:'stable-id'}],lastSelectedProfileId:'stable-id',history:{mapping:'C:/generated'},tree:{version:1,nodes:[]}},appearance:{theme:'dark'},explorer:{localBookmarks:[],remoteBookmarks:[],folderBookmarks:[{id:'pair-stable'}],folderPairHistory:[],paneColumns:{},bookmarkTree:{version:1,nodes:[]}},browse:{browseLocations:{key:{remote:'/generated'}},paneSorts:{}},sync:{exclusions:{},syncOptions:{},syncPresets:[{id:'preset-stable'}],retainedSyncs:[]},trust:{version:1,pins:{endpoint:'generated-pin'}}});
test('generated five-file fixtures retain exact aggregate identities and manifest bytes',()=>{
 const original=aggregate(),files=packSettings(original);assert.deepEqual(Object.keys(files).sort(),['bookmarks.json','connections.json','history.json','settings.json','sync-profiles.json']);
 assert.deepEqual(unpackSettings(files),original);assert.equal(JSON.parse(files['settings.json']).connections,undefined);assert.equal(JSON.parse(files['connections.json']).profiles[0].id,'stable-id');
 const changed={...files,'history.json':files['history.json']+'\n'};assert.throws(()=>unpackSettings(changed),/manifest/i);
});
