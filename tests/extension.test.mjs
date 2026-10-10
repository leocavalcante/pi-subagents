import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { jiti, loadExtensions } from './pi-runtime.mjs';
import { Value } from 'typebox/value';
import { initTheme } from '@earendil-works/pi-coding-agent';

const { MAX_CHILD_JSON_RECORDS, MAX_CHILD_STDOUT_BYTES } = await jiti.import('../capture.ts');
const { DEFAULT_PROGRESS_UPDATE_INTERVAL_MS } = await jiti.import('../progress.ts');
const { MAX_AGENT_DESCRIPTION_BYTES, MAX_AGENT_TOOL_LIST_BYTES, MAX_MODEL_SELECTOR_BYTES, MAX_TIMEOUT_MS } = await jiti.import('../agents.ts');
const { MAX_PENDING_JOB_WAITS } = await jiti.import('../jobs.ts');
const MAX_WORKING_DIRECTORY_LENGTH = 32_767;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandbox = mkdtempSync(join(tmpdir(), 'pi-subagents-test-'));
const traceFile = join(sandbox, 'trace.jsonl');
const oldArgv = process.argv[1];
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.argv[1] = join(root, 'tests/fixtures/fake-pi.mjs');
process.env.PI_CODING_AGENT_DIR = join(sandbox, 'agent');
process.env.SUBAGENT_TEST_TRACE = traceFile;
mkdirSync(join(sandbox, 'agent/agents'), { recursive: true });
writeFileSync(join(sandbox, 'agent/agents/worker.md'), '---\nname: worker\ndescription: Test worker\n---\nTest-only instructions.\n');
writeFileSync(join(sandbox, 'agent/agents/pinned.md'), '---\nname: pinned\ndescription: Pinned worker\nmodel: fake/pinned:high\ntools: [read, bash]\n---\nPinned instructions.\n');
mkdirSync(join(sandbox, 'project/.pi/agents'), { recursive: true });
writeFileSync(join(sandbox, 'project/.pi/agents/project.md'), '---\nname: project\ndescription: Project worker\n---\nProject instructions.\n');

let extension, tools, messages;
const ctx = () => ({ cwd: sandbox, mode: 'rpc', hasUI: false, isProjectTrusted: () => false, model: { provider: 'fake', id: 'parent' }, thinkingLevel: 'high' });
const invoke = (name, params, context = ctx(), signal) => tools.get(name).definition.execute('test-call', params, signal, undefined, context);
const launch = async params => (await invoke('subagent', { background: true, agent: 'worker', task: 'delay=150', ...params })).details.background.id;
const status = async id => (await invoke('subagent_jobs', { action: 'status', jobId: id })).details;
const traces = () => readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const waitFor = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await sleep(10); }
  throw new Error('Timed out waiting for test condition');
};
const finish = (id, timeoutMs = 15000) => waitFor(async () => { const job = await status(id); return job.finishedAt ? job : undefined; }, timeoutMs);
const noisyTasks = prefix => {
  const task = `${prefix}${'x'.repeat(1_300_000)}`;
  return Array.from({ length: 8 }, () => ({ agent: 'worker', task }));
};
const shutdown = async () => {
  for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'reload' }, ctx());
};

beforeEach(async () => {
  writeFileSync(traceFile, '');
  messages = [];
  const loaded = await loadExtensions([join(root, 'index.ts')], sandbox);
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.sendMessage = (message, options) => messages.push({ message, options });
  extension = loaded.extensions[0];
  tools = extension.tools;
});
afterEach(async () => {
  await shutdown();
  for (const entry of traces()) if (entry.promptFile) assert.equal(existsSync(entry.promptFile), false, 'Temporary prompts must be removed');
});
after(() => {
  process.argv[1] = oldArgv;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  delete process.env.SUBAGENT_TEST_TRACE;
  rmSync(sandbox, { recursive: true, force: true });
});

test('background returns before completion, retains progress, and sends a follow-up', async () => {
  const started = Date.now();
  const id = await launch({ task: 'delay=400 main' });
  assert.ok(Date.now() - started < 300);
  assert.equal((await status(id)).state, 'running');
  assert.equal(messages.length, 0);
  // The first Windows launch lazily compiles the supervisor before Pi can emit progress.
  const firstUpdate = await waitFor(async () => {
    const job = await status(id);
    return job.latest ? { latest: job.latest } : job.finishedAt ? { finished: job } : undefined;
  }, process.platform === 'win32' ? 60_000 : 15_000);
  assert.ok(firstUpdate.latest, `Background job finished before progress: ${firstUpdate.finished?.state ?? 'unknown'}${firstUpdate.finished?.error ? ` (${firstUpdate.finished.error})` : ''}`);
  assert.match(firstUpdate.latest.content[0].text, /progress/);
  const result = await finish(id);
  assert.equal(result.state, 'completed');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /result: delay=400 main/);
  assert.deepEqual(messages[0].options, { deliverAs: 'followUp', triggerTurn: true });
  const child = traces().find(t => t.event === 'start');
  assert.equal(child.model, 'fake/parent');
  assert.equal(child.thinking, 'high');
});

test('foreground cancellation preserves an explicit null abort reason and releases its slot', async () => {
  const controller = new AbortController();
  const pending = invoke('subagent', { agent: 'worker', task: 'delay=10000 null-abort-reason' }, ctx(), controller.signal).then(
    () => ({ resolved: true }),
    reason => ({ reason }),
  );
  await waitFor(() => traces().some(entry => entry.event === 'start' && entry.task === 'delay=10000 null-abort-reason'));
  controller.abort(null);
  assert.deepEqual(await pending, { reason: null });
  const next = await invoke('subagent', { agent: 'worker', task: 'after null abort reason' });
  assert.notEqual(next.isError, true, 'Child process slot must be released after cancellation');
});

test('progress bursts are throttled without dropping captured or final results', async () => {
  const count = 2000;
  let updates = 0;
  const started = performance.now();
  const foreground = await tools.get('subagent').definition.execute(
    'progress-burst-test', { agent: 'worker', task: 'progress-burst:' + count }, undefined,
    () => { updates++; }, ctx(),
  );
  const elapsed = performance.now() - started;
  assert.equal(foreground.isError, undefined);
  assert.ok(updates >= 1, 'the first progress notification is immediate');
  assert.ok(updates <= Math.ceil(elapsed / DEFAULT_PROGRESS_UPDATE_INTERVAL_MS) + 2,
    `Progress updates (${updates}) exceeded the configured cadence over ${elapsed.toFixed(1)} ms`);
  const captured = foreground.details.results[0];
  assert.equal(captured.usage.turns, count, 'all child events are still accounted for');
  assert.equal(captured.messages.at(-1).content[0].text, 'burst ' + (count - 1));
  assert.equal(captured.capture.messagesDropped, count - 128, 'history capture remains independent of progress notifications');

  const id = await launch({ task: 'progress-burst:300' });
  const job = await finish(id);
  assert.equal(job.state, 'completed');
  assert.equal(job.latest.details.results[0].usage.turns, 300, 'background jobs retain the complete final result');
  assert.match(messages.at(-1).message.content, /burst 299/);
});

test('progress callback failures do not interrupt child capture or cleanup', async () => {
  const cases = [
    { name: 'single', params: { agent: 'worker', task: 'progress callback single' }, results: 1 },
    { name: 'parallel', params: { concurrency: 1, tasks: [
      { agent: 'worker', task: 'progress callback parallel one' },
      { agent: 'worker', task: 'progress callback parallel two' },
    ] }, results: 2 },
    { name: 'chain', params: { chain: [
      { agent: 'worker', task: 'progress callback chain one' },
      { agent: 'worker', task: 'progress callback chain two {previous}' },
    ] }, results: 2 },
  ];

  for (const scenario of cases) {
    let updates = 0;
    const result = await tools.get('subagent').definition.execute(
      'throwing-progress-test', scenario.params, undefined,
      () => { updates++; throw new Error('progress renderer failed'); }, ctx(),
    );
    assert.equal(updates, 1, `${scenario.name} progress should be disabled after its first callback failure`);
    assert.notEqual(result.isError, true, `${scenario.name} task results should still be returned`);
    assert.equal(result.details.results.length, scenario.results);
    assert.ok(result.details.results.every(task => task.exitCode === 0), `${scenario.name} child processes should finish normally`);
    const childTasks = traces().filter(entry => entry.event === 'start' && entry.task.includes(`progress callback ${scenario.name}`));
    assert.equal(childTasks.length, scenario.results);
    assert.ok(childTasks.every(child => traces().some(entry => entry.event === 'end' && entry.pid === child.pid)),
      `${scenario.name} child cleanup should finish despite the failed callback`);
  }
});

test('background completion rendering escapes terminal controls without changing follow-up content', async () => {
  const id = await launch({ task: 'terminal-control-text' });
  await finish(id);
  assert.equal(messages.length, 1);

  const followUp = messages[0].message;
  const hostile = `terminal ${String.fromCharCode(27)}]52;c;pi-subagents-test${String.fromCharCode(7)} ${String.fromCharCode(27)}[2J${String.fromCharCode(0x9b)}2J\nnext line`;
  assert.ok(followUp.content.includes(hostile), 'the model-facing follow-up keeps the original child output');
  assert.equal(followUp.details.latest.details.results[0].messages.at(-1).content[0].text, hostile,
    'structured child output remains unchanged');

  const renderer = extension.messageRenderers.get('subagent-background');
  assert.equal(typeof renderer, 'function');
  initTheme('dark', false);
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
  const rendered = renderer(followUp, { expanded: false, outputPad: 1 }, theme).render(100).join('\n');
  assert.equal(rendered.includes(`${String.fromCharCode(27)}]52;`), false, 'child OSC sequences must not reach the terminal');
  assert.equal(rendered.includes(`${String.fromCharCode(27)}[2J`), false, 'child CSI sequences must not reach the terminal');
  assert.equal(rendered.includes(String.fromCharCode(7)), false, 'child BEL controls must not reach the terminal');
  assert.equal(rendered.includes(String.fromCharCode(0x9b)), false, 'C1 controls must not reach the terminal');
  assert.ok(rendered.includes('\\u001b]52;c;pi-subagents-test\\u0007'));
  assert.ok(rendered.includes('\\u009b2J'));
  assert.ok(rendered.includes('next line'));
});

test('silent background jobs work across modes and expose the notification policy', async () => {
  for (const params of [
    { agent: 'worker', task: 'silent single' },
    { tasks: [{ agent: 'worker', task: 'silent parallel' }, { agent: 'worker', task: 'fail' }] },
    { chain: [{ agent: 'worker', task: 'silent chain' }, { agent: 'worker', task: 'next {previous}' }] },
  ]) {
    const launched = await invoke('subagent', { ...params, background: true, notify: false });
    assert.equal(launched.details.background.notify, false);
    assert.match(launched.content[0].text, /No automatic completion/);
    const id = launched.details.background.id;
    const waited = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
    assert.equal(waited.structuredContent.job.notify, false);
    assert.equal(waited.structuredContent.timedOut, false);
    assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, waited.structuredContent), true);
    const output = await invoke('subagent_jobs', { action: 'output', jobId: id });
    assert.notEqual(output.isError, true);
    const listed = await invoke('subagent_jobs', { action: 'list' });
    assert.equal(listed.structuredContent.jobs.find(job => job.id === id).notify, false);
    assert.match(listed.content[0].text, /silent/);
  }
  assert.equal(messages.length, 0);
  await finish(await launch({ task: 'explicit normal notification', notify: true }));
  assert.equal(messages.length, 1);
});

test('silent job waits, cancellations and evictions do not promise a completion message', async () => {
  const id = await launch({ task: 'delay=10000 silent cancel', notify: false });
  const timed = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 1 });
  assert.equal(timed.structuredContent.timedOut, true);
  assert.doesNotMatch(timed.content[0].text, /arrive automatically/);
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  const canceled = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
  assert.equal(canceled.structuredContent.job.state, 'canceled');
  assert.equal(messages.length, 0);
  const heavy = await invoke('subagent', { background: true, notify: false, tasks: noisyTasks('retention-registry-heavy:') });
  const heavyId = heavy.details.background.id;
  const evicted = await invoke('subagent_jobs', { action: 'wait', jobId: heavyId, timeoutMs: 30000 });
  assert.equal(evicted.structuredContent.timedOut, false);
  assert.equal(evicted.structuredContent.job.state, 'completed');
  assert.equal(evicted.structuredContent.job.outputEvicted, true);
  assert.deepEqual(evicted.structuredContent.job.usage, {
    input: 40, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 80,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }, 'Compact usage observation should remain after captured output eviction');
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, evicted.structuredContent), true);
  assert.match(evicted.content[0].text, /Silent jobs do not deliver completion messages/);
  const page = await invoke('subagent_jobs', { action: 'output', jobId: heavyId });
  assert.equal(page.isError, true);
  assert.doesNotMatch(page.content[0].text, /See the completion message/);
  assert.equal(messages.length, 0);
});

test('background usage overflow clears partial metadata even after output eviction', async () => {
  const launched = await invoke('subagent', {
    background: true, notify: false, concurrency: 1,
    tasks: noisyTasks('usage-overflow-heavy:'),
  });
  const id = launched.details.background.id;
  const waited = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 30000 });
  assert.equal(waited.structuredContent.timedOut, false);
  assert.equal(waited.structuredContent.job.outputEvicted, true);
  assert.equal(waited.structuredContent.job.usage, undefined,
    'An unrepresentable aggregate must not leave the first task\'s partial usage in metadata');
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, waited.structuredContent), true);
  const listed = await invoke('subagent_jobs', { action: 'list' });
  assert.equal(listed.structuredContent.jobs.find(job => job.id === id).usage, undefined);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, listed.structuredContent), true);
});

test('notify is a background-only boolean validated before project approval or execution', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  for (const notify of [true, false, null, 'false', 0]) {
    const foreground = await invoke('subagent', { agent: 'project', task: 'invalid notification', agentScope: 'both', notify }, context);
    assert.equal(foreground.isError, true);
    assert.match(foreground.content[0].text, /notify/);
  }
  for (const notify of [null, 'false', 0]) {
    const background = await invoke('subagent', { agent: 'project', task: 'invalid notification', agentScope: 'both', background: true, notify }, context);
    assert.equal(background.isError, true);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('wait returns a structured final snapshot without polling, extra delivery or billing', async () => {
  const id = await launch({ task: 'delay=200 wait result' });
  const result = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.action, 'wait');
  assert.equal(result.structuredContent.timedOut, false);
  assert.equal(result.structuredContent.job.state, 'completed');
  assert.match(result.content[0].text, /result: delay=200 wait result/);
  assert.equal(result.usage, undefined);
  assert.equal(messages.length, 1);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, result.structuredContent), true);
  const again = await invoke('subagent_jobs', { action: 'wait', jobId: id });
  assert.equal(again.structuredContent.timedOut, false);
  assert.equal(messages.length, 1);
  const failed = await launch({ task: 'fail' });
  const failure = await invoke('subagent_jobs', { action: 'wait', jobId: failed, timeoutMs: 5000 });
  assert.notEqual(failure.isError, true, 'A failed job is not a failed inspection');
  assert.equal(failure.structuredContent.job.state, 'failed');
});

test('wait timeout and turn abortion leave the background job running', async () => {
  const id = await launch({ task: 'delay=10000 wait independent' });
  const timed = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 1 });
  assert.equal(timed.structuredContent.timedOut, true);
  assert.notEqual(timed.isError, true);
  assert.equal(timed.structuredContent.job.state, 'running');
  assert.match(timed.content[0].text, /Wait timed out/);
  const controller = new AbortController();
  const waited = invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 }, ctx(), controller.signal);
  controller.abort();
  await assert.rejects(waited, { name: 'AbortError' });
  assert.equal((await status(id)).state, 'running');
  const canceled = invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  assert.equal((await canceled).structuredContent.job.state, 'canceled');
});

test('job-wait saturation returns a valid retry error without mutating the job', async () => {
  const id = await launch({ task: 'delay=10000 waiter capacity', notify: false });
  const outputSchema = tools.get('subagent_jobs').definition.outputSchema;
  const controllers = Array.from({ length: MAX_PENDING_JOB_WAITS }, () => new AbortController());
  const pending = controllers.map(controller => invoke('subagent_jobs',
    { action: 'wait', jobId: id, timeoutMs: 5000 }, ctx(), controller.signal));

  const saturated = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
  assert.equal(saturated.isError, true);
  assert.match(saturated.structuredContent.error, /Too many concurrent job waits/);
  assert.equal(Value.Check(outputSchema, saturated.structuredContent), true);
  assert.equal((await status(id)).state, 'running', 'saturated waits must not cancel the background job');

  controllers[0].abort();
  await assert.rejects(pending[0], { name: 'AbortError' });
  const replacementController = new AbortController();
  const replacement = invoke('subagent_jobs',
    { action: 'wait', jobId: id, timeoutMs: 5000 }, ctx(), replacementController.signal);
  const saturatedAgain = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 1 });
  assert.equal(saturatedAgain.isError, true, 'aborting one waiter lets another take its place');

  controllers.slice(1).forEach(controller => controller.abort());
  replacementController.abort();
  await Promise.allSettled([...pending.slice(1), replacement]);
  assert.equal((await status(id)).state, 'running');
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  await finish(id);
});

