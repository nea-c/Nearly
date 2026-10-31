import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {statusBadgeSvg, badgeStates} from '../scripts/status-badge-artwork.mjs';
const root=new URL('../',import.meta.url);
test('adopted A uses fixed upper right half-width and exact approved symbols',async()=>{
 assert.deepEqual(badgeStates,['sync','done','error','paused']);
 for(const state of badgeStates){const svg=statusBadgeSvg(state,'data:image/png;base64,dummy',32);assert.match(svg,/<svg[^>]+width="32"[^>]+height="32"/);assert.match(svg,/<svg x="16" y="0" width="16" height="16" viewBox="0 0 16 16">/);assert.match(svg,/stroke="#17212B" stroke-width="2.35"/);assert.ok(!svg.includes('clipPath'));}
 // Freeze the approved clockwise arrow; changing its direction changes the visible choice.
 assert.match(statusBadgeSvg('sync','data:image/png;base64,dummy',32),/M12\.5 9\.6A4\.8 4\.8 0 1 1 10\.2 3\.7L12 4\.6/);
 assert.throws(()=>statusBadgeSvg('connected','',32));
});
test('r3.6 regression restores shell badges and avoids a duplicate composite window badge',async()=>{
 const adapter=await fs.readFile(new URL('src-tauri/src/taskbar_adapter.rs',root),'utf8');
 assert.match(adapter,/status_icon_native::apply_shell/);
 assert.doesNotMatch(adapter,/window\.set_overlay_icon\(None\)/);
 assert.match(adapter,/TaskbarState::Idle => BASE/);
});

test('approved C directly renders the exact native14 check geometry',async()=>{
 const m=await import('../scripts/status-badge-artwork.mjs');assert.equal(typeof m.doneBadge14MarkSvg,'function');const svg=m.doneBadge14MarkSvg();assert.match(svg,/width="14" height="14" viewBox="0 0 14 14"/);assert.match(svg,/d="M3\.25 7 L5\.75 9\.5 L10\.5 4\.5"/);assert.match(svg,/stroke="#17212B" stroke-width="2\.1"/);assert.match(svg,/stroke-linecap="round" stroke-linejoin="round"/);assert.ok(!svg.includes('<image'));
});
