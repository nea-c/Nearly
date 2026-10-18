import assert from 'node:assert/strict';import {test} from 'node:test';import fs from 'node:fs';
const template=fs.readFileSync(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
test('five storage primaries and per-file backups are outside installer payload/deletion targets',()=>{
 const storage=['settings','history','bookmarks','sync-profiles','connections'].flatMap(name=>[name+'.json',name+'.backup.json']);
 const mutations=template.split(/\r?\n/).map(line=>line.trim()).filter(line=>/^(?:Delete|RMDir|File)\s/i.test(line));
 for(const name of storage)for(const line of mutations)assert.equal(line.toLowerCase().includes(name.toLowerCase()),false,'Installer must preserve '+name+': '+line);
 assert.ok(mutations.length>0,'Actual installer mutation instructions were checked');
 assert.ok(!mutations.some(line=>/RMDir\s+\/r|Delete\s+.*\*/i.test(line)),'Wildcard removal could include storage');
});
