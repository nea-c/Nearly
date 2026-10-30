import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import './check-version.mjs';

// A successful HTML response does not mean Vite has transformed the entry graph.
// Keep that cold compilation outside the individual 30-second behavior tests.
const root=fileURLToPath(new URL('../',import.meta.url));
let ready=false;
const server=await createServer({root,plugins:[{
 name:'ui-qa-readiness',
 configureServer(vite){
  // Register before Vite's HTML fallback, which otherwise answers this URL.
  vite.middlewares.use('/__qa_ready',(_request,response)=>{
   response.statusCode=ready?200:503;
   response.end(ready?'ready':'compiling');
  });
 },
}]});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
 await server.close();process.exit(0);
});
try{
 await server.listen();
 const html=await server.transformIndexHtml('/',await fs.readFile(new URL('../index.html',import.meta.url),'utf8'));
 const pending=[...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(match=>
  match[1].endsWith('.css')?`${match[1]}?direct`:match[1]);
 const seen=new Set();
 while(pending.length){
  const batch=[...new Set(pending.splice(0))].filter(url=>!seen.has(url));
  for(const url of batch)seen.add(url);
  await Promise.all(batch.map(async url=>{
   const result=await server.transformRequest(url);
   if(!result)throw Error(`UI readiness could not transform ${url}`);
   const module=await server.moduleGraph.getModuleByUrl(url);
   for(const dependency of module?.importedModules??[])pending.push(dependency.url);
  }));
 }
 ready=true;
 console.log(`UI QA ready: ${seen.size} transformed resources`);
}catch(error){
 console.error(error);await server.close();process.exitCode=1;
}
