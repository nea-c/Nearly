// Existing local browser only. Does not modify icon-source.png, icon.ico, or installer icons.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {badgeStates,statusBadgeSvg} from './status-badge-artwork.mjs';
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
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await generateStatusBadges(process.argv[2]);
