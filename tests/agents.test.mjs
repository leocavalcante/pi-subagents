import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { jiti } from './pi-runtime.mjs';

const { discoverAgents, MAX_AGENT_DESCRIPTION_BYTES, MAX_AGENT_TOOL_LIST_BYTES, MAX_AGENT_TOOL_COUNT, MAX_MODEL_SELECTOR_BYTES, MAX_TIMEOUT_MS } = await jiti.import('../agents.ts');
const sandbox = mkdtempSync(join(tmpdir(), 'pi-agents-test-'));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(sandbox, 'user');
const userDir = join(sandbox, 'user/agents');
const projectDir = join(sandbox, 'project/.pi/agents');
const cwd = join(sandbox, 'project/nested');
const agent = (dir, file, yaml) => writeFileSync(join(dir, `${file}.md`), `---\n${yaml}\n---\nInstructions for ${file}.\n`);

beforeEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  for (const dir of [userDir, projectDir, cwd]) mkdirSync(dir, { recursive: true });
});
after(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(sandbox, { recursive: true, force: true });
});

test('project agent symlinks to non-regular files are rejected without blocking', { skip: process.platform === 'win32' }, () => {
  const fifo = join(projectDir, 'agent-pipe');
  execFileSync('mkfifo', [fifo]);
  symlinkSync(fifo, join(projectDir, 'linked-pipe.md'));
  const script = `import { jiti } from ${JSON.stringify(new URL('./pi-runtime.mjs', import.meta.url).href)};\n` +
    `const { discoverAgents } = await jiti.import(${JSON.stringify(new URL('../agents.ts', import.meta.url).href)});\n` +
    `process.stdout.write(JSON.stringify(discoverAgents(process.env.AGENT_TEST_CWD, 'project')));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, PI_CODING_AGENT_DIR: join(sandbox, 'user'), AGENT_TEST_CWD: cwd },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.error, undefined, `Discovery child must finish: ${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.agents, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /regular file/);
});

test('oversized agent files are skipped without retaining or echoing prompt contents', () => {
  const secret = 'OVERSIZED_PRIVATE_AGENT_PROMPT';
  const prefix = `---\nname: oversized\ndescription: Too large\n---\n${secret}`;
  const content = prefix + 'x'.repeat(512 * 1024 + 1 - Buffer.byteLength(prefix));
  writeFileSync(join(projectDir, 'oversized.md'), content);

  const result = discoverAgents(cwd, 'project');
  assert.deepEqual(result.agents, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /512 KiB size limit/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('agent directory scanning is bounded even with many unrelated entries', () => {
  for (let i = 0; i < 4096; i++) writeFileSync(join(userDir, `ignored-${String(i).padStart(4, '0')}.txt`), '');
  agent(userDir, 'worker', 'name: worker\ndescription: Worker');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /4096-entry scan limit/);
});

test('agent file-count overflow fails closed before loading partial definitions', () => {
  for (let i = 0; i < 257; i++) {
    agent(userDir, `agent-${String(i).padStart(3, '0')}`, `name: worker-${i}\ndescription: Worker ${i}`);
  }

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents, []);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /256-definition limit/);
  assert.match(result.diagnostics[0].message, /no definitions .* loaded/);
});

test('agent directory content is capped in filename order', () => {
  const fileBytes = 512 * 1024;
  const count = 9;
  for (let i = 0; i < count; i++) {
    const prefix = `---\nname: worker-${i}\ndescription: Worker ${i}\n---\n`;
    const content = prefix + 'x'.repeat(fileBytes - Buffer.byteLength(prefix));
    writeFileSync(join(projectDir, `agent-${String(i).padStart(2, '0')}.md`), content);
  }

  const result = discoverAgents(cwd, 'project');
  assert.deepEqual(result.agents.map(a => a.name), Array.from({ length: 8 }, (_, i) => `worker-${i}`));
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /4 MiB content limit/);
  assert.ok(result.agents.every(a => Buffer.byteLength(a.systemPrompt) < fileBytes));
});

test('agent diagnostics are bounded with one omission notice', () => {
  for (let i = 0; i < 80; i++) writeFileSync(join(userDir, `bad-${String(i).padStart(2, '0')}.md`), '---\nname: [invalid\n---\n');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents, []);
  assert.equal(result.diagnostics.length, 64);
  assert.equal(result.diagnostics.at(-1).message, 'Further agent diagnostics omitted.');
});

