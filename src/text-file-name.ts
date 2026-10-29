/** Double-click policy only. Native decoding, size and overlap checks remain authoritative. */
const extensions=new Set(('txt text log csv tsv json jsonc json5 yaml yml toml ini cfg conf config properties '+
 'html htm xhtml xml svg css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte '+
 'py pyw sh bash zsh fish sql md markdown rst tex c h cc hh cpp hpp cxx hxx cs java kt kts '+
 'rs go lua rb php pl pm r bat cmd ps1 psm1 psd1').split(' '));
const names=new Set(['readme','license','licence','notice','changelog','makefile','dockerfile','gemfile','rakefile','.gitignore','.gitattributes','.gitmodules','.editorconfig','.npmrc','.yarnrc','.bashrc','.bash_profile','.profile','.zshrc']);
export function textFileName(name:string){
 if(!name||/[\\/:\0]/.test(name))return false;
 const lower=name.toLowerCase();
 return names.has(lower)||/^\.env(?:\.[a-z0-9._-]+)?$/.test(lower)||
   (lower.lastIndexOf('.')>0&&extensions.has(lower.split('.').at(-1)??''));
}
