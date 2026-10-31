// Existing local browser only. Does not modify icon-source.png, icon.ico, or installer icons.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {badgeStates,statusBadgeSvg,doneBadge14MarkSvg} from './status-badge-artwork.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function generateStatusBadges(output=path.join(root,'src-tauri/icons/badges')){
 const base='data:image/png;base64,'+(await fs.readFile(path.join(root,'src-tauri/icons/icon-source.png'))).toString('base64');
 const browser=await chromium.launch(process.env.NEARLY_ICON_BROWSER?{executablePath:process.env.NEARLY_ICON_BROWSER}:process.platform==='win32'?{channel:'msedge'}:{});
 try{
  const page=await browser.newPage({deviceScaleFactor:1});
  await fs.mkdir(output,{recursive:true});
  const result={};
  for(const state of badgeStates){
   const svg=statusBadgeSvg(state,base,32);
   const data=await page.evaluate(async svg=>{const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(svg);await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {png:canvas.toDataURL('image/png').split(',')[1],rgba:Array.from(ctx.getImageData(0,0,32,32).data)};},svg);
   await fs.writeFile(path.join(output,state+'.png'),Buffer.from(data.png,'base64'));
   result[state]={width:32,height:32,rgbaSha256:createHash('sha256').update(Buffer.from(data.rgba)).digest('hex')};
  }
  console.log(JSON.stringify(result,null,2));
  return result;
 }finally{await browser.close();}
}

// The approved preview's recipe: retain the existing16px background/corner,
// nearest-sample that background to14px, then paint the mark at native14px.
export async function generateDoneOverlay(output=path.join(root,'src-tauri/icons/badges/done-overlay.png')){
 const base='data:image/png;base64,'+(await fs.readFile(path.join(root,'src-tauri/icons/icon-source.png'))).toString('base64');
 const committed='data:image/png;base64,'+(await fs.readFile(path.join(root,'src-tauri/icons/badges/done.png'))).toString('base64');
 const marked=statusBadgeSvg('done',base,32),background=marked.replace(/<g fill="none" stroke="#17212B"[^>]*>.*?<\/g>/,'');
 const browser=await chromium.launch(process.env.NEARLY_ICON_BROWSER?{executablePath:process.env.NEARLY_ICON_BROWSER}:process.platform==='win32'?{channel:'msedge'}:{});
 try{const page=await browser.newPage({deviceScaleFactor:1});await page.route('**/*',r=>r.abort());const data=await page.evaluate(async({committed,marked,background,mark})=>{
  const image=async src=>{const i=new Image();i.src=src;await i.decode();return i;},svg=s=>'data:image/svg+xml;base64,'+btoa(s),canvas=n=>{const c=document.createElement('canvas');c.width=c.height=n;return c;},pixels=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data,crop=i=>{const c=canvas(16);c.getContext('2d').drawImage(i,16,0,16,16,0,0,16,16);return c;};
  const actual=pixels(crop(await image(committed))),expected=pixels(crop(await image(svg(marked))));if(actual.some((v,i)=>v!==expected[i]))throw Error('Committed badge differs from source renderer');
  const source=pixels(crop(await image(svg(background)))),glyph=canvas(14),g=glyph.getContext('2d'),sample=g.createImageData(14,14);
  for(let y=0;y<14;y++)for(let x=0;x<14;x++)for(let k=0;k<4;k++)sample.data[(y*14+x)*4+k]=source[(Math.floor((2*y+1)*16/28)*16+Math.floor((2*x+1)*16/28))*4+k];
  g.putImageData(sample,0,0);g.drawImage(await image(svg(mark)),0,0);const out=canvas(16);out.getContext('2d').drawImage(glyph,2,2);return{png:out.toDataURL('image/png').split(',')[1],rgba:Array.from(pixels(out))};
 },{committed,marked,background,mark:doneBadge14MarkSvg()});await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,Buffer.from(data.png,'base64'));return{output,width:16,height:16,artwork:{x:2,y:2,width:14,height:14},rgbaSha256:createHash('sha256').update(Buffer.from(data.rgba)).digest('hex')};
 }finally{await browser.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--done-overlay')console.log(JSON.stringify(await generateDoneOverlay(process.argv[3])));else await generateStatusBadges(process.argv[2]);
}
