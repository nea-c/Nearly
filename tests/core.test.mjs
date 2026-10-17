import { test } from "node:test";
import assert from "node:assert/strict";
import { Queue, Store, overlap, remotePath } from "../.test-build/core.js";
test("global theme defaults to system and persists without altering profiles or history", () => {
  const store = new Store();
  assert.equal(store.theme, "system");
  for (const theme of ["light", "dark", "system"]) {
    store.theme = theme;
    assert.equal(new Store(JSON.parse(JSON.stringify(store.serialize()))).theme, theme);
  }
  assert.throws(() => new Store({ theme: "unexpected" }));
});
test("rejects malformed settings before they can be overwritten", () => {
  assert.throws(() => new Store({ version: 1, profiles: "broken" }));
  assert.throws(
    () => new Store({ version: 1, profiles: [], history: { a: 123 } }),
  );
});
test("coalesces repeated changes and keeps first detection time", () => {
  const q = new Queue();
  q.push("a", 0);
  q.push("a", 400);
  assert.equal(q.size, 1);
  assert.equal(q.take(899), null);
  assert.deepEqual(q.take(900), { path: "a", first: 0, last: 400, attempt: 0 });
});
test("changes during upload survive and retry never overwrites newer version", () => {
  const q = new Queue();
  q.push("a", 0);
  const old = q.take(500);
  q.push("a", 600);
  q.retry(old, 700);
  assert.equal(q.take(1100).last, 600);
});
test("bounded queue refuses overflow without silently losing entries", () => {
  const q = new Queue(2);
  q.push("a", 0);
  q.push("b", 0);
  assert.throws(() => q.push("c", 0), /上限/);
  assert.equal(q.size, 2);
});
test("history survives closing tabs, editing profile preserves identity", () => {
  const s = new Store();
  const p = s.saveProfile({
    name: "One",
    host: "example.invalid",
    port: 22,
    user: "me",
    auth: "agent",
    mode: "mock",
  });
  s.remember(p.id, "/www", "C:\\site");
  s.tabs.push({ id: "t" });
  s.tabs = [];
  s.saveProfile({ ...p, name: "Two" });
  assert.equal(s.local(p.id, "/www/"), "C:\\site");
  assert.equal(s.profiles.length, 1);
  assert.equal(s.profiles[0].name, "Two");
  const restored = new Store(JSON.parse(JSON.stringify(s.serialize())));
  assert.equal(restored.local(p.id, "/www"), "C:\\site");
  assert.equal(restored.tabs.length, 0);
});
test("overlap respects boundaries and normalizes traversal", () => {
  assert.equal(remotePath("/a//b/../c/"), "/a/c");
  assert.ok(overlap("/a", "/a/b"));
  assert.ok(overlap("/", "/a"));
  assert.ok(!overlap("/a", "/ab"));
});
test("profile validation prevents secret storage and invalid endpoints", () => {
  const s = new Store();
  assert.throws(() =>
    s.saveProfile({ name: "x", host: "x", port: 0, user: "x" }),
  );
  const p = s.saveProfile({
    name: "x",
    host: "x",
    port: 22,
    user: "x",
    password: "SECRET",
    mode: "mock",
    auth: "agent",
  });
  assert.ok(!JSON.stringify(p).includes("SECRET"));
});
