import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncDecisionSummary} from '../.test-build/sync-decisions.js';
test('decision summary shares only bounded numeric metadata and anonymous IDs',()=>{
 const input={version:1,counts:{mtime_mismatch:4000,secret:'credential',size_mismatch:'secret'},examples:Array.from({length:4000},()=>({id:'f-0123456789abcdef',reason:'mtime_mismatch',path:'C:/private/secret',host:'credential',localSize:512,remoteSize:512,localUtcSeconds:100,remoteUtcSeconds:101,remoteMinusLocalSeconds:1})),password:'secret'};
 const text=syncDecisionSummary(input),v=JSON.parse(text);assert.equal(v.examples.length,12);assert.equal(v.counts.mtime_mismatch,4000);assert.equal(v.examples[0].remoteMinusLocalSeconds,1);assert(!text.includes('secret'));assert(!text.includes('credential'));assert(!text.includes('private'));assert(!text.includes('path'));assert(text.length<6000);
});
test('malformed reports and path-like IDs cannot leak into summary',()=>{
 assert.equal(syncDecisionSummary(undefined),'');assert.equal(syncDecisionSummary({version:2}), '');
 const v=JSON.parse(syncDecisionSummary({version:1,examples:[{id:'C:/private',reason:'mtime_mismatch'},{id:'f-0123456789abcdef',reason:'private-path'}]}));assert.deepEqual(v.examples,[]);
});
