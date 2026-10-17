import test from "node:test";
import assert from "node:assert/strict";
const base = process.env.NEARLY_RETAINED_MODEL_DIR ?? "../.test-build";
const { Store, Queue } = await import(
  new URL(base + "/core.js", import.meta.url)
);
const model = () =>
  import(new URL(base + "/retained-sync.js", import.meta.url));
const profile = (id = "generated") => ({
  id,
  name: "Generated profile",
  host: "example.invalid",
  port: 22,
  user: "fixture",
  auth: "key",
  mode: "sftp",
  keyFile: "C:\\generated\\fixture.ppk",
  hostKey: "",
});
const record = (id = "retained-1") => ({
  id,
  profile: profile(),
  local: "C:\\generated\\source",
  remote: "/generated/upload",
  exclusionRules: "*.tmp\ncache/",
  deleteRemoved: false,
  recursive: true,
  pendingState: "unknown",
});
const runtime = (id, retainedId, p) => ({
  id,
  retainedId,
  profile: p,
  local: "C:\\generated\\source",
  remote: "/generated/upload",
  status: "stopped",
  pending: 0,
  sent: 0,
  speed: 0,
  latency: 0,
  logs: [],
  queue: new Queue(),
});

test("retained records reload disconnected with no runtime jobs or workspaces", () => {
  const empty = new Store();
  assert.deepEqual(empty.retainedSyncs, []);
  const value = record();
  value.pendingState = "unreflected";
  const store = new Store({ profiles: [profile()], retainedSyncs: [value] });
  assert.deepEqual(store.listRetainedSyncs(), [value]);
  assert.deepEqual(store.tabs, []);
  assert.deepEqual(store.workspaces, []);
  const loaded = new Store(JSON.parse(JSON.stringify(store.serialize())));
  assert.deepEqual(loaded.retainedSyncs, [value]);
  assert.deepEqual(loaded.tabs, []);
  assert.deepEqual(loaded.workspaces, []);
});

test("runtime profile projection cannot persist passphrases or private key material", () => {
  const store = new Store({ profiles: [profile()] });
  const input = record();
  Object.assign(input.profile, {
    passphrase: "GENERATED_SECRET",
    password: "GENERATED_PASSWORD",
    privateKey: "GENERATED_PRIVATE_KEY",
  });
  store.upsertRetainedSync(input);
  const serialized = JSON.stringify(store.serialize());
  for (const secret of [
    "GENERATED_SECRET",
    "GENERATED_PASSWORD",
    "GENERATED_PRIVATE_KEY",
    "passphrase",
    "privateKey",
  ])
    assert.ok(!serialized.includes(secret));
  assert.deepEqual(
    Object.keys(store.retainedSyncs[0].profile).sort(),
    Object.keys(profile()).sort(),
  );
});

test("retained snapshots and serialization are detached from callers and live profile edits", () => {
  const store = new Store({ profiles: [profile()] });
  const input = record();
  const returned = store.upsertRetainedSync(input);
  input.profile.host = "changed.invalid";
  returned.profile.user = "changed";
  const listed = store.listRetainedSyncs();
  listed[0].profile.name = "changed";
  const output = store.serialize();
  output.retainedSyncs[0].profile.keyFile = "changed";
  store.saveProfile({ ...profile(), host: "edited.invalid" });
  assert.equal(store.retainedSyncs[0].profile.host, "example.invalid");
  assert.equal(store.retainedSyncs[0].profile.user, "fixture");
  assert.equal(store.retainedSyncs[0].profile.name, "Generated profile");
  assert.equal(
    store.retainedSyncs[0].profile.keyFile,
    "C:\\generated\\fixture.ppk",
  );
});

test("strict persisted schema rejects unknown fields, malformed flags, paths, profiles and accessors", async () => {
  const { validateRetainedSync, validateRetainedSyncs } = await model();
  for (const input of [
    null,
    [],
    { ...record(), status: "running" },
    { ...record(), passphrase: "GENERATED_SECRET" },
    { ...record(), pendingState: "synced" },
    { ...record(), recursive: "true" },
    { ...record(), deleteRemoved: 1 },
    { ...record(), local: "relative" },
    { ...record(), remote: "/x/../y" },
    { ...record(), exclusionRules: "bad\0rule" },
    { ...record(), profile: { ...profile(), password: "GENERATED_SECRET" } },
    { ...record(), profile: { ...profile(), port: "22" } },
    { ...record(), profile: { ...profile(), auth: "password" } },
    Object.assign(Object.create({ inherited: true }), record()),
  ])
    assert.throws(() => validateRetainedSync(input));
  const getter = { ...record() };
  Object.defineProperty(getter, "local", {
    get() {
      throw Error("getter was executed");
    },
    enumerable: true,
  });
  assert.throws(
    () => validateRetainedSync(getter),
    (error) => !error.message.includes("getter was executed"),
  );
  assert.throws(() => validateRetainedSyncs([record(), record()]));
  assert.throws(() => validateRetainedSyncs(null));
  assert.throws(() => validateRetainedSyncs(new Array(1)));
  assert.throws(
    () => new Store({ retainedSyncs: [{ ...record(), status: "running" }] }),
  );
});

test("upsert uses exact IDs without replacing distinct duplicate pairs and enforces 100 bound atomically", () => {
  const store = new Store();
  store.upsertRetainedSync(record("one"));
  store.upsertRetainedSync(record("two"));
  assert.equal(store.retainedSyncs.length, 2);
  store.upsertRetainedSync({ ...record("one"), recursive: false });
  assert.equal(store.retainedSyncs.length, 2);
  assert.equal(store.retainedSyncs[0].recursive, false);
  for (let index = 2; index < 100; index++)
    store.upsertRetainedSync(record("record-" + index));
  const before = JSON.stringify(store.serialize());
  assert.throws(() => store.upsertRetainedSync(record("overflow")));
  assert.equal(JSON.stringify(store.serialize()), before);
  store.upsertRetainedSync({ ...record("one"), pendingState: "unreflected" });
  assert.equal(store.retainedSyncs.length, 100);
});

