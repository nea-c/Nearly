import {test,expect} from '@playwright/test';
async function open(page,path='/samples/config.json',text='{\n  "name": "Nearly",\n  "enabled": true\n}\n'){
 await page.addInitScript(({path,text})=>{
  const w=window as any;w.handlers={};w.calls=[];w.saved=text;
  w.syntaxEvents=[];const OriginalWorker=Worker;
  w.Worker=class extends OriginalWorker {constructor(url,options){const started=performance.now();w.syntaxEvents.push({created:String(url)});super(url,options);this.addEventListener('message',event=>w.syntaxEvents.push({elapsed:performance.now()-started,ready:event.data.ready,id:event.data.id,reason:event.data.reason,count:event.data.segments?.length}));this.addEventListener('error',event=>w.syntaxEvents.push({elapsed:performance.now()-started,error:event.message}));}};
  w.__TAURI__={core:{invoke:async(cmd,args)=>{
   w.calls.push({cmd,args});
   if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};
   if(cmd==='load_settings')return {theme:'light',language:'en'};
   if(cmd==='list_text_documents')return [{token:'syntax-fixture',path,text,encoding:'UTF-8 BOM',newline:'CRLF',side:'remote',connectionLabel:'fixture@localhost:22'}];
   if(cmd==='save_text_document'){if(w.failSave)throw 'External change fixture';w.saved=args.text;return {text:args.text};}
  }},event:{listen:async(name,handler)=>{w.handlers[name]=handler;return()=>{};}}};
 },{path,text});
 await page.goto('/editor.html');await expect(page.locator('textarea')).toHaveValue(text);return page.locator('textarea');
}
test('filename syntax colors are safe, theme-aware, and keep original textarea save semantics',async({page})=>{
 const text='{\n "name": "<img src=x onerror=alert(1)>",\n "enabled": true, "count": 42\n}\n';
 const input=await open(page,'/samples/config.json',text);
 await expect(page.locator('.syntax-layer .syntax-property').first()).toBeVisible({timeout:15000}).catch(async error=>{console.log('SYNTAX_EVENTS',await page.evaluate(()=>(window as any).syntaxEvents));throw error;});
 await expect(page.locator('.syntax-layer img,.syntax-layer script')).toHaveCount(0);
 expect(await page.locator('.syntax-code').textContent()).toBe(text);
 for(const theme of ['light','dark','midnight','forest','mint']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const colors=await page.locator('.syntax-property').first().evaluate(el=>({foreground:getComputedStyle(el).color,base:getComputedStyle(document.querySelector('.syntax-code')!).color}));
  expect(colors.foreground).not.toBe(colors.base);
  await expect(page.locator('.editor-active-path')).toHaveAttribute('title',/\/samples\/config\.json/);
 }
 await input.fill(text+'// local edit\n');await page.keyboard.press('Control+s');
 expect(await page.evaluate(()=>(window as any).saved)).toBe(text+'// local edit\n');
 await input.fill('changed after save');await page.evaluate(()=>(window as any).failSave=true);await page.keyboard.press('Control+s');
 await expect(input).toHaveValue('changed after save');await expect(page.locator('.editor-tab-dirty')).toBeVisible();
 await expect(page.locator('.text-editor-status')).toContainText('External change fixture');
});
test('selection, scrolling, undo and IME composition stay owned by the textarea',async({page})=>{
 const text=Array.from({length:120},(_,i)=>'const value'+i+' = "日本語 '+i+(i===0?'x'.repeat(300):'')+'";').join('\n')+'\n';
 const input=await open(page,'/samples/code.js',text);
 await expect(page.locator('.syntax-keyword').first()).toBeVisible();
 await input.evaluate((el:HTMLTextAreaElement)=>{el.setSelectionRange(6,12);el.scrollTop=600;el.scrollLeft=120;el.dispatchEvent(new Event('scroll'));});
 expect(await input.evaluate((el:HTMLTextAreaElement)=>el.value.slice(el.selectionStart,el.selectionEnd))).toBe('value0');
 expect(await page.locator('.syntax-layer').evaluate(el=>el.scrollTop)).toBe(await input.evaluate(el=>el.scrollTop));
 expect(await page.locator('.syntax-layer').evaluate(el=>el.scrollLeft)).toBe(await input.evaluate(el=>el.scrollLeft));
 expect(await input.evaluate(el=>getComputedStyle(el,'::selection').color)).not.toBe('rgba(0, 0, 0, 0)');
 await input.evaluate((el:HTMLTextAreaElement)=>el.dispatchEvent(new CompositionEvent('compositionstart',{data:'に'})));
 await expect(page.locator('.editor-input')).toHaveAttribute('data-composing','true');
 await input.fill('const 日本語 = "入力中";\n');
 await input.evaluate((el:HTMLTextAreaElement)=>el.dispatchEvent(new CompositionEvent('compositionend',{data:'日本語'})));
 await expect(page.locator('.syntax-code')).toHaveText('const 日本語 = "入力中";\n');
 await expect(input).toHaveValue('const 日本語 = "入力中";\n');
 await input.click();await page.keyboard.press('End');await page.keyboard.type('x');await page.keyboard.press('Control+z');
 await expect(input).toHaveValue('const 日本語 = "入力中";\n');
});
test('unknown text files remain editable plain text',async({page})=>{
 const input=await open(page,'/samples/notes.unknown','ordinary text\n');
 await expect(page.locator('.editor-input')).toHaveAttribute('data-highlight','false');
 await input.fill('still editable');await expect(input).toHaveValue('still editable');
});
test('large code files stay plain text and a blocked tokenizer never blocks editing',async({page})=>{
 const text=('const value = 1;\n').repeat(7000);
 const input=await open(page,'/samples/large.js',text);
 await expect(page.locator('.editor-input')).toHaveAttribute('data-highlight','false');
 await input.fill('const nowSmall = true;');await expect(page.locator('.syntax-keyword').first()).toBeVisible({timeout:15000});
});
async function fakeTokenizer(page,mode:string){
 await page.clock.install();
 await page.addInitScript(mode=>{
  const w=window as any;w.fakeWorkers=[];w.fakeJobs=[];w.terminated=0;w.prevented=0;
  w.Worker=class {
   onmessage:any;onerror:any;
   constructor(){if(mode==='constructor')throw Error('Generated worker construction failure');w.fakeWorkers.push(this);queueMicrotask(()=>this.onmessage?.({data:{ready:true}}));}
   addEventListener(){}
   postMessage(data){if(mode==='post')throw Error('Generated worker message failure');w.fakeJobs.push({worker:this,data});if(mode==='error')queueMicrotask(()=>this.onerror?.({preventDefault(){w.prevented++;}}));}
   terminate(){w.terminated++;}
  };
 },mode);
}
for(const mode of ['constructor','post','timeout','error'])test('worker '+mode+' failure falls back without losing edits or uncaught errors',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await fakeTokenizer(page,mode);
 const input=await open(page,'/samples/file.js','const original = 1;\n');
 await input.fill('const latest = "日本語";\n');await page.clock.fastForward(90);
 for(let i=0;i<3;i++){await page.clock.fastForward(300);if(await page.locator('.editor-input').getAttribute('data-highlight')==='false')break;}
 await expect(page.locator('.editor-input')).toHaveAttribute('data-highlight','false');
 await expect(input).toHaveValue('const latest = "日本語";\n');
 expect(errors).toEqual([]);
 if(mode==='error')expect(await page.evaluate(()=>(window as any).prevented)).toBeGreaterThanOrEqual(1);
 if(mode!=='constructor'){
  const count=await page.evaluate(()=>(window as any).terminated);expect(count).toBeGreaterThanOrEqual(1);expect(count).toBeLessThanOrEqual(2);
 }
});
test('old worker replies cannot replace newer text or resurrect a closed document',async({page})=>{
 await fakeTokenizer(page,'held');const input=await open(page,'/samples/stale.js','const original = 1;\n');
 await page.clock.fastForward(90);await expect.poll(()=>page.evaluate(()=>(window as any).fakeJobs.length)).toBe(1);
 await input.fill('const latest = 2;\n');await page.clock.fastForward(90);
 await page.evaluate(()=>{const j=(window as any).fakeJobs[0];j.worker.onmessage({data:{id:j.data.id,segments:[{text:j.data.text,kind:'keyword'}]}});});
 await expect(page.locator('.syntax-code')).toHaveText('const latest = 2;\n');
 await expect.poll(()=>page.evaluate(()=>(window as any).fakeJobs.length)).toBe(2);
 await page.evaluate(()=>{const j=(window as any).fakeJobs[1];j.worker.onmessage({data:{id:j.data.id,segments:[{text:j.data.text,kind:'keyword'}]}});});
 await expect(page.locator('.syntax-keyword')).toHaveText('const latest = 2;\n');
 await page.locator('[data-editor-tab-close]').click();await page.locator('[data-editor-discard]').click();
 expect(await page.evaluate(()=>(window as any).terminated)).toBe(1);
 await page.evaluate(()=>{const j=(window as any).fakeJobs[0];j.worker.onmessage({data:{id:j.data.id,segments:[{text:'stale',kind:'keyword'}]}});});
 await expect(page.locator('.editor-tab,.syntax-layer')).toHaveCount(0);
});
test('forced colors preserves native foreground and selection',async({page})=>{
 const input=await open(page);await page.emulateMedia({forcedColors:'active'});
 await expect(page.locator('.syntax-layer')).toBeHidden();
 expect(await input.evaluate(el=>getComputedStyle(el).color)).not.toBe('rgba(0, 0, 0, 0)');
 await input.fill('selected');await input.selectText();await expect(input).toHaveValue('selected');
});
for(const [name,source] of [['settings.yaml','enabled: true\nport: 22\n'],['settings.toml','[server]\nport = 22\n'],['server.properties','name=Nearly\n'],['index.html','<div class="sample">Nearly</div>\n'],['style.css','.sample { color: red; }\n'],['script.py','def hello():\n    return "Nearly"\n']]){
 test('common format colors '+name,async({page})=>{
  await open(page,'/samples/'+name,source);
  await expect(page.locator('.syntax-code > span').first()).toBeVisible({timeout:15000});
  expect(await page.locator('.syntax-code').textContent()).toBe(source);
 });
}
