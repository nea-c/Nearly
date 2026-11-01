import type {Locator,Page} from '@playwright/test';

// Generated-fixture diagnostics only. No tolerance, assertion, retry or product
// changes. Each temporary element/style is restored before the test continues.
const paintProperties=[
 'box-sizing','background-color','background-image','background-origin','background-clip',
 'border-top-width','border-right-width','border-bottom-width','border-left-width',
 'border-top-style','border-right-style','border-bottom-style','border-left-style',
 'border-top-color','border-right-color','border-bottom-color','border-left-color',
 'border-top-left-radius','border-top-right-radius','border-bottom-left-radius','border-bottom-right-radius',
 'padding-top','padding-right','padding-bottom','padding-left','box-shadow','opacity','filter',
 'outline-width','outline-style','outline-color','outline-offset','transform','clip-path','isolation',
];
async function configuration(target:Locator){
 return target.evaluate((el,properties)=>{
  const css=getComputedStyle(el),r=el.getBoundingClientRect();
  const ancestors=[];for(let p=el.parentElement;p&&ancestors.length<5;p=p.parentElement){
   const s=getComputedStyle(p),b=p.getBoundingClientRect();
   ancestors.push({tag:p.tagName,rect:{x:b.x,y:b.y,width:b.width,height:b.height},paint:Object.fromEntries(['background-color','background-image','opacity','overflow-x','overflow-y','clip-path','transform','filter','isolation','contain','box-shadow','position','z-index'].map(k=>[k,s.getPropertyValue(k)]))});
  }
  return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},paint:Object.fromEntries(properties.map(k=>[k,css.getPropertyValue(k)])),ancestors,dpr:devicePixelRatio,userAgent:navigator.userAgent};
 },paintProperties);
}
async function sample(page:Page,rect:{x:number;y:number;width:number;height:number}){
 const png=await page.screenshot({scale:'css',timeout:5000});
 return page.evaluate(async({png,r})=>{
  const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const c=canvas.getContext('2d')!;c.drawImage(image,0,0);
  const pixels=c.getImageData(r.x+r.width-12,r.y,12,12);
  const corner=document.createElement('canvas');corner.width=12;corner.height=12;corner.getContext('2d')!.putImageData(pixels,0,0);
  return {rgba:Array.from(pixels.data),point:Array.from(pixels.data.slice((5*12+11)*4,(5*12+12)*4)),png:corner.toDataURL('image/png').split(',')[1]};
 },{png:png.toString('base64'),r:rect});
}
function delta(a:{rgba:number[]},b:{rgba:number[]}){
 let count=0,max=0;const examples=[];
 for(let i=0;i<a.rgba.length;i+=4){const d=Math.max(...[0,1,2,3].map(k=>Math.abs(a.rgba[i+k]-b.rgba[i+k])));max=Math.max(max,d);if(d){count++;if(examples.length<6)examples.push({x:168+i/4%12,y:Math.floor(i/4/12),a:a.rgba.slice(i,i+4),b:b.rgba.slice(i,i+4)});}}
 return {count,max,examples};
}
async function borderNine(page:Page,rect:{x:number;y:number;width:number;height:number}){
 const raw=await sample(page,rect),rgba:number[]=[];
 for(let y=0;y<9;y++)rgba.push(...raw.rgba.slice((y*12+3)*4,(y*12+12)*4));
 const png=await page.evaluate(data=>{const c=document.createElement('canvas');c.width=9;c.height=9;c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data),9,9),0,0);return c.toDataURL('image/png').split(',')[1];},rgba);
 return {rgba,point:rgba.slice((5*9+8)*4,(5*9+9)*4),png};
}
function nineDelta(a:{rgba:number[]},b:{rgba:number[]}){
 let count=0,max=0;const examples=[];
 for(let i=0;i<a.rgba.length;i+=4){const d=Math.max(...[0,1,2,3].map(k=>Math.abs(a.rgba[i+k]-b.rgba[i+k])));max=Math.max(max,d);if(d){count++;if(examples.length<6)examples.push({x:171+i/4%9,y:Math.floor(i/4/9),a:a.rgba.slice(i,i+4),b:b.rgba.slice(i,i+4)});}}
 return {count,max,examples};
}
export async function observeUnmaskedBorder(mainPage:Page,editorPage:Page,main:Locator,editor:Locator){
 const configs=await Promise.all([main,editor].map(configuration));
 for(const target of [main,editor])if(!await target.evaluate(el=>Array.from(el.querySelectorAll('button > span')).every(span=>getComputedStyle(span).visibility==='visible')))throw Error('Unmasked history contains a visibility mask');
 const a=await borderNine(mainPage,configs[0].rect),b=await borderNine(editorPage,configs[1].rect);
 return {configs,main:{point:a.point,png:a.png},editor:{point:b.point,png:b.png},comparison:nineDelta(a,b)};
}
export async function visibilityMaskPaintDiagnostic(mainPage:Page,editorPage:Page,main:Locator,editor:Locator){
 const targets=[main,editor],pages=[mainPage,editorPage],configs=await Promise.all(targets.map(configuration));
 const saved=await Promise.all(targets.map(t=>t.evaluate(el=>Array.from(el.querySelectorAll<HTMLElement>('button > span'),span=>({style:span.getAttribute('style'),qa:span.getAttribute('data-qa-visibility')})))));
 const captures:{label:string;point:number[];png:string}[]=[],raw=new Map<string,Awaited<ReturnType<typeof borderNine>>>();
 async function capture(label:string,index:number){const value=await borderNine(pages[index],configs[index].rect);raw.set(label,value);captures.push({label,point:value.point,png:value.png});}
 async function visibility(masked:boolean){
  for(let i=0;i<targets.length;i++)await targets[i].evaluate((el,{masked,saved})=>{
   Array.from(el.querySelectorAll<HTMLElement>('button > span')).forEach((span,n)=>{
    if(masked){span.dataset.qaVisibility=span.style.visibility;span.style.visibility='hidden';}
    else{
     // Flush pending CSSOM attribute serialization before removing it. Edge's
     // lazy style serialization otherwise recreates style="" after removal
     // (reproduced in an app-free span fixture). Preserve absence as absence.
     span.getAttribute('style');
     if(saved[n].style===null)span.removeAttribute('style');else span.setAttribute('style',saved[n].style!);
     if(saved[n].qa===null)span.removeAttribute('data-qa-visibility');else span.setAttribute('data-qa-visibility',saved[n].qa!);
     if(span.getAttribute('style')!==saved[n].style||span.getAttribute('data-qa-visibility')!==saved[n].qa)throw Error('Visibility attributes differ at restore boundary');
    }
   });
  },{masked,saved:saved[i]});
 }
 try{
  // These five stages precede ANY node replacement or other style control.
  for(const stage of ['unmasked0','masked0','unmasked1','masked1','unmasked2']){await visibility(stage.startsWith('masked'));await capture(stage+'-main',0);await capture(stage+'-editor',1);}
  await capture('outer-before',1);
  // Independent outer-host-only control: reuse ALL original child nodes and
  // handlers, restore the original host before any further application action.
  await editor.evaluate(el=>{const host=el.cloneNode(false) as HTMLElement;(host as any).__maskOriginalHost=el;host.dataset.maskPaintHost='';while(el.firstChild)host.append(el.firstChild);el.replaceWith(host);});
  try{await capture('outer-fresh-same-children',1);}
  finally{await editorPage.evaluate(()=>{const host=document.querySelector<HTMLElement>('[data-mask-paint-host]');if(host){const original=(host as any).__maskOriginalHost;while(host.firstChild)original.append(host.firstChild);host.replaceWith(original);}});}
  await capture('outer-restored',1);
  const pair=(a:string,b:string)=>({a,b,...nineDelta(raw.get(a)!,raw.get(b)!)});
  const stages=['unmasked0','masked0','unmasked1','masked1','unmasked2'];
  const comparisons=[...stages.map(s=>pair(s+'-main',s+'-editor')),...['main','editor'].flatMap(side=>[pair('unmasked0-'+side,'masked0-'+side),pair('unmasked0-'+side,'unmasked1-'+side),pair('masked0-'+side,'masked1-'+side),pair('unmasked1-'+side,'unmasked2-'+side)]),pair('outer-before','outer-fresh-same-children'),pair('outer-before','outer-restored')];
  return {version:1,region:'Unmodified upper-right 9x9, x171..179/y0..8; includes x179,y5 and no label/glyph pixels',configs,captures,comparisons};
 }finally{
  await editorPage.evaluate(()=>{const host=document.querySelector<HTMLElement>('[data-mask-paint-host]');if(host){const original=(host as any).__maskOriginalHost;while(host.firstChild)original.append(host.firstChild);host.replaceWith(original);}});
  await visibility(false);
  for(let i=0;i<targets.length;i++){const restored=await targets[i].evaluate(el=>Array.from(el.querySelectorAll<HTMLElement>('button > span'),span=>({style:span.getAttribute('style'),qa:span.getAttribute('data-qa-visibility')})));if(JSON.stringify(restored)!==JSON.stringify(saved[i]))throw Error('Visibility diagnostic did not restore exact original attributes '+JSON.stringify({target:i,expected:saved[i],actual:restored}));}
 }
}
export async function controlledPaintDiagnostic(mainPage:Page,editorPage:Page,main:Locator,editor:Locator){
 const targets=[main,editor],pages=[mainPage,editorPage];
 const configs=await Promise.all(targets.map(configuration));
 const saved=await Promise.all(targets.map(t=>t.evaluate(el=>({style:el.getAttribute('style'),spans:Array.from(el.querySelectorAll<HTMLElement>('button > span'),s=>s.style.visibility)}))));
 const captures:{label:string;point:number[];png:string}[]=[];
 const raw=new Map<string,Awaited<ReturnType<typeof sample>>>();
 async function capture(label:string,index:number){const result=await sample(pages[index],configs[index].rect);raw.set(label,result);captures.push({label,point:result.point,png:result.png});}
 try{
  for(const target of targets)await target.evaluate(el=>{for(const s of el.querySelectorAll<HTMLElement>('button > span'))s.style.visibility='hidden';});
  // Same component, CSS, position and context: measure repeated paint first.
  await capture('main-repeat0',0);await capture('editor-repeat0',1);
  await capture('main-repeat1',0);await capture('editor-repeat1',1);
  await capture('main-repeat2',0);await capture('editor-repeat2',1);
  // Fresh node, identical component markup/CSS and original parent/position.
  // Keep the original node (including handlers) and restore it, never clone it
  // back. This distinguishes retained-node/display-list state from its CSS.
  for(const i of [0,1]){
   await targets[i].evaluate(el=>{const clone=el.cloneNode(true) as HTMLElement;(clone as any).__paintOriginalNode=el;clone.dataset.controlledPaintClone='';el.replaceWith(clone);});
   try{await capture(i?'editor-fresh-component':'main-fresh-component',i);}
   finally{await pages[i].evaluate(()=>{const clone=document.querySelector<HTMLElement>('[data-controlled-paint-clone]');if(clone){const original=(clone as any).__paintOriginalNode;clone.replaceWith(original);}});}
  }
  // Empty rounded border with identical explicit paint properties, at the SAME
  // pixel location. 2x2 controls separate CSS from page/ancestor/children effects.
  const strip=await mainPage.locator('.titlebar').evaluate(el=>getComputedStyle(el).backgroundColor);
  for(const pageIndex of [0,1])for(const styleIndex of [0,1]){
   await pages[pageIndex].evaluate(({config,strip})=>{
    const root=document.createElement('div');root.dataset.controlledPaintRoot='';const r=config.rect;
    root.style.cssText=`all:initial;display:block;position:fixed;left:${r.x-2}px;top:${r.y-2}px;width:${r.width+4}px;height:${r.height+4}px;background:${strip};z-index:2147483647;pointer-events:none`;
    const leaf=document.createElement('div');leaf.style.cssText=`all:initial;display:block;position:absolute;left:2px;top:2px;width:${r.width}px;height:${r.height}px`;
    for(const [key,value]of Object.entries(config.paint))leaf.style.setProperty(key,value);
    root.append(leaf);document.body.append(root);
   },{config:configs[styleIndex],strip});
   try{await capture(`leaf-page${pageIndex}-css${styleIndex}`,pageIndex);}
   finally{await pages[pageIndex].evaluate(()=>document.querySelector('[data-controlled-paint-root]')?.remove());}
  }
  // Reapply the SAME computed CSS to the actual editor component, then test one
  // declared paint factor at a time. These are controls, never proposed fixes.
  const controls:[string,Record<string,string>][]=[
   ['same-computed-css',configs[1].paint],
   ['clip-border-box',{'background-clip':'border-box'}],
   ['clip-padding-box',{'background-clip':'padding-box'}],
   ['square-corner',{'border-top-left-radius':'0px','border-top-right-radius':'0px'}],
   ['uniform-bottom-border',{'border-bottom-width':'1px','border-bottom-style':'solid','border-bottom-color':configs[1].paint['background-color'],'padding-bottom':'1px'}],
   ['compositor-layer',{'transform':'translateZ(0)'}],
  ];
  for(const [label,properties]of controls){
   try{
    await editor.evaluate((el,p)=>{for(const [key,value]of Object.entries(p))(el as HTMLElement).style.setProperty(key,value,'important');},properties);
    await capture(label,1);
   }finally{await editor.evaluate((el,style)=>{if(style===null)el.removeAttribute('style');else el.setAttribute('style',style);},saved[1].style);}
  }
  await capture('editor-restored',1);
  const pair=(a:string,b:string)=>({a,b,...delta(raw.get(a)!,raw.get(b)!)});
  const comparisons=[pair('main-repeat0','main-repeat1'),pair('main-repeat0','main-repeat2'),pair('editor-repeat0','editor-repeat1'),pair('editor-repeat0','editor-repeat2'),pair('main-repeat0','editor-repeat0'),pair('main-repeat0','main-fresh-component'),pair('editor-repeat0','editor-fresh-component'),pair('main-repeat0','editor-fresh-component'),pair('main-repeat0','leaf-page0-css0'),pair('editor-repeat0','leaf-page1-css1'),pair('leaf-page0-css0','leaf-page0-css1'),pair('leaf-page0-css0','leaf-page1-css0'),pair('leaf-page1-css0','leaf-page1-css1'),...controls.flatMap(([label])=>[pair('editor-repeat0',label),pair('main-repeat0',label)]),pair('editor-repeat0','editor-restored')];
  return {version:1,region:'12x12 upper-right; point is tab-relative x179,y5',configs,captures,comparisons};
 }finally{
  for(const page of pages)await page.evaluate(()=>{const clone=document.querySelector<HTMLElement>('[data-controlled-paint-clone]');if(clone)clone.replaceWith((clone as any).__paintOriginalNode);});
  for(let i=0;i<targets.length;i++){
   await targets[i].evaluate((el,saved)=>{if(saved.style===null)el.removeAttribute('style');else el.setAttribute('style',saved.style);Array.from(el.querySelectorAll<HTMLElement>('button > span')).forEach((span,n)=>span.style.visibility=saved.spans[n]??'');},saved[i]);
   const restored=await targets[i].evaluate(el=>({style:el.getAttribute('style'),spans:Array.from(el.querySelectorAll<HTMLElement>('button > span'),s=>s.style.visibility)}));
   if(JSON.stringify(restored)!==JSON.stringify(saved[i]))throw Error('Paint diagnostic did not restore component styles');
  }
  for(const page of pages){await page.evaluate(()=>document.querySelector('[data-controlled-paint-root]')?.remove());if(await page.locator('[data-controlled-paint-root]').count())throw Error('Paint diagnostic left an overlay behind');}
 }
}