test("pending updates validate state and removal refuses every linked live job state", () => {
  const store = new Store();
  store.upsertRetainedSync(record());
  store.updateRetainedPending("retained-1", "unreflected");
  assert.equal(store.retainedSyncs[0].pendingState, "unreflected");
  assert.throws(() => store.updateRetainedPending("retained-1", "caughtUp"));
  assert.throws(() => store.updateRetainedPending("absent", "unknown"));
  const job = runtime("job", "retained-1", profile());
  store.tabs.push(job);
  for (const status of ["running", "failed", "stopping"]) {
    job.status = status;
    assert.throws(() => store.removeRetainedSync("retained-1"));
    assert.equal(store.retainedSyncs.length, 1);
  }
  job.status = "stopped";
  assert.equal(store.removeRetainedSync("retained-1"), true);
  assert.equal(store.removeRetainedSync("retained-1"), false);
});

test("workspace close and stopped job replacement preserve retained entries and ID links", () => {
  const p = profile();
  const store = new Store({ profiles: [p] });
  store.upsertRetainedSync(record());
  const workspace = store.createWorkspace(p.id);
  store.connectWorkspace(workspace.id, p);
  store.attachJob(workspace.id, runtime("old", "retained-1", p));
  assert.equal(store.tabs[0].retainedId, "retained-1");
  store.attachJob(workspace.id, runtime("next", "retained-1", p));
  assert.equal(store.tabs.length, 1);
  assert.equal(store.tabs[0].id, "next");
  assert.equal(store.retainedSyncs.length, 1);
  store.closeWorkspace(workspace.id);
  assert.equal(store.tabs.length, 0);
  assert.equal(store.retainedSyncs.length, 1);
});

test("retained profile references block deletion until explicit removal", () => {
  const store = new Store({ profiles: [profile()] });
  store.upsertRetainedSync(record());
  store.saveProfile({ ...profile(), host: "changed.invalid" });
  assert.throws(() => store.deleteConnectionNode("generated"));
  assert.equal(store.profiles.length, 1);
  store.removeRetainedSync("retained-1");
  store.deleteConnectionNode("generated");
  assert.equal(store.profiles.length, 0);
});

test("retained profile snapshots preserve exact authentication strings and Unicode bounds match native", async () => {
  const { validateRetainedSync } = await model();
  const input = record();
  Object.assign(input.profile, {
    name: "  Display name  ",
    host: "  EXAMPLE.invalid  ",
    user: "  exact user  ",
    hostKey: "  SHA256:fixture  ",
    keyFile: "C:\\generated\\key with spaces.ppk",
  });
  const store = new Store();
  store.upsertRetainedSync(input);
  assert.deepEqual(store.retainedSyncs[0].profile, input.profile);
  assert.deepEqual(
    new Store(store.serialize()).retainedSyncs[0].profile,
    input.profile,
  );
  assert.throws(() =>
    validateRetainedSync({ ...record(), local: "C:\\" + "日".repeat(1400) }),
  );
  assert.throws(() =>
    validateRetainedSync({ ...record(), remote: "/" + "日".repeat(1400) }),
  );
  assert.throws(() =>
    validateRetainedSync({
      ...record(),
      profile: { ...profile(), host: "h".repeat(4096), user: "u".repeat(4096) },
    }),
  );
});

test("strict retained collections refuse numeric-looking extra keys without reading getters", async () => {
  const { validateRetainedSyncs } = await model();
  const collection = [record()];
  Object.defineProperty(collection, "01", {
    value: record("hidden"),
    enumerable: true,
  });
  assert.throws(() => validateRetainedSyncs(collection));
  const getter = [record()];
  Object.defineProperty(getter, "0", {
    get() {
      throw Error("collection getter executed");
    },
  });
  assert.throws(
    () => validateRetainedSyncs(getter),
    (error) => !error.message.includes("getter executed"),
  );
  const store = new Store();
  const input = record();
  Object.defineProperty(input.profile, "passphrase", {
    get() {
      throw Error("secret getter executed");
    },
    enumerable: true,
  });
  assert.doesNotThrow(() => store.upsertRetainedSync(input));
  assert.ok(!JSON.stringify(store.serialize()).includes("passphrase"));
});

test("retained runtime links reject unknown IDs and duplicate active use without deleting snapshots", () => {
  const p = profile();
  const store = new Store({ profiles: [p] });
  store.upsertRetainedSync(record());
  const first = store.createWorkspace(p.id);
  const second = store.createWorkspace(p.id);
  store.connectWorkspace(first.id, p);
  store.connectWorkspace(second.id, p);
  assert.throws(() =>
    store.attachJob(first.id, runtime("unknown", "absent", p)),
  );
  assert.equal(store.tabs.length, 0);
  const active = runtime("active", "retained-1", p);
  active.status = "running";
  store.attachJob(first.id, active);
  assert.throws(() =>
    store.attachJob(second.id, runtime("duplicate", "retained-1", p)),
  );
  assert.equal(store.tabs.length, 1);
  store.tabs[0].status = "stopped";
  store.tabs[0].busy = true;
  assert.throws(() => store.removeRetainedSync("retained-1"));
  assert.equal(store.retainedSyncs.length, 1);
});
