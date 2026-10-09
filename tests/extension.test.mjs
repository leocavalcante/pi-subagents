import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadExtensions } from './pi-runtime.mjs';
import { Value } from 'typebox/value';

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
const ctx = () => ({ cwd: sandbox, mode: 'rpc', hasUI: false, model: { provider: 'fake', id: 'parent' }, thinkingLevel: 'high' });
const invoke = (name, params, context = ctx(), signal) => tools.get(name).definition.execute('test-call', params, signal, undefined, context);
const launch = async params => (await invoke('subagent', { background: true, agent: 'worker', task: 'delay=150', ...params })).details.background.id;
const status = async id => (await invoke('subagent_jobs', { action: 'status', jobId: id })).details;
const traces = () => readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const waitFor = async predicate => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await sleep(10); }
  throw new Error('Timed out waiting for test condition');
};
const finish = id => waitFor(async () => { const job = await status(id); return job.finishedAt ? job : undefined; });
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
  await waitFor(async () => (await status(id)).latest);
  assert.match((await status(id)).latest.content[0].text, /progress/);
  const result = await finish(id);
  assert.equal(result.state, 'completed');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /result: delay=400 main/);
  assert.deepEqual(messages[0].options, { deliverAs: 'followUp', triggerTurn: true });
  const child = traces().find(t => t.event === 'start');
  assert.equal(child.model, 'fake/parent');
  assert.equal(child.thinking, 'high');
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
  const heavy = await invoke('subagent', { background: true, notify: false, tasks: noisyTasks('retention-heavy:') });
  const heavyId = heavy.details.background.id;
  const evicted = await invoke('subagent_jobs', { action: 'wait', jobId: heavyId, timeoutMs: 15000 });
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
  const waited = await invoke('subagent_jobs', { action: 'wait', jobId: id, timeoutMs: 10000 });
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
  const timedOut = await launch({ task: 'delay=10000 windows timeout', timeoutMs: 100 });
  await waitFor(() => traces().some(t => t.event === 'start' && t.task.includes('windows timeout')));
  const result = await finish(timedOut);
  assert.equal(result.state, 'failed');
  assert.equal(result.latest.details.results[0].timedOut, true);
  assert.equal(graceTimers.length - beforeTimeout, 1,
    'A deadline should schedule only the bounded inherited-pipe drain timer');
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
    if (String(args[0]).endsWith('prompt-pinned.md')) {
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
  for (const task of ['malformed-null', 'malformed-content', 'malformed-usage', 'malformed-fractional-usage', 'malformed-json', 'non-finite-number', 'malformed-metadata', 'malformed-pending', 'malformed-legacy', 'malformed-message', 'malformed-tool-result', 'malformed-user-message']) {
    const id = await launch({ task });
    const job = await finish(id);
    assert.equal(job.state, 'failed');
    if (task === 'non-finite-number') {
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

test('working directory arguments reject non-strings and NUL before project approval or spawn', async () => {
  let approvals = 0;
  const context = {
    ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } },
  };
  const invalid = [
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: null },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: 'bad\0path' },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: {} }] },
    { agentScope: 'project', chain: [{ agent: 'project', task: 'invalid cwd', cwd: 'bad\0path' }] },
  ];
  for (const params of invalid) {
    const result = await invoke('subagent', params, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cwd/);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  const schema = tools.get('subagent').definition.parameters;
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'valid', cwd: 'project' }), true);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'invalid', cwd: 'bad\0path' }), false);
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
    `model: ${JSON.stringify(`fake/${escape}[31m`)}`,
    `tools: ${JSON.stringify(['read', `custom${String.fromCharCode(10)}${escape}`])}`,
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

test('invalid project-agent confirmation overrides cannot disable trust prompts', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  const schema = tools.get('subagent').definition.parameters;
  for (const confirmProjectAgents of [0, '', null, 'false']) {
    const params = { agent: 'project', task: 'must not run', agentScope: 'project', confirmProjectAgents };
    assert.equal(Value.Check(schema, params), false);
    const result = await invoke('subagent', params, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /confirmProjectAgents/);
  }
  assert.equal(Value.Check(schema, { agent: 'project', task: 'opt out', agentScope: 'project', confirmProjectAgents: false }), true);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
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
  const launched = await invoke('subagent', { background: true, tasks: noisyTasks('retention-heavy:') });
  const id = launched.details.background.id;
  const job = await finish(id);
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
