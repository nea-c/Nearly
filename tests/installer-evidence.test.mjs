import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
const evidence=await import('../scripts/installer-qa-evidence.mjs').catch(()=>({}));
const summary=()=>({schemaVersion:2,controllerSha:'a'.repeat(40),scenario:'success',destinationKind:'custom',passed:true,cases:[{case:'candidate-ui-en-0-0',passed:true}]});
test('public summary permits only bounded typed results and never raw errors or authorization',()=>{
 assert.equal(typeof evidence.validatePublicSummary,'function');
 assert.deepEqual(evidence.validatePublicSummary(summary()),summary());
 for(const patch of [{token:'secret'},{error:'private path'},{destinationKind:'drive'},{controllerSha:'wrong'},{cases:[{case:'valid',passed:true,path:'private'}]},{cases:[{case:'../secret',passed:true}]}])assert.throws(()=>evidence.validatePublicSummary({...summary(),...patch}));
});

function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]);}
function png(metadata=true){const header=Buffer.alloc(13);header.writeUInt32BE(640,0);header.writeUInt32BE(480,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(metadata?[chunk('tEXt',Buffer.from('Comment\0never publish metadata secrets'))]:[]),chunk('IDAT',deflateSync(Buffer.alloc(480*(640*4+1)))),chunk('IEND',Buffer.alloc(0))]);}
test('public screenshot strips ancillary metadata and rejects altered or appended bytes',()=>{
 assert.equal(typeof evidence.publicPng,'function');
 const clean=evidence.publicPng(png());assert.deepEqual(clean,png(false));assert.equal(clean.includes(Buffer.from('secrets')),false);
 const corrupt=png();corrupt[corrupt.length-1]^=1;
 for(const bytes of [corrupt,Buffer.concat([png(),Buffer.from('private trailer')]),Buffer.from('not a PNG')])assert.throws(()=>evidence.publicPng(bytes));
});
test('UI evidence requires known labels and state assertions rather than arbitrary captured text',()=>{
 assert.equal(typeof evidence.validateUiEvidence,'function');
 const record={schemaVersion:1,case:'en-0-1',language:'en',mode:'Install',destinationKind:'default',start:0,desktop:1,result:'installed',lastStage:'finish',events:[{stage:'directory',screenshot:'directory.png'},{stage:'shortcut-assertions',captions:['Create a Start menu shortcut','Create a desktop shortcut'],defaults:[1,0],selected:[0,1],independentToggle:true},{stage:'finish-assertions',runUnchecked:true,backRetainedChoices:true,destinationFromActualEdit:true}]};
 assert.deepEqual(evidence.validateUiEvidence(record),record);
 const failure={...record,result:'failed',lastStage:'shortcuts',events:[{stage:'failure',screenshot:'failure.png'}]};
 assert.deepEqual(evidence.validateUiEvidence(failure),failure);
 for(const patch of [{token:'secret'},{events:[{stage:'directory',screenshot:'../secret.png'}]},{events:[{stage:'shortcut-assertions',captions:['private text','secret'],defaults:[1,0],selected:[0,1],independentToggle:true}]}])assert.throws(()=>evidence.validateUiEvidence({...record,...patch}));
});
