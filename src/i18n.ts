import { catalog, ownedMessages, catalogConflicts } from './translation-registry.js';
import { localizeNativeError } from './native-errors.js';

export type Language = 'ja' | 'en';
export type TranslationValues = Record<string, unknown>;
let language: Language = 'ja';
const missing = new Set<string>();
const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const keys = Object.keys(catalog).filter(key=>key.length>0).sort((a,b)=>b.length-a.length);
const literalPattern = keys.length ? new RegExp(keys.map(escapeRegex).join('|'),'gu') : undefined;
const slots = /\{([A-Za-z0-9_]+)\}/g;
const escapeHtmlText = (value:string) => value.replace(/[&<>"']/g,char=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]!));

export function setLanguage(value: Language): void {
  if(value !== 'ja' && value !== 'en') throw new RangeError('Unsupported language');
  language=value;
}
export function getLanguage(): Language { return language; }
function rememberMissing(source:string):void {
  if(missing.size<128 && japanese.test(source)) missing.add(source.slice(0,240));
}
function format(template:string,values:TranslationValues):string {
  return template.replace(slots,(whole,key:string)=>Object.hasOwn(values,key)?String(values[key]):whole);
}
export function t(source:string,values:TranslationValues={}):string {
  const translated=language==='en' && Object.hasOwn(catalog,source)?catalog[source]:source;
  if(language==='en' && !Object.hasOwn(catalog,source)) rememberMissing(source);
  return format(translated,values);
}
export function text(parts:TemplateStringsArray,...values:unknown[]):string {
  const source=parts.reduce((all,part,i)=>all+part+(i<values.length?`{${i}}`:''),'');
  const parameters:TranslationValues=Object.create(null);
  values.forEach((value,i)=>{parameters[String(i)]=value;});
  return t(source,parameters);
}
/** Translate only source-code literal segments. Existing escaping of values stays with the caller. */
export function html(parts:TemplateStringsArray,...values:unknown[]):string {
  return parts.reduce((all,part,i)=>{
    let rendered=part;
    if(language==='en'){
      rendered=literalPattern?part.replace(literalPattern,key=>escapeHtmlText(catalog[key])):part;
      rememberMissing(rendered);
    }
    return all+rendered+(i<values.length?String(values[i]):'');
  },'');
}

type MessagePattern={pattern:RegExp;keys:string[];separators:string[];source:string;english:string};
function compileMessage(template:string,source:string,english:string):MessagePattern {
  const names:string[]=[],separators:string[]=[];let expression='^',at=0;
  for(const match of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)){
    const literal=template.slice(at,match.index);
    if(names.length)separators.push(literal);
    expression+=escapeRegex(literal)+'([\\s\\S]*?)';
    names.push(match[1]);at=match.index+match[0].length;
  }
  expression+=escapeRegex(template.slice(at))+'$';
  return {pattern:new RegExp(expression,'u'),keys:names,separators,source,english};
}
const messagePatterns=Object.entries(ownedMessages).flatMap(([source,english])=>[
  compileMessage(source,source,english),compileMessage(english,source,english),
]);
/** Full owned-message patterns only: user values and unknown OS/library text remain opaque. */
export function tError(error:unknown):string {
  const raw=error instanceof Error?error.message:String(error);
  if(raw.length<=65536){
    for(const entry of messagePatterns){
      if(entry.separators.some(separator=>!separator||raw.indexOf(separator)!==raw.lastIndexOf(separator)))continue;
      const match=entry.pattern.exec(raw);if(!match||match[0]!==raw)continue;
      const values:TranslationValues=Object.create(null);let consistent=true;
      entry.keys.forEach((key,i)=>{
        if(Object.hasOwn(values,key) && values[key]!==match[i+1]) consistent=false;
        values[key]=match[i+1];
      });
      if(consistent)return format(language==='ja'?entry.source:entry.english,values);
    }
  }
  return localizeNativeError(raw,language);
}
export function getLocalizationDiagnostics():{missing:string[];conflicts:string[]} {
  return {missing:[...missing],conflicts:[...catalogConflicts]};
}
