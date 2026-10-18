import {test} from 'node:test';import assert from 'node:assert/strict';import {archiveEligibility} from '../.test-build/archive-actions.js';
test('multiple supported siblings compress while extraction remains single ZIP only',()=>{assert.deepEqual(archiveEligibility('local',[{name:'a',dir:true},{name:'b.ZIP',dir:false}],true),{compress:true,extract:false});});

test('path invalidation preserves unrelated cached entries and rejects old pending seed',async()=>{
 const {DirectoryCache}=await import('../.test-build/directory-cache.js');const cache=new DirectoryCache();cache.seed('keep',[1]);let resolve;const pending=cache.read('changed',()=>new Promise(r=>resolve=r));await Promise.resolve();cache.invalidatePath('changed');resolve([2]);await pending;let reads=0;assert.deepEqual(await cache.read('keep',()=>{reads++;return Promise.resolve([9]);}),[1]);assert.deepEqual(await cache.read('changed',()=>{reads++;return Promise.resolve([3]);}),[3]);assert.equal(reads,1);
});
