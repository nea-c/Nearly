import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {versionFiles, projectRoot} from '../scripts/version.mjs';
import {
  buildOptions,
  buildPaths,
  publishBuild,
} from "../scripts/build-windows.mjs";
const tempRoot =
  process.env.NEARLY_BUILD_TEST_TEMP ||
  fileURLToPath(
    new URL("../test-results/build-script-fixtures/", import.meta.url),
  );
await fs.mkdir(tempRoot, { recursive: true });

test("build options and external Cargo directories select the expected artifact", () => {
  const root = path.resolve("fixture-project");
  assert.deepEqual(buildOptions(["--offline", "--locked"], {}), {
    offline: true,
    target: undefined,
  });
  const options = buildOptions(["--target", "x86_64-pc-windows-msvc"], {});
  const dirs = buildPaths(root, options, {
    CARGO_TARGET_DIR: path.resolve("external-cache"),
  });
  assert.equal(
    dirs.artifact,
    path.join(
      path.resolve("external-cache"),
      options.target,
      "release",
      "Nearly.exe",
    ),
  );
  assert.equal(
    buildPaths(root, buildOptions([], {}), {}).artifact,
    path.join(root, "src-tauri", "target", "release", "Nearly.exe"),
  );
  assert.throws(() => buildOptions(["--debug"], {}));
  assert.throws(() => buildOptions(["--target"], {}));
});

test("publication preserves previous outputs and accepts an unchanged cached PE", async () => {
  const root = await fs.mkdtemp(path.join(tempRoot, "nearly-build-publish-"));
  const artifact = path.join(root, "cached.exe"),
    binary = Buffer.alloc(128);
  binary.write("MZ");
  binary.writeUInt32LE(64, 0x3c);
  binary.writeUInt32LE(0x4550, 64);
  await fs.writeFile(artifact, binary);
  await fs.utimes(artifact, new Date(0), new Date(0));
  await fs.mkdir(path.join(root, "build"));
  await fs.writeFile(
    path.join(root, "build", "Nearly.exe"),
    "prior executable",
  );
  await fs.writeFile(
    path.join(root, "build", "build-info.json"),
    "prior metadata",
  );
  const info = await publishBuild(root, artifact, {
    version: "fixture",
    identifier: "local.syncfiles.native",
  });
  assert.equal(info.artifactModifiedAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(
    await fs.readFile(path.join(root, "build", "Nearly.exe")),
    binary,
  );
  const backups = await fs.readdir(path.join(root, "build", "previous"));
  assert.equal(
    await fs.readFile(
      path.join(root, "build", "previous", backups[0], "Nearly.exe"),
      "utf8",
    ),
    "prior executable",
  );
  assert.equal(
    await fs.readFile(
      path.join(root, "build", "previous", backups[0], "build-info.json"),
      "utf8",
    ),
    "prior metadata",
  );
  await fs.writeFile(artifact, "not an executable");
  await assert.rejects(() =>
    publishBuild(root, artifact, { version: "fixture", identifier: "fixture" }),
  );
  assert.deepEqual(
    await fs.readFile(path.join(root, "build", "Nearly.exe")),
    binary,
  );
});

test(
  "failed CLI execution cannot publish an existing stale release artifact",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(tempRoot, "nearly-build-failure-"));
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.mkdir(path.join(root, "src-tauri", "target", "release"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "node_modules", "@tauri-apps", "cli"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "build"));
    await fs.copyFile(
      fileURLToPath(new URL("../scripts/build-windows.mjs", import.meta.url)),
      path.join(root, "scripts", "build-windows.mjs"),
    );
    await fs.mkdir(path.join(root, 'src'));
    await fs.copyFile(path.join(projectRoot, 'version.json'), path.join(root, 'version.json'));
    await fs.copyFile(path.join(projectRoot, 'scripts/version.mjs'), path.join(root, 'scripts/version.mjs'));
    for (const [name, content] of await versionFiles()) await fs.writeFile(path.join(root, name), content);
    await fs.writeFile(
      path.join(root, "src-tauri", "target", "release", "Nearly.exe"),
      "stale release",
    );
    await fs.writeFile(
      path.join(root, "build", "Nearly.exe"),
      "prior published",
    );
    await fs.writeFile(
      path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
      "require('node:fs').writeFileSync('cli-fixture.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),target:process.env.CARGO_TARGET_DIR})); process.exitCode = 7;",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "build-windows.mjs"), "--offline"],
      {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          CARGO_TARGET_DIR: path.join(root, "src-tauri", "target"),
          CARGO_BUILD_TARGET: "",
        },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Tauri build failed/);
    assert.equal(
      await fs.readFile(path.join(root, "build", "Nearly.exe"), "utf8"),
      "prior published",
    );
    assert.equal(
      await fs.readFile(
        path.join(root, "src-tauri", "target", "release", "Nearly.exe"),
        "utf8",
      ),
      "stale release",
    );
    const invocation = JSON.parse(
      await fs.readFile(path.join(root, "cli-fixture.json"), "utf8"),
    );
    assert.deepEqual(invocation.args, [
      "build",
      "--no-bundle",
      "--ci",
      "--",
      "--locked",
      "--offline",
    ]);
    assert.equal(invocation.cwd, root);
    assert.equal(invocation.target, path.join(root, "src-tauri", "target"));
  },
);

