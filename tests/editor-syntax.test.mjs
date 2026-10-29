import test from 'node:test';import assert from 'node:assert/strict';
import {syntaxLanguage,highlightEligible,HIGHLIGHT_LIMIT,HIGHLIGHT_LINE_LIMIT} from '../.test-build/editor-syntax-language.js';
import {syntaxSegments} from '../.test-build/editor-syntax-tokens.js';
test('known extensions and config filenames are selected without content guessing',()=>{
 for(const [file,id] of [['C:\\samples\\CONFIG.JSON','json'],['/app/pack.mcmeta','json'],['/app/data.json5','json5'],['settings.yml','yaml'],['settings.toml','toml'],['server.properties','properties'],['.env.production','bash'],['.bashrc','bash'],['script.ts','typescript'],['style.css','css'],['page.xml','markup'],['query.sql','sql'],['notes.md','markdown'],['worker.py','python']])assert.equal(syntaxLanguage(file)?.id,id,file);
 for(const file of ['README','image.bin','config.json.bak','notes.txt','__proto__','file.__proto__'])assert.equal(syntaxLanguage(file),null,file);
});
test('large and pathological single lines use plain text without changing the document',()=>{
 assert.equal(highlightEligible('\n'.repeat(HIGHLIGHT_LIMIT)),true);
 assert.equal(highlightEligible('\n'.repeat(HIGHLIGHT_LIMIT+1)),false);
 assert.equal(highlightEligible('a'.repeat(HIGHLIGHT_LINE_LIMIT)),true);
 assert.equal(highlightEligible('a'.repeat(HIGHLIGHT_LINE_LIMIT+1)),false);
 assert.equal(highlightEligible('日本語\n😀\n'),true);
});
test('nested syntax tokens preserve exact Unicode and literal markup as bounded data',()=>{
 const source='<img onerror="alert(1)"> 日本語😀\n';
 const result=syntaxSegments([{type:'tag',content:['<img ',{type:'attr-name',content:'onerror'},'=',{type:'attr-value',content:'"alert(1)"'},'>']},' 日本語😀\n'],source);
 assert.equal(result.map(s=>s.text).join(''),source);assert.ok(result.some(s=>s.kind==='string'));
 assert.deepEqual(syntaxSegments([{type:'__proto__',content:'literal'}],'literal'),[{text:'literal',kind:''}]);
 assert.throws(()=>syntaxSegments(['changed'],'original'),/mismatch/);
 let nested='a';for(let i=0;i<40;i++)nested={type:'tag',content:nested};assert.throws(()=>syntaxSegments(nested,'a'),/budget/);
});
