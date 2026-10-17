import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../.test-build/core.js';

function luminance(hex) {
  const rgb=hex.match(/[a-f\d]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
}
function contrast(a,b) {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function palette(theme) {
  const css=readFileSync(new URL('../src/green-themes.css',import.meta.url),'utf8');
  const block=css.match(new RegExp(`:root\\[data-theme="${theme}"\\] \\{([^}]+)\\}`))?.[1];
  assert.ok(block,`${theme} palette exists`);
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-f\d]{6})\s*;/gi)].map(m=>[m[1],m[2]]));
}

test('green themes preserve explicit choice and language across restart and OS changes',()=>{
  for(const theme of ['forest','mint']) for(const language of ['ja','en']) {
    const store=new Store({theme,language,settingsRevision:17});
    const before=store.serialize();
    assert.equal(store.resolveInitialTheme(theme==='mint'),false);
    const restored=new Store(JSON.parse(JSON.stringify(before)));
    assert.equal(restored.resolveInitialTheme(theme!=='mint'),false);
    assert.equal(restored.theme,theme);
    assert.equal(restored.language,language);
    assert.deepEqual(restored.serialize(),before);
  }
});

for(const theme of ['forest','mint']) test(`${theme} text, warnings, errors, selections and buttons meet contrast targets`,()=>{
  const p=palette(theme), metrics={};
  const pairs=[
    ['text-main','surface-base'],['text-main','surface-panel'],['text-main','surface-input'],
    ['text-main','surface-selected'],['text-main','surface-selected-hover'],
    ['text-muted','surface-base'],['text-muted','surface-panel'],['text-muted','surface-input'],
    ['text-accent','surface-panel'],['danger-text','surface-panel'],['success-text','surface-panel'],
    ['warning-text','warning-bg'],['action-text','action-bg'],['action-text','action-hover'],
    ['action-text','danger-bg'],['action-text','danger-hover'],
    ['disabled-text','surface-raised'],['danger-text','danger-subtle'],
  ];
  for(const [fg,bg] of pairs){assert.ok(p[fg]&&p[bg],`${fg}/${bg} tokens`);metrics[`${fg}/${bg}`]=+contrast(p[fg],p[bg]).toFixed(2);assert.ok(contrast(p[fg],p[bg])>=4.5,`${theme} ${fg}/${bg}: ${metrics[`${fg}/${bg}`]}`);}
  for(const bg of ['surface-base','surface-panel','surface-input']) assert.ok(contrast(p['focus-ring'],p[bg])>=3,`${theme} visible focus on ${bg}`);
  console.log(`${theme} contrast ${JSON.stringify(metrics)}`);
});

test('Forest checkbox fill and tick remain distinguishable in active and disabled states',()=>{
  const p=palette('forest');
  for(const fill of ['checkbox-on','checkbox-on-hover','checkbox-disabled-on']) {
    assert.ok(contrast(p[fill],p['checkbox-mark'])>=4.5,`${fill} tick contrast`);
    assert.ok(contrast(p[fill],p['surface-input'])>=3,`${fill} filled state contrast`);
  }
  assert.ok(contrast(p['border-main'],p['surface-input'])>=3,'unchecked outline contrast');
});

test('Jade lifts workspace and panel luminance without flattening their hierarchy',()=>{
  const p=palette('forest');
  const prior={'surface-base':'#0d1110','surface-panel':'#151c19','surface-raised':'#202a25','surface-input':'#101713'};
  for(const[token,old]of Object.entries(prior))assert.ok(luminance(p[token])>=luminance(old)*1.8,`${token} visibly brighter`);
  assert.ok(luminance(p['surface-panel'])>luminance(p['surface-base']));
  assert.ok(luminance(p['surface-raised'])>luminance(p['surface-panel']));
});
