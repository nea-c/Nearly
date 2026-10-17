import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeUpdateRoots, settleUpdateWrites } from '../.test-build/startup-update-settle.js';

test('settlement awaits both windows-local write queues before checking readiness', async () => {
  let resolveSettings, resolveRetained;
  const settings = new Promise(resolve => { resolveSettings = resolve; });
  const retained = new Promise(resolve => { resolveRetained = resolve; });
  let checked = false;
  const settling = settleUpdateWrites(() => [settings, retained], () => { checked = true; return true; });
  resolveSettings(); await Promise.resolve(); assert.equal(checked, false);
  resolveRetained(); assert.equal(await settling, true); assert.equal(checked, true);
});
test('write errors reject settlement instead of acknowledging ready', async () => {
  const failure = Error('disk write failed');
  await assert.rejects(settleUpdateWrites(() => [Promise.reject(failure), Promise.resolve()], () => true), failure);
});
test('a late queued write or a busy renderer prevents ready acknowledgement', async () => {
  let finish;
  const settings = new Promise(resolve => { finish = resolve; });
  let retained = Promise.resolve();
  const settling = settleUpdateWrites(() => [settings, retained], () => true);
  retained = Promise.resolve(); finish(); assert.equal(await settling, false);
  const queues = [Promise.resolve(), Promise.resolve()];
  assert.equal(await settleUpdateWrites(() => queues, () => false), false);
});
test('unseal restores each portal prior inert value without touching the updater', () => {
  const app = {inert: false}, modal = {inert: true}, settings = {inert: false}, updater = {inert: false};
  const unseal = freezeUpdateRoots([app, modal, settings]);
  assert.deepEqual([app.inert, modal.inert, settings.inert, updater.inert], [true, true, true, false]);
  unseal(); assert.deepEqual([app.inert, modal.inert, settings.inert, updater.inert], [false, true, false, false]);
});
