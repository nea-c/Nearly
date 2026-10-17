import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function buildOptions(args, env = process.env) {
  let offline = false,
    target = env.CARGO_BUILD_TARGET || undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offline") offline = true;
    else if (args[i] === "--locked") {
      /* Lockfile enforcement is always enabled. */
    } else if (args[i] === "--target") target = args[++i] || "";
    else throw Error(`Unknown build option: ${args[i]}`);
  }
  if (
    target !== undefined &&
    !/^(x86_64|aarch64|i686)-pc-windows-msvc$/.test(target)
  )
    throw Error("Use a supported Windows MSVC target triple");
  return { offline, target };
}

export function buildPaths(root, options, env = process.env) {
  const targetDir = path.resolve(
    root,
    env.CARGO_TARGET_DIR || "src-tauri/target",
  );
  return {
    targetDir,
    artifact: path.join(
      targetDir,
      ...(options.target ? [options.target] : []),
      "release",
      "Nearly.exe",
    ),
    output: path.join(root, "build"),
    cli: path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  };
}

const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

// A failed build never replaces previous deliverables. Successful publication
// moves every previous output into a unique backup directory without deleting it.
export async function publishBuild(root, artifact, config, target) {
  const binary = await fs.readFile(artifact);
  if (binary.length < 64 || binary[0] !== 0x4d || binary[1] !== 0x5a)
    throw Error(
      "Build output is missing or is not a nonempty Windows executable",
    );
  const pe = binary.readUInt32LE(0x3c);
  if (
    pe < 64 ||
    pe + 4 > binary.length ||
    binary.readUInt32LE(pe) !== 0x00004550
  )
    throw Error("Build output does not contain a valid PE signature");
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const output = path.join(root, "build");
  const stage = path.join(output, `.staging-${randomUUID()}`);
  const previous = path.join(output, "previous", `${stamp}-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, "Nearly.exe"), binary, { flag: "wx" });
  const info = {
    version: config.version,
    identifier: config.identifier,
    builtAt: new Date().toISOString(),
    artifactModifiedAt: (await fs.stat(artifact)).mtime.toISOString(),
    target: target || "host",
    bytes: binary.length,
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
  await fs.writeFile(
    path.join(stage, "build-info.json"),
    JSON.stringify(info, null, 2) + "\n",
    { flag: "wx" },
  );
  const names = ["Nearly.exe", "build-info.json"];
  const backed = [],
    installed = [];
  try {
    for (const name of names)
      if (await exists(path.join(output, name))) {
        await fs.mkdir(previous, { recursive: true });
        await fs.rename(path.join(output, name), path.join(previous, name));
        backed.push(name);
      }
    for (const name of names) {
      await fs.rename(path.join(stage, name), path.join(output, name));
      installed.push(name);
    }
  } catch (error) {
    // Preserve newly copied files as well, then restore the prior pair.
    for (const name of installed)
      await fs
        .rename(path.join(output, name), path.join(stage, name))
        .catch(() => {});
    for (const name of backed)
      if (!(await exists(path.join(output, name))))
        await fs
          .rename(path.join(previous, name), path.join(output, name))
          .catch(() => {});
    throw Error(
      `Publishing failed; prior output/backup is preserved: ${error.message}`,
    );
  }
  return info;
}

export async function runBuild(args = process.argv.slice(2)) {
  if (process.platform !== "win32")
    throw Error("Windows builds require a Windows host with MSVC tools");
  const options = buildOptions(args);
  const paths = buildPaths(projectRoot, options);
  const config = JSON.parse(
    await fs.readFile(
      path.join(projectRoot, "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  );
  if (
    config.identifier !== "local.syncfiles.native" ||
    config.mainBinaryName !== "Nearly"
  )
    throw Error(
      "Production app identity/main binary differs; refusing an ambiguous production build",
    );
  await fs.access(paths.cli);
  const cliArgs = [paths.cli, "build", "--no-bundle", "--ci"];
  if (options.target) cliArgs.push("--target", options.target);
  cliArgs.push("--", "--locked");
  if (options.offline) cliArgs.push("--offline");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: projectRoot,
      env: { ...process.env, CARGO_TARGET_DIR: paths.targetDir },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `Tauri build failed (${signal || code}); previous output is unchanged`,
            ),
          ),
    );
  });
  const info = await publishBuild(
    projectRoot,
    paths.artifact,
    config,
    options.target,
  );
  console.log(`Built build/Nearly.exe (${info.sha256})`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runBuild().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