test('agent descriptions are bounded by UTF-8 bytes and oversized values are not echoed', () => {
  const atLimit = 'x'.repeat(MAX_AGENT_DESCRIPTION_BYTES);
  const multibyteAtLimit = '😀'.repeat(MAX_AGENT_DESCRIPTION_BYTES / 4);
  const oversized = 'x'.repeat(MAX_AGENT_DESCRIPTION_BYTES + 1);
  const multibyteOversized = '€'.repeat(Math.floor(MAX_AGENT_DESCRIPTION_BYTES / 3) + 1);
  assert.equal(Buffer.byteLength(multibyteAtLimit, 'utf8'), MAX_AGENT_DESCRIPTION_BYTES);
  assert.ok(multibyteOversized.length < MAX_AGENT_DESCRIPTION_BYTES);
  assert.ok(Buffer.byteLength(multibyteOversized, 'utf8') > MAX_AGENT_DESCRIPTION_BYTES);
  agent(userDir, 'a-unicode-limit', `name: a-unicode-limit\ndescription: ${JSON.stringify(multibyteAtLimit)}`);
  agent(userDir, 'valid', `name: valid\ndescription: ${JSON.stringify(atLimit)}`);
  agent(userDir, 'oversized', `name: oversized\ndescription: ${JSON.stringify(oversized)}`);
  agent(userDir, 'multibyte', `name: multibyte\ndescription: ${JSON.stringify(multibyteOversized)}`);

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['a-unicode-limit', 'valid']);
  assert.equal(result.agents[0].description, multibyteAtLimit);
  assert.equal(result.agents[1].description, atLimit);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every(d => d.message ===
    `description must be well-formed Unicode and at most ${MAX_AGENT_DESCRIPTION_BYTES} UTF-8 bytes.`));
  assert.equal(JSON.stringify(result).includes(oversized), false);
  assert.equal(JSON.stringify(result).includes(multibyteOversized), false);
});

test('agent names reject oversized UTF-8 and terminal or bidirectional controls', () => {
  agent(userDir, 'oversized-name', `name: "${'€'.repeat(86)}"\ndescription: Too many UTF-8 bytes`);
  agent(userDir, 'terminal-control', 'name: "bad\\u001b[31mname"\ndescription: Terminal control');
  agent(userDir, 'c1-control', 'name: "bad\\u009bname"\ndescription: C1 terminal control');
  agent(userDir, 'line-control', 'name: "bad\\nname"\ndescription: Newline');
  agent(userDir, 'bidi-control', 'name: "bad\\u202ename"\ndescription: Bidirectional control');
  agent(userDir, 'valid-unicode', 'name: café\ndescription: Valid Unicode name');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['café']);
  assert.equal(result.diagnostics.length, 5);
  assert.ok(result.diagnostics.every(d => d.message === 'name must be well-formed Unicode, at most 256 UTF-8 bytes, and contain no control or bidirectional formatting characters.'));
});

test('malformed YAML and invalid definitions do not break discovery', () => {
  agent(userDir, 'bad-yaml', 'name: [unterminated');
  agent(userDir, 'scalar', 'just a scalar');
  agent(userDir, 'blank-name', 'name: "  "\ndescription: Blank');
  agent(userDir, 'bad-tools', 'name: unsafe\ndescription: Invalid allowlist\ntools: [read, 42]');
  agent(userDir, 'bad-thinking', 'name: wrong\ndescription: Invalid thinking\nthinking: extreme');
  agent(userDir, 'good', 'name: worker\ndescription: Valid worker');
  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['worker']);
  assert.equal(result.diagnostics.length, 5);
  assert.ok(result.diagnostics.every(d => d.source === 'user' && d.filePath && d.message));
});

test('agent definitions with invalid UTF-8 are rejected without exposing prompt bytes', () => {
  const privatePrompt = 'PRIVATE_INVALID_UTF8_PROMPT';
  writeFileSync(join(userDir, 'bad-utf8.md'), Buffer.concat([
    Buffer.from(`---\nname: bad-utf8\ndescription: Invalid encoding\n---\n${privatePrompt}`),
    Buffer.from([0xc3, 0x28]),
  ]));
  agent(userDir, 'valid', 'name: worker\ndescription: Valid worker');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['worker']);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].message, 'Agent definition is not valid UTF-8.');
  assert.equal(JSON.stringify(result).includes(privatePrompt), false);
  assert.equal(JSON.stringify(result).includes('�'), false);
});