test('invalid job actions are rejected without mutating jobs and retain schema-valid errors', async () => {
  const id = await launch({ task: 'delay=10000 invalid action' });
  const outputSchema = tools.get('subagent_jobs').definition.outputSchema;
  for (const action of ['unexpected', null, undefined]) {
    const params = { jobId: id };
    if (action !== undefined) params.action = action;
    const result = await invoke('subagent_jobs', params);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /action/);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
  }
  assert.equal((await status(id)).state, 'running');
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  await finish(id);
});

test('job ID inputs are bounded to UUID length before registry lookups', async () => {
  const definition = tools.get('subagent_jobs').definition;
  const id = await launch({ task: 'delay=10000 bounded job ID', notify: false });
  assert.equal(id.length, 36);
  assert.equal(Value.Check(definition.parameters, { action: 'status', jobId: id }), true);
  assert.equal(Value.Check(definition.parameters, { action: 'status', jobId: 'x'.repeat(37) }), false);

  for (const jobId of ['x'.repeat(37), 42]) {
    const result = await invoke('subagent_jobs', { action: 'status', jobId });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /jobId must be a string no longer than 36 characters/);
    assert.equal(Value.Check(definition.outputSchema, result.structuredContent), true);
  }
  const unknown = await invoke('subagent_jobs', { action: 'status', jobId: 'unknown' });
  assert.match(unknown.content[0].text, /Unknown or missing job ID/);
  assert.equal((await status(id)).state, 'running');
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  await finish(id);
});

test('invalid wait queries do not mutate jobs and unavailable IDs fail promptly', async () => {
  const id = await launch({ task: 'delay=10000 wait query safety' });
  for (const timeoutMs of [0, -1, 1.5, Infinity, 60001]) {
    const result = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /timeoutMs/);
  }
  for (const action of ['cancel', 'clear', 'forget', 'status', 'list', 'output']) {
    assert.equal((await invoke('subagent_jobs', { action, jobId: id, timeoutMs: 1 })).isError, true);
  }
  assert.equal((await status(id)).state, 'running');
  assert.equal((await invoke('subagent_jobs', { action: 'wait', jobId: 'unknown' })).isError, true);
  assert.equal((await invoke('subagent_jobs', { action: 'wait' })).isError, true);
  assert.equal((await invoke('subagent_jobs', { action: 'wait', jobId: id, offset: 0 })).isError, true);
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  await finish(id);
});

test('background is independent of the launch turn abort signal', async () => {
  const controller = new AbortController();
  const started = await invoke('subagent', { background: true, agent: 'worker', task: 'delay=120 independent' }, ctx(), controller.signal);
  controller.abort();
  assert.equal((await finish(started.details.background.id)).state, 'completed');
});

test('foreground still waits and does not create background jobs', async () => {
  const updates = [];
  const result = await tools.get('subagent').definition.execute('fg', { agent: 'pinned', task: 'delay=100 foreground' }, undefined, update => updates.push(update), ctx());
  assert.match(result.content[0].text, /result:/);
  assert.ok(updates.length > 0);
  assert.equal(messages.length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).details.jobs.length, 0);
  const child = traces().find(t => t.event === 'start');
  assert.equal(child.model, 'fake/pinned:high');
  assert.equal(child.tools, 'read,bash');
  assert.equal(child.thinking, undefined);
});

test('foreground results report cumulative SDK usage for every mode including failed steps', async () => {
  for (const params of [
    { agent: 'worker', task: 'usage' },
    { tasks: [{ agent: 'worker', task: 'usage' }, { agent: 'worker', task: 'zero-exit fail' }] },
    { chain: [{ agent: 'worker', task: 'usage' }, { agent: 'worker', task: 'zero-exit fail' }, { agent: 'worker', task: 'never run' }] },
  ]) {
    const updates = [];
    const result = await tools.get('subagent').definition.execute('usage', params, undefined, update => updates.push(update), ctx());
    const tasks = result.details.results.length;
    assert.equal(result.usage.input, tasks * 2);
    assert.equal(result.usage.output, tasks * 2);
    assert.equal(result.usage.totalTokens, tasks * 4);
    assert.deepEqual(result.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.ok(updates.every(update => update.usage === undefined), 'Progress is not a billable result');
  }
});

test('nested tool usage counts once and does not change assistant context or turn counts', async () => {
  const result = await invoke('subagent', { agent: 'worker', task: 'nested-usage' });
  assert.equal(result.usage.input, 12);
  assert.equal(result.usage.output, 22);
  assert.equal(result.usage.totalTokens, 104);
  assert.equal(result.usage.cacheWrite1h, 5);
  assert.equal(result.usage.reasoning, 7, 'Reasoning is a subset of output, not additional tokens');
  assert.equal(result.usage.cost.total, 1);
  assert.equal(result.usage.cost.cacheWrite, 0.4);
  assert.equal(result.details.results[0].usage.turns, 2);
  assert.equal(result.details.results[0].usage.contextTokens, 2);
  assert.equal(result.details.results[0].usage.cost, 1);
  assert.equal(result.details.results[0].messages.filter(message => message.role === 'toolResult').length, 1,
    'an identical legacy copy is not retained a second time');
});

test('legacy tool-result deduplication is adjacent, exact, and backward-compatible', async () => {
  for (const task of ['nested-usage-legacy-first', 'nested-usage-legacy-only']) {
    const result = await invoke('subagent', { agent: 'worker', task });
    assert.equal(result.details.results[0].messages.filter(message => message.role === 'toolResult').length, 1,
      task + ' should retain the tool result once');
  }
  const distinct = await invoke('subagent', { agent: 'worker', task: 'nested-usage-different-copy' });
  const toolResults = distinct.details.results[0].messages.filter(message => message.role === 'toolResult');
  assert.equal(toolResults.length, 2, 'non-identical messages sharing a call ID remain distinct');
  assert.equal(toolResults[1].content[0].text, 'different legacy payload');
});

test('background job metadata reports cumulative chain usage without billing inspections', async () => {
  const launched = await invoke('subagent', { background: true, chain: [
    { agent: 'worker', task: 'nested-usage' }, { agent: 'worker', task: 'delay=1000 usage' },
  ] });
  const id = launched.details.background.id;
  const live = await waitFor(async () => {
    const result = await invoke('subagent_jobs', { action: 'status', jobId: id });
    return result.structuredContent.job?.usage?.input >= 10 ? result : undefined;
  });
  assert.equal(live.usage, undefined);
  assert.equal(live.structuredContent.job.state, 'running');
  assert.ok(live.structuredContent.job.resultCount >= 1 && live.structuredContent.job.resultCount <= 2);
  assert.ok(live.structuredContent.job.usage.input >= 10);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, live.structuredContent), true);

  const waited = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
  assert.equal(waited.usage, undefined);
  assert.equal(waited.structuredContent.job.state, 'completed');
  assert.deepEqual(waited.structuredContent.job.usage, {
    input: 14, output: 24, cacheRead: 30, cacheWrite: 40, totalTokens: 108,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    cacheWrite1h: 5, reasoning: 7,
  });
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, waited.structuredContent), true);

  const listed = await invoke('subagent_jobs', { action: 'list' });
  assert.equal(listed.usage, undefined);
  assert.deepEqual(listed.structuredContent.jobs.find(job => job.id === id).usage, waited.structuredContent.job.usage);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, listed.structuredContent), true);
});

test('history eviction preserves billable usage while background inspections never bill again', async () => {
  const launched = await invoke('subagent', { agent: 'worker', task: 'history-flood', background: true });
  assert.equal(launched.usage, undefined);
  const job = await finish(launched.details.background.id);
  assert.equal(job.latest.usage.totalTokens, 404);
  assert.ok(job.latest.details.results[0].capture.messagesDropped > 0);
  for (const action of ['status', 'output', 'list']) {
    const inspected = await invoke('subagent_jobs', { action, ...(action === 'list' ? {} : { jobId: job.id }) });
    assert.equal(inspected.usage, undefined);
  }
});

test('invalid cost components, nested usage and aggregate overflow fail without echoing payloads', async () => {
  for (const task of ['malformed-cost-component', 'malformed-nested-usage', 'usage-overflow']) {
    const result = await invoke('subagent', { agent: 'worker', task });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /usage/);
    assert.equal(result.content[0].text.includes('private payload'), false);
    assert.ok(Number.isFinite(result.usage.input));
  }
});

test('overflow across a batch preserves captures without returning non-finite usage', async () => {
  const result = await invoke('subagent', { tasks: [{ agent: 'worker', task: 'usage-overflow' }, { agent: 'worker', task: 'usage-overflow' }] });
  assert.equal(result.isError, true);
  assert.equal(result.usage, undefined);
  assert.match(result.content[0].text, /cumulative.*usage/);
  assert.equal(result.details.results.length, 2);
  assert.ok(result.details.results.every(task => Number.isFinite(task.reportedUsage.input)));
});

test('cross-task token aggregation reports safe-integer overflow precisely', async () => {
  const result = await invoke('subagent', { tasks: [
    { agent: 'worker', task: 'safe-token-overflow' },
    { agent: 'worker', task: 'safe-token-overflow' },
  ] });
  assert.equal(result.isError, true);
  assert.equal(result.usage, undefined);
  assert.match(result.content[0].text, /cumulative subagent usage: token totals exceed JavaScript's safe integer limits/);
  assert.equal(result.details.results.length, 2);
  assert.ok(result.details.results.every(task =>
    task.reportedUsage.input === Number.MAX_SAFE_INTEGER && task.reportedUsage.totalTokens === Number.MAX_SAFE_INTEGER));
});

test('multi-step rendering omits unrepresentable usage totals', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const render = (result, expanded) => definition.renderResult(result, { expanded }, theme, {}).render(100).join('\n');
  for (const task of ['large-usage', 'safe-token-overflow']) {
    const result = await invoke('subagent', { tasks: [
      { agent: 'worker', task }, { agent: 'worker', task },
    ] });
    assert.equal(result.isError, true);
    for (const expanded of [false, true]) {
      assert.doesNotMatch(render(result, expanded), /Total:/,
        'A total that exceeds finite-cost or safe-token limits must not be presented as valid');
    }
  }
});

test('multi-block diagnostic responses share the total model-facing text budget', async () => {
  const tasks = [{ agent: 'worker', task: 'large-usage' }, { agent: 'worker', task: 'large-usage' }];
  for (const background of [false, true]) {
    const initial = await invoke('subagent', { tasks, background });
    const result = background ? (await finish(initial.details.background.id)).latest : initial;
    assert.equal(result.isError, true);
    const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
    assert.ok(Buffer.byteLength(text) <= 50 * 1024);
    assert.match(text, /cumulative.*usage/);
    assert.equal(text.includes('�'), false);
    assert.ok(result.details.results.every(task => task.messages.at(-1).content[0].text.length === 40000));
  }
});

test('single, parallel, and chained failures report failed jobs', async () => {
  for (const params of [
    { agent: 'worker', task: 'fail' },
    { tasks: [{ agent: 'worker', task: 'ok' }, { agent: 'worker', task: 'fail' }] },
    { chain: [{ agent: 'worker', task: 'fail' }, { agent: 'worker', task: 'must-not-run' }] },
  ]) {
    const launched = await invoke('subagent', { background: true, ...params });
    assert.equal((await finish(launched.details.background.id)).state, 'failed');
  }
  assert.equal(traces().some(t => t.task?.includes('must-not-run')), false);
  assert.equal(messages.length, 3);
  for (const { message } of messages) {
    assert.match(message.content, /failed/);
    assert.match(message.content, /fixture failure/);
  }
});

test('background chains substitute previous output and capture working directory', async () => {
  const started = await invoke('subagent', {
    background: true,
    chain: [{ agent: 'worker', task: 'first' }, { agent: 'worker', task: 'second {previous}', cwd: join(sandbox, 'project') }],
  });
  assert.equal((await finish(started.details.background.id)).state, 'completed');
  const children = traces().filter(t => t.event === 'start');
  assert.equal(children.length, 2);
  assert.equal(children[1].task, 'second result: first');
  assert.equal(children[1].cwd, join(sandbox, 'project'));
});

test('parallel progress does not count running children as completed', async () => {
  const started = await invoke('subagent', { background: true, tasks: Array.from({ length: 4 }, () => ({ agent: 'worker', task: 'delay=500 progress-check' })) });
  const id = started.details.background.id;
  await waitFor(async () => (await status(id)).latest);
  const progress = (await status(id)).latest;
  assert.match(progress.content[0].text, /Parallel: 0\/4 done, 4 pending/);
  assert.ok(progress.details.results.every(r => r.exitCode === -1));
  assert.equal((await finish(id)).state, 'completed');
});

test('all foreground and background invocations share a four-process budget', async () => {
  const batch = prefix => Array.from({ length: 6 }, (_, i) => ({ agent: 'worker', task: `delay=100 ${prefix}-${i}` }));
  const a = await invoke('subagent', { background: true, tasks: batch('a') });
  const b = await invoke('subagent', { background: true, tasks: batch('b') });
  const foreground = invoke('subagent', { agent: 'worker', task: 'delay=100 foreground-budget' });
  await Promise.all([finish(a.details.background.id), finish(b.details.background.id), foreground]);
  let active = 0, peak = 0;
  for (const entry of traces()) {
    if (entry.event === 'start') { active++; peak = Math.max(peak, active); }
    if (entry.event === 'end') active--;
  }
  assert.equal(active, 0);
  assert.equal(peak, 4);
  assert.equal(traces().filter(t => t.event === 'start').length, 13);
});

test('process queue overflow fails safely without spawning and recovers after work drains', async () => {
  const requests = Array.from({ length: 37 }, (_, i) => invoke('subagent', {
    agent: 'worker', task: `delay=100 queue-limit-${i}`,
  }));
  const results = await Promise.all(requests);
  const full = results.filter(result => result.details.results[0]?.errorMessage?.includes('process queue is full'));
  assert.equal(full.length, 1);
  assert.equal(full[0].isError, true);
  assert.match(full[0].content[0].text, /maximum 32 waiting tasks\); retry after current work completes/);
  assert.equal(traces().filter(entry => entry.event === 'start').length, 36);
  assert.equal(traces().filter(entry => entry.event === 'end').length, 36);

  const recovered = await invoke('subagent', { agent: 'worker', task: 'queue recovered' });
  assert.notEqual(recovered.isError, true);
  assert.equal(traces().filter(entry => entry.event === 'start').length, 37);
});

test('parallel concurrency can be lowered without changing result order', async () => {
  for (const concurrency of [1, 2]) {
    writeFileSync(traceFile, '');
    const tasks = Array.from({ length: 4 }, (_, i) => ({ agent: 'worker', task: `delay=150 controlled-${i}` }));
    const result = await invoke('subagent', { tasks, concurrency });
    assert.equal(result.isError, false);
    assert.equal(result.details.concurrency, concurrency);
    assert.deepEqual(result.details.results.map(r => r.task), tasks.map(t => t.task));
    let active = 0, peak = 0;
    for (const entry of traces()) {
      if (entry.event === 'start') peak = Math.max(peak, ++active);
      if (entry.event === 'end') active--;
    }
    assert.equal(active, 0);
    assert.equal(peak, concurrency);
  }
});

test('invalid or inapplicable concurrency limits fail before launching children', async () => {
  for (const concurrency of [0, -1, 1.5, 5, NaN, Infinity]) {
    const result = await invoke('subagent', { tasks: [{ agent: 'worker', task: 'x' }], concurrency });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /concurrency/);
  }
  for (const params of [{ agent: 'worker', task: 'x' }, { chain: [{ agent: 'worker', task: 'x' }] }]) {
    assert.equal((await invoke('subagent', { ...params, concurrency: 2 })).isError, true);
  }
  assert.equal(traces().length, 0);
});

test('canceling a serialized parallel job never starts its remaining tasks', async () => {
  const launched = await invoke('subagent', { background: true, concurrency: 1, tasks: Array.from({ length: 4 }, () => ({ agent: 'worker', task: 'delay=10000 stubborn serial' })) });
  const id = launched.details.background.id;
  await waitFor(() => traces().some(t => t.event === 'start'));
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  assert.equal((await finish(id)).state, 'canceled');
  assert.equal(traces().filter(t => t.event === 'start').length, 1);
});