async function personalSettingsFixture(root) {
  const output = path.join(root, "build");
  await fs.mkdir(output, { recursive: true });
  const names = ["settings", "history", "bookmarks", "sync-profiles", "connections"].flatMap(name=>[name+".json",name+".backup.json"]);
  const originals = new Map();
  for (const name of names) {
    const file = path.join(output, name);
    const bytes = Buffer.from(JSON.stringify({ generatedFixtureOnly: true, name, privateSentinel: "NEVER-DISTRIBUTE-GENERATED-SETTINGS" }) + "\r\n");
    await fs.writeFile(file, bytes);
    await fs.utimes(file, new Date(1_000), new Date(1_000));
    originals.set(name, { bytes, mtime: (await fs.stat(file)).mtimeMs });
  }
  return async () => {
    for (const [name, original] of originals) {
      const file = path.join(output, name);
      assert.deepEqual(await fs.readFile(file), original.bytes, `${name} bytes stay untouched`);
      assert.equal((await fs.stat(file)).mtimeMs, original.mtime, `${name} is never rewritten or moved`);
    }
    // Only the explicit distribution pair may enter publication staging/backups.
    async function inspect(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await inspect(file);
        else {
          assert.ok(["Nearly.exe", "build-info.json"].includes(entry.name), `Unexpected published artifact: ${entry.name}`);
          assert.equal((await fs.readFile(file)).includes(Buffer.from("NEVER-DISTRIBUTE-GENERATED-SETTINGS")), false);
        }
      }
    }
    for (const entry of await fs.readdir(output, { withFileTypes: true }))
      if (entry.isDirectory() && (entry.name === "previous" || entry.name.startsWith(".staging-")))
        await inspect(path.join(output, entry.name));
    assert.equal((await fs.readFile(path.join(output, "build-info.json"))).includes(Buffer.from("NEVER-DISTRIBUTE-GENERATED-SETTINGS")), false);
  };
}
async function generatedPe(root) {
  const artifact = path.join(root, "generated-release.exe");
  const bytes = Buffer.alloc(128);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64);
  await fs.writeFile(artifact, bytes);
  return artifact;
}
const generatedBuildConfig = { version: "generated-fixture", identifier: "local.syncfiles.native" };

test("repeated publication never changes or distributes EXE-adjacent personal settings", async () => {
  const root = await fs.mkdtemp(path.join(tempRoot, "nearly-portable-settings-"));
  const check = await personalSettingsFixture(root);
  const artifact = await generatedPe(root);
  // Settings can coexist with the EXE before the first and every later build.
  await publishBuild(root, artifact, generatedBuildConfig);
  await check();
  await publishBuild(root, artifact, generatedBuildConfig);
  await check();
  const previous = await fs.readdir(path.join(root, "build", "previous"));
  assert.equal(previous.length, 1);
  assert.deepEqual((await fs.readdir(path.join(root, "build", "previous", previous[0]))).sort(), ["Nearly.exe", "build-info.json"]);
  await fs.writeFile(artifact, "invalid artifact");
  await assert.rejects(() => publishBuild(root, artifact, generatedBuildConfig));
  await check();
});

test("publication rollback preserves adjacent settings and stages only the distribution pair", async () => {
  const root = await fs.mkdtemp(path.join(tempRoot, "nearly-portable-rollback-"));
  const check = await personalSettingsFixture(root);
  const artifact = await generatedPe(root);
  await publishBuild(root, artifact, generatedBuildConfig);
  const oldExe = await fs.readFile(path.join(root, "build", "Nearly.exe"));
  const oldInfo = await fs.readFile(path.join(root, "build", "build-info.json"));
  const rename = fs.rename;
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && path.basename(from) === "build-info.json" && path.basename(path.dirname(from)).startsWith(".staging-") && to === path.join(root, "build", "build-info.json")) {
      failed = true;
      throw Error("Generated fixture publication failure");
    }
    return rename(from, to);
  };
  try { await assert.rejects(() => publishBuild(root, artifact, generatedBuildConfig), /Publishing failed/); }
  finally { fs.rename = rename; }
  assert.equal(failed, true);
  assert.deepEqual(await fs.readFile(path.join(root, "build", "Nearly.exe")), oldExe);
  assert.deepEqual(await fs.readFile(path.join(root, "build", "build-info.json")), oldInfo);
  await check();
});