test('agent metadata rejects YAML escapes that decode to unpaired surrogates', () => {
  agent(userDir, 'bad-name-surrogate', 'name: "\\uD800"\ndescription: Invalid name');
  agent(userDir, 'bad-description-surrogate', 'name: bad-description\ndescription: "\\uD800"');
  agent(userDir, 'bad-model-surrogate', 'name: bad-model\ndescription: Invalid model\nmodel: "\\uD800"');
  agent(userDir, 'bad-tools-surrogate', 'name: bad-tools\ndescription: Invalid tools\ntools: ["\\uD800"]');
  agent(userDir, 'valid', 'name: worker\ndescription: Valid worker');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['worker']);
  assert.equal(result.diagnostics.length, 4);
  assert.ok(result.diagnostics.some(d => d.message.startsWith('name must be well-formed Unicode')));
  assert.ok(result.diagnostics.some(d => d.message.startsWith('description must be well-formed Unicode')));
  assert.ok(result.diagnostics.some(d => d.message.startsWith('model must be well-formed Unicode')));
  assert.ok(result.diagnostics.some(d => d.message === 'tools entries must contain well-formed Unicode.'));
  assert.equal(JSON.stringify(result).includes('\\ud800'), false);
});

test('agent filename precedence and name ordering are locale-independent', () => {
  agent(userDir, 'a', 'name: worker\ndescription: Dot filename');
  agent(userDir, 'a_', 'name: worker\ndescription: Underscore filename');
  agent(userDir, 'a-agent', 'name: a\ndescription: A');
  agent(userDir, 'aa-agent', 'name: aa\ndescription: AA');
  agent(userDir, 'z-agent', 'name: z\ndescription: Z');
  agent(userDir, 'accented-agent', 'name: á\ndescription: Accented');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['a', 'aa', 'worker', 'z', 'á']);
  assert.equal(result.agents.find(a => a.name === 'worker').description, 'Underscore filename');
});

test('model selectors are byte-bounded before becoming child arguments', () => {
  const atLimit = 'x'.repeat(MAX_MODEL_SELECTOR_BYTES);
  agent(userDir, 'valid-model', `name: valid\ndescription: Valid model\nmodel: "${atLimit}"`);
  agent(userDir, 'oversized-model', `name: oversized\ndescription: Oversized model\nmodel: "${'x'.repeat(MAX_MODEL_SELECTOR_BYTES + 1)}"`);
  agent(userDir, 'multibyte-model', `name: multibyte\ndescription: Oversized UTF-8 model\nmodel: "${'€'.repeat(Math.ceil(MAX_MODEL_SELECTOR_BYTES / 3))}"`);
  agent(userDir, 'control-model', 'name: control\ndescription: Control character model\nmodel: "fake\\u001b/model"');

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['valid']);
  assert.equal(result.agents[0].model, atLimit);
  assert.equal(result.diagnostics.length, 3);
  assert.ok(result.diagnostics.every(d => d.message ===
    `model must be well-formed Unicode, at most ${MAX_MODEL_SELECTOR_BYTES} UTF-8 bytes, and contain no control characters.`));
  assert.equal(JSON.stringify(result).includes('x'.repeat(MAX_MODEL_SELECTOR_BYTES + 1)), false);
});