test('cancellation during prompt creation prevents spawning and cleans up the prompt', async t => {
  let releaseWrite, enteredWrite;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  const entered = new Promise(resolve => { enteredWrite = resolve; });
  const originalWrite = fsPromises.writeFile;
  const originalSpawn = childProcess.spawn;
  const write = t.mock.method(fsPromises, 'writeFile', async (...args) => {
    enteredWrite();
    await gate;
    return originalWrite(...args);
  });
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => originalSpawn(...args));
  syncBuiltinESMExports();
  try {
    const id = await launch({ task: 'canceled while writing prompt' });
    await entered;
    const promptPath = write.mock.calls[0].arguments[0];
    await invoke('subagent_jobs', { action: 'cancel', jobId: id });
    releaseWrite();
    assert.equal((await finish(id)).state, 'canceled');
    assert.equal(spawn.mock.callCount(), 0, 'An aborted task must not spawn a child');
    assert.equal(existsSync(promptPath), false);
    assert.equal(existsSync(dirname(promptPath)), false);
    const next = await launch({ task: 'after prompt cancellation' });
    assert.equal((await finish(next)).state, 'completed');
  } finally {
    releaseWrite();
    write.mock.restore();
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cancellation before spawn is retried and deadlines start after spawn', async t => {
  const children = [];
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.killRequests = 0;
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdout = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stderr.destroy = () => {};
    child.finish = () => {
      if (child.closed) return;
      child.closed = true;
      clearTimeout(child.fallbackTimer);
      child.emit('exit', null);
      child.emit('close', null);
    };
    child.kill = () => {
      child.killRequests++;
      child.killAt ??= Date.now();
      queueMicrotask(child.finish);
      return false;
    };
    child.spawnTimer = setTimeout(() => {
      child.pid = Symbol('synthetic child PID');
      child.spawnAt = Date.now();
      child.emit('spawn');
    }, 60);
    child.fallbackTimer = setTimeout(child.finish, 500);
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const controller = new AbortController();
    const canceledPending = invoke('subagent', { agent: 'worker', task: 'abort before spawn' }, ctx(), controller.signal)
      .then(result => ({ result }), error => ({ error }));
    await waitFor(() => children.length === 1);
    controller.abort();
    const canceled = await canceledPending;
    assert.equal(canceled.error, controller.signal.reason);
    assert.equal(children[0].killRequests, 1, 'Cancellation must be retried once a PID is available');

    const timed = await invoke('subagent', { agent: 'worker', task: 'deadline starts at spawn', timeoutMs: 30 });
    const child = children[1];
    assert.equal(timed.details.results[0].timedOut, true);
    assert.ok(child.killRequests > 0, 'An expired deadline must terminate the spawned child');
    assert.ok(child.killAt - child.spawnAt >= 20, 'The deadline must start when the child emits spawn');
  } finally {
    for (const child of children) {
      clearTimeout(child.spawnTimer);
      child.finish();
    }
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cancel handles running and queued tasks, with SIGKILL escalation', async () => {
  const started = await invoke('subagent', { background: true, tasks: Array.from({ length: 8 }, () => ({ agent: 'worker', task: 'delay=10000 stubborn' })) });
  const id = started.details.background.id;
  await waitFor(() => traces().filter(t => t.event === 'start').length === 4);
  const cancel = await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  assert.equal(cancel.details.state, 'canceling');
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  const job = await finish(id);
  assert.equal(job.state, 'canceled');
  assert.equal(job.error, undefined, 'Expected child cancellation must not be reported as a job failure');
  assert.match((await invoke('subagent_jobs', { action: 'status', jobId: id })).content[0].text, /Canceled by request/);
  assert.equal(traces().filter(t => t.event === 'start').length, 4);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /canceled/);
  assert.match(messages[0].message.content, /Canceled by request/);
  const next = await launch({ task: 'after cancellation' });
  assert.equal((await finish(next)).state, 'completed');
});

test('Windows cancellation and deadlines skip the POSIX SIGKILL grace timer', { skip: process.platform !== 'win32' }, async t => {
  const graceTimers = [];
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 1000) graceTimers.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  });

  const canceled = await launch({ task: 'delay=10000 windows cancel' });
  await waitFor(() => traces().some(t => t.event === 'start'));
  const beforeCancel = graceTimers.length;
  await invoke('subagent_jobs', { action: 'cancel', jobId: canceled });
  assert.equal((await finish(canceled)).state, 'canceled');
  assert.equal(graceTimers.length - beforeCancel, 1,
    'Cancellation should schedule only the bounded inherited-pipe drain timer');

  const beforeTimeout = graceTimers.length;
  // Allow the child to start on loaded Windows runners before testing the deadline.
  const timedOut = await launch({ task: 'delay=10000 windows timeout', timeoutMs: 2000 });
  await waitFor(() => traces().some(t => t.event === 'start' && t.task.includes('windows timeout')));
  const result = await finish(timedOut);
  assert.equal(result.state, 'failed');
  assert.equal(result.latest.details.results[0].timedOut, true);
  assert.equal(graceTimers.length - beforeTimeout, 1,
    'A deadline should schedule only the bounded inherited-pipe drain timer');
});

test('Windows Job Object supervision cleans descendants after cancellation and leader exit', { skip: process.platform !== 'win32' }, async () => {
  const descendantPids = new Set();
  const startedDescendant = task => traces().find(entry => entry.event === 'grandchild' && entry.task === task);
  try {
    const model = 'fake/model with spaces "quoted" \\';
    const workingDirectory = join(sandbox, 'working directory with spaces');
    mkdirSync(workingDirectory, { recursive: true });
    const argumentResult = await invoke('subagent', { agent: 'worker', task: 'Windows supervisor quotes arguments', model, cwd: workingDirectory, timeoutMs: 15000 });
    assert.equal(argumentResult.details.results[0].exitCode, 0);
    const argumentTrace = traces().find(entry => entry.event === 'start' && entry.task === 'Windows supervisor quotes arguments');
    assert.equal(argumentTrace.model, model, 'quoted model arguments must arrive unchanged');
    assert.equal(argumentTrace.cwd, workingDirectory, 'the working directory must survive paths with spaces');

    const canceledTask = 'delay=10000 orphan grandchild-ignored grandchild-marker canceled Windows containment';
    const canceledId = await launch({ task: canceledTask });
    await waitFor(() => startedDescendant(canceledTask));
    descendantPids.add(startedDescendant(canceledTask).pid);
    await invoke('subagent_jobs', { action: 'cancel', jobId: canceledId });
    assert.equal((await finish(canceledId)).state, 'canceled');
    await sleep(2200);
    assert.equal(traces().some(entry => entry.event === 'grandchild-marker'), false,
      'cancellation must terminate descendants that ignore stdio before they can perform delayed work');

    const timeoutTask = 'delay=10000 orphan grandchild-ignored grandchild-marker timed-out Windows containment';
    const timeoutId = await launch({ task: timeoutTask, timeoutMs: 1000 });
    await waitFor(() => startedDescendant(timeoutTask));
    descendantPids.add(startedDescendant(timeoutTask).pid);
    const timeoutResult = await finish(timeoutId);
    assert.equal(timeoutResult.state, 'failed');
    assert.equal(timeoutResult.latest.details.results[0].timedOut, true);
    await sleep(2200);
    assert.equal(traces().some(entry => entry.event === 'grandchild-marker'), false,
      'a deadline must terminate descendants that ignore stdio before they can perform delayed work');

    const completedTask = 'delay=100 orphan grandchild-ignored grandchild-marker normal Windows containment';
    const completedId = await launch({ task: completedTask });
    await waitFor(() => startedDescendant(completedTask));
    descendantPids.add(startedDescendant(completedTask).pid);
    assert.equal((await finish(completedId)).state, 'completed');
    await sleep(2200);
    assert.equal(traces().some(entry => entry.event === 'grandchild-marker'), false,
      'normal leader exit must also terminate descendants that have closed their stdio');
  } finally {
    for (const pid of descendantPids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
});

test('Windows supervisor resolves bare Pi commands through PATH, not the working directory', { skip: process.platform !== 'win32' }, async () => {
  const pathDirectory = join(sandbox, 'pi-on-path');
  const workingDirectory = join(sandbox, 'cwd-with-decoy-pi');
  mkdirSync(pathDirectory, { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });

  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const probeSource = join(root, 'tests', 'fixtures', 'pi-probe.cs');
  const probeExecutable = join(pathDirectory, 'pi.exe');
  const compile = childProcess.spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -Path $env:PI_SUBAGENTS_TEST_SOURCE -OutputAssembly $env:PI_SUBAGENTS_TEST_OUTPUT -OutputType ConsoleApplication; exit 0",
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PI_SUBAGENTS_TEST_SOURCE: probeSource, PI_SUBAGENTS_TEST_OUTPUT: probeExecutable },
  });
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  copyFileSync(probeExecutable, join(workingDirectory, 'pi.exe'));

  const previousArgv = process.argv[1];
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  try {
    // Exercise getPiInvocation's bare-name fallback, as used by Bun virtual scripts.
    process.argv[1] = join(sandbox, 'missing-virtual-pi-extension.js');
    process.env.PATH = `${pathDirectory};${previousPath ?? ''}`;
    process.chdir(workingDirectory);

    const result = await invoke('subagent', {
      agent: 'worker', task: 'resolve the Pi executable', cwd: workingDirectory,
    });
    assert.equal(result.details.results[0].exitCode, 0, result.content[0]?.text);
    assert.equal(existsSync(join(pathDirectory, 'pi-probe-launched')), true,
      'the executable found on PATH should run');
    assert.equal(existsSync(join(workingDirectory, 'pi-probe-launched')), false,
      'a same-named executable in the child working directory must not shadow PATH');
  } finally {
    process.argv[1] = previousArgv;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    process.chdir(previousCwd);
  }
});

test('POSIX cancellation kills descendants in the child process group', { skip: process.platform === 'win32' }, async () => {
  const id = await launch({ task: 'delay=10000 stubborn grandchild' });
  await waitFor(() => traces().some(t => t.event === 'grandchild'));
  const descendant = traces().find(t => t.event === 'grandchild').pid;
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  assert.equal((await finish(id)).state, 'canceled');
  await waitFor(() => {
    try { return /State:\s+Z/.test(readFileSync(`/proc/${descendant}/status`, 'utf8')); }
    catch { return true; }
  });
});

test('cancellation still escalates after the leader exits and descendants ignore stdio', { skip: process.platform !== 'linux' }, async () => {
  const id = await launch({ task: 'delay=10000 grandchild-ignored' });
  await waitFor(() => traces().some(t => t.event === 'grandchild'));
  const descendant = traces().find(t => t.event === 'grandchild').pid;
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  assert.equal((await finish(id)).state, 'canceled');
  await waitFor(() => {
    try { return /State:\s+Z/.test(readFileSync(`/proc/${descendant}/status`, 'utf8')); }
    catch { return true; }
  });
});

test('normal completion cleans up descendants that do not inherit pipes', { skip: process.platform !== 'linux' }, async () => {
  const id = await launch({ task: 'delay=500 orphan grandchild-ignored' });
  let descendant;
  try {
    await waitFor(() => traces().some(t => t.event === 'grandchild'));
    descendant = traces().find(t => t.event === 'grandchild').pid;
    const job = await finish(id);
    assert.equal(job.state, 'completed');
    assert.equal(job.latest.details.results[0].capture.inheritedPipesClosed, undefined);
    assert.ok(traces().some(t => t.event === 'grandchild-term' && t.pid === descendant), 'descendants receive the SIGTERM grace period');
    await waitFor(() => {
      try { return /State:\s+Z/.test(readFileSync(`/proc/${descendant}/status`, 'utf8')); }
      catch { return true; }
    });
  } finally {
    descendant ??= traces().find(t => t.event === 'grandchild')?.pid;
    if (descendant) {
      try { process.kill(descendant, 'SIGKILL'); } catch {}
    }
    await invoke('subagent_jobs', { action: 'cancel', jobId: id });
    await finish(id);
  }
});

test('foreground abort during descendant cleanup is still honored', { skip: process.platform !== 'linux' }, async () => {
  const controller = new AbortController();
  const pending = invoke('subagent', { agent: 'worker', task: 'delay=100 orphan grandchild-ignored' }, ctx(), controller.signal);
  let descendant;
  try {
    await waitFor(() => traces().some(t => t.event === 'grandchild'));
    descendant = traces().find(t => t.event === 'grandchild').pid;
    await waitFor(() => traces().some(t => t.event === 'grandchild-term' && t.pid === descendant));
    controller.abort();
    await assert.rejects(pending, /aborted/i);
    await waitFor(() => {
      try { return /State:\s+Z/.test(readFileSync(`/proc/${descendant}/status`, 'utf8')); }
      catch { return true; }
    });
  } finally {
    controller.abort();
    descendant ??= traces().find(t => t.event === 'grandchild')?.pid;
    if (descendant) {
      try { process.kill(descendant, 'SIGKILL'); } catch {}
    }
    await pending.catch(() => {});
  }
});

test('inherited pipes cannot retain a completed child or process slot indefinitely', { skip: process.platform !== 'linux' }, async () => {
  const id = await launch({ task: 'orphan grandchild', timeoutMs: 500 });
  try {
    await waitFor(() => traces().some(t => t.event === 'grandchild'));
    const descendant = traces().find(t => t.event === 'grandchild').pid;
    const job = await finish(id);
    assert.equal(job.state, 'completed');
    assert.equal(job.latest.details.results[0].capture.inheritedPipesClosed, true);
    assert.match(job.latest.content[0].text, /Inherited output pipes/);
    await waitFor(() => {
      try { return /State:\s+Z/.test(readFileSync(`/proc/${descendant}/status`, 'utf8')); }
      catch { return true; }
    });
    assert.equal((await finish(await launch({ task: 'after inherited pipes' }))).state, 'completed');
  } finally {
    await invoke('subagent_jobs', { action: 'cancel', jobId: id });
    await finish(id);
  }
});

test('stdout records and stderr are bounded while both streams continue draining', async () => {
  for (const task of ['stdout-flood', 'stdout-flood-unterminated']) {
    const job = await finish(await launch({ task }));
    assert.equal(job.state, 'failed');
    assert.match(job.latest.content[0].text, /JSON record.*exceeded/);
    assert.ok(JSON.stringify(job.latest.details).length < 10000);
  }
  const stderrJob = await finish(await launch({ task: 'stderr-flood' }));
  assert.equal(stderrJob.state, 'completed');
  const result = stderrJob.latest.details.results[0];
  assert.equal(result.capture.stderrTruncated, true);
  assert.ok(Buffer.byteLength(result.stderr) <= 64 * 1024);
  assert.match(result.stderr, /stderr capture truncated/);
  assert.equal(result.stderr.includes('\uFFFD'), false);
  assert.match(stderrJob.latest.content[0].text, /Capture notice/);
});

test('cumulative stdout overflow terminates the child, reports truncation, and releases its process slot', async t => {
  const originalSpawn = childProcess.spawn;
  let killRequests = 0;
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => {
    if (!args[1].includes('fake/pinned:high')) return originalSpawn(...args);
    const child = new EventEmitter();
    let childKillRequests = 0;
    // Force the POSIX group-kill attempt to throw before touching any real PID; child.kill is stubbed below.
    child.pid = Symbol('synthetic child PID');
    child.kill = () => {
      killRequests++;
      if (++childKillRequests === 1) queueMicrotask(() => { child.emit('exit', null); child.emit('close', null); });
      return false;
    };
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdout = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stderr.destroy = () => {};
    queueMicrotask(() => {
      child.emit('spawn');
      // Model an oversized chunk and its bounded prefix without allocating 128 MiB in every CI job.
      const oversized = Buffer.alloc(1);
      Object.defineProperty(oversized, 'length', { value: MAX_CHILD_STDOUT_BYTES + 1 });
      Object.defineProperty(oversized, 'subarray', { value: () => Buffer.from('x') });
      child.stdout.emit('data', oversized);
    });
    return child;
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = await invoke('subagent', { agent: 'pinned', task: 'cumulative stdout overflow' });
    assert.equal(result.isError, true);
    assert.equal(result.details.results[0].failureContext.eventType, 'stdout_limit');
    assert.equal(result.details.results[0].capture.stdoutTruncated, true);
    assert.match(result.details.results[0].errorMessage, /stdout exceeded 128 MiB/);
    assert.match(result.content[0].text, /stdout capture stopped at 128 MiB/);
    assert.ok(killRequests > 0, 'The byte limit must initiate existing child termination');

    const launched = await invoke('subagent', { background: true, agent: 'pinned', task: 'background stdout limit' });
    const job = await finish(launched.details.background.id);
    assert.equal(job.state, 'failed');
    const output = await invoke('subagent_jobs', { action: 'output', jobId: launched.details.background.id });
    assert.equal(output.structuredContent.output.failureContext.eventType, 'stdout_limit');
    assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, output.structuredContent), true);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  assert.notEqual((await invoke('subagent', { agent: 'worker', task: 'after stdout limit' })).isError, true,
    'The process slot must be available after child cleanup');
});

test('per-child JSONL record limit stops parsing, terminates the child, and releases its slot', async t => {
  const originalSpawn = childProcess.spawn;
  let killRequests = 0;
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => {
    if (!args[1].includes('fake/pinned:high')) return originalSpawn(...args);
    const child = new EventEmitter();
    let childKillRequests = 0;
    child.pid = Symbol('synthetic child PID');
    child.kill = () => {
      killRequests++;
      if (++childKillRequests === 1) queueMicrotask(() => { child.emit('exit', null); child.emit('close', null); });
      return false;
    };
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.stdout = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stderr.destroy = () => {};
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.emit('data', Buffer.alloc(MAX_CHILD_JSON_RECORDS + 100, 0x0a));
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const launched = await invoke('subagent', { background: true, agent: 'pinned', task: 'JSONL record limit' });
    const job = await finish(launched.details.background.id);
    const task = job.latest.details.results[0];
    assert.equal(job.state, 'failed');
    assert.equal(task.failureContext.eventType, 'record_limit');
    assert.equal(task.failureContext.record, MAX_CHILD_JSON_RECORDS + 1);
    assert.match(task.errorMessage, /JSON record count exceeded 100000/);
    assert.ok(killRequests > 0, 'The record limit must initiate existing child termination');
    const output = await invoke('subagent_jobs', { action: 'output', jobId: launched.details.background.id });
    assert.equal(output.structuredContent.output.failureContext.eventType, 'record_limit');
    assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, output.structuredContent), true);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
  assert.notEqual((await invoke('subagent', { agent: 'worker', task: 'after JSONL record limit' })).isError, true,
    'The process slot must be available after child cleanup');
});

