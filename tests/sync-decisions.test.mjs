import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncDecisionSummary} from '../.test-build/sync-decisions.js';
test('decision summary shares only bounded numeric metadata and anonymous IDs',()=>{
 const input={version:1,counts:{mtime_mismatch:4000,secret:'credential',size_mismatch:'secret'},examples:Array.from({length:4000},()=>({id:'f-0123456789abcdef',reason:'mtime_mismatch',path:'C:/private/secret',host:'credential',localSize:512,remoteSize:512,localUtcSeconds:100,remoteUtcSeconds:101,remoteMinusLocalSeconds:1})),password:'secret'};
 const text=syncDecisionSummary(input),v=JSON.parse(text);assert.equal(v.examples.length,12);assert.equal(v.counts.mtime_mismatch,4000);assert.equal(v.examples[0].remoteMinusLocalSeconds,1);assert(!text.includes('secret'));assert(!text.includes('credential'));assert(!text.includes('private'));assert(!text.includes('path'));assert(text.length<6000);
});
test('malformed reports and path-like IDs cannot leak into summary',()=>{
 assert.equal(syncDecisionSummary(undefined),'');assert.equal(syncDecisionSummary({version:3}), '');
 const v=JSON.parse(syncDecisionSummary({version:1,examples:[{id:'C:/private',reason:'mtime_mismatch'},{id:'f-0123456789abcdef',reason:'private-path'}]}));assert.deepEqual(v.examples,[]);
});

test('policy v2 reports retained remote and conflicts with fixed precision and policy',()=>{
 const text=syncDecisionSummary({version:2,precision:'secret server',comparisonPolicy:'private path',counts:{remote_newer_retained:4000,sync_conflict:1},examples:[{id:'f-0123456789abcdef',reason:'remote_newer_retained',localSize:469,remoteSize:469,localUtcSeconds:100,remoteUtcSeconds:140,remoteMinusLocalSeconds:40},{id:'f-0123456789abcdef',reason:'sync_conflict',path:'secret path'}]});
 const v=JSON.parse(text);assert.equal(v.version,2);assert.match(v.precision,/no tolerance/);assert.match(v.comparisonPolicy,/initial local-newer/);assert.equal(v.counts.remote_newer_retained,4000);assert.equal(v.counts.sync_conflict,1);assert.equal(v.examples.length,2);assert(!text.includes('secret'));assert(!text.includes('private'));
});
