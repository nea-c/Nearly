export const HIGHLIGHT_LIMIT = 100_000;
export const HIGHLIGHT_LINE_LIMIT = 10_000;
export type SyntaxLanguage = {id:string;label:string};
const formats:Record<string,SyntaxLanguage>=Object.create(null);
for(const [id,label,extensions] of [
 ['json','JSON','json jsonc mcmeta'],['json5','JSON5','json5'],['yaml','YAML','yaml yml'],
 ['toml','TOML','toml'],['ini','INI','ini cfg'],['properties','Properties','properties'],
 ['markup','HTML/XML','html htm xml svg xhtml'],['css','CSS','css'],
 ['javascript','JavaScript','js mjs cjs'],['typescript','TypeScript','ts mts cts'],
 ['python','Python','py pyw'],['bash','Shell','sh bash zsh'],['sql','SQL','sql'],['markdown','Markdown','md markdown'],
])for(const ext of extensions.split(' '))formats[ext]={id,label};
export function syntaxLanguage(path:string):SyntaxLanguage|null {
 const name=path.split(/[\\/]/).pop()?.toLowerCase()??'';
 if(/^\.env(?:\.|$)/.test(name)||['.bashrc','.bash_profile','.profile','.zshrc'].includes(name))return{id:'bash',label:'Shell'};
 return formats[name.split('.').pop()??'']??null;
}
export function highlightEligible(text:string){
 if(text.length>HIGHLIGHT_LIMIT)return false;
 let length=0;for(let i=0;i<text.length;i++){length=text[i]==='\n'?0:length+1;if(length>HIGHLIGHT_LINE_LIMIT)return false;}
 return true;
}