test('bounded history keeps the final answer and usage from evicted messages', async () => {
  const job = await finish(await launch({ task: 'history-flood' }));
  assert.equal(job.state, 'completed');
  const result = job.latest.details.results[0];
  assert.ok(result.messages.length <= 128);
  assert.ok(result.capture.messagesDropped > 0);
  assert.equal(result.usage.turns, 202);
  assert.match(job.latest.content[0].text, /result: history-flood/);
  assert.match(job.latest.content[0].text, /messages omitted from captured history/);
  const theme = { fg: (_color, text) => text, bold: text => text };
  for (const mode of ['single', 'chain', 'parallel']) for (const expanded of [false, true]) {
    const rendered = tools.get('subagent').definition.renderResult(
      { ...job.latest, details: { ...job.latest.details, mode } }, { expanded }, theme, {},
    ).render(100).join('\n');
    assert.match(rendered, /Capture notice/);
  }
});

test('task deadlines fail rather than cancel jobs and release the process slot', async () => {
  const job = await finish(await launch({ task: 'delay=10000 stubborn deadline', timeoutMs: 300 }));
  assert.equal(job.state, 'failed');
  assert.equal(job.latest.isError, true);
  assert.match(job.latest.content[0].text, /timed out after 300 ms/);
  assert.equal(job.latest.details.results[0].timedOut, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /failed/);
  assert.equal((await finish(await launch({ task: 'after deadline' }))).state, 'completed');
});

test('a deadline after oversized output reports both failure causes', async () => {
  const job = await finish(await launch({ task: 'stdout-flood-hang delay=10000 stubborn', timeoutMs: 1500 }));
  assert.equal(job.state, 'failed');
  assert.equal(job.latest.details.results[0].timedOut, true);
  assert.match(job.latest.content[0].text, /timed out after 1500 ms/);
  assert.match(job.latest.content[0].text, /JSON record.*exceeded/);
});

test('deadlines start after acquiring a slot, not while queued', async () => {
  const occupying = await invoke('subagent', { background: true, tasks: Array.from({ length: 4 }, () => ({ agent: 'worker', task: 'delay=800 occupy' })) });
  await waitFor(() => traces().filter(t => t.event === 'start').length === 4);
  const queued = await launch({ task: 'delay=50 queued deadline', timeoutMs: 500 });
  await Promise.all([finish(occupying.details.background.id), finish(queued)]);
  assert.equal((await status(queued)).state, 'completed');
  const entries = traces();
  const queuedStart = entries.findIndex(t => t.event === 'start' && t.task.includes('queued deadline'));
  assert.ok(entries.slice(0, queuedStart).some(t => t.event === 'end' && t.task.includes('occupy')));
});

test('parallel and chain entries override the default per-task deadline', async () => {
  const parallel = await invoke('subagent', {
    timeoutMs: 100,
    tasks: [{ agent: 'worker', task: 'delay=10000 timeout' }, { agent: 'worker', task: 'delay=200 allowed', timeoutMs: 2000 }],
  });
  assert.equal(parallel.isError, true);
  assert.equal(parallel.details.results[0].timedOut, true);
  assert.equal(parallel.details.results[1].exitCode, 0);
  const chain = await invoke('subagent', {
    timeoutMs: 2000,
    chain: [{ agent: 'worker', task: 'first' }, { agent: 'worker', task: 'delay=10000 timeout', timeoutMs: 100 }, { agent: 'worker', task: 'deadline-must-not-run' }],
  });
  assert.equal(chain.isError, true);
  assert.match(chain.content[0].text, /Chain stopped at step 2/);
  assert.equal(traces().some(t => t.task?.includes('deadline-must-not-run')), false);
});

test('explicit cancellation takes precedence over an upcoming deadline', async () => {
  const id = await launch({ task: 'delay=10000 stubborn canceled deadline', timeoutMs: 1000 });
  await waitFor(() => traces().some(t => t.event === 'start'));
  await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  const job = await finish(id);
  assert.equal(job.state, 'canceled');
  assert.match(messages[0].message.content, /Canceled by request/);
});

test('invalid deadlines fail validation before launching any child', async () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 86400001]) {
    for (const params of [
      { agent: 'worker', task: 'invalid deadline', timeoutMs },
      { tasks: [{ agent: 'worker', task: 'invalid deadline', timeoutMs }] },
      { chain: [{ agent: 'worker', task: 'invalid deadline', timeoutMs }] },
    ]) {
      const result = await invoke('subagent', params);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /timeoutMs/);
    }
  }
  assert.equal(traces().length, 0);
});

test('shutdown waits for background cleanup and does not deliver into a new session', async () => {
  await launch({ task: 'delay=10000 stubborn shutdown' });
  await waitFor(() => traces().some(t => t.event === 'start'));
  await shutdown();
  assert.equal(messages.length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).details.jobs.length, 0);
});

test('validation and project permission denial happen before launching a job', async () => {
  for (const params of [
    {},
    { agent: 'missing', task: 'x' },
    { agent: 'worker', task: 'x', tasks: [{ agent: 'worker', task: 'x' }] },
    { tasks: Array.from({ length: 9 }, () => ({ agent: 'worker', task: 'x' })) },
  ]) {
    const result = await invoke('subagent', { background: true, ...params });
    assert.equal(result.details.background, undefined);
  }
  for (const mode of ['print', 'json']) {
    const rejected = await invoke('subagent', { background: true, agent: 'worker', task: 'x' }, { ...ctx(), mode });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /long-lived/);
  }
  let confirmations = 0;
  const denied = await invoke('subagent', { background: true, agent: 'project', task: 'x', agentScope: 'project' }, {
    ...ctx(), cwd: join(sandbox, 'project'), mode: 'tui', hasUI: true,
    isProjectTrusted: () => false, ui: { confirm: async () => { confirmations++; return false; } },
  });
  assert.match(denied.content[0].text, /not approved/);
  assert.equal(confirmations, 1);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).details.jobs.length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'status', jobId: 'missing' })).isError, true);
});

test('maximum-length valid agent names do not overflow system-prompt filenames', async () => {
  const name = 'a'.repeat(256);
  const definitionPath = join(sandbox, 'agent/agents/long-name.md');
  writeFileSync(definitionPath,
    `---\nname: ${name}\ndescription: Long-name worker\n---\nLong-name system prompt.\n`);
  try {
    const result = await invoke('subagent', { agent: name, task: 'long agent name prompt' });
    assert.equal(result.isError, undefined);
    assert.equal(result.details.results[0].exitCode, 0);
    const child = traces().find(entry => entry.event === 'start' && entry.task === 'long agent name prompt');
    assert.ok(child?.promptFile, 'The child must receive the agent system prompt file.');
  } finally {
    rmSync(definitionPath, { force: true });
  }
});

test('failed prompt writes remove their temporary directory and release the slot', async t => {
  let promptPath;
  const write = t.mock.method(fsPromises, 'writeFile', async file => {
    promptPath = file;
    throw new Error('fixture prompt write failure');
  });
  try {
    const id = await launch({ task: 'prompt-write-error' });
    const failed = await finish(id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.latest.content[0].text, /setup failed.*preparing system prompt/);
    assert.equal(existsSync(dirname(promptPath)), false);
  } finally { write.mock.restore(); }
  assert.equal((await finish(await launch({ task: 'after prompt write error' }))).state, 'completed');
});

test('setup failures return task-level results and preserve independent or earlier work', async t => {
  const originalWrite = fsPromises.writeFile;
  const write = t.mock.method(fsPromises, 'writeFile', async (...args) => {
    if (String(args[1]).includes('Pinned instructions.')) {
      throw Object.assign(new Error('private prompt payload'), { code: 'EACCES' });
    }
    return originalWrite(...args);
  });
  try {
    for (const params of [
      { agent: 'pinned', task: 'setup single' },
      { concurrency: 1, tasks: [{ agent: 'worker', task: 'before setup' }, { agent: 'pinned', task: 'setup parallel' }, { agent: 'worker', task: 'after setup' }] },
      { chain: [{ agent: 'worker', task: 'before setup chain' }, { agent: 'pinned', task: 'setup chain' }, { agent: 'worker', task: 'never setup chain' }] },
    ]) {
      const result = await invoke('subagent', params);
      assert.equal(result.isError, true);
      const failed = result.details.results.find(task => task.agent === 'pinned');
      assert.equal(failed.exitCode, 1);
      assert.equal(failed.usage.turns, 0);
      assert.match(failed.errorMessage, /setup failed.*preparing system prompt.*EACCES/);
      assert.equal(JSON.stringify(result).includes('private prompt payload'), false);
      assert.equal(result.details.results.length, params.tasks ? 3 : params.chain ? 2 : 1);
      assert.equal(result.usage.input, params.tasks ? 4 : params.chain ? 2 : 0);
      assert.ok(result.details.results.filter(task => task.agent === 'worker').every(task => task.exitCode === 0));
    }
    assert.equal(traces().some(task => task.task?.includes('never setup chain')), false);
  } finally { write.mock.restore(); }
  assert.notEqual((await invoke('subagent', { agent: 'pinned', task: 'after setup restore' })).isError, true);
});

test('synchronous spawn failures remain inspectable and do not discard sibling results', async t => {
  const originalSpawn = childProcess.spawn;
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => {
    if (args[1].includes('fake/pinned:high')) throw Object.assign(new Error('private spawn payload'), { code: 'ERR_INVALID_ARG_VALUE' });
    return originalSpawn(...args);
  });
  syncBuiltinESMExports();
  try {
    const id = await launch({ agent: undefined, task: undefined, tasks: [{ agent: 'pinned', task: 'bad spawn' }, { agent: 'worker', task: 'good spawn' }] });
    const job = await finish(id);
    assert.equal(job.state, 'failed');
    assert.equal(job.latest.details.results.length, 2);
    assert.match(job.latest.details.results[0].errorMessage, /setup failed.*launching child process.*ERR_INVALID_ARG_VALUE/);
    assert.equal(job.latest.details.results[1].exitCode, 0);
    assert.equal(job.latest.usage.input, 2);
    const page = await invoke('subagent_jobs', { action: 'output', jobId: id, taskIndex: 0 });
    assert.match(page.structuredContent.output.text, /setup failed/);
    assert.equal(JSON.stringify(page).includes('private spawn payload'), false);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
});

test('asynchronous spawn failures expose only a safe setup diagnostic', async t => {
  const originalSpawn = childProcess.spawn;
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => {
    if (!args[1].includes('fake/pinned:high')) return originalSpawn(...args);
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    for (const name of ['stdout', 'stderr']) {
      child[name] = new EventEmitter();
      child[name].setEncoding = () => {};
      child[name].destroy = () => {};
    }
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('private spawn payload'), { code: 'ENOENT' }));
      child.emit('close', null);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await invoke('subagent', { agent: 'pinned', task: 'asynchronous spawn failure' });
    assert.equal(result.isError, true);
    assert.equal(result.details.results[0].exitCode, 1);
    assert.equal(result.details.results[0].errorMessage, 'Subagent setup failed while launching child process (ENOENT).');
    assert.equal(JSON.stringify(result).includes('private spawn payload'), false);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
});

test('malformed child events fail cleanly without crashing or retaining slots', async () => {
  const malformedTasks = [
    'malformed-null', 'malformed-content', 'malformed-usage', 'malformed-fractional-usage',
    'malformed-json', 'ill-formed-unicode-event', 'duplicate-ill-formed-unicode-event',
    'non-finite-number', 'malformed-metadata',
    'malformed-pending', 'malformed-legacy', 'malformed-message', 'malformed-tool-result',
    'malformed-user-message',
  ];
  for (const task of malformedTasks) {
    const id = await launch({ task });
    const job = await finish(id);
    assert.equal(job.state, 'failed');
    if (task === 'ill-formed-unicode-event' || task === 'duplicate-ill-formed-unicode-event') {
      const result = job.latest.details.results[0];
      assert.match(job.latest.content[0].text, /ill-formed Unicode string/);
      assert.deepEqual(result.failureContext, { eventType: 'invalid_json', record: 1 });
      assert.deepEqual(result.messages, [], 'the malformed child record is rejected before retention');
      const marker = task === 'ill-formed-unicode-event' ? 'DO_NOT_ECHO_UNICODE_' : 'DO_NOT_ECHO_DUPLICATE_';
      assert.equal(JSON.stringify(job.latest).includes(marker), false);
    } else if (task === 'non-finite-number') {
      assert.match(job.latest.content[0].text, /outside the finite JavaScript range/);
      assert.equal(job.latest.details.results[0].messages.some(message =>
        message.content.some(part => part.type === 'toolCall' && part.id === 'huge')), false,
        'The non-finite child value must not enter captured messages');
    } else {
      assert.match(job.latest.content[0].text, /Invalid subagent JSON event/);
    }
    if (task === 'malformed-tool-result') assert.match(job.latest.content[0].text, /malformed tool result metadata/);
    if (task === 'malformed-user-message') {
      assert.match(job.latest.content[0].text, /malformed user message content/);
      assert.equal(job.latest.details.results[0].messages.some(message => message.role === 'user'), false,
        'Malformed user content must be rejected before it enters captured history');
    }
    if (task === 'malformed-fractional-usage') {
      assert.match(job.latest.content[0].text, /malformed assistant usage/);
      assert.equal(job.latest.usage.input, 2, 'fractional usage from the invalid event is not accumulated');
      const status = await invoke('subagent_jobs', { action: 'status', jobId: id });
      const schema = tools.get('subagent_jobs').definition.outputSchema;
      assert.equal(Value.Check(schema, status.structuredContent), true);
      assert.equal(Value.Check(schema, {
        ...status.structuredContent,
        job: { ...status.structuredContent.job,
          usage: { ...status.structuredContent.job.usage, input: Number.MAX_SAFE_INTEGER },
        },
      }), true, 'the largest exact token count is representable in status output');
      for (const input of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(Value.Check(schema, {
          ...status.structuredContent,
          job: { ...status.structuredContent.job,
            usage: { ...status.structuredContent.job.usage, input },
          },
        }), false, 'structured usage schema rejects inexact token counts');
      }
    }
    assert.match(job.latest.content[0].text, /^Agent failed:/);
  }
  assert.equal((await finish(await launch({ task: 'after malformed output' }))).state, 'completed');
});

test('Pi and extension-defined AgentMessage roles are ignored around child results', async () => {
  const job = await finish(await launch({ task: 'documented-message-roles' }));
  assert.equal(job.state, 'completed');
  const result = job.latest.details.results[0];
  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, 'stop', 'Trailing context messages must not erase the completed assistant turn');
  assert.deepEqual(result.messages.map(message => message.role), ['assistant', 'toolResult', 'assistant']);
  assert.equal(result.messages.at(-1).content[0].text, 'Pi 1.1 terminal answer');
  assert.equal(result.errorMessage, undefined);
});

test('tool-result-end rejects a well-formed message with the wrong role', async () => {
  const job = await finish(await launch({ task: 'wrong-role-tool-result' }));
  assert.equal(job.state, 'failed');
  assert.match(job.latest.content[0].text, /tool result event must contain a tool result message/);
  assert.equal(job.latest.details.results[0].messages.some(message => message.content.length === 0), false,
    'the invalid event must not be retained as an assistant message');
});

test('deep JSON cannot overflow renderer or session serialization stacks', async () => {
  const result = await invoke('subagent', { agent: 'worker', task: 'deep-json' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nesting/);
  assert.doesNotThrow(() => JSON.stringify(result));
  const theme = { fg: (_color, text) => text, bold: text => text };
  assert.doesNotThrow(() => tools.get('subagent').definition.renderResult(result, { expanded: true }, theme, {}).render(80));
  assert.notEqual((await invoke('subagent', { agent: 'worker', task: 'next' })).isError, true);
});

test('zero exit without a completed assistant message fails cleanly', async () => {
  for (const task of ['silent-exit', 'junk-exit', 'session-only-exit']) {
    const job = await finish(await launch({ task }));
    assert.equal(job.state, 'failed');
    assert.match(job.latest.content[0].text, /assistant message|malformed JSON/);
  }
});

test('tool-use-only exits are incomplete, while a later final response succeeds', async () => {
  const incomplete = await invoke('subagent', { agent: 'worker', task: 'tool-use-only' });
  assert.equal(incomplete.isError, true);
  assert.equal(incomplete.details.results[0].stopReason, 'toolUse');
  assert.equal(incomplete.details.results[0].exitCode, 1);
  assert.equal(incomplete.usage.input, 1, 'usage from the incomplete assistant turn remains billable');
  assert.equal(incomplete.usage.totalTokens, 2);
  assert.match(incomplete.content[0].text, /without a final assistant response/);

  const completed = await invoke('subagent', { agent: 'worker', task: 'tool-use-then-final' });
  assert.notEqual(completed.isError, true);
  assert.equal(completed.details.results[0].stopReason, 'stop');
  assert.match(completed.content[0].text, /result: tool-use-then-final/);

  const chain = await invoke('subagent', { chain: [
    { agent: 'worker', task: 'tool-use-only' },
    { agent: 'worker', task: 'must-not-run-after-tool-use' },
  ] });
  assert.equal(chain.isError, true);
  assert.match(chain.content[0].text, /Chain stopped at step 1/);
  assert.equal(chain.details.results[0].exitCode, 1);
  assert.equal(traces().some(t => t.task?.includes('must-not-run-after-tool-use')), false);
});

test('successful retry clears stale errors and redacted thinking remains valid', async () => {
  for (const task of ['retry-recovered', 'redacted-thinking']) {
    const result = await invoke('subagent', { agent: 'worker', task });
    assert.equal(result.isError, undefined);
    assert.equal(result.details.results[0].errorMessage, undefined);
  }
});

test('public tools reject non-object parameter payloads without throwing', async () => {
  for (const params of [null, []]) {
    for (const name of ['subagent', 'subagent_agents', 'subagent_jobs']) {
      const result = await invoke(name, params);
      assert.equal(result.isError, true, `${name} must reject ${params === null ? 'null' : 'array'} parameters`);
      assert.match(result.content[0].text, /parameters must be an object/i);
      assert.doesNotThrow(() => JSON.stringify(result));
      const outputSchema = tools.get(name).definition.outputSchema;
      if (outputSchema) assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    }
  }
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('public tool schemas and handlers reject unknown top-level and nested parameters', async () => {
  const subagentSchema = tools.get('subagent').definition.parameters;
  const cases = [
    [{ agent: 'worker', task: 'unknown root', timeOutMs: 50 }, /subagent/],
    [{ tasks: [{ agent: 'worker', task: 'unknown task field', timeOutMs: 50 }] }, /task/],
    [{ chain: [{ agent: 'worker', task: 'unknown chain field', timeOutMs: 50 }] }, /chain step/],
  ];
  for (const [params, diagnostic] of cases) {
    assert.equal(Value.Check(subagentSchema, params), false);
    const result = await invoke('subagent', params);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unsupported parameters/);
    assert.match(result.content[0].text, diagnostic);
    assert.equal(result.details.results.length, 0);
  }

  const agentSchema = tools.get('subagent_agents').definition.parameters;
  const agentParams = { agentScope: 'user', unexpected: true };
  assert.equal(Value.Check(agentSchema, agentParams), false);
  const agents = await invoke('subagent_agents', agentParams);
  assert.equal(agents.isError, true);
  assert.match(agents.content[0].text, /Unsupported parameters/);

  const jobsSchema = tools.get('subagent_jobs').definition.parameters;
  const jobParams = { action: 'list', unexpected: true };
  assert.equal(Value.Check(jobsSchema, jobParams), false);
  const jobs = await invoke('subagent_jobs', jobParams);
  assert.equal(jobs.isError, true);
  assert.match(jobs.content[0].text, /Unsupported parameters/);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, jobs.structuredContent), true);
  assert.equal(traces().length, 0, 'Invalid parameters must not start child processes');
});

