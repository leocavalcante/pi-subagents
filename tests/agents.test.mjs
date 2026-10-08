import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { jiti } from './pi-runtime.mjs';

const { discoverAgents } = await jiti.import('../agents.ts');
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