test('agent tool allowlists reject ambiguous names and modifiers and are bounded before becoming a child argument', () => {
  const atLimit = 'x'.repeat(MAX_AGENT_TOOL_LIST_BYTES);
  const commaTool = 'read,bash';
  const nulTool = `read${String.fromCharCode(0)}bash`;
  const escapeTool = `read${String.fromCharCode(27)}bash`;
  const addModifier = '+private-tool';
  const removeModifier = '-bash';
  agent(userDir, 'valid-array-tools', `name: valid-array-tools\ndescription: Separate array entries\ntools: ${JSON.stringify(['read', 'bash'])}`);
  agent(userDir, 'valid-tools', `name: valid-tools\ndescription: At-limit tool argument\ntools: ["${atLimit}"]`);
  agent(userDir, 'oversized-tools', `name: oversized-tools\ndescription: Oversized tool argument\ntools: ["${'x'.repeat(MAX_AGENT_TOOL_LIST_BYTES + 1)}"]`);
  agent(userDir, 'multibyte-tools', `name: multibyte-tools\ndescription: Oversized UTF-8 tool argument\ntools: ["${'€'.repeat(Math.ceil(MAX_AGENT_TOOL_LIST_BYTES / 3))}"]`);
  agent(userDir, 'oversized-list-string', `name: oversized-list-string\ndescription: Oversized comma-separated list\ntools: "${'x'.repeat(MAX_AGENT_TOOL_LIST_BYTES + 1)}"`);
  agent(userDir, 'multibyte-list-string', `name: multibyte-list-string\ndescription: Oversized UTF-8 comma-separated list\ntools: "${'€'.repeat(Math.ceil(MAX_AGENT_TOOL_LIST_BYTES / 3))}"`);
  agent(userDir, 'many-tools', `name: many-tools\ndescription: Too many tool names\ntools: ${JSON.stringify(Array.from({ length: MAX_AGENT_TOOL_COUNT + 1 }, (_, i) => `tool-${i}`))}`);
  agent(userDir, 'comma-array', `name: comma-array\ndescription: Ambiguous comma tool\ntools: ${JSON.stringify([commaTool])}`);
  agent(userDir, 'nul-array', `name: nul-array\ndescription: NUL tool\ntools: ${JSON.stringify([nulTool])}`);
  agent(userDir, 'escape-array', `name: escape-array\ndescription: Control tool\ntools: ${JSON.stringify([escapeTool])}`);
  agent(userDir, 'add-modifier', `name: add-modifier\ndescription: Modifier entry\ntools: ${JSON.stringify([addModifier])}`);
  agent(userDir, 'remove-modifier', `name: remove-modifier\ndescription: Modifier entry\ntools: ${JSON.stringify([removeModifier])}`);

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(a => a.name), ['valid-array-tools', 'valid-tools']);
  assert.deepEqual(result.agents[0].tools, ['read', 'bash']);
  assert.deepEqual(result.agents[1].tools, [atLimit]);
  assert.equal(result.diagnostics.length, 10);
  assert.ok(result.diagnostics.every(d => /tools/.test(d.message)));
  assert.equal(JSON.stringify(result).includes('x'.repeat(MAX_AGENT_TOOL_LIST_BYTES + 1)), false);
  assert.equal(JSON.stringify(result).includes(commaTool), false);
  assert.equal(JSON.stringify(result).includes(nulTool), false);
  assert.equal(JSON.stringify(result).includes(escapeTool), false);
  assert.equal(JSON.stringify(result).includes(addModifier), false);
  assert.equal(JSON.stringify(result).includes(removeModifier), false);
  assert.equal(result.diagnostics.filter(d => d.message ===
    "tools entries must not contain commas, control characters, or start with '+' or '-'.").length, 5);
});

test('agent runtime timeout defaults are integer-bounded and invalid definitions fail closed', () => {
  agent(userDir, 'minimum-timeout', `name: minimum-timeout\ndescription: Minimum timeout\ntimeoutMs: 1`);
  agent(userDir, 'maximum-timeout', `name: maximum-timeout\ndescription: Maximum timeout\ntimeoutMs: ${MAX_TIMEOUT_MS}`);
  const invalid = [
    ['zero', '0'], ['negative', '-1'], ['fraction', '1.5'], ['over-limit', String(MAX_TIMEOUT_MS + 1)],
    ['string', '"100"'], ['boolean', 'true'], ['null', 'null'], ['object', '{ value: 100 }'], ['array', '[100]'],
  ];
  for (const [name, value] of invalid) {
    agent(userDir, `timeout-${name}`, `name: timeout-${name}\ndescription: Invalid timeout\ntimeoutMs: ${value}`);
  }

  const result = discoverAgents(cwd, 'user');
  assert.deepEqual(result.agents.map(entry => [entry.name, entry.timeoutMs]), [
    ['maximum-timeout', MAX_TIMEOUT_MS], ['minimum-timeout', 1],
  ]);
  assert.equal(result.diagnostics.length, invalid.length);
  assert.ok(result.diagnostics.every(diagnostic =>
    diagnostic.message === `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`));
  assert.equal(JSON.stringify(result).includes('Invalid timeout'), false);
});

