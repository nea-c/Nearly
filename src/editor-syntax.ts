import {syntaxLanguage,highlightEligible} from './editor-syntax-language.js';
import type {Segment} from './editor-syntax-tokens.js';
type Job={owner:object;id:number;text:string;language:string;resolve:(segments:Segment[]|null)=>void};
/** One bounded worker per editor window. A pathological grammar cannot block input. */
class Tokenizer {
 private worker?:Worker;private ready=false;private next=0;private active?:Job;
 private queue=new Map<object,Job>();private timeout?:ReturnType<typeof setTimeout>;
 request(owner:object,text:string,language:string){
  this.cancelQueued(owner);
  return new Promise<Segment[]|null>(resolve=>{this.queue.set(owner,{owner,text,language,id:++this.next,resolve});this.pump();});
 }
 private cancelQueued(owner:object){this.queue.get(owner)?.resolve(null);this.queue.delete(owner);}
 cancel(owner:object){this.cancelQueued(owner);if(this.active?.owner===owner)this.failed();if(!this.active&&!this.queue.size)this.stop();}
 private stop(){clearTimeout(this.timeout);this.worker?.terminate();this.worker=undefined;this.ready=false;}
 private failed(){
  let job=this.active;this.active=undefined;
  // An old in-flight revision and its queued replacement may share an owner.
  // Only a failed startup owns the queued job; never delete a newer revision.
  if(!job){job=this.queue.values().next().value;if(job)this.queue.delete(job.owner);}
  this.stop();job?.resolve(null);this.pump();
 }
 private pump(){
  if(this.active||!this.queue.size)return;
  if(!this.worker){
   try{
    this.worker=new Worker(new URL('./editor-syntax-worker.ts',import.meta.url),{type:'module'});
    const worker=this.worker;
    // Cold module loading is separate from the 250ms token budget below.
    // Input remains rendered as plain text while this private worker loads.
    this.timeout=setTimeout(()=>this.failed(),10000);
    this.worker.onerror=(event)=>{event.preventDefault();if(this.worker===worker)this.failed();};
    this.worker.onmessage=({data})=>{
     if(this.worker!==worker)return;
     if(data.ready){clearTimeout(this.timeout);this.ready=true;this.pump();return;}
     if(!this.active||data.id!==this.active.id)return;
     clearTimeout(this.timeout);const job=this.active;this.active=undefined;job.resolve(Array.isArray(data.segments)?data.segments:null);this.pump();
    };
   }catch{for(const job of this.queue.values())job.resolve(null);this.queue.clear();this.stop();}
  }
  if(!this.ready||!this.worker)return;
  const job=this.queue.values().next().value as Job;this.queue.delete(job.owner);this.active=job;
  this.timeout=setTimeout(()=>this.failed(),250);
  try{this.worker.postMessage({id:job.id,text:job.text,language:job.language});}catch{this.failed();}
 }
}
const tokenizer=new Tokenizer();
export function syntaxEditor(input:HTMLTextAreaElement,path:string,mode:(label:string,plain:boolean)=>void){
 const root=document.createElement('div');root.className='editor-input';root.dataset.composing='false';
 const layer=document.createElement('pre');layer.className='syntax-layer';layer.setAttribute('aria-hidden','true');
 const code=document.createElement('code');code.className='syntax-code';layer.append(code);root.append(layer,input);
 const language=syntaxLanguage(path);const owner={};let disposed=false,revision=0,composing=false,lastHighlightedText:string|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const sync=()=>{layer.style.width=input.clientWidth+'px';layer.style.height=input.clientHeight+'px';layer.scrollTop=input.scrollTop;layer.scrollLeft=input.scrollLeft;};
 const refresh=()=>{
  clearTimeout(timer);const version=++revision,text=input.value;
  const eligible=!!language&&highlightEligible(text);
  if(eligible&&text===lastHighlightedText){sync();return;}
  lastHighlightedText=undefined;
  root.dataset.highlight=String(eligible);code.textContent=eligible?text:'';
  mode(eligible?language!.label:'',!eligible);sync();
  if(!eligible||composing)return;
  timer=setTimeout(()=>{
   if(disposed||root.closest('[hidden]'))return;
   void tokenizer.request(owner,text,language!.id).then(segments=>{
    if(disposed||composing||revision!==version||input.value!==text)return;
    if(!segments){root.dataset.highlight='false';mode('',true);return;}
    const nodes=document.createDocumentFragment();
    for(const segment of segments){
     if(!segment.kind)nodes.append(document.createTextNode(segment.text));
     else{const span=document.createElement('span');span.className='syntax-'+segment.kind;span.textContent=segment.text;nodes.append(span);}
    }
    code.replaceChildren(nodes);lastHighlightedText=text;sync();
   });
  },80);
 };
 const start=()=>{composing=true;root.dataset.composing='true';clearTimeout(timer);++revision;tokenizer.cancel(owner);};
 const end=()=>{composing=false;root.dataset.composing='false';refresh();};
 input.addEventListener('input',refresh);input.addEventListener('scroll',sync);
 input.addEventListener('compositionstart',start);input.addEventListener('compositionend',end);
 const observer=new ResizeObserver(sync);observer.observe(input);refresh();
 return {root,refresh,activate(){sync();refresh();},dispose(){disposed=true;clearTimeout(timer);observer.disconnect();tokenizer.cancel(owner);input.removeEventListener('input',refresh);input.removeEventListener('scroll',sync);input.removeEventListener('compositionstart',start);input.removeEventListener('compositionend',end);}};
}
