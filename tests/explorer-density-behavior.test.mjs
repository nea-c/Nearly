import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExplorerDensity } from '../.test-build/explorer-density.js';

function withFixture(options, run) {
  const {top=145,left=47,count=50,height=110,kind='.table-scroll'}=options;
  const header=kind==='.table-scroll'?28:0;
  const root={dataset:{}};
  const rowHeight=()=>root.dataset.compactExplorer==='true'?24:32;
  const scroller={scrollTop:top,scrollLeft:left,clientHeight:height,
    get scrollHeight(){return header+count*rowHeight();},
    getBoundingClientRect:()=>({top:10,bottom:10+height,height}),
    querySelector:selector=>selector==='thead'?{getBoundingClientRect:()=>({height:header})}:null,
    querySelectorAll:()=>rows,
    matches:selector=>selector===kind,
    isConnected:true};
  const rows=Array.from({length:count},(_,index)=>({isConnected:true,
    getBoundingClientRect:()=>({top:10+header+index*rowHeight()-scroller.scrollTop,bottom:10+header+(index+1)*rowHeight()-scroller.scrollTop,height:rowHeight()})}));
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:{documentElement:root,querySelectorAll:()=>[scroller]}});
  try { run({root,scroller,rows}); }
  finally {
    if(original)Object.defineProperty(globalThis,'document',original);
    else delete globalThis.document;
  }
}

test('density toggle retains row identity, selection, visible anchor and horizontal scroll',()=>{
  withFixture({},({root,scroller,rows})=>{
    const row=rows[4];row.selected=true;
    const top=row.getBoundingClientRect().top;
    applyExplorerDensity(true);
    assert.equal(root.dataset.compactExplorer,'true');
    assert.equal(rows[4],row);assert.equal(row.selected,true);
    assert.equal(row.getBoundingClientRect().top,top);
    assert.equal(scroller.scrollLeft,47);
    applyExplorerDensity(false);
    assert.equal(root.dataset.compactExplorer,undefined);
    assert.equal(scroller.scrollTop,145);
    assert.equal(scroller.scrollLeft,47);
  });
});
test('density clamps at the list end and handles an empty scroller',()=>{
  withFixture({top:1518},({scroller})=>{
    applyExplorerDensity(true);
    assert.equal(scroller.scrollTop,scroller.scrollHeight-scroller.clientHeight);
  });
  withFixture({top:0,count:0},({scroller})=>{
    applyExplorerDensity(true);assert.equal(scroller.scrollTop,0);
  });
});
test('a heavily clipped anchor stays visible when its row shrinks',()=>{
  withFixture({top:153},({scroller,rows})=>{
    const row=rows[4];applyExplorerDensity(true);
    assert.equal(row.getBoundingClientRect().bottom,39);
    assert.equal(scroller.scrollLeft,47);
  });
});
test('folder, connection and bookmark scrollers retain their own visible anchors',()=>{
  for(const kind of ['.folder-tree','#connection-tree','.bookmark-tree-menu']){
    withFixture({kind},({scroller,rows})=>{
      const row=rows[4],top=row.getBoundingClientRect().top;
      applyExplorerDensity(true);
      assert.equal(row.getBoundingClientRect().top,top,kind);
      assert.equal(scroller.scrollLeft,47,kind);
    });
  }
});
test('applying the current density does not read geometry or modify scroll',()=>{
  withFixture({},({root,scroller})=>{
    root.dataset.compactExplorer='true';
    scroller.getBoundingClientRect=()=>{throw Error('unexpected geometry read');};
    applyExplorerDensity(true);assert.equal(scroller.scrollTop,145);
  });
});