test('normalizes config, preserves explicit empty tools, and supports thinking', () => {
  agent(userDir, 'z', 'name: " z "\ndescription: " Worker Z "\nmodel: "  "\ntools: []\nthinking: off');
  agent(userDir, 'a', 'name: a\ndescription: Worker A\ntools: "read, bash,read, "\nmodel: " fake/model "\nthinking: max');
  agent(userDir, 'b', 'name: b\ndescription: Worker B');
  const { agents, diagnostics } = discoverAgents(cwd, 'user');
  assert.deepEqual(agents.map(a => a.name), ['a', 'b', 'z']);
  assert.deepEqual(agents[0].tools, ['read', 'bash']);
  assert.equal(agents[0].model, 'fake/model');
  assert.equal(agents[0].thinking, 'max');
  assert.equal(agents[1].tools, undefined);
  assert.deepEqual(agents[2].tools, []);
  assert.equal(agents[2].thinking, 'off');
  assert.equal(agents[2].model, undefined);
  assert.equal(agents[2].description, 'Worker Z');
  assert.deepEqual(diagnostics, []);
});

test('duplicate names within a directory report both paths without changing precedence', () => {
  agent(userDir, 'a-worker', 'name: worker\ndescription: First');
  agent(userDir, 'z-worker', 'name: " worker "\ndescription: Last');
  const result = discoverAgents(cwd, 'user');
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].description, 'Last');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].filePath, join(userDir, 'z-worker.md'));
  assert.match(result.diagnostics[0].message, /Duplicate/);
  assert.ok(result.diagnostics[0].message.includes(join(userDir, 'a-worker.md')));
  assert.equal(result.diagnostics[0].message.includes('Instructions'), false);
});

test('malformed duplicates do not override valid definitions and cross-scope overrides are intentional', () => {
  agent(userDir, 'a-worker', 'name: worker\ndescription: Personal');
  agent(userDir, 'z-invalid', 'name: worker\ndescription: Invalid\ntools: [42]');
  agent(projectDir, 'worker', 'name: worker\ndescription: Project');
  const result = discoverAgents(cwd, 'both');
  assert.equal(result.agents[0].description, 'Project');
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /tools/);
  assert.equal(discoverAgents(cwd, 'user').agents[0].description, 'Personal');
});

test('scope and project precedence work from nested or relative directories', () => {
  agent(userDir, 'worker', 'name: worker\ndescription: Personal');
  agent(projectDir, 'worker', 'name: worker\ndescription: Project');
  agent(projectDir, 'reviewer', 'name: reviewer\ndescription: Review');
  assert.equal(discoverAgents(cwd, 'user').agents[0].source, 'user');
  const both = discoverAgents(relative(process.cwd(), cwd), 'both');
  assert.deepEqual(both.agents.map(a => a.name), ['reviewer', 'worker']);
  assert.equal(both.agents[1].source, 'project');
  assert.equal(both.projectAgentsDir, projectDir);
  assert.ok(discoverAgents(cwd, 'project').agents.every(a => a.source === 'project'));
});

test('project agent file symlinks stay within the project trust boundary', t => {
  const internal = join(sandbox, 'project/shared-agent.md');
  const external = join(sandbox, 'external-agent.md');
  writeFileSync(internal, '---\nname: internal\ndescription: In-project shared agent\n---\nInternal prompt.\n');
  writeFileSync(external, '---\nname: escaped\ndescription: Outside project\n---\nExternal prompt.\n');
  try {
    symlinkSync(internal, join(projectDir, 'linked-internal.md'));
    symlinkSync(external, join(projectDir, 'linked-external.md'));
  } catch (error) {
    // Creating file symlinks on Windows requires Developer Mode or the
    // SeCreateSymbolicLinkPrivilege right. Keep the rest of the suite usable
    // when neither is available, but do not hide unrelated setup failures.
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('File symlink creation is unavailable; enable Developer Mode or grant symlink privilege to run this boundary test.');
      return;
    }
    throw error;
  }

  const result = discoverAgents(cwd, 'project');
  assert.deepEqual(result.agents.map(a => a.name), ['internal']);
  assert.equal(result.agents[0].filePath, join(projectDir, 'linked-internal.md'));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].filePath, join(projectDir, 'linked-external.md'));
  assert.match(result.diagnostics[0].message, /outside the project root/i);
});

