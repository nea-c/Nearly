import test from 'node:test';import assert from 'node:assert/strict';
import {textFileName} from '../.test-build/text-file-name.js';
test('double-click recognizes text filenames without guessing content or executable targets',()=>{
 for(const name of ['notes.TXT','config.json','server.yml','script.ts','code.rs','page.html','data.csv','build.ps1','.env.production','.gitignore','README','Dockerfile','Makefile'])assert.equal(textFileName(name),true,name);
 for(const name of ['photo.png','archive.zip','run.exe','folder.lnk','remote.LNK','unknown.custom','json','a.txt.exe','../note.txt','C:\\note.txt','note.txt:stream','__proto__'])assert.equal(textFileName(name),false,name);
});
