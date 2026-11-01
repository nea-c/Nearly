import type {Locator,Page} from '@playwright/test';

export async function compareTabPaint(mainPage:Page,editorPage:Page,main:Locator,editor:Locator){
 const elements=[main,editor],owners=[mainPage,editorPage];
 const metadata=await Promise.all(elements.map(el=>el.evaluate(node=>{
  const r=node.getBoundingClientRect(),label=node.querySelector<HTMLElement>('button[role=tab]');if(!label)throw Error('Tab label button required');
  const css=getComputedStyle(label),rects=Array.from(label.children).filter(el=>el.tagName==='SPAN').map(span=>{const s=span.getBoundingClientRect();return {left:Math.floor(s.left-r.left),top:Math.floor(s.top-r.top),right:Math.ceil(s.right-r.left),bottom:Math.ceil(s.bottom-r.top)};}).filter(s=>s.right>s.left&&s.bottom>s.top);
  const close=node.querySelector<HTMLElement>('button:not([role=tab])');if(!close)throw Error('Tab close target required');
  return {box:{x:r.x,y:r.y,width:r.width,height:r.height},rects,closeLeft:close.getBoundingClientRect().left-r.left,labelPaint:Object.fromEntries(['background-color','background-image','opacity','filter','box-shadow'].map(k=>[k,css.getPropertyValue(k)]))};
 })));
 const boxes=metadata.map(m=>m.box);if(boxes.some(b=>!b.width||!b.height)||boxes[0].width!==boxes[1].width||boxes[0].height!==boxes[1].height)throw Error('Equal visible tab bounds required');
 // Only different label/status content is normalized in IMAGE SPACE. Keep all
 // tab contour/corners, straight borders, close ink/disc, and focus pixels live.
 // Label padding remains compared; label background paint is also asserted by
 // the caller. Negative controls cover opaque child fill and chrome regressions.
 const closeLeft=Math.min(...metadata.map(m=>m.closeLeft)),rawRegions=metadata.flatMap(m=>m.rects);
 if(rawRegions.some(r=>r.left<2||r.top<8||r.right>closeLeft||r.bottom>boxes[0].height-8))throw Error('Semantic label bounds overlap protected tab chrome');
 // Raster ink can overhang a line box by one pixel (e.g. Segoe UI's j
 // descender). Bound that fringe strictly away from chrome and the close hitbox.
 const regions=rawRegions.map(r=>({left:Math.max(2,r.left-1),top:Math.max(8,r.top-1),right:Math.min(closeLeft,r.right+1),bottom:Math.min(boxes[0].height-8,r.bottom+1)}));
 const pngs=await Promise.all(owners.map(owner=>owner.screenshot({scale:'css'})));
 return editorPage.evaluate(async({pngs,boxes,regions,labelPaints})=>{
  const samples=await Promise.all(pngs.map(async(png:string,i:number)=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);const r=boxes[i]!;return c.getImageData(r.x,r.y,r.width,r.height+1).data;}));
  const normalized=new Set<number>();for(const r of regions)for(let y=r.top;y<r.bottom;y++)for(let x=r.left;x<r.right;x++){const i=y*boxes[0].width+x;normalized.add(i);for(const sample of samples)sample.fill(0,i*4,i*4+4);}
  let different=0,max=0,cornerDifferent=0;const examples=[];for(let i=0;i<samples[0].length;i+=4){const x=i/4%boxes[0]!.width,y=Math.floor(i/4/boxes[0]!.width),d=Math.max(...[0,1,2,3].map(k=>Math.abs(samples[0][i+k]-samples[1][i+k])));max=Math.max(max,d);const corner=y<8&&(x<8||x>=boxes[0]!.width-8);if(d>(corner?8:2)){different++;if(corner)cornerDifferent++;if(examples.length<6)examples.push({x,y,main:[...samples[0].slice(i,i+4)],editor:[...samples[1].slice(i,i+4)]});}}
  return {different,max,cornerDifferent,examples,mainBox:boxes[0],editorBox:boxes[1],labelPaints,normalizedRegions:regions,semanticPixels:normalized.size,comparedPixels:samples[0].length/4-normalized.size,devicePixelRatio:devicePixelRatio,userAgent:navigator.userAgent};
 },{pngs:pngs.map((png:{toString(encoding:string):string})=>png.toString('base64')),boxes,regions,labelPaints:metadata.map(m=>m.labelPaint)});
}
