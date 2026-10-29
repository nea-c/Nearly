import './prism-config.js';
import Prism from 'prismjs/components/prism-core.js';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-json5.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-ini.js';
import 'prismjs/components/prism-properties.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-markdown.js';
import {syntaxSegments} from './editor-syntax-tokens.js';
import {highlightEligible} from './editor-syntax-language.js';
type Request={id:number;text:string;language:string};
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<Request>)=>void)|null;postMessage(message:unknown):void};
scope.onmessage=({data})=>{
 try{
  if(!highlightEligible(data.text)||!Prism.languages[data.language])throw Error('Unsupported syntax request');
  const segments=syntaxSegments(Prism.tokenize(data.text,Prism.languages[data.language]),data.text);
  scope.postMessage({id:data.id,segments});
 }catch(error){scope.postMessage({id:data.id,segments:null,reason:error instanceof Error?error.message:'Tokenizer failed'});}
};
scope.postMessage({ready:true});
