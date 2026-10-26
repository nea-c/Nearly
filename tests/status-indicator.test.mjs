import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceIndicator,statusIcon} from '../.test-build/status-indicator.js';
test('workspace indicator distinguishes observed connection and sync without probing',()=>{
 const w={connection:{}};
 assert.equal(workspaceIndicator({},undefined,'en').kind,'disconnected');
 assert.equal(workspaceIndicator(w,undefined,'en').kind,'connected');
 for(const syncPhase of ['scanning','working','caught_up',undefined])assert.equal(workspaceIndicator(w,{status:'running',pending:0,syncPhase},'en').kind,'sync');
 assert.equal(workspaceIndicator(w,{status:'stopped',pending:0,syncPhase:'error'},'en').kind,'connected');
 assert.equal(workspaceIndicator(w,{status:'stopping',pending:0},'en').kind,'stopping');
 assert.equal(workspaceIndicator(w,{status:'failed',pending:0},'en').kind,'error');
 assert.equal(workspaceIndicator({connectionFailed:true},undefined,'ja').kind,'error');
 assert.equal(workspaceIndicator({connecting:true},undefined,'en').label,'Connecting…');
});
test('all states use the same fixed svg viewport and hide decorative icons from names',()=>{
 for(const kind of ['connected','disconnected','connecting','sync','stopping','error']){
  const s=statusIcon({kind,label:'<unsafe>'});assert.match(s,/viewBox="0 0 16 16"/);assert.match(s,/aria-hidden="true"/);assert.match(s,/data-state=/);assert.doesNotMatch(s,/<unsafe>|<script|animate/);
 }
});

test('connecting ring keeps eight even gaps wider than one pixel including its closing seam',()=>{
 const s=statusIcon({kind:'connecting',label:'Connecting'});
 const r=Number(s.match(/ r="([\d.]+)"/)?.[1]);
 const stroke=Number(s.match(/stroke-width="([\d.]+)"/)?.[1]);
 const [dash,gap]=s.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/).slice(1).map(Number);
 const circumference=2*Math.PI*r;
 const normalized=Number(s.match(/pathLength="([\d.]+)"/)?.[1]??circumference);
 assert.equal(normalized/(dash+gap),8,'closing gap must match the other seven gaps');
 assert.ok((gap*circumference/normalized-stroke)*14/16>=1,'round line caps must leave at least one CSS pixel of clear gap');
});
