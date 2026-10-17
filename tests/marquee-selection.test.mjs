import test from 'node:test';
import assert from 'node:assert/strict';
import {crossedThreshold,intersects} from '../.test-build/marquee-selection.js';
test('marquee movement distinguishes click jitter from a range gesture',()=>{
  assert.equal(crossedThreshold({x:100,y:200},{x:103,y:202}),false);
  assert.equal(crossedThreshold({x:100,y:200},{x:103,y:204}),true);
  assert.equal(crossedThreshold({x:100,y:200},{x:94,y:200}),true);
});
test('range geometry selects intersected rows after either drag direction and excludes header/touch-only boundaries',()=>{
  const selection={left:220,top:33,right:240,bottom:85};
  const rows=[{left:0,top:0,right:400,bottom:30},{left:0,top:30,right:400,bottom:60},{left:0,top:60,right:400,bottom:90},{left:0,top:90,right:400,bottom:120}];
  assert.deepEqual(rows.map(r=>intersects(selection,r)),[false,true,true,false]);
  assert.equal(intersects(selection,{left:240,top:33,right:300,bottom:85}),false);
});