test('renderers tolerate partial calls and invalid tool argument types', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  for (const args of [{ chain: [{}] }, { tasks: [{}] }, { task: 42, agent: {} }]) {
    assert.doesNotThrow(() => definition.renderCall(args, theme, {}).render(80));
  }
  const rawEscape = String.fromCharCode(27);
  const invalidNameCall = definition.renderCall({ agent: `unsafe${rawEscape}[31m`, task: 'preview' }, theme, {});
  const invalidNamePreview = invalidNameCall.render(80).join(String.fromCharCode(10));
  assert.equal(invalidNamePreview.includes(rawEscape), false);
  assert.ok(invalidNamePreview.includes('u001b'));
  const hugeNamePreview = definition.renderCall({ agent: 'x'.repeat(1024 * 1024), task: 'preview' }, theme, {}).render(80);
  assert.ok(Buffer.byteLength(hugeNamePreview.join(String.fromCharCode(10))) < 512);
  const result = await invoke('subagent', { agent: 'worker', task: 'odd-tool-args' });
  for (const expanded of [false, true]) assert.doesNotThrow(() => definition.renderResult(result, { expanded }, theme, {}).render(80));
  const original = result.details.results[0];
  const neighborPath = `${homedir()}-backup/file`;
  const neighbor = { ...result, details: { ...result.details, results: [{ ...original, messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: neighborPath } }] }] }] } };
  assert.ok(definition.renderResult(neighbor, { expanded: false }, theme, {}).render(120).join('\n').includes(neighborPath));
});

test('fallback tool-call previews bound nested arguments before JSON serialization', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const result = await invoke('subagent', { agent: 'worker', task: 'preview arguments' });
  const original = result.details.results[0];
  const args = {
    previewMarker: 'bounded-preview-marker',
    text: 'x'.repeat(1_000_000),
    nested: { long: 'y'.repeat(1_000_000), items: Array.from({ length: 10_000 }, () => 'item') },
    fourth: true,
    fifth: 'not included',
  };
  const custom = {
    ...result,
    details: {
      ...result.details,
      results: [{ ...original, messages: [{ role: 'assistant', content: [
        { type: 'toolCall', id: 'preview-call', name: 'custom_tool', arguments: args },
      ] }] }],
    },
  };
  const originalStringify = JSON.stringify;
  let serializedArgs;
  JSON.stringify = function (value, ...parameters) {
    if (value?.previewMarker === 'bounded-preview-marker') serializedArgs = value;
    return originalStringify.call(this, value, ...parameters);
  };
  try {
    definition.renderResult(custom, { expanded: true }, theme, { isError: false }).render(80);
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.notEqual(serializedArgs, args, 'the original captured arguments are not serialized for display');
  assert.ok(serializedArgs.text.length <= 128);
  assert.ok(serializedArgs.nested.long.length <= 128);
  assert.match(serializedArgs.nested.items, /items/);
  assert.ok(Buffer.byteLength(originalStringify(serializedArgs)) < 4096,
    'the preview serialization stays small regardless of the captured argument size');
  assert.equal(args.text.length, 1_000_000, 'captured arguments remain unchanged');
});

test('subagent renderers escape untrusted terminal controls without changing captured output', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const esc = String.fromCharCode(27);
  const c1Csi = String.fromCharCode(0x9b);
  const bell = String.fromCharCode(7);
  const hostile = `terminal ${esc}]52;c;pi-subagents-test${bell} ${esc}[2J${c1Csi}2J\nnext line`;
  const render = (result, expanded) => definition.renderResult(result, { expanded }, theme, {}).render(100).join('\n');

  const output = await invoke('subagent', { agent: 'worker', task: 'terminal-control-text' });
  assert.equal(output.details.results[0].messages.at(-1).content[0].text, hostile,
    'the original child output remains available in structured details');
  for (const expanded of [false, true]) {
    const rendered = render(output, expanded);
    assert.equal(rendered.includes(esc), false, `untrusted ANSI must not reach the terminal (expanded=${expanded})`);
    assert.equal(rendered.includes(c1Csi), false, `C1 controls must not reach the terminal (expanded=${expanded})`);
    assert.ok(rendered.includes('\\u001b]52;c;pi-subagents-test\\u0007'));
    assert.ok(rendered.includes('\\u009b2J'));
    assert.ok(rendered.includes('next line'));
  }

  const toolCall = await invoke('subagent', { agent: 'worker', task: 'terminal-control-tool-call' });
  for (const expanded of [false, true]) assert.equal(render(toolCall, expanded).includes(esc), false);

  const failed = await invoke('subagent', { agent: 'worker', task: 'terminal-control-crash' });
  assert.equal(failed.details.results[0].stderr.startsWith('terminal '), true);
  for (const expanded of [false, true]) assert.equal(render(failed, expanded).includes(esc), false);

  for (const params of [
    { tasks: [{ agent: 'worker', task: 'terminal-control-text' }] },
    { chain: [{ agent: 'worker', task: 'terminal-control-text' }] },
  ]) {
    const multi = await invoke('subagent', params);
    for (const expanded of [false, true]) assert.equal(render(multi, expanded).includes(esc), false);
  }

  const hostileCalls = [
    definition.renderCall({ agent: 'worker', task: hostile }, theme, {}),
    definition.renderCall({ agentScope: hostile, tasks: [{ agent: 'worker', task: hostile }] }, theme, {}),
    definition.renderCall({ agentScope: hostile, chain: [{ agent: 'worker', task: hostile }] }, theme, {}),
  ];
  for (const call of hostileCalls) assert.equal(call.render(100).join('\n').includes(esc), false);
  const fallback = definition.renderResult({ content: [{ type: 'text', text: hostile }] }, { expanded: true }, theme, {})
    .render(100).join('\n');
  assert.equal(fallback.includes(esc), false);
});

test('subagent_jobs renderers escape terminal controls without changing job output', async () => {
  initTheme('dark', false);
  const definition = tools.get('subagent_jobs').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const esc = String.fromCharCode(27);
  const c1Csi = String.fromCharCode(0x9b);
  const hostile = `terminal ${esc}]52;c;pi-subagents-test${String.fromCharCode(7)} ${esc}[2J${c1Csi}2J\nnext line`;
  const id = await launch({ task: 'terminal-control-text', notify: false });
  await finish(id);

  const statusResult = await invoke('subagent_jobs', { action: 'status', jobId: id });
  const outputResult = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.ok(statusResult.content[0].text.includes(hostile));
  assert.equal(statusResult.details.latest.details.results[0].messages.at(-1).content[0].text, hostile,
    'captured child output remains unchanged in job details');
  assert.equal(outputResult.structuredContent.output.text, hostile,
    'paged model-facing output remains unchanged');

  for (const result of [statusResult, outputResult]) {
    for (const expanded of [false, true]) {
      const rendered = definition.renderResult(result, { expanded }, theme, { isError: false }).render(100).join('\n');
      assert.equal(rendered.includes(`${esc}]52;`), false, `child OSC sequences must not reach the terminal (expanded=${expanded})`);
      assert.equal(rendered.includes(`${esc}[2J`), false, `child cursor-control sequences must not reach the terminal (expanded=${expanded})`);
      assert.equal(rendered.includes(c1Csi), false, `C1 controls must not reach the terminal (expanded=${expanded})`);
      assert.equal(rendered.includes(String.fromCharCode(7)), false, `BEL must not reach the terminal (expanded=${expanded})`);
      assert.ok(rendered.includes('\\u001b]52;c;pi-subagents-test\\u0007'));
      assert.ok(rendered.includes('\\u009b2J'));
    }
  }

  const hostileId = `job${esc}[2J${c1Csi}2J`;
  const call = definition.renderCall({ action: 'output', jobId: hostileId }, theme, {});
  const renderedCall = call.render(100).join('\n');
  assert.equal(renderedCall.includes(esc), false);
  assert.equal(renderedCall.includes(c1Csi), false);
  assert.ok(renderedCall.includes('\\u001b[2J'));
  assert.ok(renderedCall.includes('\\u009b2J'));
});

test('terminal display escaping bounds expansion for control-heavy tool output', () => {
  initTheme('dark', false);
  const definition = tools.get('subagent_jobs').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const esc = String.fromCharCode(27);
  const hostile = `${esc}[2J`.repeat(40_000);
  const rendered = definition.renderResult(
    { content: [{ type: 'text', text: hostile }] }, { expanded: true }, theme, { isError: false },
  ).render(80).join('\n');

  assert.equal(rendered.includes(`${esc}[2J`), false, 'hostile cursor controls must be escaped');
  assert.ok(rendered.includes('\\u001b[2J'), 'escaped control sequences remain readable');
  assert.ok(rendered.length <= hostile.length + 128 * 1024,
    `renderer added excessive output (${rendered.length} characters for ${hostile.length} input characters)`);
});

test('all modes and agent names are validated before foreground children start', async () => {
  for (const params of [
    { agent: 'worker', tasks: [{ agent: 'worker', task: 'x' }] },
    { task: 'x', chain: [{ agent: 'worker', task: 'x' }] },
    { agent: 'worker', task: 'x', chain: [] },
    { tasks: [] }, { agent: 'worker', task: '  ' },
    { chain: [{ agent: 'worker', task: 'x' }, { agent: 'missing', task: 'x' }] },
  ]) {
    const result = await invoke('subagent', params);
    assert.equal(result.isError, true);
  }
  assert.equal(traces().length, 0);
});

test('agent selectors enforce UTF-8 and control limits before approval or background retention', async () => {
  const multibyteName = '€'.repeat(86); // 258 UTF-8 bytes, but only 86 schema characters.
  const schema = tools.get('subagent').definition.parameters;
  const requests = [
    { agent: multibyteName, task: 'oversized name' },
    { tasks: [{ agent: multibyteName, task: 'oversized name' }] },
    { chain: [{ agent: multibyteName, task: 'oversized name' }] },
  ];
  for (const request of requests) assert.equal(Value.Check(schema, request), true);
  for (const name of [`bad${String.fromCharCode(10)}name`, `bad${String.fromCharCode(10)}`, `bad${String.fromCharCode(27)}[31m`, `bad${String.fromCodePoint(0x202e)}name`]) {
    assert.equal(Value.Check(schema, { agent: name, task: 'invalid control' }), false);
  }

  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  for (const request of requests) {
    const result = await invoke('subagent', { ...request, agentScope: 'project', background: true }, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Agent name must be at most 256 UTF-8 bytes/);
    assert.equal(JSON.stringify(result).includes(multibyteName), false);
    assert.equal(result.details.background, undefined);
  }
  const controlName = `bad${String.fromCharCode(27)}[31m`;
  const control = await invoke('subagent', { agent: controlName, task: 'invalid control', agentScope: 'project' }, context);
  assert.equal(control.isError, true);
  assert.match(control.content[0].text, /Agent name must be at most 256 UTF-8 bytes/);
  assert.equal(JSON.stringify(control).includes(controlName), false);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('model selectors are bounded before child spawn or background retention', async () => {
  const schema = tools.get('subagent').definition.parameters;
  const tooLong = 'x'.repeat(MAX_MODEL_SELECTOR_BYTES + 1);
  const oversizedUtf8 = '€'.repeat(Math.ceil(MAX_MODEL_SELECTOR_BYTES / 3));
  const control = 'fake/worker\0model';
  const unpaired = `fake/${String.fromCharCode(0xd800)}`;
  const invalid = [
    { agent: 'worker', task: 'invalid model', model: tooLong },
    { tasks: [{ agent: 'worker', task: 'invalid model', model: tooLong }] },
    { chain: [{ agent: 'worker', task: 'invalid model', model: tooLong }] },
    { agent: 'worker', task: 'invalid model', model: oversizedUtf8 },
    { agent: 'worker', task: 'invalid model', model: control },
    { agent: 'worker', task: 'invalid model', model: unpaired },
  ];
  assert.equal(Value.Check(schema, invalid[0]), false, 'the schema rejects overlong selectors');
  assert.equal(Value.Check(schema, invalid[3]), true, 'runtime byte validation also rejects multibyte values below the character limit');
  assert.equal(Value.Check(schema, invalid[5]), true, 'runtime validation rejects unpaired surrogates that JSON schemas cannot express');
  for (const request of invalid) {
    const result = await invoke('subagent', { ...request, background: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /model must be a non-empty selector of at most 512 UTF-8 bytes/);
    assert.equal(JSON.stringify(result).includes(tooLong), false);
    assert.equal(JSON.stringify(result).includes(control), false);
    assert.equal(JSON.stringify(result).includes(unpaired), false);
    assert.equal(result.details.background, undefined);
  }
  assert.equal(traces().length, 0, 'invalid model selectors must not launch children');
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).details.jobs.length, 0);
  const oversizedParentModel = await invoke('subagent', { agent: 'worker', task: 'invalid parent model' }, {
    ...ctx(), model: { provider: 'fake', id: 'x'.repeat(MAX_MODEL_SELECTOR_BYTES) },
  });
  assert.equal(oversizedParentModel.isError, true, 'the inherited parent selector is checked after resolution too');
  assert.match(oversizedParentModel.content[0].text, /Resolved model selector/);
  assert.equal(traces().length, 0);

  const valid = 'x'.repeat(MAX_MODEL_SELECTOR_BYTES);
  const result = await invoke('subagent', { agent: 'worker', task: 'boundary model', model: valid });
  assert.notEqual(result.isError, true);
  assert.equal(traces().find(entry => entry.event === 'start').model, valid);
});

test('working directory arguments reject non-strings, NUL, and overlong paths before approval or spawn', async () => {
  let approvals = 0;
  const context = {
    ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } },
  };
  const tooLong = 'x'.repeat(MAX_WORKING_DIRECTORY_LENGTH + 1);
  const unpairedPath = `invalid${String.fromCharCode(0xd800)}path`;
  const invalid = [
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: null },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: 'bad\0path' },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: unpairedPath },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: tooLong },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: {} }] },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: unpairedPath }] },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: tooLong }] },
    { agentScope: 'project', chain: [{ agent: 'project', task: 'invalid cwd', cwd: 'bad\0path' }] },
    { agentScope: 'project', chain: [{ agent: 'project', task: 'invalid cwd', cwd: unpairedPath }] },
    { agentScope: 'project', chain: [{ agent: 'project', task: 'invalid cwd', cwd: tooLong }] },
  ];
  for (const params of invalid) {
    const result = await invoke('subagent', params, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cwd/);
    assert.equal(JSON.stringify(result).includes(tooLong), false);
    assert.equal(JSON.stringify(result).includes(unpairedPath), false);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  const schema = tools.get('subagent').definition.parameters;
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'valid', cwd: 'project' }), true);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'invalid', cwd: 'bad\0path' }), false);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'invalid', cwd: tooLong }), false);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'invalid', cwd: unpairedPath }), true,
    'runtime validation rejects unpaired surrogates that JSON schemas cannot express');
  const multibyteUnderLimit = '😀'.repeat(Math.floor(MAX_WORKING_DIRECTORY_LENGTH / 2));
  assert.ok(multibyteUnderLimit.length <= MAX_WORKING_DIRECTORY_LENGTH);
  assert.ok(Buffer.byteLength(multibyteUnderLimit, 'utf8') > MAX_WORKING_DIRECTORY_LENGTH);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'valid unicode cwd', cwd: multibyteUnderLimit }), true);
  const atLimit = 'a/'.repeat(Math.floor(MAX_WORKING_DIRECTORY_LENGTH / 2)) + 'a';
  assert.equal(atLimit.length, MAX_WORKING_DIRECTORY_LENGTH);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'resolved cwd', cwd: atLimit }), true);
  const resolvedTooLong = await invoke('subagent', {
    agent: 'project', task: 'resolved cwd', agentScope: 'project', cwd: atLimit,
  }, context);
  assert.equal(resolvedTooLong.isError, true);
  assert.match(resolvedTooLong.content[0].text, /Resolved cwd must not exceed/);
  assert.equal(JSON.stringify(resolvedTooLong).includes(atLimit), false);
  assert.equal(approvals, 0, 'a joined path over the limit must be rejected before project approval');
  assert.equal(traces().length, 0, 'a joined path over the limit must be rejected before spawn');
});

