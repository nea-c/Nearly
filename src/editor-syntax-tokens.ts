export type Segment={text:string;kind:string};
const kinds:Record<string,string>={comment:'comment',prolog:'comment',doctype:'comment',cdata:'comment',
 property:'property',key:'property',variable:'property',symbol:'property',tag:'property',selector:'property','attr-name':'property',
 string:'string','attr-value':'string',char:'string',regex:'string',url:'string',
 number:'number',boolean:'number',constant:'number',keyword:'keyword',atrule:'keyword',
 function:'function',title:'function','class-name':'function',builtin:'function',punctuation:'punctuation',operator:'punctuation'};
/** Reduce grammar objects to bounded text segments. No HTML is generated. */
export function syntaxSegments(stream:unknown,source:string):Segment[]{
 const result:Segment[]=[];let count=0;
 const visit=(part:unknown,parent='',depth=0)=>{
  if(++count>10_000||depth>32)throw Error('Syntax token budget');
  if(typeof part==='string'){
   const last=result.at(-1);if(last&&last.kind===parent)last.text+=part;else result.push({text:part,kind:parent});
  }else if(Array.isArray(part))for(const item of part)visit(item,parent,depth+1);
  else if(part&&typeof part==='object'&&'type' in part&&'content' in part){const token=part as {type:string;content:unknown};visit(token.content,Object.hasOwn(kinds,token.type)?kinds[token.type]:parent,depth+1);}
  else throw Error('Invalid syntax token');
 };
 visit(stream);
 if(result.map(s=>s.text).join('')!==source)throw Error('Syntax text mismatch');
 return result;
}
