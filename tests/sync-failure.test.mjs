import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../.test-build/core.js";
import {
  snapshotWorkspaceTransfer,
  hydrateWorkspaceTransfer,
  validateWorkspaceTransfer,
} from "../.test-build/workspace-transfer.js";
import { setLanguage } from "../.test-build/i18n.js";
import { localizeNativeError } from "../.test-build/native-errors.js";
const module = await import("../.test-build/sync-failure.js").catch(() => ({}));
test('sync conflicts are explicit and localized without offering automatic overwrite',()=>{
 setLanguage('ja');const details=module.failureDetails({relativePath:'generated/file.txt',operation:'conflict',reason:'Sync conflict: remote changed since sync baseline; no overwrite attempted',commitState:'not_committed',pending:1,requiresRescan:true});
 assert.equal(details.operation,'同期の競合');assert.match(details.reason,/リモート/);assert.match(module.failureLabels(true,true).title,/競合/);assert.match(module.failureLabels(true,true).help,/自動/);
 setLanguage('en');assert.match(module.failureLabels(true,true).title,/conflict/);assert.match(module.failureLabels(true,true).help,/No automatic/);setLanguage('ja');
});
test("new scan and stopped summaries translate with committed failure context intact", () => {
  for (const original of [
    "Initial local scan completed",
    "Sync stopped after error; manual restart performs a full scan. Staging or already committed changes may remain.",
    "Upload committed; Local source changed",
  ]) {
    const japanese = localizeNativeError(original, "ja");
    assert.notEqual(japanese, original);
    assert.equal(localizeNativeError(japanese, "en"), original);
  }
});
test("failure details preserve opaque relative paths and distinguish uncertain commit", () => {
  assert.equal(
    typeof module.failureDetails,
    "function",
    "structured failure presentation is available",
  );
  const result = module.failureDetails({
    relativePath: "folder/<tag> $&.txt",
    operation: "upload",
    reason: "Local source changed",
    commitState: "unknown",
    pending: 3,
    requiresRescan: true,
  });
  assert.equal(result.path, "folder/<tag> $&.txt");
  assert.equal(result.pending, 3);
  assert.match(result.commit, /不明/);
  assert.match(result.reason, /./);
});
test("failure survives 100 mixed log lines and a workspace transfer without widening its path", () => {
  const profile = {
    id: "p",
    name: "Fixture",
    host: "fixture.invalid",
    port: 22,
    user: "test",
    auth: "key",
    mode: "sftp",
    keyFile: "",
    hostKey: "pin",
  };
  const store = new Store({ profiles: [profile] });
  const w = store.createWorkspace("p", "C:\\synthetic");
  store.connectWorkspace(w.id, profile);
  const failure = {
    relativePath: "folder/a.txt",
    operation: "compare/upload",
    reason: "Local source changed",
    commitState: "not_committed",
    pending: 1,
    requiresRescan: true,
  };
  store.attachJob(w.id, {
    id: "job",
    profile,
    local: "C:\\synthetic",
    remote: "/synthetic",
    status: "failed",
    failure,
    logs: Array(100).fill("Skipped unchanged b.txt"),
    sent: 1,
    speed: 0,
    latency: 0,
  });
  const transfer = snapshotWorkspaceTransfer(store, w.id);
  assert.deepEqual(transfer.job.failure, failure);
  const target = new Store({ profiles: [profile] });
  hydrateWorkspaceTransfer(target, transfer, w.id);
  assert.deepEqual(target.tabs[0].failure, failure);
  transfer.job.failure.relativePath = "C:\\private\\secret.txt";
  assert.throws(
    () => validateWorkspaceTransfer(transfer),
    /Invalid workspace transfer/,
  );
});
test("failure summaries switch language without translating opaque paths", () => {
  const failure = {
    relativePath: "設定/$&.txt",
    operation: "scan",
    reason: "Local source changed",
    commitState: "committed",
    pending: 0,
    requiresRescan: true,
  };
  setLanguage("en");
  assert.equal(module.failureDetails(failure).operation, "scan");
  assert.equal(module.failureDetails(failure).commit, "Committed");
  assert.equal(module.failureDetails(failure).path, failure.relativePath);
  setLanguage("ja");
  assert.equal(module.failureDetails(failure).operation, "ローカル走査");
});
test("failed stop request remains visibly failed and is not automatically repeated", async () => {
  const status = { status: "running", errorCount: 0, logs: [], speed: 5 };
  let calls = 0;
  assert.equal(
    await module.stopAfterStatusFailure(
      status,
      "Status lock failed",
      async () => {
        calls++;
        throw Error("Stop uncertain");
      },
    ),
    false,
  );
  assert.equal(status.status, "failed");
  assert.match(status.statusError, /Stop uncertain/);
  await module.stopAfterStatusFailure(
    status,
    "Status lock failed",
    async () => {
      calls++;
    },
  );
  assert.equal(calls, 1);
  assert.match(status.statusError, /Stop uncertain/);
});
test("status failure stops once and never reports success or auto restarts", async () => {
  assert.equal(typeof module.stopAfterStatusFailure, "function");
  const status = { status: "running", errorCount: 0, logs: [], speed: 10 };
  let calls = 0;
  assert.equal(
    await module.stopAfterStatusFailure(
      status,
      new Error("Status lock failed"),
      async () => {
        calls++;
      },
    ),
    true,
  );
  assert.equal(status.status, "failed");
  assert.equal(status.statusError, "Status lock failed");
  assert.equal(status.stopComplete, true);
  await module.stopAfterStatusFailure(
    status,
    new Error("Status lock failed"),
    async () => {
      calls++;
    },
  );
  assert.equal(calls, 1);
});
test("failure title claims stopped only after completion is confirmed", () => {
  assert.match(module.failureLabels(false).title, /未確認/);
  assert.doesNotMatch(module.failureLabels(true).title, /未確認/);
});
test("poll failure retains the first persistent failure and records status error separately", () => {
  assert.equal(typeof module.applyStatusPollFailure, "function");
  const failure = {
    relativePath: "a.txt",
    operation: "upload",
    reason: "Local source changed",
    commitState: "not_committed",
    pending: 2,
    requiresRescan: true,
  };
  const tab = {
    status: "running",
    failure,
    errorCount: 0,
    logs: [],
    speed: 40,
  };
  module.applyStatusPollFailure(tab, new Error("Status lock failed"));
  assert.equal(tab.status, "failed");
  assert.equal(tab.speed, 0);
  assert.equal(tab.failure, failure);
  assert.equal(tab.statusError, "Status lock failed");
  assert.equal(tab.errorCount, 1);
  module.applyStatusPollFailure(tab, new Error("Status lock failed"));
  assert.equal(tab.errorCount, 1);
});
