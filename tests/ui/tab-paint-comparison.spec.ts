import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {compareTabPaint} from './tab-paint-comparison.js';

test('tab comparison never mutates live tab nodes or attributes',async({page,context})=>{
 const markup=(name:string)=>`<style>body{margin:0;font:13px/15px 'Segoe UI'}#target{margin:5px 0 0 3px;width:180px;height:37px;box-sizing:border-box;border:1px solid #789;border-bottom:0;border-radius:8px 8px 0 0;background:#eee;display:flex;align-items:center}button{border:0;background:transparent;color:#234;font:inherit;padding:7px;text-align:left}button[role=tab]{flex:1;min-width:0}button:last-child{width:28px;padding:0}span{display:inline-block}</style><div id="target"><button role="tab"><span>${name}</span></button><button><span>×</span></button></div>`;
 await page.setContent(markup('New tab'));const editor=await context.newPage();await editor.setContent(markup('first.js'));
 for(const owner of [page,editor])await owner.locator('#target').evaluate(root=>{(window as any).__comparisonMutations=[];(window as any).__comparisonObserver=new MutationObserver(records=>(window as any).__comparisonMutations.push(...records.map(r=>r.type+':'+r.attributeName)));(window as any).__comparisonObserver.observe(root,{subtree:true,attributes:true,childList:true,characterData:true});});
 const result=await compareTabPaint(page,editor,page.locator('#target'),editor.locator('#target'));
 for(const owner of [page,editor])expect(await owner.evaluate(()=>{(window as any).__comparisonObserver.disconnect();return (window as any).__comparisonMutations;})).toEqual([]);
 expect(result.different,JSON.stringify(result)).toBe(0);await editor.close();
});

test('semantic normalization cannot reach the failed border pixel',async({page,context})=>{
 const markup='<style>body{margin:0;font:13px/19.5px "Segoe UI"}#target{position:relative;margin:5px 0 0 3px;width:180px;height:37px;box-sizing:border-box;display:flex;align-items:center;border:1px solid #789;border-radius:8px 8px 0 0;background:#eee}button{border:0;background:transparent;color:#234;font:inherit;padding:7px}button[role=tab]{flex:1}button:last-child{width:28px;padding:0}</style><div id="target"><button role="tab"><span>label</span></button><button><span>×</span></button></div>';
 await page.setContent(markup);const editor=await context.newPage();await editor.setContent(markup);
 expect((await compareTabPaint(page,editor,page.locator('#target'),editor.locator('#target'))).different).toBe(0);
 await editor.locator('#target').evaluate(el=>{const r=el.getBoundingClientRect(),spot=document.createElement('div');Object.assign(spot.style,{position:'fixed',left:r.x+r.width-1+'px',top:r.y+5+'px',width:'1px',height:'1px',background:'#f0f',zIndex:'9999'});document.body.append(spot);});
 const result=await compareTabPaint(page,editor,page.locator('#target'),editor.locator('#target'));
 expect(result.different).toBe(1);expect(result.cornerDifferent).toBe(1);expect(result.examples[0]).toMatchObject({x:179,y:5});
 await editor.locator('button[role=tab] span').evaluate(el=>Object.assign((el as HTMLElement).style,{position:'absolute',left:'0px',top:'0px'}));
 await expect(compareTabPaint(page,editor,page.locator('#target'),editor.locator('#target'))).rejects.toThrow('Semantic label bounds overlap protected tab chrome');await editor.close();
});

async function fixture(page:Page,context:BrowserContext,theme:string){
 await page.addInitScript(theme=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme,language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};},theme);
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();for(let i=0;i<4;i++)await page.locator('#add-tab').click();
 const editor=await context.newPage();await editor.addInitScript(theme=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};if(cmd==='load_settings')return {theme,language:'en'};if(cmd==='list_text_documents')return ['first','second','middle','fourth','last'].map(token=>({token,path:'/generated/'+token+'.js',side:'remote',connectionLabel:'Generated server',text:'// generated fixture',encoding:'UTF-8',newline:'LF'}));}},event:{listen:async()=>()=>{}}};},theme);
 await editor.goto('/editor.html');await expect(editor.locator('.editor-tab')).toHaveCount(5);await page.locator('.tab [role=tab]').first().click();await editor.locator('.editor-tab [role=tab]').first().click();
 for(const owner of [page,editor]){await owner.evaluate(()=>(document.activeElement as HTMLElement)?.blur());await owner.mouse.move(1100,800);}
 return editor;
}

for(const theme of ['dark','midnight','forest','mint'])test('actual opaque child-background regression remains visible: '+theme,async({page,context})=>{
 const editor=await fixture(page,context,theme),main=page.locator('.titlebar .tab').nth(1),tab=editor.locator('.editor-tab').nth(1);
 const before=await compareTabPaint(page,editor,main,tab);expect(before.different,JSON.stringify(before)).toBe(0);expect(before.labelPaints[1]).toEqual(before.labelPaints[0]);
 // Remove ONLY the original transparent-child fix. Generic themed button CSS
 // now wins exactly as in the old bug; no artificial corner/colour is painted.
 const removed=await editor.evaluate(()=>{let count=0;for(const sheet of Array.from(document.styleSheets))for(let i=sheet.cssRules.length-1;i>=0;i--){const rule=sheet.cssRules[i] as CSSStyleRule;if(rule.selectorText==='.editor-window .editor-tab :is(.editor-tab-label, .editor-tab-close)'){sheet.deleteRule(i);count++;}}return count;});
 expect(removed).toBe(1);expect(await tab.evaluate(el=>getComputedStyle(el).borderTopLeftRadius)).toBe('8px');
 const bad=await compareTabPaint(page,editor,main,tab);console.log('TAB_PAINT_OLD_BUG '+JSON.stringify({theme,different:bad.different,cornerDifferent:bad.cornerDifferent,examples:bad.examples,labelPaints:bad.labelPaints}));
 expect(bad.labelPaints[1]['background-color']).not.toBe('rgba(0, 0, 0, 0)');expect(bad.different).toBeGreaterThan(0);expect(bad.cornerDifferent).toBeGreaterThan(0);await editor.close();
});

test('image normalization retains real tab-fill and close-disc differences',async({page,context})=>{
 const editor=await fixture(page,context,'forest'),main=page.locator('.titlebar .tab').nth(1),tab=editor.locator('.editor-tab').nth(1);
 expect((await compareTabPaint(page,editor,main,tab)).different).toBe(0);
 await tab.evaluate(el=>(el as HTMLElement).style.backgroundColor='#f0f');const fill=await compareTabPaint(page,editor,main,tab);expect(fill.different).toBeGreaterThan(0);
 await tab.evaluate(el=>(el as HTMLElement).style.removeProperty('background-color'));
 await main.locator('[data-close]').hover();await tab.locator('[data-editor-tab-close]').hover();expect((await compareTabPaint(page,editor,main,tab)).different).toBe(0);
 await tab.evaluate(el=>(el as HTMLElement).style.setProperty('--tab-close-hover-color','#f0f'));const disc=await compareTabPaint(page,editor,main,tab);expect(disc.different).toBeGreaterThan(0);expect(disc.cornerDifferent).toBe(0);await editor.close();
});