test('large tasks use stdin and relative cwd resolves from the parent session', async () => {
  const task = 'x'.repeat(256 * 1024);
  const result = await invoke('subagent', { agent: 'worker', task, cwd: 'project' });
  assert.equal(result.isError, undefined);
  const child = traces().find(t => t.event === 'start');
  assert.equal(child.task, task);
  assert.equal(child.cwd, join(sandbox, 'project'));
});

test('task input limits use UTF-8 bytes and reject oversized dispatches before approval or job creation', async () => {
  const maxTaskBytes = 4 * 1024 * 1024;
  const maxDispatchBytes = 16 * 1024 * 1024;
  const multibyteTask = '€'.repeat(Math.floor(maxTaskBytes / 3) + 1);
  assert.ok(multibyteTask.length < maxTaskBytes, 'The schema character count is below the byte cap');
  assert.ok(Buffer.byteLength(multibyteTask, 'utf8') > maxTaskBytes);

  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  const schema = tools.get('subagent').definition.parameters;
  const invalid = [
    { agent: 'project', task: multibyteTask, agentScope: 'project', background: true },
    { tasks: [{ agent: 'project', task: multibyteTask }], agentScope: 'project', background: true },
    { chain: [{ agent: 'project', task: multibyteTask }], agentScope: 'project', background: true },
  ];
  for (const params of invalid) {
    assert.equal(Value.Check(schema, params), true, 'Schema character limits must not replace byte validation');
    const result = await invoke('subagent', params, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /4 MiB UTF-8 size limit/);
    assert.equal(JSON.stringify(result).includes(multibyteTask), false);
    assert.equal(result.details.background, undefined);
  }

  const atLimit = 'x'.repeat(maxTaskBytes);
  assert.equal(Value.Check(schema, { agent: 'worker', task: atLimit }), true);
  const overDispatch = { tasks: Array.from({ length: 5 }, () => ({ agent: 'project', task: atLimit })),
    agentScope: 'project', background: true };
  assert.equal(Value.Check(schema, overDispatch), true);
  const combined = await invoke('subagent', overDispatch, context);
  assert.equal(combined.isError, true);
  assert.match(combined.content[0].text, new RegExp(`${maxDispatchBytes / (1024 * 1024)} MiB UTF-8 size limit`));
  assert.equal(JSON.stringify(combined).includes(atLimit), false);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('delegated task text rejects unpaired surrogates before approval or job creation', async () => {
  const unpaired = `invalid${String.fromCharCode(0xd800)}task`;
  const schema = tools.get('subagent').definition.parameters;
  const requests = [
    { agent: 'project', task: unpaired },
    { tasks: [{ agent: 'project', task: unpaired }] },
    { chain: [{ agent: 'project', task: unpaired }] },
  ];
  for (const request of requests) assert.equal(Value.Check(schema, request), true);

  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  for (const request of requests) {
    const result = await invoke('subagent', { ...request, agentScope: 'project', background: true }, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Task must contain well-formed Unicode/);
    assert.equal(JSON.stringify(result).includes(unpaired), false);
    assert.equal(result.details.background, undefined);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('spawn errors remain inspectable and release process slots', async () => {
  const id = await launch({ cwd: join(sandbox, 'does-not-exist') });
  const failed = await finish(id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.latest.content[0].text, /ENOENT/);
  const good = await launch({ task: 'good after spawn error' });
  assert.equal((await finish(good)).state, 'completed');
});

test('agent listing is read-only, scoped, and reports invalid files without exposing prompts', async () => {
  const badFile = join(sandbox, 'agent/agents/broken.md');
  writeFileSync(badFile, '---\nname: [unterminated\n---\n');
  try {
    const result = await invoke('subagent_agents', {});
    assert.match(result.content[0].text, /worker.*Test worker/);
    assert.match(result.content[0].text, /broken.md/);
    assert.deepEqual(result.details.agents.map(a => a.name), ['pinned', 'worker']);
    assert.ok(result.details.agents.every(a => a.systemPrompt === undefined));
    assert.equal(result.details.diagnostics.length, 1);
    assert.deepEqual(result.structuredContent, result.details);
    const project = await invoke('subagent_agents', { agentScope: 'project' }, { ...ctx(), cwd: join(sandbox, 'project') });
    assert.deepEqual(project.details.agents.map(a => a.name), ['project']);
    assert.equal(traces().length, 0);
  } finally { rmSync(badFile); }
});

test('agent timeout defaults apply in every dispatch mode and yield to call overrides', async () => {
  const file = join(sandbox, 'agent/agents/timeout-default.md');
  writeFileSync(file, '---\nname: timeout-default\ndescription: Timeout default worker\ntimeoutMs: 250\n---\nTimed worker.\n');
  const invalidFile = join(sandbox, 'agent/agents/timeout-null-default.md');
  writeFileSync(invalidFile, '---\nname: timeout-null-default\ndescription: Invalid timeout default\ntimeoutMs: null\n---\nInvalid config.\n');
  try {
    const listing = await invoke('subagent_agents', {});
    const configured = listing.details.agents.find(agent => agent.name === 'timeout-default');
    assert.equal(configured.timeoutMs, 250);
    assert.match(listing.content[0].text, /timeoutMs=250/);
    assert.ok(listing.details.diagnostics.some(diagnostic => diagnostic.filePath === invalidFile && /timeoutMs must be an integer/.test(diagnostic.message)));
    assert.equal(Value.Check(tools.get('subagent_agents').definition.outputSchema, listing.structuredContent), true);

    const subagentSchema = tools.get('subagent').definition.parameters;
    assert.equal(Value.Check(subagentSchema, { agent: 'timeout-default', task: 'schema opt-out', timeoutMs: null }), true);
    assert.equal(Value.Check(subagentSchema, { tasks: [{ agent: 'timeout-default', task: 'schema entry opt-out', timeoutMs: null }] }), true);
    assert.equal(Value.Check(subagentSchema, { chain: [{ agent: 'timeout-default', task: 'schema chain opt-out', timeoutMs: null }] }), true);

    const defaultDeadline = await invoke('subagent', {
      agent: 'timeout-default', task: 'delay=2000 agent default timeout',
    });
    assert.equal(defaultDeadline.isError, true);
    assert.equal(defaultDeadline.details.results[0].timedOut, true);
    assert.equal(defaultDeadline.details.results[0].timeoutMs, 250);
    assert.match(defaultDeadline.content[0].text, /timed out after 250 ms/);

    const topLevelOverride = await invoke('subagent', {
      agent: 'timeout-default', task: 'delay=500 top-level timeout override', timeoutMs: 1200,
    });
    assert.notEqual(topLevelOverride.isError, true);
    assert.equal(topLevelOverride.details.results[0].timeoutMs, 1200);

    const disabledSingleDeadline = await invoke('subagent', {
      agent: 'timeout-default', task: 'delay=500 explicitly disable agent deadline', timeoutMs: null,
    });
    assert.notEqual(disabledSingleDeadline.isError, true);
    assert.equal(disabledSingleDeadline.details.results[0].exitCode, 0);
    assert.equal(disabledSingleDeadline.details.results[0].timedOut, undefined);
    assert.equal(disabledSingleDeadline.details.results[0].timeoutMs, undefined);

    const disabledEntryDeadline = await invoke('subagent', {
      timeoutMs: 100,
      tasks: [
        { agent: 'timeout-default', task: 'delay=500 explicitly disable entry deadline', timeoutMs: null },
        { agent: 'timeout-default', task: 'delay=500 inherit batch deadline' },
      ],
    });
    assert.equal(disabledEntryDeadline.isError, true);
    assert.equal(disabledEntryDeadline.details.results[0].exitCode, 0);
    assert.equal(disabledEntryDeadline.details.results[0].timeoutMs, undefined);
    assert.equal(disabledEntryDeadline.details.results[1].timedOut, true);
    assert.equal(disabledEntryDeadline.details.results[1].timeoutMs, 100);

    const disabledChainEntryDeadline = await invoke('subagent', {
      timeoutMs: 100,
      chain: [
        { agent: 'timeout-default', task: 'delay=500 explicitly disable chain entry deadline', timeoutMs: null },
        { agent: 'timeout-default', task: 'delay=500 inherit chain deadline' },
      ],
    });
    assert.equal(disabledChainEntryDeadline.isError, true);
    assert.equal(disabledChainEntryDeadline.details.results[0].exitCode, 0);
    assert.equal(disabledChainEntryDeadline.details.results[0].timeoutMs, undefined);
    assert.equal(disabledChainEntryDeadline.details.results[1].timedOut, true);
    assert.equal(disabledChainEntryDeadline.details.results[1].timeoutMs, 100);

    for (const params of [
      { timeoutMs: 100, tasks: [{ agent: 'timeout-default', task: 'delay=500 task override', timeoutMs: 1200 }] },
      { timeoutMs: 100, chain: [{ agent: 'timeout-default', task: 'delay=500 chain override', timeoutMs: 1200 }] },
    ]) {
      const overridden = await invoke('subagent', params);
      assert.notEqual(overridden.isError, true);
      assert.equal(overridden.details.results[0].timeoutMs, 1200);
    }

    const background = await invoke('subagent', {
      background: true, agent: 'timeout-default', task: 'delay=2000 background default timeout',
    });
    const finished = await finish(background.details.background.id);
    assert.equal(finished.state, 'failed');
    assert.equal(finished.latest.details.results[0].timedOut, true);
    assert.equal(finished.latest.details.results[0].timeoutMs, 250);
    const timeoutOutput = await invoke('subagent_jobs', { action: 'output', jobId: background.details.background.id });
    assert.equal(timeoutOutput.structuredContent.output.timedOut, true);
    assert.equal(timeoutOutput.structuredContent.output.timeoutMs, 250);
    const jobOutputSchema = tools.get('subagent_jobs').definition.outputSchema;
    assert.equal(Value.Check(jobOutputSchema, timeoutOutput.structuredContent), true);
    assert.equal(Value.Check(jobOutputSchema, {
      ...timeoutOutput.structuredContent,
      output: { ...timeoutOutput.structuredContent.output, timeoutMs: MAX_TIMEOUT_MS + 1 },
    }), false);

    const completedBackground = await invoke('subagent', {
      background: true, agent: 'timeout-default', task: 'delay=50 configured successful deadline', timeoutMs: 5000,
    });
    assert.equal((await finish(completedBackground.details.background.id)).state, 'completed');
    const completedOutput = await invoke('subagent_jobs', { action: 'output', jobId: completedBackground.details.background.id });
    assert.equal(completedOutput.structuredContent.output.timedOut, false);
    assert.equal(completedOutput.structuredContent.output.timeoutMs, 5000);
    assert.equal(Value.Check(jobOutputSchema, completedOutput.structuredContent), true);

    const backgroundOptOut = await invoke('subagent', {
      background: true,
      timeoutMs: 100,
      tasks: [{ agent: 'timeout-default', task: 'delay=500 background entry deadline opt-out', timeoutMs: null }],
    });
    const optOutJob = await finish(backgroundOptOut.details.background.id);
    assert.equal(optOutJob.state, 'completed');
    assert.equal(optOutJob.latest.details.results[0].exitCode, 0);
    assert.equal(optOutJob.latest.details.results[0].timeoutMs, undefined);
    const optOutOutput = await invoke('subagent_jobs', { action: 'output', jobId: backgroundOptOut.details.background.id });
    assert.equal(optOutOutput.structuredContent.output.timedOut, false);
    assert.equal(Object.hasOwn(optOutOutput.structuredContent.output, 'timeoutMs'), false);
    assert.equal(Value.Check(jobOutputSchema, optOutOutput.structuredContent), true);
  } finally { rmSync(file); rmSync(invalidFile); }
});

test('agent listings omit oversized descriptions from structured metadata', async () => {
  const file = join(sandbox, 'agent/agents/oversized-description.md');
  const description = `PRIVATE_DESCRIPTION_${'x'.repeat(MAX_AGENT_DESCRIPTION_BYTES)}`;
  writeFileSync(file, `---\nname: oversized-description\ndescription: ${JSON.stringify(description)}\n---\nPrompt.\n`);
  try {
    const listed = await invoke('subagent_agents', {});
    assert.equal(listed.details.agents.some(agent => agent.name === 'oversized-description'), false);
    assert.ok(listed.details.diagnostics.some(diagnostic => diagnostic.filePath === file &&
      diagnostic.message === `description must be well-formed Unicode and at most ${MAX_AGENT_DESCRIPTION_BYTES} UTF-8 bytes.`));
    assert.equal(JSON.stringify(listed).includes(description), false);
    const outputSchema = tools.get('subagent_agents').definition.outputSchema;
    assert.equal(Value.Check(outputSchema, listed.structuredContent), true);
    assert.equal(Value.Check(outputSchema, {
      agentScope: 'user',
      agents: [{ name: 'oversized-description', description, source: 'user', filePath: file }],
      projectAgentsDir: null,
      diagnostics: [],
    }), false);
  } finally {
    rmSync(file, { force: true });
  }
});

test('ambiguous and modifier agent tool entries are rejected before child processes launch', async () => {
  const invalid = [
    { name: 'comma-tool', value: 'private-tool-probe,private-extra-probe' },
    { name: 'nul-tool', value: `read${String.fromCharCode(0)}bash` },
    { name: 'escape-tool', value: `read${String.fromCharCode(27)}bash` },
    { name: 'add-modifier', value: '+private-tool-probe' },
    { name: 'remove-modifier', value: '-bash' },
  ];
  const files = invalid.map(({ name, value }) => {
    const file = join(sandbox, 'agent/agents', `${name}.md`);
    writeFileSync(file, `---\nname: ${name}\ndescription: Invalid tool entry\ntools: ${JSON.stringify([value])}\n---\nPrompt.\n`);
    return file;
  });
  try {
    const listed = await invoke('subagent_agents', {});
    for (const { name, value } of invalid) {
      assert.equal(listed.details.agents.some(agent => agent.name === name), false);
      assert.ok(listed.details.diagnostics.some(diagnostic => diagnostic.message ===
        "tools entries must not contain commas, control characters, or start with '+' or '-'."));
      assert.equal(JSON.stringify(listed).includes(value), false);
      const result = await invoke('subagent', { agent: name, task: 'must not spawn' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unknown agent/);
      assert.equal(JSON.stringify(result).includes(value), false);
    }
    assert.equal(traces().length, 0);
  } finally {
    for (const file of files) rmSync(file, { force: true });
  }
});

test('oversized agent tool lists are diagnosed and never reach child processes', async () => {
  const file = join(sandbox, 'agent/agents/oversized-tools.md');
  const toolName = 'x'.repeat(MAX_AGENT_TOOL_LIST_BYTES + 1);
  writeFileSync(file, `---\nname: oversized-tools\ndescription: Oversized argv test\ntools: ["${toolName}"]\n---\nPrompt.\n`);
  try {
    const listed = await invoke('subagent_agents', {});
    assert.equal(listed.details.agents.some(agent => agent.name === 'oversized-tools'), false);
    assert.ok(listed.details.diagnostics.some(diagnostic => /tools must be/.test(diagnostic.message)));
    const result = await invoke('subagent', { agent: 'oversized-tools', task: 'must not spawn' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown agent/);
    assert.equal(JSON.stringify(result).includes(toolName), false);
    assert.equal(traces().length, 0);
  } finally {
    rmSync(file, { force: true });
  }
});

test('project agent metadata is escaped in listings and trust confirmations', async () => {
  const projectDir = join(sandbox, 'project/.pi/agents');
  const hostileName = 'safe `name` [link](https://example.invalid)';
  const escape = String.fromCharCode(27);
  const c1 = String.fromCodePoint(0x009b);
  const hostileDescription = `visible${String.fromCharCode(10)}### forged heading ${escape}[31mred${escape}[0m${c1}31m${String.fromCodePoint(0x202e)}`;
  const metadataFile = join(projectDir, 'metadata.md');
  const hostilePathFile = join(projectDir, `path-${escape}.md`);
  const yamlAgent = (name, description, suffix = '') => [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'model: fake/safe',
    `tools: ${JSON.stringify(['read', 'custom-safe'])}`,
    suffix,
    '---',
    'Untrusted test prompt.',
    '',
  ].filter(Boolean).join(String.fromCharCode(10));
  writeFileSync(metadataFile, yamlAgent(hostileName, hostileDescription));
  const canUseControlFilename = process.platform !== 'win32';
  if (canUseControlFilename) writeFileSync(hostilePathFile, yamlAgent('path-safe', 'Path test'));
  try {
    const context = { ...ctx(), cwd: join(sandbox, 'project') };
    const listed = await invoke('subagent_agents', { agentScope: 'project' }, context);
    const text = listed.content[0].text;
    assert.equal(text.includes(escape), false);
    assert.equal(text.includes(String.fromCodePoint(0x202e)), false);
    assert.equal(text.includes(c1), false);
    assert.equal(text.split(String.fromCharCode(10)).some(line => line.startsWith('### forged heading')), false);
    assert.ok(text.includes('u001b'));
    assert.ok(text.includes('u000a'));
    assert.equal(listed.details.agents.find(agent => agent.name === hostileName).description, hostileDescription);
    assert.deepEqual(listed.details.agents.find(agent => agent.name === hostileName).tools, ['read', 'custom-safe']);
    if (canUseControlFilename) {
      assert.ok(listed.details.agents.some(agent => agent.filePath === hostilePathFile));
      assert.equal(text.includes(hostilePathFile), false);
      const pathLine = text.split(String.fromCharCode(10)).find(line => line.includes('u001b') && line.includes('md'));
      assert.ok(pathLine.includes('path-'));
      assert.ok(pathLine.includes('\\u001b'));
      assert.ok(pathLine.includes('.md'));
    }
    assert.deepEqual(listed.structuredContent, listed.details);

    let confirmation = '';
    const trustContext = { ...context, hasUI: true, isProjectTrusted: () => false,
      ui: { confirm: async (_title, body) => { confirmation = body; return false; } } };
    const denied = await invoke('subagent', { agent: hostileName, task: 'must not start', agentScope: 'project' }, trustContext);
    assert.equal(denied.content[0].text, 'Canceled: project-local agents not approved.');
    assert.equal(confirmation.includes(escape), false);
    assert.equal(confirmation.includes(String.fromCodePoint(0x202e)), false);
    assert.equal(confirmation.includes(hostileName), false);
    assert.equal(confirmation.includes('Project agents are repo-controlled.'), true);
    assert.equal(traces().length, 0);
  } finally {
    rmSync(metadataFile, { force: true });
    rmSync(hostilePathFile, { force: true });
  }
});

test('untrusted project agents fail closed without UI approval and run only for trusted projects', async () => {
  const untrusted = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: false, isProjectTrusted: () => false };
  const denied = await invoke('subagent', { agent: 'project', task: 'must not run', agentScope: 'project' }, untrusted);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /without UI approval/);
  assert.equal(traces().length, 0);

  const trusted = { ...untrusted, isProjectTrusted: () => true };
  const allowed = await invoke('subagent', { agent: 'project', task: 'trusted headless', agentScope: 'project' }, trusted);
  assert.notEqual(allowed.isError, true);
  assert.equal(allowed.details.results[0].exitCode, 0);
  assert.equal(traces().filter(entry => entry.event === 'start').length, 1);
});

test('project agent path escape diagnostics satisfy the listing output schema', async () => {
  const target = join(sandbox, 'external-project-agent.md');
  const link = join(sandbox, 'project/.pi/agents/escaped.md');
  writeFileSync(target, '---\nname: escaped\ndescription: Outside project\n---\nExternal prompt.\n');
  symlinkSync(target, link);
  try {
    const result = await invoke('subagent_agents', { agentScope: 'project' }, { ...ctx(), cwd: join(sandbox, 'project') });
    assert.deepEqual(result.details.agents.map(a => a.name), ['project']);
    assert.ok(result.details.diagnostics.some(d => d.filePath === link && /outside the project root/i.test(d.message)));
    assert.deepEqual(result.structuredContent, result.details);
    assert.equal(Value.Check(tools.get('subagent_agents').definition.outputSchema, result.structuredContent), true);
    assert.equal(result.structuredContent.agents.some(a => a.name === 'escaped'), false);
    assert.equal(traces().length, 0);
  } finally {
    rmSync(link);
    rmSync(target);
  }
});

test('agent thinking overrides inheritance and empty tools disable the selection', async () => {
  const file = join(sandbox, 'agent/agents/limited.md');
  writeFileSync(file, '---\nname: limited\ndescription: No tools\ntools: []\nthinking: off\n---\nLimited instructions.\n');
  try {
    const result = await invoke('subagent', { agent: 'limited', task: 'limited' });
    assert.equal(result.isError, undefined);
    const child = traces().find(t => t.event === 'start');
    assert.equal(child.model, 'fake/parent');
    assert.equal(child.thinking, 'off');
    assert.equal(child.noTools, true);
    writeFileSync(file, '---\nname: limited\ndescription: Pinned thinking\nmodel: fake/pinned:high\nthinking: low\n---\nPinned instructions.\n');
    await invoke('subagent', { agent: 'limited', task: 'pinned thinking' });
    const pinned = traces().filter(t => t.event === 'start').at(-1);
    assert.equal(pinned.model, 'fake/pinned:high');
    assert.equal(pinned.thinking, 'low');
  } finally { rmSync(file); }
});

test('per-call model and thinking overrides take precedence without broadening tools', async () => {
  const result = await invoke('subagent', { agent: 'pinned', task: 'overrides', model: ' fake/override:medium ', thinking: 'low' });
  const first = traces().find(t => t.event === 'start');
  assert.equal(first.model, 'fake/override:medium');
  assert.equal(first.thinking, 'low');
  assert.equal(first.tools, 'read,bash');
  assert.equal(result.details.results[0].model, 'fake/override:medium');
  await invoke('subagent', { agent: 'worker', task: 'explicit model', model: 'fake/explicit:low' });
  assert.equal(traces().filter(t => t.event === 'start').at(-1).thinking, undefined);
  await invoke('subagent', { agent: 'worker', task: 'thinking only', thinking: 'off' });
  const last = traces().filter(t => t.event === 'start').at(-1);
  assert.equal(last.model, 'fake/parent');
  assert.equal(last.thinking, 'off');
});

test('parallel and background chain entries override batch model and thinking defaults', async () => {
  const entries = [{ agent: 'pinned', task: 'batch default' }, { agent: 'worker', task: 'entry override', model: 'fake/entry', thinking: 'off' }];
  await invoke('subagent', { tasks: entries, model: 'fake/batch', thinking: 'medium' });
  const starts = traces().filter(t => t.event === 'start');
  assert.equal(starts.find(t => t.task === 'batch default').model, 'fake/batch');
  assert.equal(starts.find(t => t.task === 'batch default').thinking, 'medium');
  assert.equal(starts.find(t => t.task === 'entry override').model, 'fake/entry');
  assert.equal(starts.find(t => t.task === 'entry override').thinking, 'off');
  const launched = await invoke('subagent', { background: true, chain: entries, model: 'fake/chain', thinking: 'low' });
  assert.equal((await finish(launched.details.background.id)).state, 'completed');
  const chain = traces().filter(t => t.event === 'start').slice(2);
  assert.deepEqual(chain.map(t => [t.model, t.thinking]), [['fake/chain', 'low'], ['fake/entry', 'off']]);
});

test('invalid agent scope cannot select project agents or bypass trust confirmation', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  const result = await invoke('subagent', { agent: 'project', task: 'must not run', agentScope: 'unexpected' }, context);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /agentScope/);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('agent listing rejects invalid scopes instead of selecting project agents', async () => {
  const context = { ...ctx(), cwd: join(sandbox, 'project') };
  const outputSchema = tools.get('subagent_agents').definition.outputSchema;
  for (const agentScope of ['unexpected', null, {}]) {
    const result = await invoke('subagent_agents', { agentScope }, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /agentScope/);
    assert.deepEqual(result.structuredContent.agents, []);
    assert.equal(result.structuredContent.agentScope, 'user');
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
  }
  assert.equal(traces().length, 0);
});

test('invalid background overrides are rejected before project approval or job creation', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  const schema = tools.get('subagent').definition.parameters;
  for (const background of [0, '', null, 'false', {}]) {
    const params = { agent: 'project', task: 'must not run', agentScope: 'project', background };
    assert.equal(Value.Check(schema, params), false);
    const result = await invoke('subagent', params, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /background must be a boolean/);
    assert.equal(result.details.background, undefined);
  }
  assert.equal(Value.Check(schema, { agent: 'project', task: 'foreground', background: false }), true);
  assert.equal(Value.Check(schema, { agent: 'project', task: 'background', background: true }), true);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('project-agent approval cannot be bypassed by a model-controlled parameter', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  const schema = tools.get('subagent').definition.parameters;
  const bypass = { agent: 'project', task: 'must not run', agentScope: 'project', confirmProjectAgents: false };
  assert.equal(Value.Check(schema, bypass), false, 'the tool schema must not expose a per-call approval bypass');
  const rejected = await invoke('subagent', bypass, context);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /confirmProjectAgents is no longer supported/);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);

  const approved = await invoke('subagent', { agent: 'project', task: 'approved', agentScope: 'project' }, context);
  assert.notEqual(approved.isError, true);
  assert.equal(approved.details.results[0].exitCode, 0);
  assert.equal(approvals, 1, 'an untrusted project agent requires an actual UI approval');
  assert.equal(traces().filter(entry => entry.event === 'start').length, 1);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('invalid dispatch overrides fail before project approval or any child launch', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  for (const overrides of [{ model: '' }, { model: '  ' }, { model: 42 }, { thinking: 'invalid' }, { thinking: null }]) {
    for (const params of [{ agent: 'project', task: 'x', ...overrides }, { tasks: [{ agent: 'project', task: 'x', ...overrides }] }, { chain: [{ agent: 'project', task: 'x', ...overrides }] }]) {
      assert.equal((await invoke('subagent', { ...params, agentScope: 'both' }, context)).isError, true);
    }
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
});

test('final output includes all text blocks and chain substitution preserves dollar sequences', async () => {
  const output = await invoke('subagent', { agent: 'worker', task: 'blocks' });
  assert.equal(output.content[0].text, 'first block\n\nsecond block');
  assert.equal((await invoke('subagent', { agent: 'worker', task: 'empty-final' })).content[0].text, '(no output)');
  await invoke('subagent', { chain: [{ agent: 'worker', task: 'dollars' }, { agent: 'worker', task: 'prefix {previous} suffix {previous}' }] });
  const literal = '$& $$ $` $\' {previous}';
  assert.equal(traces().filter(t => t.event === 'start').at(-1).task, `prefix ${literal} suffix ${literal}`);
});

test('named chain outputs reuse earlier full captures alongside previous output in one pass', async () => {
  const updates = [];
  const result = await tools.get('subagent').definition.execute('named', { chain: [
    { id: 'initial', agent: 'worker', task: 'blocks' },
    { id: 'middle', agent: 'worker', task: 'dollars' },
    { id: 'final', agent: 'worker', task: 'earlier={steps.initial}; recent={previous}; named={steps.middle}' },
  ] }, undefined, update => updates.push(update), ctx());
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.details.results.map(step => step.stepId), ['initial', 'middle', 'final']);
  const tasks = traces().filter(row => row.event === 'start').map(row => row.task);
  const dollars = "$& $$ $` $' {previous}";
  assert.equal(tasks[2], `earlier=first block\n\nsecond block; recent=${dollars}; named=${dollars}`);
  assert.ok(updates.some(update => update.details.results.some(step => step.stepId === 'middle')));
});

test('repeated chain context is rejected before materialization or launching the oversized step', async () => {
  const template = '{previous}'.repeat(2_000);
  const result = await invoke('subagent', { chain: [
    { agent: 'worker', task: 'huge-final' },
    { agent: 'worker', task: template },
  ] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Chain stopped at step 2.*4 MiB UTF-8 size limit/);
  assert.equal(result.details.results.length, 2);
  assert.equal(result.details.results[0].exitCode, 0);
  assert.equal(result.details.results[1].exitCode, 1);
  assert.equal(result.details.results[1].task, template, 'Do not retain the oversized expanded context');
  assert.match(result.details.results[1].errorMessage, /4 MiB UTF-8 size limit/);
  assert.equal(result.content[0].text.includes('é'), false, 'Do not echo prior output into diagnostics');
  assert.equal(traces().filter(row => row.event === 'start').length, 1);
});

test('named outputs work in silent background chains and output pages expose step IDs', async () => {
  const started = await invoke('subagent', { background: true, notify: false, chain: [
    { id: 'large', agent: 'worker', task: 'large' },
    { agent: 'worker', task: 'intermediate' },
    { id: 'reuse', agent: 'worker', task: 'reuse {steps.large}' },
  ] });
  const id = started.details.background.id;
  const finished = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 5000 });
  assert.equal(finished.structuredContent.job.state, 'completed');
  assert.equal(traces().filter(row => row.event === 'start').at(-1).task, 'reuse ' + 'é'.repeat(40000));
  const output = await invoke('subagent_jobs', { action: 'output', jobId: id, taskIndex: 2 });
  assert.equal(output.structuredContent.output.stepId, 'reuse');
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, output.structuredContent), true);
  assert.equal(messages.length, 0);
});

test('invalid chain IDs and references fail preflight before approval or any child launches', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  const bad = [
    [{ id: 'dup', task: 'first' }, { id: 'dup', task: 'second' }],
    [{ id: 'self', task: '{steps.self}' }],
    [{ task: '{steps.future}' }, { id: 'future', task: 'second' }],
    [{ task: 'valid first' }, { task: '{steps.missing}' }],
    [{ id: '', task: 'first' }], [{ id: 42, task: 'first' }], [{ id: 'x'.repeat(65), task: 'first' }],
    [{ task: '{steps.invalid name}' }],
  ];
  for (const entries of bad) for (const background of [false, true]) {
    const result = await invoke('subagent', { chain: entries.map(entry => ({ ...entry, agent: 'project' })), background, agentScope: 'both' }, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /chain.*(ID|reference)/i);
    assert.equal(result.details.results.length, 0);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);
});

