import test from 'node:test';
import assert from 'node:assert/strict';
import {DirectoryCache} from '../.test-build/directory-cache.js';
test('listing cache shares inflight reads and bounds TTL, paths and entry retention',async()=>{
  let now=0,calls=0,release;
  const cache=new DirectoryCache(10,2,3,()=>now);
  const load=()=>{calls++;return new Promise(r=>release=r)};
  const first=cache.read('/a',load),second=cache.read('/a',load);
  await Promise.resolve();assert.equal(calls,1);release([1,2]);
  const one=await first;one.push(9);assert.deepEqual(await second,[1,2]);
  assert.deepEqual(await cache.read('/a',async()=>[3]),[1,2]);
  cache.seed('/b',[3,4]);assert.deepEqual(await cache.read('/a',async()=>[5]),[5]);
  now=11;assert.deepEqual(await cache.read('/a',async()=>[6]),[6]);
});
test('invalidation prevents an old completion populating cache and failures never cache',async()=>{
  const cache=new DirectoryCache();let finish;
  const old=cache.read('/a',()=>new Promise(r=>finish=r));await Promise.resolve();
  cache.invalidate();cache.seed('/a',['new']);finish(['old']);assert.deepEqual(await old,['old']);
  assert.deepEqual(await cache.read('/a',async()=>['wrong']),['new']);
  await assert.rejects(cache.read('/error',async()=>{throw Error('failed')}));
  assert.deepEqual(await cache.read('/error',async()=>['retry']),['retry']);
});

test('stale owner generation cannot seed a later navigation cache',async()=>{
  const cache=new DirectoryCache();let release,current=true;
  const stale=cache.read('/old',()=>new Promise(r=>release=r),()=>current);
  await Promise.resolve();current=false;release(['old']);await stale;
  assert.deepEqual(await cache.read('/old',async()=>['fresh']),['fresh']);
});

test('subtree invalidation evicts only removed directory descendants and pending replies',async()=>{
 const cache=new DirectoryCache();cache.seed('/folder',['old']);cache.seed('/folder/child',['child']);cache.seed('/folder-other',['keep']);let finish;const pending=cache.read('/folder/pending',()=>new Promise(r=>finish=r));await Promise.resolve();cache.invalidateMatching(p=>p==='/folder'||p.startsWith('/folder/'));finish(['late']);await pending;
 assert.deepEqual(await cache.read('/folder',async()=>['fresh']),['fresh']);assert.deepEqual(await cache.read('/folder/child',async()=>['fresh child']),['fresh child']);assert.deepEqual(await cache.read('/folder/pending',async()=>['fresh pending']),['fresh pending']);assert.deepEqual(await cache.read('/folder-other',async()=>['wrong']),['keep']);
});
test('removed subtree drops obsolete children while preserving expansion and unrelated tree tokens',async()=>{
 const {FolderTree}=await import('../.test-build/tree.js');const tree=new FolderTree('remote','/');tree.record('/',[{name:'folder',dir:true},{name:'other',dir:true}]);tree.record('/folder',[{name:'child',dir:true}]);tree.record('/folder/child',[{name:'old',dir:true}]);tree.node('/folder').expanded=true;tree.node('/folder/child').expanded=true;const stale=tree.begin('/folder/child'),unrelated=tree.begin('/other');tree.invalidateSubtree('/folder',true);
 for(const p of ['/folder','/folder/child']){assert.equal(tree.peek(p).loaded,false);assert.deepEqual(tree.peek(p).children,[]);assert.equal(tree.peek(p).expanded,true);}assert.equal(tree.current('/folder/child',stale),false);assert.equal(tree.current('/other',unrelated),true);
});
