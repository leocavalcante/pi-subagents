import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const directory = mkdtempSync(join(tmpdir(), "pi-subagents-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const options = {
  encoding: "utf8",
  timeout: 180000,
  shell: process.platform === "win32",
};

try {
  const output = execFileSync(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    options,
  );
  const packages = JSON.parse(output);
  assert.equal(packages.length, 1, "npm pack must create one tarball");
  const packed = packages[0];
  const paths = packed.files.map((file) => file.path);
  const packedPaths = new Set(paths);

  const entrypoints = manifest.pi?.extensions;
  assert.deepEqual(entrypoints, ["./index.ts"]);
  assert(packedPaths.has("index.ts"), "The extension entry point must ship");
  assert(
    paths.includes("windows-supervisor.cs"),
    "The Windows supervisor must ship",
  );
  assert(
    !paths.some((path) => /^(?:tests|\.github|docs|node_modules)\//.test(path)),
    "Tests, workflows, docs, and installed dependencies must not ship",
  );

  // Walk the entry point's local imports and runtime assets against the tarball.
  const pending = ["index.ts"];
  const visited = new Set();
  const localReference =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  while (pending.length > 0) {
    const sourceFile = pending.pop();
    if (visited.has(sourceFile)) continue;
    visited.add(sourceFile);
    assert(
      packedPaths.has(sourceFile),
      `Entry-point dependency is missing from tarball: ${sourceFile}`,
    );
    assert(
      existsSync(sourceFile),
      `Missing local source dependency: ${sourceFile}`,
    );
    const source = readFileSync(sourceFile, "utf8");
    for (const [, specifier] of source.matchAll(localReference)) {
      const dependency = posix.normalize(
        posix.join(posix.dirname(sourceFile), specifier),
      );
      assert(
        dependency !== ".." && !dependency.startsWith("../"),
        `Local dependency escapes package root: ${specifier}`,
      );
      assert(
        packedPaths.has(dependency),
        `Entry-point dependency is missing from tarball: ${dependency} (referenced by ${sourceFile})`,
      );
      if (dependency.endsWith(".ts")) pending.push(dependency);
    }
  }

  const consumer = join(directory, "consumer");
  mkdirSync(consumer);
  const archive = join(directory, packed.filename);
  execFileSync(
    npm,
    [
      "install",
      "--prefix",
      consumer,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      archive,
      `jiti@${manifest.devDependencies.jiti}`,
      `@earendil-works/pi-coding-agent@${manifest.devDependencies["@earendil-works/pi-coding-agent"]}`,
    ],
    { ...options, stdio: "inherit" },
  );

  const installedManifest = JSON.parse(
    readFileSync(
      join(
        consumer,
        "node_modules",
        ...manifest.name.split("/"),
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(installedManifest.version, manifest.version);

  const smokeTest = join(consumer, "load.mjs");
  writeFileSync(
    smokeTest,
    `import assert from "node:assert/strict";
const loaded = await import(${JSON.stringify(`${manifest.name}/index.ts`)});
const register = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
assert.equal(typeof register, "function");
const tools = [];
const commands = [];
const events = [];
const messageRenderers = [];
register({
  registerTool: ({ name }) => tools.push(name),
  registerCommand: (name) => commands.push(name),
  registerMessageRenderer: (name) => messageRenderers.push(name),
  on: (event) => events.push(event),
});
assert.deepEqual(tools, ["subagent_agents", "subagent_jobs", "subagent"]);
assert.deepEqual(commands, []);
assert.deepEqual(messageRenderers, ["subagent-background"]);
assert.deepEqual(events, ["session_shutdown"]);
console.log("Packed extension loads under Node.js through jiti.");
`,
  );
  execFileSync(process.execPath, ["--import", "jiti/register", smokeTest], {
    ...options,
    cwd: consumer,
    stdio: "inherit",
  });
  console.log(
    `Validated ${packed.filename}: ${paths.length} allowlisted files.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