test('empty named output stops the chain without spawning a blank task', async () => {
  const result = await invoke('subagent', { chain: [
    { id: 'empty', agent: 'worker', task: 'empty-final' },
    { agent: 'worker', task: '{steps.empty}' },
  ] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /step 2.*empty/);
  assert.equal(traces().filter(row => row.event === 'start').length, 1);
});

test('chain size is bounded in the schema and preflight before project approval or job creation', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  const chain = Array.from({ length: 33 }, () => ({ agent: 'project', task: 'do not launch' }));
  const schema = tools.get('subagent').definition.parameters;
  assert.equal(Value.Check(schema, { chain }), false);
  assert.equal(Value.Check(schema, { chain: chain.slice(0, 32) }), true);
  for (const background of [false, true]) {
    const result = await invoke('subagent', { chain, background, agentScope: 'both' }, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Too many chain steps.*33.*32/);
    assert.equal(result.details.background, undefined);
  }
  for (const key of ['chain', 'tasks']) for (const value of [null, {}, 'invalid']) {
    const result = await invoke('subagent', { [key]: value });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /must be arrays/);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).details.jobs.length, 0);
  const accepted = await invoke('subagent', { chain: Array.from({ length: 32 }, (_, i) => ({ agent: 'worker', task: i ? 'never run' : 'fail' })) });
  assert.match(accepted.content[0].text, /Chain stopped at step 1/);
});

test('empty initial chain context fails before project approval or launching a child', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  const result = await invoke('subagent', { chain: [{ agent: 'project', task: ' {previous} {previous} ' }], agentScope: 'both' }, context);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /empty|non-empty/);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
});

test('a chain stops when substitution creates a blank task without consuming a slot', async () => {
  const result = await invoke('subagent', { chain: [{ agent: 'worker', task: 'empty-final' }, { agent: 'worker', task: '{previous}' }, { agent: 'worker', task: 'never run' }] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /step 2.*empty/);
  assert.equal(result.details.results.length, 2);
  assert.equal(result.details.results[1].usage.turns, 0);
  assert.equal(traces().filter(t => t.event === 'start').length, 1);
  assert.notEqual((await invoke('subagent', { agent: 'worker', task: 'after blank task' })).isError, true);
});

test('chain rendering uses model failure status even on zero exit, and shows pending steps', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const render = (result, expanded) => definition.renderResult(result, { expanded }, theme, {}).render(100).join('\n');
  const updates = [];
  const result = await definition.execute('chain-failure', { chain: [{ agent: 'worker', task: 'zero-exit fail' }] }, undefined,
    partial => updates.push([render(partial, false), render(partial, true)]), ctx());
  assert.equal(result.isError, true);
  for (const expanded of [false, true]) {
    assert.match(render(result, expanded), /0\/1 steps/);
    assert.match(render(result, expanded), /✗/);
    assert.match(updates[0][Number(expanded)], /⏳/);
  }
});

test('all render modes show model, process, and protocol failure diagnoses', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  for (const [task, diagnosis] of [['crash', /fixture crashed/], ['zero-exit fail', /fixture failure/], ['stdout-flood', /oversized record discarded/]]) {
    for (const params of [{ agent: 'worker', task }, { chain: [{ agent: 'worker', task }] }, { tasks: [{ agent: 'worker', task }] }]) {
      const result = await invoke('subagent', params);
      for (const expanded of [false, true]) {
        assert.match(definition.renderResult(result, { expanded }, theme, {}).render(100).join('\n'), diagnosis);
      }
    }
  }
});

test('collapsed rendering bounds long lines, error messages, and tool paths', async () => {
  const definition = tools.get('subagent').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  for (const task of ['large', 'large-error fail', 'long-path']) {
    const result = await invoke('subagent', { agent: 'worker', task });
    const preview = definition.renderResult(result, { expanded: false }, theme, {}).render(80).join('\n');
    assert.ok(Buffer.byteLength(preview) < 4096);
    assert.equal(preview.includes('\uFFFD'), false);
    if (task === 'large') assert.ok(definition.renderResult(result, { expanded: true }, theme, {}).render(80).length > 100);
  }
});