test('project agent reads reject directory swaps during path revalidation and open', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-agent-race-'));
  const makeCase = name => {
    const projectRoot = join(root, name);
    const projectDir = join(projectRoot, '.pi/agents');
    const cwd = join(projectRoot, 'nested');
    const outsideDir = join(root, `${name}-outside`);
    const savedProjectDir = join(projectRoot, '.pi/agents-saved');
    const baseName = `race-${name}`;
    const fileName = `${baseName}.md`;
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outsideDir);
    agent(projectDir, baseName, 'name: in-project\ndescription: In project');
    agent(outsideDir, baseName, 'name: outside\ndescription: Outside project');
    return { projectDir, cwd, outsideDir, savedProjectDir, filePath: join(projectDir, fileName), fileName };
  };
  const revalidationCase = makeCase('revalidation');
  const openCase = makeCase('open');
  const cases = { revalidation: revalidationCase, open: openCase };
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { jiti } from ${JSON.stringify(new URL('./pi-runtime.mjs', import.meta.url).href)};
    const cases = ${JSON.stringify(cases)};
    let revalidationSwap = false;
    let openSwap = false;
    const originalRealpathSync = fs.realpathSync;
    const originalOpenSync = fs.openSync;
    const movedDirectories = new Set();
    const replaceDirectory = item => {
      fs.renameSync(item.projectDir, item.savedProjectDir);
      movedDirectories.add(item);
      fs.symlinkSync(item.outsideDir, item.projectDir, process.platform === 'win32' ? 'junction' : 'dir');
    };
    const restoreDirectory = item => {
      if (!movedDirectories.has(item)) return;
      fs.rmSync(item.projectDir, { recursive: true, force: true });
      fs.renameSync(item.savedProjectDir, item.projectDir);
    };
    fs.realpathSync = function (path, ...options) {
      const resolved = originalRealpathSync.call(fs, path, ...options);
      if (!revalidationSwap && path === cases.revalidation.filePath) {
        replaceDirectory(cases.revalidation);
        revalidationSwap = true;
      }
      return resolved;
    };
    fs.openSync = function (path, ...options) {
      if (!openSwap && typeof path === 'string' && path.toLowerCase().endsWith(cases.open.fileName.toLowerCase())) {
        replaceDirectory(cases.open);
        openSwap = true;
      }
      return originalOpenSync.call(fs, path, ...options);
    };
    syncBuiltinESMExports();
    let output;
    try {
      const { discoverAgents } = await jiti.import(${JSON.stringify(new URL('../agents.ts', import.meta.url).href)});
      const revalidationResult = discoverAgents(cases.revalidation.cwd, 'project');
      const openResult = discoverAgents(cases.open.cwd, 'project');
      output = JSON.stringify({ revalidationSwap, openSwap, revalidationResult, openResult });
    } finally {
      fs.realpathSync = originalRealpathSync;
      fs.openSync = originalOpenSync;
      syncBuiltinESMExports();
      restoreDirectory(cases.revalidation);
      restoreDirectory(cases.open);
    }
    process.stdout.write(output);
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(child.error, undefined, `Race fixture child must finish: ${child.error?.message}`);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.revalidationSwap, true);
    assert.equal(result.openSwap, true);
    assert.deepEqual(result.revalidationResult.agents, []);
    assert.equal(result.revalidationResult.diagnostics.length, 1);
    assert.match(result.revalidationResult.diagnostics[0].message, /outside the project root/i);
    assert.deepEqual(result.openResult.agents, []);
    assert.equal(result.openResult.diagnostics.length, 1);
    assert.match(result.openResult.diagnostics[0].message, /changed while opening/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project agents directories that resolve outside the project are ignored', () => {
  const externalDir = join(sandbox, 'external-agents');
  mkdirSync(externalDir);
  agent(externalDir, 'escaped', 'name: escaped\ndescription: Outside project');
  rmSync(projectDir, { recursive: true, force: true });
  symlinkSync(externalDir, projectDir, process.platform === 'win32' ? 'junction' : 'dir');

  const result = discoverAgents(cwd, 'project');
  assert.deepEqual(result.agents, []);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].filePath, projectDir);
  assert.match(result.diagnostics[0].message, /outside the project root/i);
});
