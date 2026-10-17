import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowseHistory, parentFolder } from '../.test-build/navigation.js';

test('history commits only confirmed reads and normal branches discard forward history', () => {
 const h=new BrowseHistory();h.commit('/');h.commit('/a');h.commit('/b');
 const target=h.target(-1);assert.equal(h.current,'/b'); // request/failure leaves cursor unchanged
 assert.equal(target.path,'/a');h.commit(target.path,target.index);
 assert.equal(h.target(1).path,'/b');h.commit('/a');assert.equal(h.target(1).path,'/b'); // refresh
 h.commit('/c');assert.equal(h.target(1),undefined);assert.equal(h.target(-1).path,'/a');
 assert.throws(()=>h.commit('/wrong',0));assert.equal(h.current,'/c');
});
test('history is bounded and independent; roots never navigate to the virtual PC',()=>{
 const a=new BrowseHistory(),b=new BrowseHistory();b.commit('/home');
 for(let n=0;n<100;n++)a.commit('/'+n);assert.equal(a.length,64);assert.equal(b.current,'/home');
 for(let n=0;n<63;n++){const target=a.target(-1);a.commit(target.path,target.index);}
 assert.equal(a.current,'/36');assert.equal(a.target(-1),undefined);
 assert.equal(parentFolder('local','C:\\'),undefined);assert.equal(parentFolder('remote','/'),undefined);
 assert.equal(parentFolder('local','C:\\child'),'C:\\');assert.equal(parentFolder('remote','/home/child'),'/home');
});