test('finished job records can be forgotten or cleared without canceling active jobs', async () => {
  const active = await launch({ task: 'delay=1500 active record' });
  const finished = await launch({ task: 'finished record' });
  await finish(finished);
  assert.equal((await invoke('subagent_jobs', { action: 'forget', jobId: active })).isError, true);
  assert.equal((await invoke('subagent_jobs', { action: 'forget', jobId: finished })).details.forgotten, finished);
  assert.equal((await invoke('subagent_jobs', { action: 'status', jobId: finished })).isError, true);
  await finish(await launch({ task: 'another finished record' }));
  assert.equal((await invoke('subagent_jobs', { action: 'clear' })).details.cleared, 1);
  assert.equal((await status(active)).state, 'running');
  assert.equal((await finish(active)).state, 'completed');
});

test('finished registry output is byte-bounded while completion delivery retains the result', async () => {
  const launched = await invoke('subagent', { background: true, tasks: noisyTasks('retention-registry-heavy:') });
  const id = launched.details.background.id;
  const job = await finish(id, 30000);
  assert.equal(job.state, 'completed');
  assert.equal(job.outputEvicted, true);
  assert.equal(job.latest, undefined);
  assert.equal(messages[0].message.details.latest.details.results.length, 8);
  assert.match((await invoke('subagent_jobs', { action: 'status', jobId: id })).content[0].text, /evicted/);
  assert.match((await invoke('subagent_jobs', { action: 'list' })).content[0].text, /output evicted/);
  const page = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.equal(page.isError, true);
  assert.match(page.structuredContent.error, /evicted/);
  assert.equal(page.structuredContent.job.outputEvicted, true);
});

test('finished registry accounting includes model metadata after its source message is evicted', async () => {
  const modelBytes = 7 * 1024 * 1024;
  const launched = await invoke('subagent', {
    background: true,
    notify: false,
    tasks: Array.from({ length: 5 }, () => ({ agent: 'worker', task: 'unretained-model' })),
  }, { ...ctx(), model: undefined });
  const id = launched.details.background.id;
  const sawUnretainedModel = await waitFor(async () => {
    const job = await status(id);
    return job.latest?.details?.results.some(task => task.model?.length === modelBytes &&
      task.capture?.messagesDropped > 0 && task.capture.retainedMessageBytes < 1024 * 1024) ?? false;
  });
  assert.equal(sawUnretainedModel, true, 'The large source record is absent from history while its model metadata remains');
  const job = await finish(id);
  assert.equal(job.state, 'completed');
  assert.equal(job.outputEvicted, true, 'Retained model metadata over the shared budget must evict the silent result');
  assert.equal(job.latest, undefined);
  assert.equal(messages.length, 0, 'A silent job must not retain a completion-message copy');
  const output = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.equal(output.isError, true);
  assert.equal(output.structuredContent.job.outputEvicted, true);
});

test('parallel and chain histories share a bounded aggregate capture budget', async () => {
  const budget = 32 * 1024 * 1024;
  const parallel = await invoke('subagent', {
    tasks: Array.from({ length: 8 }, () => ({ agent: 'worker', task: 'retention-heavy' })),
  });
  const parallelBytes = parallel.details.results.reduce((sum, result) => sum + result.capture.retainedMessageBytes, 0);
  assert.ok(parallelBytes <= budget, `Parallel history retained ${parallelBytes} bytes`);
  assert.ok(parallel.details.results.every(result => result.capture.retainedMessageBytes <= budget / 8));
  assert.ok(parallel.details.results.every(result => result.capture.messagesDropped >= 2));

  const chain = await invoke('subagent', {
    chain: Array.from({ length: 8 }, (_, i) => ({ id: `step-${i}`, agent: 'worker', task: 'retention-heavy' })),
  });
  assert.equal(chain.details.results.length, 8);
  const chainBytes = chain.details.results.reduce((sum, result) => sum + result.capture.retainedMessageBytes, 0);
  assert.ok(chainBytes <= budget, `Chain history retained ${chainBytes} bytes`);

  const chainStartsBefore = traces().filter(entry => entry.event === 'start').length;
  const expanded = await invoke('subagent', {
    chain: [
      { agent: 'worker', task: 'chain-aggregate-output' },
      ...Array.from({ length: 31 }, () => ({ agent: 'worker', task: '{previous}' })),
    ],
  });
  assert.equal(expanded.isError, true, 'Aggregate expanded tasks must stop before exceeding the dispatch limit');
  assert.match(expanded.content[0].text, /remaining .* per-dispatch task limit/);
  assert.ok(expanded.details.results.length < 32);
  const expandedBytes = expanded.details.results.reduce((sum, result) => sum + Buffer.byteLength(result.task), 0);
  assert.ok(expandedBytes <= budget, `Retained expanded task text used ${expandedBytes} bytes`);
  assert.equal(traces().filter(entry => entry.event === 'start').length - chainStartsBefore,
    expanded.details.results.length - 1, 'The oversized expanded task must fail before spawning a child');

  const overflow = await invoke('subagent', {
    chain: Array.from({ length: 32 }, (_, i) => ({ agent: 'worker', task: i === 0 ? 'chain-capture-overflow' : 'must-not-run' })),
  });
  assert.equal(overflow.isError, true, 'A dropped final answer must not be passed onward as an empty chain result');
  assert.equal(overflow.details.results.length, 1);
  assert.equal(overflow.details.results[0].capture.finalAssistantMessageDropped, true);
  assert.match(overflow.content[0].text, /exceeded the available history capture budget/);
});

test('single and chain responses cap text without truncating captured data or chain input', async () => {
  for (const params of [{ agent: 'worker', task: 'large' }, { chain: [{ agent: 'worker', task: 'large' }] }, { agent: 'worker', task: 'large-error fail' }]) {
    const result = await invoke('subagent', params);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
    assert.match(result.content[0].text, /Output truncated/);
    assert.equal(result.content[0].text.includes('\uFFFD'), false);
    assert.equal(result.details.results.at(-1).messages.at(-1).content[0].text.length, 40000);
  }
  await invoke('subagent', { chain: [{ agent: 'worker', task: 'large' }, { agent: 'worker', task: 'prefix {previous}' }] });
  assert.equal(traces().filter(t => t.event === 'start').at(-1).task, 'prefix ' + 'é'.repeat(40000));
});

test('truncating oversized model text encodes only the bounded prefix', async () => {
  const originalFrom = Buffer.from;
  const encodedLengths = [];
  Buffer.from = (value, ...args) => {
    if (typeof value === 'string') encodedLengths.push(value.length);
    return originalFrom(value, ...args);
  };
  let result;
  try {
    result = await invoke('subagent', { agent: 'worker', task: 'x'.repeat(100000) });
  } finally {
    Buffer.from = originalFrom;
  }
  assert.notEqual(result.isError, true);
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
  assert.match(result.content[0].text, /Output truncated/);
  assert.ok(encodedLengths.length > 0);
  assert.ok(encodedLengths.every(length => length <= 50 * 1024),
    `Oversized output should not be fully encoded: ${Math.max(...encodedLengths)} UTF-16 code units`);
});

test('parallel responses share a total text budget and keep every captured result', async () => {
  const result = await invoke('subagent', { tasks: Array.from({ length: 8 }, () => ({ agent: 'worker', task: 'large' })) });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
  assert.match(result.content[0].text, /8\/8 succeeded/);
  assert.match(result.content[0].text, /Output truncated/);
  assert.equal(result.details.results.length, 8);
  assert.ok(result.details.results.every(r => r.messages.at(-1).content[0].text.length === 40000));
  assert.equal((result.content[0].text.match(/### \[`worker`\] completed/g) ?? []).length, 8);
  const mixed = await invoke('subagent', { tasks: Array.from({ length: 8 }, (_, i) => ({ agent: 'worker', task: i === 7 ? 'large fail' : 'large' })) });
  assert.match(mixed.content[0].text, /7\/8 succeeded/);
  assert.match(mixed.content[0].text, /fixture failure/);
  assert.ok(Buffer.byteLength(mixed.content[0].text) <= 50 * 1024);
});

test('streaming text uses the same budget as the completed result', async () => {
  const updates = [];
  const definition = tools.get('subagent').definition;
  await definition.execute('bounded-stream', { agent: 'worker', task: 'large' }, undefined, partial => updates.push(partial), ctx());
  assert.ok(updates.length > 0);
  assert.ok(updates.every(p => Buffer.byteLength(p.content[0].text) <= 50 * 1024));
  assert.match(updates.at(-1).content[0].text, /Output truncated/);
  assert.equal(updates.at(-1).details.results[0].messages.at(-1).content[0].text.length, 40000);
});

test('job output pages retrieve text beyond the truncated completion summary', async () => {
  const id = await launch({ task: 'large' });
  await finish(id);
  let offset = 0, output = '';
  do {
    const result = await invoke('subagent_jobs', { action: 'output', jobId: id, offset, limit: 32768 });
    assert.notEqual(result.isError, true);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
    const page = result.structuredContent.output;
    output += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  assert.equal(output, 'é'.repeat(40000));
});

test('structured job responses exclude full captures and support selecting batch output', async () => {
  const launched = await invoke('subagent', { background: true, tasks: [{ agent: 'worker', task: 'first' }, { agent: 'worker', task: 'second' }] });
  const id = launched.details.background.id;
  await finish(id);
  const listed = await invoke('subagent_jobs', { action: 'list' });
  assert.ok(tools.get('subagent_jobs').definition.outputSchema);
  assert.equal(listed.structuredContent.jobs[0].id, id);
  assert.equal(listed.structuredContent.jobs[0].latest, undefined);
  const inspected = await invoke('subagent_jobs', { action: 'status', jobId: id });
  assert.equal(inspected.structuredContent.job.resultCount, 2);
  assert.equal(inspected.structuredContent.job.latest, undefined);
  const output = await invoke('subagent_jobs', { action: 'output', jobId: id, taskIndex: 1 });
  assert.equal(output.structuredContent.output.text, 'result: second');
  assert.equal(output.structuredContent.output.taskIndex, 1);
  const forgotten = await invoke('subagent_jobs', { action: 'forget', jobId: id });
  assert.equal(forgotten.structuredContent.forgotten, id);
  assert.equal((await invoke('subagent_jobs', { action: 'clear' })).structuredContent.cleared, 0);
  const missing = await invoke('subagent_jobs', { action: 'status', jobId: id });
  assert.equal(missing.isError, true);
  assert.match(missing.structuredContent.error, /Unknown/);
  for (const response of [listed, inspected, output, forgotten, missing, await invoke('subagent_jobs', { action: 'clear' })]) {
    assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, response.structuredContent), true);
  }
  assert.equal(output.details.latest, undefined, 'Output pages must not duplicate full captures into session history');
});

test('output pages reject active jobs and expose failed-job diagnoses after completion', async () => {
  const id = await launch({ task: 'delay=10000 hold' });
  const active = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.equal(active.isError, true);
  assert.match(active.structuredContent.error, /finished job/);
  await waitFor(async () => (await status(id)).latest?.details?.results[0]?.messages?.length);
  const canceled = await invoke('subagent_jobs', { action: 'cancel', jobId: id });
  assert.equal(canceled.structuredContent.job.id, id);
  await finish(id);
  const canceledOutput = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.equal(canceledOutput.structuredContent.output.partial, true);
  assert.match(canceledOutput.structuredContent.output.text, /Partial, unverified output/);
  assert.doesNotMatch(canceledOutput.structuredContent.output.text, /failed task/);
  const failed = await launch({ task: 'zero-exit fail' });
  await finish(failed);
  const output = await invoke('subagent_jobs', { action: 'output', jobId: failed });
  assert.notEqual(output.isError, true, 'Reading a failed task is not an inspection failure');
  assert.equal(output.structuredContent.job.state, 'failed');
  assert.match(output.structuredContent.output.text, /fixture failure/);
  assert.match(output.structuredContent.output.text, /Partial, unverified output/);
  assert.equal(output.structuredContent.output.partial, true);
  assert.equal(output.structuredContent.output.exitCode, 0);
  assert.equal(output.structuredContent.output.processExitCode, 0);
  assert.equal(output.structuredContent.output.timedOut, false);
  assert.equal('timeoutMs' in output.structuredContent.output, false);
});

test('invalid UTF-8 child records fail safely and preserve later valid messages', async () => {
  const job = await finish(await launch({ task: 'invalid-utf8-event' }));
  assert.equal(job.state, 'failed');
  const task = job.latest.details.results[0];
  assert.equal(task.exitCode, 1);
  assert.equal(task.processExitCode, 0);
  assert.deepEqual(task.failureContext, {
    eventType: 'invalid_utf8', record: 2, lastStopReason: 'stop',
  });
  assert.deepEqual(task.messages.map(message => message.role), ['assistant', 'assistant']);
  assert.equal(JSON.stringify(task).includes('DO_NOT_ECHO_INVALID_UTF8_'), false);

  const page = await invoke('subagent_jobs', { action: 'output', jobId: job.id });
  assert.equal(page.isError, undefined);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, page.structuredContent), true);
  assert.equal(page.structuredContent.output.failureContext.eventType, 'invalid_utf8');
  assert.match(page.structuredContent.output.text, /Invalid subagent JSON event: malformed UTF-8/);
  assert.match(page.structuredContent.output.text, /before invalid UTF-8/);
  assert.match(page.structuredContent.output.text, /after invalid UTF-8/);
  assert.equal(page.structuredContent.output.text.includes('DO_NOT_ECHO_INVALID_UTF8_'), false);
  assert.equal(page.structuredContent.output.text.includes('\uFFFD'), false);
});

test('failed protocol jobs expose safe context and paginated unverified partial output', async () => {
  const id = await launch({ task: 'protocol-error-after-progress' });
  const job = await finish(id);
  assert.equal(job.state, 'failed');
  const task = job.latest.details.results[0];
  assert.equal(task.exitCode, 1, 'A protocol violation remains a task failure');
  assert.equal(task.processExitCode, 0, "The child's raw process status remains separately available");
  assert.deepEqual(task.failureContext, {
    eventType: 'tool_result_end', role: 'other', record: 4, lastStopReason: 'stop',
  });
  assert.deepEqual(task.messages.map(message => message.role), ['assistant', 'toolResult', 'assistant']);
  assert.equal(JSON.stringify(task).includes('DO_NOT_ECHO_EVENT_PAYLOAD'), false,
    'The invalid event is rejected before capture');

  let offset = 0;
  let text = '';
  for (;;) {
    const page = await invoke('subagent_jobs', { action: 'output', jobId: id, offset, limit: 64 });
    assert.notEqual(page.isError, true);
    assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, page.structuredContent), true);
    const output = page.structuredContent.output;
    assert.equal(output.partial, true);
    assert.equal(output.exitCode, 1);
    assert.equal(output.processExitCode, 0);
    assert.deepEqual(output.failureContext, task.failureContext);
    assert.equal(output.offset, offset);
    assert.ok(Buffer.byteLength(output.text) <= 64);
    text += output.text;
    if (output.nextOffset === null) break;
    assert.ok(output.nextOffset > offset);
    offset = output.nextOffset;
  }
  assert.match(text, /Invalid subagent JSON event: tool result event must contain a tool result message/);
  assert.match(text, /Failure context: event=tool_result_end; role=other; record=4; lastStopReason=stop; processExitCode=0/);
  assert.match(text, /\[Partial, unverified output\]/);
  assert.match(text, /tool progress café/);
  assert.match(text, /partial answer — résumé/);
  assert.equal(text.includes('DO_NOT_ECHO_EVENT_PAYLOAD'), false);
  assert.equal(text.includes('protocol-error-after-progress'), false, 'The task prompt is not echoed in protocol diagnostics');
  assert.equal(text.includes('\uFFFD'), false, 'UTF-8 pagination must not split captured text');
});

test('invalid output queries do not mutate jobs or launch children', async () => {
  const id = await launch({ task: 'small result' });
  await finish(id);
  for (const query of [{ offset: -1 }, { offset: 1.5 }, { limit: 3 }, { limit: 32769 }, { taskIndex: -1 }, { taskIndex: 1 }, { offset: 999999 }]) {
    const result = await invoke('subagent_jobs', { action: 'output', jobId: id, ...query });
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent.error);
  }
  const misuse = await invoke('subagent_jobs', { action: 'cancel', jobId: id, offset: 1 });
  assert.equal(misuse.isError, true);
  assert.equal((await status(id)).state, 'completed');
  assert.equal(traces().filter(t => t.event === 'start').length, 1);
});

test('background delivery and status cap large output but preserve full details', async () => {
  const id = await launch({ task: 'large' });
  const job = await finish(id);
  assert.equal(job.latest.details.results[0].messages.at(-1).content[0].text.length, 40000);
  assert.ok(Buffer.byteLength(job.latest.content[0].text) <= 50 * 1024);
  assert.match(messages[0].message.content, /Output truncated/);
  assert.ok(Buffer.byteLength(messages[0].message.content) <= 50 * 1024);
  assert.equal(messages[0].message.content.includes('\uFFFD'), false);
  const inspected = (await invoke('subagent_jobs', { action: 'status', jobId: id })).content[0].text;
  assert.match(inspected, /Output truncated/);
  assert.ok(Buffer.byteLength(inspected) <= 50 * 1024);
});
