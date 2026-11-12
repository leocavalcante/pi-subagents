import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from './pi-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pi-subagents-nesting-test-')));
const traceFile = join(sandbox, 'trace.jsonl');
const depthName = 'PI_SUBAGENTS_NESTING_DEPTH';
const oldArgv = process.argv[1];
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldTrace = process.env.SUBAGENT_TEST_TRACE;
const oldDepth = process.env[depthName];
process.argv[1] = join(root, 'tests/fixtures/fake-pi.mjs');
process.env.PI_CODING_AGENT_DIR = join(sandbox, 'agent');
process.env.SUBAGENT_TEST_TRACE = traceFile;
delete process.env[depthName];
mkdirSync(join(sandbox, 'agent/agents'), { recursive: true });
writeFileSync(join(sandbox, 'agent/agents/worker.md'), '---\nname: worker\ndescription: Test worker\n---\nTest-only instructions.\n');

const ctx = () => ({ cwd: sandbox, mode: 'rpc', hasUI: false, isProjectTrusted: () => false,
  model: { provider: 'fake', id: 'parent' }, thinkingLevel: 'high' });
const traces = () => readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const shutdown = async extension => {
  for (const handler of extension.handlers.get('session_shutdown') ?? []) {
    await handler({ type: 'session_shutdown', reason: 'reload' }, ctx());
  }
};

after(() => {
  process.argv[1] = oldArgv;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldTrace === undefined) delete process.env.SUBAGENT_TEST_TRACE;
  else process.env.SUBAGENT_TEST_TRACE = oldTrace;
  if (oldDepth === undefined) delete process.env[depthName];
  else process.env[depthName] = oldDepth;
  rmSync(sandbox, { recursive: true, force: true });
});

test('nested delegation propagates depth and blocks process trees past the limit', async () => {
  writeFileSync(traceFile, '');
  const loaded = await loadExtensions([join(root, 'index.ts')], sandbox);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const invoke = (params) => extension.tools.get('subagent').definition.execute('nesting-test', params, undefined, undefined, ctx());
  try {
    const first = await invoke({ agent: 'worker', task: 'nesting-depth-one' });
    assert.notEqual(first.isError, true);
    assert.equal(traces().find(entry => entry.event === 'start' && entry.task === 'nesting-depth-one').nestingDepth, '1');

    process.env[depthName] = '1';
    const second = await invoke({ agent: 'worker', task: 'nesting-depth-two' });
    assert.notEqual(second.isError, true);
    assert.equal(traces().find(entry => entry.event === 'start' && entry.task === 'nesting-depth-two').nestingDepth, '2');

    const startsBeforeLimit = traces().filter(entry => entry.event === 'start').length;
    process.env[depthName] = '2';
    const blocked = await invoke({ agent: 'worker', task: 'nesting-depth-blocked' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /limited to 2 levels/);
    assert.equal(traces().filter(entry => entry.event === 'start').length, startsBeforeLimit);

    process.env[depthName] = 'invalid';
    const malformed = await invoke({ agent: 'worker', task: 'nesting-depth-invalid' });
    assert.equal(malformed.isError, true, 'Malformed inherited depth must fail closed');
    assert.equal(traces().filter(entry => entry.event === 'start').length, startsBeforeLimit);
  } finally {
    await shutdown(extension);
  }
});
