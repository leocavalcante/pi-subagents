import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { jiti, loadExtensions } from './pi-runtime.mjs';
import { Value } from 'typebox/value';
import { initTheme } from '@earendil-works/pi-coding-agent';

const { MAX_CHILD_JSON_RECORDS, MAX_CHILD_STDOUT_BYTES } = await jiti.import('../capture.ts');
const { DEFAULT_PROGRESS_UPDATE_INTERVAL_MS } = await jiti.import('../progress.ts');
const {
  MAX_AGENT_DESCRIPTION_BYTES,
  MAX_AGENT_DIAGNOSTICS,
  MAX_AGENT_FILES,
  MAX_AGENT_NAME_BYTES,
  MAX_AGENT_SEARCH_QUERY_BYTES,
  MAX_AGENT_TOOL_COUNT,
  MAX_AGENT_TOOL_LIST_BYTES,
  MAX_AGENT_TAG_BYTES,
  MAX_AGENT_TAG_COUNT,
  MAX_AGENT_TAG_LIST_BYTES,
  MAX_MODEL_SELECTOR_BYTES,
  MAX_TIMEOUT_MS,
  MAX_WORKING_DIRECTORY_LENGTH,
} = await jiti.import('../agents.ts');
const {
  MAX_AGENT_LISTING_DIAGNOSTIC_MESSAGE_BYTES,
  MAX_AGENT_LISTING_PATH_BYTES,
  truncateAgentListingText,
} = await jiti.import('../agent-listing.ts');
const { MAX_PENDING_JOB_WAITS } = await jiti.import('../jobs.ts');
const { MAX_PAGE_BYTES } = await jiti.import('../paging.ts');
const { buildWindowsSupervisorInvocation } = await jiti.import('../windows-supervisor-invocation.ts');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Use the canonical path because macOS exposes many temp directories through symlink aliases.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pi-subagents-test-')));
const assertSameDirectory = (actualPath, expectedPath, message = 'paths should identify the same directory') => {
  const actual = statSync(actualPath);
  const expected = statSync(expectedPath);
  assert.ok(actual.isDirectory() && expected.isDirectory(), message);
  assert.equal(actual.dev, expected.dev, `${message} (device)`);
  assert.equal(actual.ino, expected.ino, message);
};
const traceFile = join(sandbox, 'trace.jsonl');
const oldArgv = process.argv[1];
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.argv[1] = join(root, 'tests/fixtures/fake-pi.mjs');
process.env.PI_CODING_AGENT_DIR = join(sandbox, 'agent');
process.env.SUBAGENT_TEST_TRACE = traceFile;
mkdirSync(join(sandbox, 'agent/agents'), { recursive: true });
writeFileSync(join(sandbox, 'agent/agents/worker.md'), '---\nname: worker\ndescription: Test worker\n---\nTest-only instructions.\n');
writeFileSync(join(sandbox, 'agent/agents/pinned.md'), '---\nname: pinned\ndescription: Pinned worker\nmodel: fake/pinned:high\ntools: [read, bash]\n---\nPinned instructions.\n');
writeFileSync(join(sandbox, 'agent/agents/env-default.md'), '---\nname: env-default\ndescription: Worker that removes selected inherited environment variables\nunsetEnv: [PI_SUBAGENTS_TEST_AGENT_ENV, PI_SUBAGENTS_TEST_CASE_ENV]\n---\nEnvironment test instructions.\n');
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

test('subagent tool description warns that first-use Windows compilation is not timed', () => {
  const description = tools.get('subagent').definition.description;
  assert.match(description, /Windows, first-use supervisor compilation also happens before the deadline and has no independent timeout/);
  assert.match(description, /canceling a caller detaches it but does not stop the shared compile/);
});

test('background returns before completion, retains progress, and sends a follow-up', async () => {
  const releaseFile = join(sandbox, 'background-handoff.release');
  const task = `process-budget-barrier:${releaseFile}|delay=2000 main`;
  rmSync(releaseFile, { force: true });
  let id;
  let launchTimer;
  const launchResult = launch({ task }).then(id => ({ id }), error => ({ error }));
  try {
    const outcome = await Promise.race([
      launchResult,
      new Promise(resolve => { launchTimer = setTimeout(() => resolve(undefined), 15_000); }),
    ]);
    assert.ok(outcome, 'Background invocation should return while its child is held at the test barrier');
    if (outcome.error) throw outcome.error;
    id = outcome.id;
    await waitFor(() => traces().some(entry => entry.event === 'start' && entry.task === task),
      process.platform === 'win32' ? 60_000 : 15_000);
    assert.equal((await status(id)).state, 'running');
    assert.equal(messages.length, 0);
    writeFileSync(releaseFile, 'release');

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
    assert.match(messages[0].message.content, /result: process-budget-barrier:.*\|delay=2000 main/);
    assert.deepEqual(messages[0].options, { deliverAs: 'followUp', triggerTurn: true });
    const child = traces().find(t => t.event === 'start');
    assert.equal(child.model, 'fake/parent');
    assert.equal(child.thinking, 'high');
  } finally {
    clearTimeout(launchTimer);
    // Releasing in finally prevents a failed assertion from stranding the child process.
    writeFileSync(releaseFile, 'release');
    const outcome = await launchResult;
    if (id === undefined && outcome.id) id = outcome.id;
    if (id !== undefined) await finish(id);
    rmSync(releaseFile, { force: true });
  }
});

test('foreground cancellation just after child close does not report a completed result', async t => {
  const controller = new AbortController();
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.pid = 2_000_000_000;
    child.kill = () => false;
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'completed answer' }], stopReason: 'stop',
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      } }) + '\n'));
      child.emit('exit', 0);
      child.emit('close', 0);
    });
    child.stdout = new EventEmitter();
    child.stdout.destroy = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stderr.destroy = () => {};
    const emit = child.emit.bind(child);
    child.emit = (event, ...args) => {
      const emitted = emit(event, ...args);
      if (event === 'close') process.nextTick(() => controller.abort());
      return emitted;
    };
    return child;
  });
  syncBuiltinESMExports();
  try {
    const outcome = await invoke('subagent', { agent: 'worker', task: 'abort after child close' }, ctx(), controller.signal)
      .then(result => ({ result }), reason => ({ reason }));
    assert.equal(outcome.reason, controller.signal.reason,
      'An abort delivered after process cleanup but before the tool result must still cancel the call');
    assert.equal(outcome.result, undefined);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
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
  let latestUpdate;
  const started = performance.now();
  const foreground = await tools.get('subagent').definition.execute(
    'progress-burst-test', { agent: 'worker', task: 'progress-burst:' + count }, undefined,
    partial => { updates++; latestUpdate = partial; }, ctx(),
  );
  const elapsed = performance.now() - started;
  assert.equal(foreground.isError, undefined);
  assert.ok(updates >= 1, 'the first progress notification is immediate');
  assert.ok(updates <= Math.ceil(elapsed / DEFAULT_PROGRESS_UPDATE_INTERVAL_MS) + 2,
    `Progress updates (${updates}) exceeded the configured cadence over ${elapsed.toFixed(1)} ms`);
  const captured = foreground.details.results[0];
  assert.equal(captured.usage.turns, count, 'all child events are still accounted for');
  assert.equal(captured.messages.at(-1).content[0].text, 'burst ' + (count - 1));
  assert.equal(latestUpdate.details.results[0].messages.at(-1).content[0].text, 'burst ' + (count - 1),
    'the final throttled progress update must include the latest captured history');
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

test('length-limited model turns fail as partial results across modes', async () => {
  const single = await invoke('subagent', { agent: 'worker', task: 'length-limit' });
  assert.equal(single.isError, true);
  assert.equal(single.details.results[0].stopReason, 'length');
  assert.equal(single.details.results[0].exitCode, 0, 'The model-level failure is distinct from the successful child exit');
  assert.match(single.content[0].text, /Partial, unverified output/);
  assert.match(single.content[0].text, /result: length-limit/);

  const parallel = await invoke('subagent', { tasks: [
    { agent: 'worker', task: 'ordinary parallel success' },
    { agent: 'worker', task: 'length-limit' },
  ] });
  assert.equal(parallel.isError, true);
  assert.match(parallel.content[0].text, /Parallel: 1\/2 succeeded/);
  assert.match(parallel.content[0].text, /failed \(length\)/);
  assert.match(parallel.content[0].text, /Partial, unverified output/);

  const chain = await invoke('subagent', { chain: [
    { agent: 'worker', task: 'length-limit' },
    { agent: 'worker', task: 'must-not-run-after-length-limit' },
  ] });
  assert.equal(chain.isError, true);
  assert.equal(chain.details.results.length, 1, 'A chain must stop after an incomplete answer');
  assert.match(chain.content[0].text, /Chain stopped at step 1/);
  assert.match(chain.content[0].text, /Partial, unverified output/);
  assert.equal(traces().some(entry => entry.task === 'must-not-run-after-length-limit'), false);

  const id = await launch({ task: 'length-limit' });
  const job = await finish(id);
  assert.equal(job.state, 'failed');
  assert.equal(job.latest.details.results[0].stopReason, 'length');
  assert.ok(messages.at(-1).message.content.includes('failed'));
  const page = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.notEqual(page.isError, true, 'Inspecting an incomplete task is not itself a failure');
  assert.equal(page.structuredContent.output.partial, true);
  assert.equal(page.structuredContent.output.exitCode, 0);
  assert.match(page.structuredContent.output.text, /Partial, unverified output/);
  assert.match(page.structuredContent.output.text, /result: length-limit/);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, page.structuredContent), true);
});

test('deferred model responses fail as incomplete results across modes', async () => {
  const single = await invoke('subagent', { agent: 'worker', task: 'deferred' });
  assert.equal(single.isError, true);
  assert.equal(single.details.results[0].stopReason, 'deferred');
  assert.equal(single.details.results[0].exitCode, 0, 'A deferred handle is a model-level incompletion, not a child-process error');
  assert.match(single.content[0].text, /Subagent failed \(deferred\)/);

  const parallel = await invoke('subagent', { tasks: [
    { agent: 'worker', task: 'ordinary deferred sibling success' },
    { agent: 'worker', task: 'deferred' },
  ] });
  assert.equal(parallel.isError, true);
  assert.match(parallel.content[0].text, /Parallel: 1\/2 succeeded/);
  assert.match(parallel.content[0].text, /failed \(deferred\)/);

  const chain = await invoke('subagent', { chain: [
    { agent: 'worker', task: 'deferred' },
    { agent: 'worker', task: 'must-not-run-after-deferred' },
  ] });
  assert.equal(chain.isError, true);
  assert.equal(chain.details.results.length, 1, 'A chain must stop when the model has not produced a final answer');
  assert.match(chain.content[0].text, /Chain stopped at step 1/);
  assert.match(chain.content[0].text, /Subagent failed \(deferred\)/);
  assert.equal(traces().some(entry => entry.task === 'must-not-run-after-deferred'), false);

  const id = await launch({ task: 'deferred' });
  const job = await finish(id);
  assert.equal(job.state, 'failed');
  assert.equal(job.latest.details.results[0].messages.at(-1).stopReason, 'deferred');
  assert.ok(messages.at(-1).message.content.includes('failed (deferred)'));
  const page = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.notEqual(page.isError, true, 'Inspecting an incomplete task is not itself a failure');
  assert.equal(page.structuredContent.output.partial, true);
  assert.equal(page.structuredContent.output.exitCode, 0);
  assert.match(page.structuredContent.output.text, /Subagent failed \(deferred\)/);
  assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, page.structuredContent), true);
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
  assertSameDirectory(children[1].cwd, join(sandbox, 'project'));
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
  const releaseFile = join(sandbox, 'process-budget.release');
  rmSync(releaseFile, { force: true });
  const batch = prefix => Array.from({ length: 6 }, (_, i) => ({
    agent: 'worker', task: `process-budget-barrier:${releaseFile}|${prefix}-${i}`,
  }));
  const a = await invoke('subagent', { background: true, tasks: batch('a') });
  const b = await invoke('subagent', { background: true, tasks: batch('b') });
  const foreground = invoke('subagent', {
    agent: 'worker', task: `process-budget-barrier:${releaseFile}|foreground`,
  });
  const work = Promise.allSettled([finish(a.details.background.id), finish(b.details.background.id), foreground]);
  // Keep every launched child alive until the shared pool has demonstrably filled.
  // This tests the cap without relying on child startup being faster than a short sleep.
  try {
    await waitFor(() => traces().filter(entry => entry.event === 'start' &&
      entry.task.startsWith('process-budget-barrier:')).length >= 4);
    const activeBeforeRelease = traces().filter(entry => entry.event === 'start' &&
      entry.task.startsWith('process-budget-barrier:')).length;
    assert.equal(activeBeforeRelease, 4);
    writeFileSync(releaseFile, 'release');
    const outcomes = await work;
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    writeFileSync(releaseFile, 'release');
    await work;
    rmSync(releaseFile, { force: true });
  }
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

test('temporary prompt files and directories are private on POSIX', { skip: process.platform === 'win32' }, async t => {
  let promptPath;
  let releaseWrite, enteredWrite;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  const entered = new Promise(resolve => { enteredWrite = resolve; });
  const originalWrite = fsPromises.writeFile;
  const write = t.mock.method(fsPromises, 'writeFile', async (...args) => {
    const result = await originalWrite(...args);
    promptPath = args[0];
    enteredWrite();
    await gate;
    return result;
  });
  syncBuiltinESMExports();
  try {
    const id = await launch({ task: 'private prompt permissions' });
    await entered;
    const directory = await fsPromises.stat(dirname(promptPath));
    const file = await fsPromises.stat(promptPath);
    assert.equal(directory.mode & 0o077, 0, 'Temporary prompt directory must not grant group or other access');
    assert.equal(file.mode & 0o077, 0, 'Temporary prompt file must not grant group or other access');
    releaseWrite();
    assert.equal((await finish(id)).state, 'completed');
  } finally {
    releaseWrite();
    write.mock.restore();
    syncBuiltinESMExports();
  }
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

test('Windows supervisor invocations keep a near-limit cwd out of argv', () => {
  const targetLength = MAX_WORKING_DIRECTORY_LENGTH - 32;
  const prefix = join(sandbox, 'long-working-directory');
  const segments = [];
  let addedLength = 0;
  while (addedLength < targetLength - prefix.length) {
    const length = Math.min(200, targetLength - prefix.length - addedLength - 1);
    segments.push('x'.repeat(length));
    addedLength += length + 1;
  }
  const cwd = join(prefix, ...segments);
  assert.equal(cwd.length, targetLength);
  assert.ok(segments.every(segment => segment.length <= 200));

  const invocation = buildWindowsSupervisorInvocation('supervisor.exe', {
    command: 'pi', args: ['--mode', 'json', '--task', 'long cwd'],
  }, cwd, []);
  assert.equal(invocation.cwd, cwd);
  assert.equal(invocation.args.includes(cwd), false,
    'the working directory must be passed separately from the Windows command line');
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
    assertSameDirectory(argumentTrace.cwd, workingDirectory, 'the working directory must survive paths with spaces');

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
  let offset = 0, pagedStderr = '';
  do {
    const page = await invoke('subagent_jobs', { action: 'output', jobId: stderrJob.id, stream: 'stderr', offset, limit: 32768 });
    const output = page.structuredContent.output;
    assert.equal(output.stream, 'stderr');
    assert.equal(output.stderrTruncated, true);
    assert.equal(output.totalBytes, Buffer.byteLength(result.stderr));
    assert.ok(Buffer.byteLength(output.text) <= 32768);
    pagedStderr += output.text;
    if (output.nextOffset === null) break;
    offset = output.nextOffset;
  } while (true);
  assert.equal(pagedStderr, result.stderr, 'The stderr stream pages reconstruct its bounded capture including the truncation notice');
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

test('a completed assistant answer evicted by trailing messages fails instead of reporting empty success', async () => {
  const result = await invoke('subagent', { agent: 'worker', task: 'history-final-evicted' });
  const task = result.details.results[0];
  assert.equal(result.isError, true);
  assert.equal(task.processExitCode, 0);
  assert.equal(task.exitCode, 1);
  assert.equal(task.capture.finalAssistantMessageDropped, true);
  assert.equal(task.messages.some(message => message.role === 'assistant'), false);
  assert.match(task.errorMessage, /Final assistant message was not retained in bounded history capture/);
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
  const occupying = await invoke('subagent', { background: true, tasks: Array.from({ length: 4 }, () => ({ agent: 'worker', task: 'delay=3000 occupy' })) });
  await waitFor(() => traces().filter(t => t.event === 'start').length === 4);
  const queued = await launch({ task: 'queued deadline', timeoutMs: 2000 });
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
  // Leave more than the startup-observation window before the runtime deadline,
  // so a slow CI runner cannot time out the child before it emits its start trace.
  const id = await launch({ task: 'delay=10000 stubborn canceled deadline', timeoutMs: 30_000 });
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
  const tagPreview = definition.renderCall({ agentTags: ['security', 'code-review'], task: 'preview' }, theme, {}).render(80).join('\n');
  assert.ok(tagPreview.includes('tags:[security,code-review]'));
  const hostileTagPreview = definition.renderCall({ agentTags: [`unsafe${rawEscape}[31m`], task: 'preview' }, theme, {}).render(80).join('\n');
  assert.equal(hostileTagPreview.includes(rawEscape), false);
  assert.ok(hostileTagPreview.includes('u001b'));
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
  const call = definition.renderCall({ action: 'output', jobId: hostileId, stepId: `review${esc}[2J` }, theme, {});
  const renderedCall = call.render(100).join('\n');
  assert.equal(renderedCall.includes(esc), false);
  assert.equal(renderedCall.includes(c1Csi), false);
  assert.ok(renderedCall.includes('\\u001b[2J'));
  assert.ok(renderedCall.includes('\\u009b2J'));
  assert.ok(renderedCall.includes('step review\\u001b[2J'));
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

test('working directory arguments reject empty, non-string, NUL, and overlong paths before approval or spawn', async () => {
  let approvals = 0;
  const context = {
    ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } },
  };
  const tooLong = 'x'.repeat(MAX_WORKING_DIRECTORY_LENGTH + 1);
  const unpairedPath = `invalid${String.fromCharCode(0xd800)}path`;
  const invalid = [
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: null },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: '' },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: 'bad\0path' },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: unpairedPath },
    { agent: 'project', task: 'invalid cwd', agentScope: 'project', cwd: tooLong },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: {} }] },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: '' }] },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: unpairedPath }] },
    { agentScope: 'project', tasks: [{ agent: 'project', task: 'invalid cwd', cwd: tooLong }] },
    { agentScope: 'project', chain: [{ agent: 'project', task: 'invalid cwd', cwd: '' }] },
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
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'invalid', cwd: '' }), false);
  assert.equal(Value.Check(schema, { tasks: [{ agent: 'worker', task: 'invalid', cwd: '' }] }), false);
  assert.equal(Value.Check(schema, { chain: [{ agent: 'worker', task: 'invalid', cwd: '' }] }), false);
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

test('unsetEnv filters inherited variables additively for agents, calls, entries, chains, and background jobs', async t => {
  const variableNames = [
    'PI_SUBAGENTS_TEST_AGENT_ENV', 'PI_SUBAGENTS_TEST_CALL_ENV',
    'PI_SUBAGENTS_TEST_ENTRY_ENV', 'PI_SUBAGENTS_TEST_KEEP_ENV', 'pi_subagents_test_case_env',
    'PI_SUBAGENTS_TEST_KEEP_UNICODE', 'PI_SUBAGENTS_TEST_KEEP_EMPTY',
  ];
  const previous = new Map(variableNames.map(name => [name, process.env[name]]));
  for (const name of variableNames) process.env[name] = `test-only-${name}`;
  process.env.PI_SUBAGENTS_TEST_KEEP_UNICODE = 'test-only-東京=🛰️';
  process.env.PI_SUBAGENTS_TEST_KEEP_EMPTY = '';
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const single = await invoke('subagent', {
    agent: 'env-default', task: 'unset-env single', unsetEnv: ['PI_SUBAGENTS_TEST_CALL_ENV'],
  });
  const child = task => traces().find(entry => entry.event === 'start' && entry.task === task);
  const presence = task => child(task).envPresence;
  assert.equal(single.details.results[0].exitCode, 0);
  assert.deepEqual(presence('unset-env single'), {
    PI_SUBAGENTS_TEST_AGENT_ENV: false,
    PI_SUBAGENTS_TEST_CALL_ENV: false,
    PI_SUBAGENTS_TEST_ENTRY_ENV: true,
    PI_SUBAGENTS_TEST_KEEP_ENV: true,
  });
  assert.equal(child('unset-env single').nestingDepth, '1', 'the internal recursion guard must always reach the child');
  assert.equal(child('unset-env single').retainedEnvironmentPreserved, true,
    'filtering must preserve unrelated Unicode environment values and equals signs');
  assert.equal(child('unset-env single').retainedEmptyEnvironmentPreserved, true,
    'filtering must preserve unrelated variables whose value is empty');
  assert.deepEqual(child('unset-env single').caseEnvPresence,
    process.platform === 'win32'
      ? { configuredName: false, differentCase: false }
      : { configuredName: false, differentCase: true },
    'Windows filtering is case-insensitive while POSIX environment names remain case-sensitive');

  const parallel = await invoke('subagent', {
    unsetEnv: ['PI_SUBAGENTS_TEST_CALL_ENV'],
    tasks: [
      { agent: 'worker', task: 'unset-env parallel entry', unsetEnv: ['PI_SUBAGENTS_TEST_ENTRY_ENV'] },
      { agent: 'env-default', task: 'unset-env parallel default' },
    ],
  });
  assert.equal(parallel.details.results.every(result => result.exitCode === 0), true);
  assert.deepEqual(presence('unset-env parallel entry'), {
    PI_SUBAGENTS_TEST_AGENT_ENV: true,
    PI_SUBAGENTS_TEST_CALL_ENV: false,
    PI_SUBAGENTS_TEST_ENTRY_ENV: false,
    PI_SUBAGENTS_TEST_KEEP_ENV: true,
  });
  assert.deepEqual(presence('unset-env parallel default'), {
    PI_SUBAGENTS_TEST_AGENT_ENV: false,
    PI_SUBAGENTS_TEST_CALL_ENV: false,
    PI_SUBAGENTS_TEST_ENTRY_ENV: true,
    PI_SUBAGENTS_TEST_KEEP_ENV: true,
  });

  const chain = await invoke('subagent', {
    unsetEnv: ['PI_SUBAGENTS_TEST_CALL_ENV'],
    chain: [
      { agent: 'worker', task: 'unset-env chain first' },
      { agent: 'env-default', task: 'unset-env chain second', unsetEnv: ['PI_SUBAGENTS_TEST_ENTRY_ENV'] },
    ],
  });
  assert.equal(chain.details.results.every(result => result.exitCode === 0), true);
  assert.equal(presence('unset-env chain first').PI_SUBAGENTS_TEST_CALL_ENV, false);
  assert.equal(presence('unset-env chain first').PI_SUBAGENTS_TEST_ENTRY_ENV, true);
  assert.deepEqual(presence('unset-env chain second'), {
    PI_SUBAGENTS_TEST_AGENT_ENV: false,
    PI_SUBAGENTS_TEST_CALL_ENV: false,
    PI_SUBAGENTS_TEST_ENTRY_ENV: false,
    PI_SUBAGENTS_TEST_KEEP_ENV: true,
  });

  const background = await invoke('subagent', {
    agent: 'env-default', task: 'unset-env background', unsetEnv: ['PI_SUBAGENTS_TEST_CALL_ENV'],
    background: true, notify: false,
  });
  assert.equal((await finish(background.details.background.id)).state, 'completed');
  assert.equal(presence('unset-env background').PI_SUBAGENTS_TEST_AGENT_ENV, false);
  assert.equal(presence('unset-env background').PI_SUBAGENTS_TEST_CALL_ENV, false);
  assert.equal(presence('unset-env background').PI_SUBAGENTS_TEST_KEEP_ENV, true);

  const listing = await invoke('subagent_agents', {});
  assert.deepEqual(listing.details.agents.find(agent => agent.name === 'env-default').unsetEnv,
    ['PI_SUBAGENTS_TEST_AGENT_ENV', 'PI_SUBAGENTS_TEST_CASE_ENV']);
  assert.match(listing.content[0].text, /unsetEnv=/);
});

test('unsetEnv bounds names and rejects malformed or internal variables before approval or spawn', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { approvals++; return true; } } };
  const schema = tools.get('subagent').definition.parameters;
  const invalid = [
    { agent: 'project', task: 'bad env name', agentScope: 'project', unsetEnv: ['BAD=NAME'] },
    { agent: 'project', task: 'bad env name', agentScope: 'project', unsetEnv: ['bad-name'] },
    { tasks: [{ agent: 'project', task: 'reserved env name', unsetEnv: ['pi_subagents_nesting_depth'] }], agentScope: 'project' },
    { chain: [{ agent: 'project', task: 'invalid env name', unsetEnv: ['1BAD'] }], agentScope: 'project' },
    { agent: 'project', task: 'overlong env name', agentScope: 'project', unsetEnv: ['x'.repeat(4097)] },
  ];
  assert.equal(Value.Check(schema, invalid[0]), false, 'the schema rejects names outside the portable environment-name syntax');
  assert.equal(Value.Check(schema, invalid[2]), true, 'the internal variable is reserved by runtime validation');
  for (const params of invalid) {
    const result = await invoke('subagent', params, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unsetEnv/);
  }
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'valid', unsetEnv: ['AWS_SECRET_ACCESS_KEY'] }), true);
  assert.equal(Value.Check(schema, invalid[4]), true, 'individual byte limits are checked by the bounded runtime parser');
  assert.equal(Value.Check(schema, { agent: 'worker', task: 'invalid', unsetEnv: Array.from({ length: 129 }, (_, i) => `ENV_${i}`) }), false);

  const fullList = Array.from({ length: 128 }, (_, index) => `FILTER_${index}`);
  const configPath = join(sandbox, 'project/.pi/agents/full-env-list.md');
  writeFileSync(configPath, `---\nname: full-env-list\ndescription: Full inherited environment filter\nunsetEnv: ${JSON.stringify(fullList)}\n---\nTest.\n`);
  try {
    const combined = await invoke('subagent', {
      agent: 'full-env-list', task: 'combined env filter', agentScope: 'project', unsetEnv: ['ADDITIONAL_FILTER'],
    }, context);
    assert.equal(combined.isError, true);
    assert.match(combined.content[0].text, /Invalid effective unsetEnv configuration/);
    assert.equal(approvals, 0, 'combined limits must be enforced before project approval');
    assert.equal(traces().length, 0, 'oversized combined filters must not spawn');
  } finally { rmSync(configPath, { force: true }); }
});

test('top-level cwd defaults parallel and chain children while entry directories override it', async () => {
  const alternate = join(sandbox, 'alternate');
  mkdirSync(alternate, { recursive: true });
  const parallel = await invoke('subagent', {
    cwd: 'project',
    tasks: [
      { agent: 'worker', task: 'parallel-default-cwd' },
      { agent: 'worker', task: 'parallel-entry-cwd', cwd: 'alternate' },
    ],
  });
  assert.notEqual(parallel.isError, true);
  const parallelChildren = new Map(traces().filter(t => t.event === 'start').map(t => [t.task, t.cwd]));
  assertSameDirectory(parallelChildren.get('parallel-default-cwd'), join(sandbox, 'project'));
  assertSameDirectory(parallelChildren.get('parallel-entry-cwd'), alternate);

  const chain = await invoke('subagent', {
    cwd: 'project',
    chain: [
      { agent: 'worker', task: 'chain-default-cwd' },
      { agent: 'worker', task: 'chain-entry-cwd', cwd: 'alternate' },
    ],
  });
  assert.equal(chain.isError, undefined);
  const chainChildren = new Map(traces().filter(t => t.event === 'start').map(t => [t.task, t.cwd]));
  assertSameDirectory(chainChildren.get('chain-default-cwd'), join(sandbox, 'project'));
  assertSameDirectory(chainChildren.get('chain-entry-cwd'), alternate);
});

test('agent working-directory defaults resolve from the parent and yield to dispatch overrides in every mode', async () => {
  const file = join(sandbox, 'agent/agents/cwd-default.md');
  const agentDirectory = join(sandbox, 'agent-work');
  const callDirectory = join(sandbox, 'call-work');
  const entryDirectory = join(sandbox, 'entry-work');
  for (const directory of [agentDirectory, callDirectory, entryDirectory]) mkdirSync(directory, { recursive: true });
  writeFileSync(file, '---\nname: cwd-default\ndescription: Working directory default\ncwd: agent-work\n---\nCwd worker.\n');
  try {
    const listing = await invoke('subagent_agents', {});
    const configured = listing.details.agents.find(agent => agent.name === 'cwd-default');
    assert.equal(configured.cwd, 'agent-work');
    assert.match(listing.content[0].text, /cwd=.*agent-work/);
    assert.equal(Value.Check(tools.get('subagent_agents').definition.outputSchema, listing.structuredContent), true);

    const emptyOverride = await invoke('subagent', {
      agent: 'cwd-default', task: 'empty cwd must not bypass agent default', cwd: '',
    });
    assert.equal(emptyOverride.isError, true);
    assert.match(emptyOverride.content[0].text, /cwd must be a non-empty path/);
    assert.equal(traces().some(entry => entry.task === 'empty cwd must not bypass agent default'), false);

    const single = await invoke('subagent', { agent: 'cwd-default', task: 'cwd default single' });
    assert.equal(single.isError, undefined);
    assertSameDirectory(traces().find(entry => entry.task === 'cwd default single').cwd, agentDirectory);

    const parallel = await invoke('subagent', {
      cwd: 'call-work',
      tasks: [
        { agent: 'cwd-default', task: 'cwd call default parallel' },
        { agent: 'cwd-default', task: 'cwd entry override parallel', cwd: 'entry-work' },
      ],
    });
    assert.notEqual(parallel.isError, true);
    assertSameDirectory(traces().find(entry => entry.task === 'cwd call default parallel').cwd, callDirectory);
    assertSameDirectory(traces().find(entry => entry.task === 'cwd entry override parallel').cwd, entryDirectory);

    const chain = await invoke('subagent', {
      chain: [
        { agent: 'cwd-default', task: 'cwd default chain' },
        { agent: 'cwd-default', task: 'cwd entry override chain', cwd: 'entry-work' },
      ],
    });
    assert.equal(chain.isError, undefined);
    assertSameDirectory(traces().find(entry => entry.task.startsWith('cwd default chain')).cwd, agentDirectory);
    assertSameDirectory(traces().find(entry => entry.task.startsWith('cwd entry override chain')).cwd, entryDirectory);

    const background = await invoke('subagent', {
      background: true, agent: 'cwd-default', task: 'cwd default background',
    });
    assert.equal((await finish(background.details.background.id)).state, 'completed');
    assertSameDirectory(traces().find(entry => entry.task === 'cwd default background').cwd, agentDirectory);
  } finally { rmSync(file); }
});

test('large tasks use stdin and relative cwd resolves from the parent session', async () => {
  const task = 'x'.repeat(256 * 1024);
  const result = await invoke('subagent', { agent: 'worker', task, cwd: 'project' });
  assert.equal(result.isError, undefined);
  const child = traces().find(t => t.event === 'start');
  assert.equal(child.task, task);
  assertSameDirectory(child.cwd, join(sandbox, 'project'));
});

test('agent working-directory defaults are bounded after resolution before project approval', async () => {
  const agentFile = join(sandbox, 'project/.pi/agents/long-cwd.md');
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async () => { throw new Error('An overlong resolved cwd must fail before approval'); } } };
  const tooLong = 'x'.repeat(MAX_WORKING_DIRECTORY_LENGTH);
  writeFileSync(agentFile, `---\nname: long-cwd\ndescription: Long configured path\ncwd: ${JSON.stringify(tooLong)}\n---\nInvalid after resolution.\n`);
  try {
    const result = await invoke('subagent', {
      agent: 'long-cwd', task: 'must not launch', agentScope: 'project',
    }, context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Resolved cwd must not exceed/);
    assert.equal(JSON.stringify(result).includes(tooLong), false);
    assert.equal(traces().length, 0);
  } finally { rmSync(agentFile, { force: true }); }
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
    assert.deepEqual(result.details.agents.map(a => a.name), ['env-default', 'pinned', 'worker']);
    assert.ok(result.details.agents.every(a => a.systemPrompt === undefined));
    assert.equal(result.details.diagnostics.length, 1);
    assert.deepEqual(result.structuredContent, result.details);
    const project = await invoke('subagent_agents', { agentScope: 'project' }, { ...ctx(), cwd: join(sandbox, 'project') });
    assert.deepEqual(project.details.agents.map(a => a.name), ['project']);
    assert.equal(traces().length, 0);
  } finally { rmSync(badFile); }
});

test('agent listing paginates large inventories with bounded text and metadata', async () => {
  const directory = join(sandbox, 'agent/agents');
  const files = [];
  const longCwd = 'c'.repeat(MAX_WORKING_DIRECTORY_LENGTH);
  for (let index = 0; index < 24; index++) {
    const name = `zz-page-${String(index).padStart(3, '0')}`;
    const file = join(directory, `${name}.md`);
    writeFileSync(file, `---\nname: ${name}\ndescription: Paged agent ${index}\ncwd: ${JSON.stringify(longCwd)}\n---\nPrivate prompt ${index}.\n`);
    files.push(file);
  }
  for (let index = 0; index < 70; index++) {
    const file = join(directory, `bad-page-${String(index).padStart(3, '0')}.md`);
    writeFileSync(file, '---\nname: [invalid\n---\n');
    files.push(file);
  }
  try {
    const schema = tools.get('subagent_agents').definition.outputSchema;
    const first = await invoke('subagent_agents', {});
    assert.equal(Value.Check(schema, first.structuredContent), true);
    assert.equal(first.details.offset, 0);
    assert.equal(first.details.limit, 10);
    assert.equal(first.details.totalAgents, 27);
    assert.equal(first.details.agents.length, 10);
    assert.equal(first.details.diagnostics.length, MAX_AGENT_DIAGNOSTICS);
    assert.equal(first.details.diagnostics.at(-1).message, 'Further agent diagnostics omitted.');
    assert.equal(first.details.nextOffset, 10);
    assert.match(first.content[0].text, /Agents 1-10 of 27\. Continue with offset 10\./);
    assert.ok(Buffer.byteLength(first.content[0].text) <= 50 * 1024);
    assert.ok(first.details.agents.every(agent => agent.systemPrompt === undefined));
    const longEntry = first.details.agents.find(agent => agent.name === 'zz-page-000');
    assert.equal(longEntry.cwd, truncateAgentListingText(longCwd, MAX_AGENT_LISTING_PATH_BYTES),
      'structured pages explicitly truncate oversized cwd metadata');
    assert.ok(longEntry.cwd.endsWith('…[truncated]'));
    assert.equal(first.content[0].text.includes(longCwd), false, 'oversized display fields are clipped without truncating the page');

    const pages = [first.structuredContent];
    let nextOffset = first.details.nextOffset;
    while (nextOffset !== null) {
      const page = await invoke('subagent_agents', { offset: nextOffset, limit: 7 });
      assert.equal(Value.Check(schema, page.structuredContent), true);
      assert.equal(page.details.offset, nextOffset);
      assert.equal(page.details.limit, 7);
      assert.ok(page.details.agents.length <= 7);
      assert.ok(Buffer.byteLength(page.content[0].text) <= 50 * 1024);
      pages.push(page.structuredContent);
      nextOffset = page.details.nextOffset;
    }
    const names = pages.flatMap(page => page.agents.map(agent => agent.name));
    assert.deepEqual(names, [...names].sort());
    assert.equal(new Set(names).size, names.length, 'pages must not overlap');
    assert.equal(names.length, first.details.totalAgents);
    assert.equal(names.at(-1), 'zz-page-023');
    assert.equal(pages.at(-1).nextOffset, null);
    assert.equal(traces().length, 0);
  } finally {
    for (const file of files) rmSync(file, { force: true });
  }
});

test('agent listing supports exact-name lookup after scope precedence', async () => {
  const projectAgent = join(sandbox, 'project/.pi/agents/worker-override.md');
  writeFileSync(projectAgent, '---\nname: worker\ndescription: Project worker override\ntools: [read]\n---\nProject-only instructions.\n');
  try {
    const schema = tools.get('subagent_agents').definition.outputSchema;
    const parameters = tools.get('subagent_agents').definition.parameters;
    assert.equal(Value.Check(parameters, { name: 'worker' }), true);

    const personal = await invoke('subagent_agents', { name: 'worker' });
    assert.equal(Value.Check(schema, personal.structuredContent), true);
    assert.equal(personal.details.agents.length, 1);
    assert.equal(personal.details.totalAgents, 1);
    assert.equal(personal.details.agents[0].source, 'user');
    assert.equal(personal.details.agents[0].description, 'Test worker');
    assert.equal(personal.details.nextOffset, null);

    const projectContext = { ...ctx(), cwd: join(sandbox, 'project') };
    const both = await invoke('subagent_agents', { agentScope: 'both', name: 'worker' }, projectContext);
    assert.equal(Value.Check(schema, both.structuredContent), true);
    assert.equal(both.details.agents.length, 1);
    assert.equal(both.details.totalAgents, 1, 'totals describe the filtered inventory');
    assert.equal(both.details.agents[0].source, 'project', 'project precedence is resolved before filtering');
    assert.equal(both.details.agents[0].description, 'Project worker override');
    assert.deepEqual(both.details.agents[0].tools, ['read']);

    const missing = await invoke('subagent_agents', { name: 'Worker' });
    assert.equal(Value.Check(schema, missing.structuredContent), true);
    assert.deepEqual(missing.details.agents, []);
    assert.equal(missing.details.totalAgents, 0);
    assert.match(missing.content[0].text, /No agent named `Worker` found/);

    const pastMatch = await invoke('subagent_agents', { name: 'worker', offset: 1 });
    assert.deepEqual(pastMatch.details.agents, []);
    assert.equal(pastMatch.details.totalAgents, 1);
    assert.match(pastMatch.content[0].text, /No agents at offset 1; 1 total/);
    assert.equal(traces().length, 0);
  } finally { rmSync(projectAgent, { force: true }); }
});

test('agent listing searches identity, capabilities, source filenames, and configured defaults after scope precedence with filtered pagination', async () => {
  const definitions = [
    ['lookup-oauth.md', 'lookup-oauth', 'OAuth security reviewer'],
    ['lookup-docs.md', 'lookup-docs', 'OAuth documentation writer'],
    ['lookup-db.md', 'lookup-db', 'Database migration helper'],
    ['source-label-only.md', 'lookup-filename-only', 'Plain description'],
    ['lookup-tool.md', 'lookup-tool-agent', 'Configured transport helper', ['read', 'custom-shell']],
    ['lookup-greek.md', 'lookup-greek', 'ΟΣ reviewer'],
    ['lookup-sharp-s-name.md', 'straße-reviewer', 'German language reviewer'],
    ['lookup-sharp-s-description.md', 'lookup-sharp-s-description', 'Straße compliance reviewer'],
    ['lookup-long-s.md', 'lookup-long-s', 'ſtraße support reviewer'],
    ['lookup-long-s-name.md', 'ſupport-reviewer', 'Long-s agent name'],
    ['lookup-ligature.md', 'lookup-ligature', 'Oﬃce formatting specialist'],
    ['lookup-beta-symbol.md', 'lookup-beta-symbol', 'ϐeta symbol reference'],
    ['lookup-micro-sign.md', 'lookup-micro-sign', 'µm conversion guide'],
    ['lookup-cafe-composed.md', 'lookup-cafe-composed', 'Café tooling'],
    ['lookup-cafe-decomposed.md', 'lookup-cafe-decomposed', 'Cafe\u0301 assistant'],
    ['lookup-café-name.md', 'lookup-café-name', 'Canonical name search'],
    ['lookup-model.md', 'lookup-model', 'Explicit model routing helper', undefined, 'vendor/custom-Reasoner', 'xhigh'],
    ['lookup-override.md', 'lookup-override', 'Secret token helper', ['custom-shell'], 'vendor/personal-secret', 'low', ['AWS_SECRET_ACCESS_KEY'], '/work/personal-runtime', 456000],
  ];
  const userFiles = definitions.map(([filename, name, description, configuredTools, model, thinking, unsetEnv, cwd, timeoutMs]) => {
    const file = join(sandbox, 'agent/agents', filename);
    const metadata = [
      ...(configuredTools ? [`tools: ${JSON.stringify(configuredTools)}`] : []),
      ...(model ? [`model: ${model}`] : []),
      ...(thinking ? [`thinking: ${thinking}`] : []),
      ...(unsetEnv ? [`unsetEnv: ${JSON.stringify(unsetEnv)}`] : []),
      ...(cwd ? [`cwd: ${JSON.stringify(cwd)}`] : []),
      ...(timeoutMs ? [`timeoutMs: ${timeoutMs}`] : []),
      ...(name === 'lookup-docs' ? [`tags: ${JSON.stringify(['Documentation', 'Security'])}`] : []),
      ...(name === 'lookup-oauth' ? [`tags: ${JSON.stringify(['Incident-Response', 'documentation', 'SECURITY'])}`] : []),
      ...(name === 'lookup-override' ? [`tags: ${JSON.stringify(['personal-sensitive'])}`] : []),
    ].join('\n');
    writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${metadata ? `${metadata}\n` : ''}---\nSearch test instructions.\n`);
    return file;
  });
  const projectOverride = join(sandbox, 'project/.pi/agents/lookup-override.md');
  writeFileSync(projectOverride, '---\nname: lookup-override\ndescription: Database project reviewer\ntools: [read]\ntags: [project-review]\nmodel: vendor/project-model\nthinking: max\nunsetEnv: [GITHUB_TOKEN]\ncwd: /work/project-runtime\ntimeoutMs: 654000\n---\nProject override instructions.\n');
  try {
    const toolDescription = tools.get('subagent_agents').definition.description;
    assert.match(toolDescription, /search names, descriptions, source filenames, capability tags, configured tools, environment filters, models, thinking settings, working directories, and deadlines/);
    assert.match(toolDescription, /tag to filter by one exact, case-insensitive capability label, tags to require every listed exact label/);
    assert.match(toolDescription, /Tags are bounded lowercase discovery labels; subagent can dispatch through agentTags when the all-tags match is unique/);
    assert.match(toolDescription, /Tags do not configure child execution settings/);
    assert.match(toolDescription, /definition filenames \(not parent directories\)/);
    assert.match(toolDescription, /cwd paths/);
    assert.match(toolDescription, /decimal timeoutMs values \(milliseconds\)/);
    assert.match(toolDescription, /unsetEnv variable names/);
    assert.match(toolDescription, /Reports invalid and duplicate definitions and agent-directory inspection failures/);
    assert.match(toolDescription, /runtime-default tools, inherited cwd paths and model\/thinking settings, and unspecified deadlines are not inferred/);
    assert.match(toolDescription, /environment variable values are never searched/);
    const schema = tools.get('subagent_agents').definition.outputSchema;
    const parameters = tools.get('subagent_agents').definition.parameters;
    assert.equal(Value.Check(parameters, { query: '  oAuTh ' }), true);

    const first = await invoke('subagent_agents', { query: '  oAuTh ', limit: 1 });
    assert.equal(Value.Check(schema, first.structuredContent), true);
    assert.equal(first.details.totalAgents, 2);
    assert.equal(first.details.agents[0].name, 'lookup-docs');
    assert.equal(first.details.nextOffset, 1);
    assert.match(first.content[0].text, /Results for "`oAuTh`": Agents 1-1 of 2/);

    const second = await invoke('subagent_agents', { query: 'oauth', offset: first.details.nextOffset, limit: 1 });
    assert.equal(second.details.totalAgents, 2);
    assert.equal(second.details.agents[0].name, 'lookup-oauth');
    assert.equal(second.details.nextOffset, null);

    const nameMatch = await invoke('subagent_agents', { query: 'LOOKUP-DB' });
    assert.deepEqual(nameMatch.details.agents.map(agent => agent.name), ['lookup-db']);

    const filenameMatch = await invoke('subagent_agents', { query: 'SOURCE-LABEL' });
    assert.deepEqual(filenameMatch.details.agents.map(agent => agent.name), ['lookup-filename-only']);
    assert.equal(filenameMatch.details.totalAgents, 1,
      'source filenames are searchable even when their labels are absent from frontmatter');
    const parentDirectoryOnly = await invoke('subagent_agents', { query: 'pi-subagents-test-' });
    assert.equal(parentDirectoryOnly.details.totalAgents, 0,
      'source search matches only the definition basename, not local directory components');

    const tagMatch = await invoke('subagent_agents', { query: 'INCIDENT-RESPONSE' });
    assert.equal(Value.Check(schema, tagMatch.structuredContent), true);
    assert.deepEqual(tagMatch.details.agents.map(agent => agent.name), ['lookup-oauth']);
    assert.deepEqual(tagMatch.details.agents[0].tags, ['incident-response', 'documentation', 'security']);
    assert.match(tagMatch.content[0].text, /tags=incident-response,documentation,security/);

    assert.equal(Value.Check(parameters, { tag: 'DOCUMENTATION', limit: 1 }), true);
    const documentationFirst = await invoke('subagent_agents', { tag: 'DOCUMENTATION', limit: 1 });
    assert.equal(documentationFirst.details.totalAgents, 2);
    assert.deepEqual(documentationFirst.details.agents.map(agent => agent.name), ['lookup-docs']);
    assert.equal(documentationFirst.details.nextOffset, 1);
    assert.match(documentationFirst.content[0].text, /Results for tag "documentation": Agents 1-1 of 2/);
    const documentationSecond = await invoke('subagent_agents', {
      tag: 'documentation', offset: documentationFirst.details.nextOffset, limit: 1,
    });
    assert.deepEqual(documentationSecond.details.agents.map(agent => agent.name), ['lookup-oauth']);
    assert.equal(documentationSecond.details.totalAgents, 2);
    assert.equal(documentationSecond.details.nextOffset, null);
    const partialTag = await invoke('subagent_agents', { tag: 'doc' });
    assert.equal(partialTag.details.totalAgents, 0, 'tag filters match complete labels, not substrings');
    const descriptionOnlyTag = await invoke('subagent_agents', { tag: 'oauth' });
    assert.equal(descriptionOnlyTag.details.totalAgents, 0, 'tag filters ignore matching descriptions and other metadata');

    assert.equal(Value.Check(parameters, { tags: ['SECURITY', 'DOCUMENTATION', 'security'], limit: 1 }), true);
    const matchingTagsFirst = await invoke('subagent_agents', {
      tags: ['SECURITY', 'DOCUMENTATION', 'security'], limit: 1,
    });
    assert.equal(matchingTagsFirst.details.totalAgents, 2);
    assert.deepEqual(matchingTagsFirst.details.agents.map(agent => agent.name), ['lookup-docs']);
    assert.equal(matchingTagsFirst.details.nextOffset, 1);
    assert.match(matchingTagsFirst.content[0].text, /Results with all tags "security", "documentation": Agents 1-1 of 2/);
    const matchingTagsSecond = await invoke('subagent_agents', {
      tags: ['documentation', 'security'], offset: matchingTagsFirst.details.nextOffset, limit: 1,
    });
    assert.deepEqual(matchingTagsSecond.details.agents.map(agent => agent.name), ['lookup-oauth']);
    assert.equal(matchingTagsSecond.details.totalAgents, 2);
    assert.equal(matchingTagsSecond.details.nextOffset, null);
    const tagIntersection = await invoke('subagent_agents', { tags: ['incident-response', 'security'] });
    assert.deepEqual(tagIntersection.details.agents.map(agent => agent.name), ['lookup-oauth']);
    assert.equal((await invoke('subagent_agents', { tags: ['security', 'code-review'] })).details.totalAgents, 0,
      'multi-tag filtering requires every exact label, not any one label');

    const configuredToolMatch = await invoke('subagent_agents', { query: 'CUSTOM-SHELL' });
    assert.deepEqual(configuredToolMatch.details.agents.map(agent => agent.name), ['lookup-override', 'lookup-tool-agent']);
    assert.deepEqual(configuredToolMatch.details.agents[1].tools, ['read', 'custom-shell']);
    const scopedToolMatch = await invoke('subagent_agents', {
      agentScope: 'both', query: 'CUSTOM-SHELL',
    }, { ...ctx(), cwd: join(sandbox, 'project') });
    assert.deepEqual(scopedToolMatch.details.agents.map(agent => agent.name), ['lookup-tool-agent'],
      'a project override with a different configured tool list replaces the personal definition before search');

    const modelMatch = await invoke('subagent_agents', { query: 'VENDOR/CUSTOM-REASONER' });
    assert.equal(Value.Check(schema, modelMatch.structuredContent), true);
    assert.deepEqual(modelMatch.details.agents.map(agent => agent.name), ['lookup-model']);
    assert.equal(modelMatch.details.agents[0].model, 'vendor/custom-Reasoner');
    const thinkingMatch = await invoke('subagent_agents', { query: 'XHIGH' });
    assert.deepEqual(thinkingMatch.details.agents.map(agent => agent.name), ['lookup-model']);
    assert.equal(thinkingMatch.details.agents[0].thinking, 'xhigh');
    assert.equal((await invoke('subagent_agents', { query: 'fake/parent' })).details.totalAgents, 0,
      'search must not infer the parent model for definitions without an explicit selector');
    assert.equal((await invoke('subagent_agents', { query: ctx().cwd })).details.totalAgents, 0,
      'search must not infer the parent working directory for definitions without an explicit cwd');
    assert.equal((await invoke('subagent_agents', { query: 'max' }, { ...ctx(), thinkingLevel: 'max' })).details.totalAgents, 0,
      'search must not infer the parent thinking level for definitions without an explicit override');
    assert.deepEqual((await invoke('subagent_agents', { query: 'vendor/personal-secret' })).details.agents.map(agent => agent.name), ['lookup-override']);
    const unsetEnvMatch = await invoke('subagent_agents', { query: 'aws_secret_access_key' });
    assert.deepEqual(unsetEnvMatch.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.deepEqual(unsetEnvMatch.details.agents[0].unsetEnv, ['AWS_SECRET_ACCESS_KEY']);
    const cwdMatch = await invoke('subagent_agents', { query: 'PERSONAL-RUNTIME' });
    assert.deepEqual(cwdMatch.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.equal(cwdMatch.details.agents[0].cwd, '/work/personal-runtime');
    const timeoutMatch = await invoke('subagent_agents', { query: '456000' });
    assert.deepEqual(timeoutMatch.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.equal(timeoutMatch.details.agents[0].timeoutMs, 456000);
    const projectContext = { ...ctx(), cwd: join(sandbox, 'project') };
    const shadowedPersonalTag = await invoke('subagent_agents', {
      agentScope: 'both', query: 'personal-sensitive',
    }, projectContext);
    assert.equal(shadowedPersonalTag.details.totalAgents, 0,
      'a shadowed personal tag is not searchable');
    const shadowedExactPersonalTag = await invoke('subagent_agents', {
      agentScope: 'both', tag: 'PERSONAL-SENSITIVE',
    }, projectContext);
    assert.equal(shadowedExactPersonalTag.details.totalAgents, 0,
      'exact tag filters do not match a shadowed personal definition');
    const exactProjectTag = await invoke('subagent_agents', {
      agentScope: 'both', tag: 'PROJECT-REVIEW',
    }, projectContext);
    assert.deepEqual(exactProjectTag.details.agents.map(agent => agent.name), ['lookup-override']);
    const projectTag = await invoke('subagent_agents', {
      agentScope: 'both', query: 'PROJECT-REVIEW',
    }, projectContext);
    assert.deepEqual(projectTag.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.deepEqual(projectTag.details.agents[0].tags, ['project-review'],
      'project tags replace the personal tags before discovery search');
    assert.equal((await invoke('subagent_agents', {
      agentScope: 'both', tags: ['personal-sensitive'],
    }, projectContext)).details.totalAgents, 0,
    'multi-tag filters must not match shadowed personal tags');
    assert.deepEqual((await invoke('subagent_agents', {
      agentScope: 'both', tags: ['PROJECT-REVIEW'],
    }, projectContext)).details.agents.map(agent => agent.name), ['lookup-override']);

    const shadowedModel = await invoke('subagent_agents', {
      agentScope: 'both', query: 'vendor/personal-secret',
    }, projectContext);
    assert.equal(shadowedModel.details.totalAgents, 0, 'a shadowed personal model selector is not searchable');
    const projectModel = await invoke('subagent_agents', {
      agentScope: 'both', query: 'VENDOR/PROJECT-MODEL',
    }, projectContext);
    assert.deepEqual(projectModel.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.equal(projectModel.details.agents[0].model, 'vendor/project-model');
    const projectThinking = await invoke('subagent_agents', {
      agentScope: 'both', query: 'MAX',
    }, projectContext);
    assert.deepEqual(projectThinking.details.agents.map(agent => agent.name), ['lookup-override'],
      'a project thinking setting is searchable and replaces the shadowed personal setting');
    const shadowedUnsetEnv = await invoke('subagent_agents', {
      agentScope: 'both', query: 'AWS_SECRET_ACCESS_KEY',
    }, projectContext);
    assert.equal(shadowedUnsetEnv.details.totalAgents, 0,
      'a shadowed personal environment filter is not searchable');
    const projectUnsetEnv = await invoke('subagent_agents', {
      agentScope: 'both', query: 'github_token',
    }, projectContext);
    assert.deepEqual(projectUnsetEnv.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.deepEqual(projectUnsetEnv.details.agents[0].unsetEnv, ['GITHUB_TOKEN'],
      'a project environment filter replaces the shadowed personal setting before search');
    const shadowedPersonalCwd = await invoke('subagent_agents', {
      agentScope: 'both', query: 'personal-runtime',
    }, projectContext);
    assert.equal(shadowedPersonalCwd.details.totalAgents, 0,
      'a shadowed personal working-directory default is not searchable');
    const projectCwd = await invoke('subagent_agents', {
      agentScope: 'both', query: 'PROJECT-RUNTIME',
    }, projectContext);
    assert.deepEqual(projectCwd.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.equal(projectCwd.details.agents[0].cwd, '/work/project-runtime');
    const shadowedPersonalTimeout = await invoke('subagent_agents', {
      agentScope: 'both', query: '456000',
    }, projectContext);
    assert.equal(shadowedPersonalTimeout.details.totalAgents, 0,
      'a shadowed personal deadline is not searchable');
    const projectTimeout = await invoke('subagent_agents', {
      agentScope: 'both', query: '654000',
    }, projectContext);
    assert.deepEqual(projectTimeout.details.agents.map(agent => agent.name), ['lookup-override']);
    assert.equal(projectTimeout.details.agents[0].timeoutMs, 654000,
      'a project deadline replaces the shadowed personal setting before search');

    const greekMatch = await invoke('subagent_agents', { query: 'σ' });
    assert.deepEqual(greekMatch.details.agents.map(agent => agent.name), ['lookup-greek'],
      'Greek final sigma in stored text should match ordinary sigma in a query');

    const sharpSNameMatch = await invoke('subagent_agents', { query: 'STRASSE-REVIEWER' });
    assert.deepEqual(sharpSNameMatch.details.agents.map(agent => agent.name), ['straße-reviewer'],
      'German sharp s in agent names should match `ss` in the query');

    const sharpSDescriptionMatch = await invoke('subagent_agents', { query: 'STRASSE COMPLIANCE' });
    assert.deepEqual(sharpSDescriptionMatch.details.agents.map(agent => agent.name), ['lookup-sharp-s-description'],
      'German sharp s in descriptions should match `ss` in the query');

    const capitalSharpSMatch = await invoke('subagent_agents', { query: 'STRAẞE COMPLIANCE' });
    assert.deepEqual(capitalSharpSMatch.details.agents.map(agent => agent.name), ['lookup-sharp-s-description'],
      'Capital sharp s in a query should match lowercase sharp s in descriptions');

    const longSMatch = await invoke('subagent_agents', { query: 'STRASSE SUPPORT' });
    assert.deepEqual(longSMatch.details.agents.map(agent => agent.name), ['lookup-long-s'],
      'Unicode long s and sharp s should both fold to `s` and `ss`');

    const longSNameMatch = await invoke('subagent_agents', { query: 'SUPPORT-REVIEWER' });
    assert.deepEqual(longSNameMatch.details.agents.map(agent => agent.name), ['ſupport-reviewer'],
      'Full case folding should also match names that contain long s');

    const ligatureMatch = await invoke('subagent_agents', { query: 'OFFICE FORMATTING' });
    assert.deepEqual(ligatureMatch.details.agents.map(agent => agent.name), ['lookup-ligature'],
      'Unicode presentation ligatures should expand during full case folding');

    const greekSymbolMatch = await invoke('subagent_agents', { query: 'βeta SYMBOL' });
    assert.deepEqual(greekSymbolMatch.details.agents.map(agent => agent.name), ['lookup-beta-symbol'],
      'Greek symbol variants should match their standard-letter case folds');

    const microSignMatch = await invoke('subagent_agents', { query: 'μm conversion' });
    assert.deepEqual(microSignMatch.details.agents.map(agent => agent.name), ['lookup-micro-sign'],
      'The micro sign should match Greek mu under default Unicode case folding');

    const decomposedQuery = await invoke('subagent_agents', { query: 'cafe\u0301 tool' });
    assert.deepEqual(decomposedQuery.details.agents.map(agent => agent.name), ['lookup-cafe-composed'],
      'decomposed query text should match canonically equivalent composed metadata');

    const composedQuery = await invoke('subagent_agents', { query: 'café ass' });
    assert.deepEqual(composedQuery.details.agents.map(agent => agent.name), ['lookup-cafe-decomposed'],
      'composed query text should match canonically equivalent decomposed metadata');

    const nameQuery = await invoke('subagent_agents', { query: 'lookup-cafe\u0301-name' });
    assert.deepEqual(nameQuery.details.agents.map(agent => agent.name), ['lookup-café-name'],
      'decomposed query text should also match canonically equivalent agent names');

    const scoped = await invoke('subagent_agents', { agentScope: 'both', query: 'database' }, projectContext);
    assert.equal(scoped.details.totalAgents, 2);
    assert.deepEqual(scoped.details.agents.map(agent => agent.name), ['lookup-db', 'lookup-override']);
    assert.equal(scoped.details.agents[1].source, 'project', 'the project definition replaces the personal definition before matching');
    assert.equal(scoped.details.agents[1].description, 'Database project reviewer');

    const hiddenPersonal = await invoke('subagent_agents', { agentScope: 'both', query: 'secret' }, projectContext);
    assert.equal(hiddenPersonal.details.totalAgents, 0, 'a shadowed personal definition is not searchable');
    assert.match(hiddenPersonal.content[0].text, /No agents matching "`secret`" found/);
    assert.equal(traces().length, 0);
  } finally {
    for (const file of userFiles) rmSync(file, { force: true });
    rmSync(projectOverride, { force: true });
  }
});

test('agentTags dispatch selects uniquely in single, parallel, and chain modes before launch', async () => {
  const definitions = [
    ['dispatch-security.md', 'dispatch-security', ['security']],
    ['dispatch-review.md', 'dispatch-review', ['code-review']],
    ['dispatch-both.md', 'dispatch-both', ['security', 'code-review']],
    ['dispatch-triage.md', 'dispatch-triage', ['security', 'incident-response']],
  ].map(([filename, name, tags]) => {
    const file = join(sandbox, 'agent/agents', filename);
    writeFileSync(file, `---\nname: ${name}\ndescription: Capability dispatch fixture\ntags: ${JSON.stringify(tags)}\n---\nInstructions.\n`);
    return file;
  });
  const personalScope = join(sandbox, 'agent/agents/dispatch-scope.md');
  const projectScope = join(sandbox, 'project/.pi/agents/dispatch-scope.md');
  const exactLimitFile = join(sandbox, 'agent/agents/dispatch-exact-limit.md');
  writeFileSync(personalScope, '---\nname: dispatch-scope\ndescription: Personal shadow\ntags: [personal-route]\n---\nPersonal instructions.\n');
  writeFileSync(projectScope, '---\nname: dispatch-scope\ndescription: Project override\ntags: [project-route]\n---\nProject instructions.\n');
  try {
    const schema = tools.get('subagent').definition.parameters;
    assert.equal(Value.Check(schema, { agentTags: ['SECURITY'], task: 'schema single' }), true);
    assert.equal(Value.Check(schema, { tasks: [{ agentTags: ['security'], task: 'schema parallel' }] }), true);
    assert.equal(Value.Check(schema, { chain: [{ agentTags: ['security'], task: 'schema chain' }] }), true);

    const single = await invoke('subagent', {
      agentTags: ['SECURITY', 'CODE-REVIEW', 'security'], task: 'single via capability tags',
    });
    assert.equal(single.isError, undefined);
    assert.equal(single.details.results[0].agent, 'dispatch-both');

    const beforeRejected = traces().length;
    const ambiguous = await invoke('subagent', { agentTags: ['security'], task: 'ambiguous tags must not start' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /ambiguous/);
    assert.match(ambiguous.content[0].text, /dispatch-security/);
    assert.match(ambiguous.content[0].text, /dispatch-both/);
    const unmatched = await invoke('subagent', { agentTags: ['unavailable'], task: 'missing tags must not start' });
    assert.equal(unmatched.isError, true);
    assert.match(unmatched.content[0].text, /No in-scope agent/);
    assert.equal(traces().length, beforeRejected, 'ambiguous and unmatched selectors must fail before starting children');
    const exactLimitTags = Array.from({ length: MAX_AGENT_TAG_COUNT }, (_, index) =>
      `${String(index).padStart(2, '0')}${'x'.repeat(index === MAX_AGENT_TAG_COUNT - 1 ? 31 : MAX_AGENT_TAG_BYTES - 2)}`);
    const exactLimitBytes = exactLimitTags.reduce((total, tag) => total + Buffer.byteLength(tag), exactLimitTags.length - 1);
    assert.equal(exactLimitBytes, MAX_AGENT_TAG_LIST_BYTES, 'the fixture must exercise the inclusive aggregate byte limit');
    writeFileSync(exactLimitFile, `---\nname: dispatch-exact-limit\ndescription: Exact aggregate tag limit\ntags: ${JSON.stringify(exactLimitTags)}\n---\nInstructions.\n`);
    assert.equal(Value.Check(schema, { agentTags: exactLimitTags, task: 'exact selector boundary' }), true);
    const exactLimitSelection = await invoke('subagent', { agentTags: exactLimitTags, task: 'exact selector boundary' });
    assert.equal(exactLimitSelection.isError, undefined, 'a selector at the aggregate limit should remain valid');
    assert.equal(exactLimitSelection.details.results[0].agent, 'dispatch-exact-limit');
    const beforeMalformed = traces().length;
    const oversizedTags = Array.from({ length: MAX_AGENT_TAG_COUNT }, (_, index) =>
      `${String(index).padStart(2, '0')}${'x'.repeat(MAX_AGENT_TAG_BYTES - 2)}`);
    assert.equal(Value.Check(schema, { agentTags: oversizedTags, task: 'oversized selector' }), true,
      'the schema bounds each label and item count, while aggregate UTF-8 size is validated at runtime');
    const oversizedSelector = await invoke('subagent', { agentTags: oversizedTags, task: 'oversized selector must not start' });
    assert.equal(oversizedSelector.isError, true);
    assert.match(oversizedSelector.content[0].text, /agentTags must be an array of 1-32 valid ASCII labels totaling at most/);
    for (const params of [
      { task: 'selector missing' },
      { agent: 'worker', agentTags: ['security'], task: 'selectors conflict' },
      { agentTags: [], task: 'empty selector' },
      { agentTags: ['not a label'], task: 'invalid selector' },
      { tasks: [{ task: 'parallel selector missing' }] },
      { chain: [{ agent: 'worker', agentTags: ['security'], task: 'chain selectors conflict' }] },
      { tasks: [
        { agentTags: ['security', 'code-review'], task: 'valid selector before invalid' },
        { agentTags: ['unavailable'], task: 'unmatched later selector' },
      ] },
      { chain: [
        { agentTags: ['security', 'code-review'], task: 'valid chain selector before invalid' },
        { agentTags: ['security'], task: 'ambiguous later selector' },
      ] },
    ]) {
      const invalid = await invoke('subagent', params);
      assert.equal(invalid.isError, true);
    }
    assert.equal(traces().length, beforeMalformed, 'oversized and malformed selectors must fail before starting children');

    const parallel = await invoke('subagent', { tasks: [
      { agentTags: ['security', 'code-review'], task: 'parallel tag selector' },
      { agent: 'worker', task: 'parallel exact selector' },
    ] });
    assert.equal(parallel.isError, false);
    assert.deepEqual(parallel.details.results.map(result => result.agent), ['dispatch-both', 'worker']);

    const chain = await invoke('subagent', { chain: [
      { agentTags: ['security', 'code-review'], task: 'chain tag selector', id: 'selected' },
      { agent: 'worker', task: 'chain exact selector after {steps.selected}' },
    ] });
    assert.equal(chain.isError, undefined);
    assert.deepEqual(chain.details.results.map(result => result.agent), ['dispatch-both', 'worker']);
    assert.match(chain.details.results[1].task, /chain tag selector/);

    const projectContext = { ...ctx(), cwd: join(sandbox, 'project') };
    const personalTagAfterOverride = await invoke('subagent', {
      agentScope: 'both', agentTags: ['personal-route'], task: 'shadowed personal tag',
    }, projectContext);
    assert.equal(personalTagAfterOverride.isError, true);
    assert.match(personalTagAfterOverride.content[0].text, /No in-scope agent/);
    const projectTagWithoutTrust = await invoke('subagent', {
      agentScope: 'both', agentTags: ['project-route'], task: 'project tag requires trust',
    }, projectContext);
    assert.equal(projectTagWithoutTrust.isError, true);
    assert.match(projectTagWithoutTrust.content[0].text, /Cannot run project-local agents/);

    let approval = '';
    const approvedContext = { ...projectContext, hasUI: true,
      ui: { confirm: async (_title, body) => { approval = body; return true; } } };
    const projectDispatch = await invoke('subagent', {
      agentScope: 'both', agentTags: ['project-route'], task: 'approved project tag dispatch',
    }, approvedContext);
    assert.equal(projectDispatch.isError, undefined);
    assert.equal(projectDispatch.details.results[0].agent, 'dispatch-scope');
    assert.match(approval, /dispatch-scope/);
  } finally {
    for (const file of [...definitions, personalScope, projectScope, exactLimitFile]) rmSync(file, { force: true });
  }
});

test('agent listing rejects invalid search queries before discovery output or child launch', async () => {
  const parameters = tools.get('subagent_agents').definition.parameters;
  const outputSchema = tools.get('subagent_agents').definition.outputSchema;
  for (const query of ['', '  ', 'x'.repeat(MAX_AGENT_SEARCH_QUERY_BYTES + 1), '\u001bsearch']) {
    assert.equal(Value.Check(parameters, { query }), false);
  }
  const multibyteOversizedQuery = '€'.repeat(Math.floor(MAX_AGENT_SEARCH_QUERY_BYTES / 3) + 1);
  const unpairedSurrogateQuery = String.fromCharCode(0xd800);
  for (const query of [multibyteOversizedQuery, unpairedSurrogateQuery]) {
    assert.equal(Value.Check(parameters, { query }), true,
      'the schema may be looser than runtime UTF-8 and Unicode-scalar validation');
    const result = await invoke('subagent_agents', { query });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /query must be valid Unicode/);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    assert.equal(result.details.totalAgents, 0);
    assert.equal(JSON.stringify(result).includes('�'), false);
  }
  const combined = await invoke('subagent_agents', { name: 'worker', query: 'worker' });
  assert.equal(combined.isError, true);
  assert.match(combined.content[0].text, /name, query, tag, and tags filters cannot be combined/);
  assert.equal(Value.Check(outputSchema, combined.structuredContent), true);
  const tagAndQuery = await invoke('subagent_agents', { tag: 'security', query: 'review' });
  assert.equal(tagAndQuery.isError, true);
  assert.match(tagAndQuery.content[0].text, /name, query, tag, and tags filters cannot be combined/);
  assert.equal(Value.Check(outputSchema, tagAndQuery.structuredContent), true);
  for (const tags of [[], 'security', null, [''], ['security', 'bad tag'], ['unicode-é'], ['-leading'],
    ['x'.repeat(MAX_AGENT_TAG_BYTES + 1)],
    Array.from({ length: MAX_AGENT_TAG_COUNT + 1 }, (_, index) => `tag${index}`)]) {
    const result = await invoke('subagent_agents', { tags });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /tags must (?:be|contain)/);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    assert.equal(result.details.totalAgents, 0);
  }
  const oversizedAggregate = Array.from({ length: MAX_AGENT_TAG_COUNT }, (_, index) =>
    `${String(index).padStart(2, '0')}${'x'.repeat(MAX_AGENT_TAG_BYTES - 2)}`);
  assert.equal(Value.Check(parameters, { tags: oversizedAggregate }), true,
    'the schema leaves aggregate UTF-8 validation to the runtime');
  const oversizedTags = await invoke('subagent_agents', { tags: oversizedAggregate });
  assert.equal(oversizedTags.isError, true);
  assert.match(oversizedTags.content[0].text, /tags must be an array of 1-32 valid ASCII labels/);
  assert.equal(Value.Check(outputSchema, oversizedTags.structuredContent), true);
  const tagsAndQuery = await invoke('subagent_agents', { tags: ['security'], query: 'review' });
  assert.equal(tagsAndQuery.isError, true);
  assert.match(tagsAndQuery.content[0].text, /name, query, tag, and tags filters cannot be combined/);
  const tagsAndTag = await invoke('subagent_agents', { tags: ['security'], tag: 'security' });
  assert.equal(tagsAndTag.isError, true);
  assert.match(tagsAndTag.content[0].text, /name, query, tag, and tags filters cannot be combined/);
  assert.equal(traces().length, 0);
});

test('agent listing keeps capability tags visible before long fields are clipped', async () => {
  const file = join(sandbox, 'agent/agents/tagged-long-tools.md');
  const longTool = 'x'.repeat(MAX_AGENT_TOOL_LIST_BYTES);
  writeFileSync(file, `---\nname: tagged-long-tools\ndescription: Agent with long tool metadata\ntools: ${JSON.stringify([longTool])}\ntags: [security]\n---\nPrompt.\n`);
  try {
    const listed = await invoke('subagent_agents', { name: 'tagged-long-tools' });
    assert.equal(listed.details.agents[0].tools[0], longTool);
    assert.deepEqual(listed.details.agents[0].tags, ['security']);
    assert.match(listed.content[0].text, /`tagged-long-tools` \[tags=security\] \(user\):/);
    assert.ok(listed.content[0].text.indexOf('tags=security') < listed.content[0].text.indexOf('tools='),
      'long tool metadata must follow the high-value discovery tags');
    assert.ok(Buffer.byteLength(listed.content[0].text, 'utf8') <= 50 * 1024);
  } finally {
    rmSync(file, { force: true });
  }
});

test('agent listing rejects invalid exact tag filters before discovery output or child launch', async () => {
  const parameters = tools.get('subagent_agents').definition.parameters;
  const outputSchema = tools.get('subagent_agents').definition.outputSchema;
  for (const tag of ['', 'tag name', 'unicode-é', '-leading', 'x'.repeat(MAX_AGENT_TAG_BYTES + 1), 'tag\n']) {
    assert.equal(Value.Check(parameters, { tag }), false);
  }
  for (const tag of [null, 'Invalid Tag', 'tag\n', 'x'.repeat(MAX_AGENT_TAG_BYTES + 1)]) {
    const result = await invoke('subagent_agents', { tag });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /tag must be a valid ASCII label/);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    assert.equal(result.details.totalAgents, 0);
  }
  assert.equal(traces().length, 0);
});

test('agent listing rejects invalid names before discovery output or child launch', async () => {
  const parameters = tools.get('subagent_agents').definition.parameters;
  const outputSchema = tools.get('subagent_agents').definition.outputSchema;
  for (const name of ['', '  ', 'x'.repeat(MAX_AGENT_NAME_BYTES + 1), '\u001bworker']) {
    assert.equal(Value.Check(parameters, { name }), false);
  }
  const multibyteOversizedName = '€'.repeat(Math.floor(MAX_AGENT_NAME_BYTES / 3) + 1);
  const unpairedSurrogateName = String.fromCharCode(0xd800);
  for (const name of [multibyteOversizedName, unpairedSurrogateName]) {
    assert.equal(Value.Check(parameters, { name }), true,
      'the schema may be looser than runtime UTF-8 and Unicode-scalar validation');
    const result = await invoke('subagent_agents', { name });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /name must be a valid agent name/);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
    assert.equal(result.details.totalAgents, 0);
    assert.equal(JSON.stringify(result).includes('�'), false);
  }
  assert.equal(traces().length, 0);
});

test('agent listing rejects invalid pagination before discovery output or child launch', async () => {
  const parameters = tools.get('subagent_agents').definition.parameters;
  const outputSchema = tools.get('subagent_agents').definition.outputSchema;
  for (const params of [{ offset: -1 }, { offset: 513 }, { offset: 1.5 }, { limit: 0 }, { limit: 11 }, { limit: 1.5 }]) {
    assert.equal(Value.Check(parameters, params), false);
    const result = await invoke('subagent_agents', params);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /offset|limit/);
    assert.equal(Value.Check(outputSchema, result.structuredContent), true);
  }
  assert.equal(traces().length, 0);
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

test('structured agent listing strings are UTF-8 bounded and mark truncation', async () => {
  for (const [limit, label] of [
    [MAX_AGENT_LISTING_PATH_BYTES, 'path'],
    [MAX_AGENT_LISTING_DIAGNOSTIC_MESSAGE_BYTES, 'diagnostic'],
  ]) {
    const value = '🙂'.repeat(limit);
    const bounded = truncateAgentListingText(value, limit);
    assert.ok(Buffer.byteLength(bounded, 'utf8') <= limit, `${label} stays within its byte limit`);
    assert.ok(bounded.endsWith('…[truncated]'), `${label} truncation is explicit`);
    assert.equal(Buffer.byteLength(truncateAgentListingText('x'.repeat(limit), limit), 'utf8'), limit,
      `${label} values at the limit remain unchanged`);
  }
});

test('agent listings cap long working-directory metadata in structured output', async () => {
  const file = join(sandbox, 'agent/agents/long-cwd.md');
  const cwd = '🚀'.repeat(MAX_AGENT_LISTING_PATH_BYTES);
  writeFileSync(file, `---\nname: long-cwd\ndescription: Long working-directory metadata\ncwd: ${JSON.stringify(cwd)}\n---\nPrompt.\n`);
  try {
    const listed = await invoke('subagent_agents', { name: 'long-cwd' });
    const [agent] = listed.structuredContent.agents;
    assert.equal(agent.name, 'long-cwd');
    assert.ok(agent.cwd.endsWith('…[truncated]'));
    assert.ok(Buffer.byteLength(agent.cwd, 'utf8') <= MAX_AGENT_LISTING_PATH_BYTES);
    assert.equal(Value.Check(tools.get('subagent_agents').definition.outputSchema, listed.structuredContent), true);
    assert.ok(Buffer.byteLength(JSON.stringify(listed.structuredContent), 'utf8') < 20_000);
  } finally { rmSync(file, { force: true }); }
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

test('agent listing output schema enforces metadata bounds and exact fields', async () => {
  const listing = (await invoke('subagent_agents', {})).structuredContent;
  const schema = tools.get('subagent_agents').definition.outputSchema;
  assert.equal(Value.Check(schema, listing), true);

  const assertRejected = (mutate, message) => {
    const candidate = structuredClone(listing);
    mutate(candidate);
    assert.equal(Value.Check(schema, candidate), false, message);
  };
  const agent = candidate => candidate.agents[0];
  assertRejected(candidate => { agent(candidate).name = ' '.repeat(MAX_AGENT_NAME_BYTES); }, 'blank names must be rejected');
  assertRejected(candidate => { agent(candidate).name = 'x'.repeat(MAX_AGENT_NAME_BYTES + 1); }, 'oversized names must be rejected');
  assertRejected(candidate => { agent(candidate).description = ''; }, 'empty descriptions must be rejected');
  assertRejected(candidate => { agent(candidate).description = 'x'.repeat(MAX_AGENT_DESCRIPTION_BYTES + 1); }, 'oversized descriptions must be rejected');
  assertRejected(candidate => { agent(candidate).model = ''; }, 'empty model selectors must be rejected');
  assertRejected(candidate => { agent(candidate).model = 'x'.repeat(MAX_MODEL_SELECTOR_BYTES + 1); }, 'oversized model selectors must be rejected');
  assertRejected(candidate => { agent(candidate).tools = Array.from({ length: MAX_AGENT_TOOL_COUNT + 1 }, (_, index) => `tool-${index}`); }, 'oversized tool arrays must be rejected');
  assertRejected(candidate => { agent(candidate).tools = ['x'.repeat(MAX_AGENT_TOOL_LIST_BYTES + 1)]; }, 'oversized tool entries must be rejected');
  assertRejected(candidate => { agent(candidate).tools = ['read', 'read']; }, 'duplicate tool entries must be rejected');
  assertRejected(candidate => { agent(candidate).tags = Array.from({ length: MAX_AGENT_TAG_COUNT + 1 }, (_, index) => `tag-${index}`); }, 'too many tags must be rejected');
  assertRejected(candidate => { agent(candidate).tags = ['Invalid Tag']; }, 'invalid tags must be rejected');
  assertRejected(candidate => { agent(candidate).tags = ['tag\n']; }, 'tags must reject trailing line terminators');
  assertRejected(candidate => { agent(candidate).tags = ['review', 'review']; }, 'duplicate tags must be rejected');
  assertRejected(candidate => { agent(candidate).cwd = ''; }, 'empty working-directory defaults must be rejected');
  assertRejected(candidate => { agent(candidate).cwd = 'x'.repeat(MAX_AGENT_LISTING_PATH_BYTES + 1); }, 'oversized listed working directories must be rejected');
  assertRejected(candidate => { agent(candidate).filePath = 'x'.repeat(MAX_AGENT_LISTING_PATH_BYTES + 1); }, 'oversized agent paths must be rejected');
  assertRejected(candidate => { candidate.projectAgentsDir = 'x'.repeat(MAX_AGENT_LISTING_PATH_BYTES + 1); }, 'oversized project agent directories must be rejected');
  assertRejected(candidate => { candidate.diagnostics.push({ filePath: 'x'.repeat(MAX_AGENT_LISTING_PATH_BYTES + 1), source: 'user', message: 'invalid' }); }, 'oversized diagnostic paths must be rejected');
  assertRejected(candidate => { candidate.diagnostics.push({ filePath: 'agent.md', source: 'user', message: 'x'.repeat(MAX_AGENT_LISTING_DIAGNOSTIC_MESSAGE_BYTES + 1) }); }, 'oversized diagnostic messages must be rejected');
  assertRejected(candidate => { agent(candidate).systemPrompt = 'private prompt'; }, 'agent entries must not permit undeclared prompt fields');
  assertRejected(candidate => { candidate.unexpected = true; }, 'listing results must not permit undeclared fields');
  assertRejected(candidate => { candidate.diagnostics.push({ filePath: 'agent.md', source: 'user', message: 'invalid', systemPrompt: 'private prompt' }); }, 'diagnostics must not permit undeclared fields');

  const atLimits = structuredClone(listing);
  Object.assign(agent(atLimits), {
    name: 'n'.repeat(MAX_AGENT_NAME_BYTES),
    description: 'd'.repeat(MAX_AGENT_DESCRIPTION_BYTES),
    model: 'm'.repeat(MAX_MODEL_SELECTOR_BYTES),
    tools: Array.from({ length: MAX_AGENT_TOOL_COUNT }, (_, index) => `tool-${index}`),
    tags: Array.from({ length: MAX_AGENT_TAG_COUNT }, (_, index) => `tag-${index}`),
    cwd: 'c'.repeat(MAX_AGENT_LISTING_PATH_BYTES),
  });
  assert.equal(Value.Check(schema, atLimits), true, 'metadata at configured limits remains valid');
  const diagnosticAtLimits = structuredClone(listing);
  diagnosticAtLimits.projectAgentsDir = 'p'.repeat(MAX_AGENT_LISTING_PATH_BYTES);
  diagnosticAtLimits.diagnostics = [{
    filePath: 'f'.repeat(MAX_AGENT_LISTING_PATH_BYTES), source: 'user',
    message: 'm'.repeat(MAX_AGENT_LISTING_DIAGNOSTIC_MESSAGE_BYTES),
  }];
  assert.equal(Value.Check(schema, diagnosticAtLimits), true, 'path and diagnostic fields at their limits remain valid');
  const maxToolEntry = structuredClone(listing);
  agent(maxToolEntry).tools = ['t'.repeat(MAX_AGENT_TOOL_LIST_BYTES)];
  assert.equal(Value.Check(schema, maxToolEntry), true, 'tool entries at the configured byte limit remain valid');
  const maxTagEntry = structuredClone(listing);
  agent(maxTagEntry).tags = ['x'.repeat(MAX_AGENT_TAG_BYTES)];
  assert.equal(Value.Check(schema, maxTagEntry), true, 'tag entries at the configured byte limit remain valid');
});

test('agent listing output schema caps agent and diagnostic collection sizes', async () => {
  const listing = (await invoke('subagent_agents', {})).structuredContent;
  const schema = tools.get('subagent_agents').definition.outputSchema;
  const template = structuredClone(listing.agents[0]);

  const atAgentLimit = structuredClone(listing);
  atAgentLimit.agents = Array.from({ length: 10 }, (_, index) => ({ ...template, name: `agent-${index}` }));
  assert.equal(Value.Check(schema, atAgentLimit), true, 'a full discovery page remains valid');
  const tooManyAgents = structuredClone(atAgentLimit);
  tooManyAgents.agents.push({ ...template, name: 'one-too-many' });
  assert.equal(Value.Check(schema, tooManyAgents), false, 'agent listing pages must not exceed their configured size');

  const diagnostic = { filePath: 'agent.md', source: 'user', message: 'Invalid definition.' };
  const atDiagnosticLimit = structuredClone(listing);
  atDiagnosticLimit.diagnostics = Array.from({ length: MAX_AGENT_DIAGNOSTICS }, (_, index) => ({
    ...diagnostic, filePath: `agent-${index}.md`,
  }));
  assert.equal(Value.Check(schema, atDiagnosticLimit), true, 'the diagnostic limit remains valid');
  const tooManyDiagnostics = structuredClone(atDiagnosticLimit);
  tooManyDiagnostics.diagnostics.push({ ...diagnostic, filePath: 'one-too-many.md' });
  assert.equal(Value.Check(schema, tooManyDiagnostics), false, 'diagnostics must not exceed their discovery cap');
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
  const zeroWidthSpace = String.fromCodePoint(0x200b);
  const wordJoiner = String.fromCodePoint(0x2060);
  const zeroWidthNonJoiner = String.fromCodePoint(0x200c);
  const zeroWidthJoiner = String.fromCodePoint(0x200d);
  const mongolianVowelSeparator = String.fromCodePoint(0x180e);
  const languageTag = String.fromCodePoint(0xe0001);
  const hangulFiller = String.fromCodePoint(0x3164);
  const standaloneTagCharacter = String.fromCodePoint(0xe0061);
  const englandFlag = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
  const scotlandFlag = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
  const walesFlag = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0077, 0xe006c, 0xe0073, 0xe007f);
  const variationSelector = String.fromCodePoint(0xfe0f);
  const supplementaryVariationSelector = String.fromCodePoint(0xe0100);
  const emojiSequence = `👩${zeroWidthJoiner}💻`;
  const scriptJoiner = `می${zeroWidthNonJoiner}توان`;
  const hiddenFormatting = `${zeroWidthSpace}${mongolianVowelSeparator}${languageTag}${hangulFiller}${standaloneTagCharacter}`;
  const hostileName = `safe${hiddenFormatting} ${englandFlag}${scotlandFlag}${walesFlag} ` + `name${wordJoiner} [link](https://example.invalid)`;
  const escape = String.fromCharCode(27);
  const c1 = String.fromCodePoint(0x009b);
  const hostileDescription = `visible${hiddenFormatting}${wordJoiner} ${emojiSequence} ✈${variationSelector} 木${supplementaryVariationSelector} ${scriptJoiner} ${englandFlag}${scotlandFlag}${walesFlag}${String.fromCharCode(10)}### forged heading ${escape}[31mred${escape}[0m${c1}31m${String.fromCodePoint(0x202e)}`;
  const hostileCwd = `configured${String.fromCharCode(10)}${escape}[31m${String.fromCodePoint(0x202e)}`;
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
  writeFileSync(metadataFile, yamlAgent(hostileName, hostileDescription, `cwd: ${JSON.stringify(hostileCwd)}`));
  const canUseControlFilename = process.platform !== 'win32';
  if (canUseControlFilename) writeFileSync(hostilePathFile, yamlAgent('path-safe', 'Path test'));
  try {
    const context = { ...ctx(), cwd: join(sandbox, 'project') };
    const listed = await invoke('subagent_agents', { agentScope: 'project' }, context);
    const text = listed.content[0].text;
    assert.equal(text.includes(escape), false);
    assert.equal(text.includes(String.fromCodePoint(0x202e)), false);
    assert.equal(text.includes(c1), false);
    for (const character of [zeroWidthSpace, wordJoiner, mongolianVowelSeparator, languageTag, hangulFiller, standaloneTagCharacter]) {
      assert.equal(text.includes(character), false, `default-ignorable ${character.codePointAt(0).toString(16)} must be visible`);
    }
    assert.equal(text.split(String.fromCharCode(10)).some(line => line.startsWith('### forged heading')), false);
    assert.ok(text.includes('u001b'));
    assert.ok(text.includes('u200b'));
    assert.ok(text.includes('u2060'));
    assert.ok(text.includes('u180e'));
    assert.ok(text.includes('u{e0001}'));
    assert.ok(text.includes('u3164'));
    assert.ok(text.includes('u{e0061}'), 'standalone emoji tag characters remain visible');
    assert.ok(text.includes(englandFlag), 'England flag emoji tag sequences remain intact');
    assert.ok(text.includes(scotlandFlag), 'Scotland flag emoji tag sequences remain intact');
    assert.ok(text.includes(walesFlag), 'Wales flag emoji tag sequences remain intact');
    assert.ok(text.includes(emojiSequence), 'ZWJ emoji sequences remain intact');
    assert.ok(text.includes(`✈${variationSelector}`), 'emoji variation selectors remain intact');
    assert.ok(text.includes(`木${supplementaryVariationSelector}`), 'supplementary variation selectors remain intact');
    assert.ok(text.includes(scriptJoiner), 'script-specific ZWNJ remains intact');
    assert.ok(text.includes('u000a'));
    assert.equal(listed.details.agents.find(agent => agent.name === hostileName).name, hostileName,
      'structured metadata preserves the original name');
    assert.equal(listed.details.agents.find(agent => agent.name === hostileName).description, hostileDescription,
      'structured metadata preserves original descriptions');
    assert.deepEqual(listed.details.agents.find(agent => agent.name === hostileName).tools, ['read', 'custom-safe']);
    assert.equal(listed.details.agents.find(agent => agent.name === hostileName).cwd, hostileCwd);
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
    for (const character of [zeroWidthSpace, wordJoiner, mongolianVowelSeparator, languageTag, hangulFiller, standaloneTagCharacter]) {
      assert.equal(confirmation.includes(character), false);
    }
    assert.equal(confirmation.includes('u200b'), true);
    assert.equal(confirmation.includes('u2060'), true);
    assert.equal(confirmation.includes('u180e'), true);
    assert.equal(confirmation.includes('u{e0001}'), true);
    assert.equal(confirmation.includes('u3164'), true);
    assert.equal(confirmation.includes('u{e0061}'), true);
    assert.equal(confirmation.includes(englandFlag), true);
    assert.equal(confirmation.includes(scotlandFlag), true);
    assert.equal(confirmation.includes(walesFlag), true);
    assert.equal(confirmation.includes(escape), false);
    assert.equal(confirmation.includes(hostileName), false);
    assert.equal(confirmation.includes('Effective child working directories:'), true);
    assert.equal(confirmation.includes('u000a'), true);
    assert.equal(confirmation.includes('Project agents are repo-controlled.'), true);
    assert.equal(traces().length, 0);
  } finally {
    rmSync(metadataFile, { force: true });
    rmSync(hostilePathFile, { force: true });
  }
});

test('project-agent approvals show effective model, thinking, tools, and timeout settings', async () => {
  const agentFile = join(sandbox, 'project/.pi/agents/approval-config.md');
  writeFileSync(agentFile, [
    '---',
    'name: approval-config',
    'description: Configured project agent',
    'model: fake/agent-model:low',
    'thinking: high',
    'tools: [read, bash]',
    'timeoutMs: 9000',
    '---',
    'Project instructions.',
    '',
  ].join('\n'));
  let confirmation = '';
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async (_title, body) => { confirmation = body; return false; } } };
  const requestApproval = async params => {
    const result = await invoke('subagent', { agentScope: 'project', ...params }, context);
    assert.equal(result.content[0].text, 'Canceled: project-local agents not approved.');
    assert.match(confirmation, /Effective child configuration/);
    assert.match(confirmation, /initial tool selection is not a sandbox/);
    assert.equal(traces().length, 0, 'approval denial must happen before any child launch');
    return confirmation;
  };
  try {
    const single = await requestApproval({
      agent: 'approval-config', task: 'single override', model: 'fake/call-model',
      thinking: 'xhigh', tools: ['grep'], timeoutMs: 5000,
    });
    assert.match(single, /model=.*fake\/call-model/);
    assert.match(single, /thinking=xhigh/);
    assert.match(single, /initial tools=.*grep/);
    assert.match(single, /timeout=5000 ms/);

    const defaults = await requestApproval({
      chain: [{ agent: 'approval-config', task: 'agent defaults' }],
    });
    assert.match(defaults, /model=.*fake\/agent-model:low/);
    assert.match(defaults, /thinking=high/);
    assert.match(defaults, /initial tools=.*read, bash/);
    assert.match(defaults, /timeout=9000 ms/);

    const parallel = await requestApproval({
      model: 'fake/batch-model', thinking: 'low', tools: ['read'], timeoutMs: 1000,
      tasks: [{ agent: 'approval-config', task: 'entry nulls', model: null, thinking: null, tools: null, timeoutMs: null }],
    });
    assert.match(parallel, /model=.*fake\/parent/);
    assert.match(parallel, /thinking=high/);
    assert.match(parallel, /initial tools=Pi defaults/);
    assert.match(parallel, /timeout=unbounded/);

    const chain = await requestApproval({
      model: 'fake/batch-model', thinking: 'low', tools: ['read'], timeoutMs: 1000,
      chain: [{ agent: 'approval-config', task: 'batch defaults' }],
    });
    assert.match(chain, /model=.*fake\/batch-model/);
    assert.match(chain, /thinking=low/);
    assert.match(chain, /initial tools=.*read/);
    assert.match(chain, /timeout=1000 ms/);
  } finally {
    rmSync(agentFile, { force: true });
  }
});

test('project-agent approval shows complete settings and refuses oversized summaries', async () => {
  const agentsDir = join(sandbox, 'project/.pi/agents');
  const longToolName = '`'.repeat(1024);
  const longChildCwd = 'x'.repeat(300);
  const filteredVariables = Array.from({ length: 128 }, (_, index) =>
    `P${String(index).padStart(3, '0')}${'X'.repeat(27)}`);
  const longToolsFile = join(agentsDir, 'approval-long-tools.md');
  const finalFile = join(agentsDir, 'approval-final.md');
  writeFileSync(longToolsFile, [
    '---',
    'name: approval-long-tools',
    'description: Long but bounded tool selection',
    `tools: ${JSON.stringify(longToolName)}`,
    `cwd: ${JSON.stringify(longChildCwd)}`,
    `unsetEnv: ${JSON.stringify(filteredVariables)}`,
    '---',
    'Prompt.',
    '',
  ].join('\n'));
  writeFileSync(finalFile, [
    '---',
    'name: approval-final',
    'description: Final approval worker',
    'model: fake/final-model',
    'timeoutMs: 6789',
    '---',
    'Prompt.',
    '',
  ].join('\n'));
  let confirmation = '';
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async (_title, body) => { approvals++; confirmation = body; return false; } } };
  try {
    const result = await invoke('subagent', {
      agentScope: 'project',
      chain: [
        { agent: 'approval-long-tools', task: 'first summary' },
        { agent: 'approval-final', task: 'last summary' },
      ],
    }, context);
    assert.equal(result.content[0].text, 'Canceled: project-local agents not approved.');
    assert.equal(approvals, 1);
    assert.ok(Buffer.byteLength(confirmation, 'utf8') > 4 * 1024,
      'exercise summaries that used to be clipped at the per-section 4 KiB limit');
    assert.ok(Buffer.byteLength(confirmation, 'utf8') <= 32 * 1024);
    assert.ok(confirmation.includes('\\u0060'.repeat(1024)), 'show the complete bounded initial tool selection');
    assert.ok(confirmation.includes(longChildCwd), 'show the full effective working directory');
    assert.ok(confirmation.includes(filteredVariables.at(-1)), 'show the complete bounded environment-removal list');
    assert.ok(confirmation.includes('`approval-final`: model=`fake/final-model`; thinking=model/Pi default; initial tools=Pi defaults; timeout=6789 ms'),
      'later requested agents must remain visible after long earlier settings');
    assert.equal(traces().length, 0);

    approvals = 0;
    const invalidParentModelContext = {
      ...context,
      model: { provider: 'p'.repeat(MAX_MODEL_SELECTOR_BYTES), id: 'model' },
    };
    const invalidParentModel = await invoke('subagent', {
      agentScope: 'project', agent: 'approval-final', task: 'invalid inherited model', model: null,
    }, invalidParentModelContext);
    assert.equal(invalidParentModel.isError, true);
    assert.match(invalidParentModel.content[0].text, /Effective model selector.*invalid or exceeds/);
    assert.equal(approvals, 0, 'invalid inherited models must be rejected before the approval prompt');
    assert.equal(traces().length, 0);

    const oversizedToolName = '`'.repeat(MAX_AGENT_TOOL_LIST_BYTES);
    const oversizedFiles = ['approval-oversized-a', 'approval-oversized-b'].map(name => {
      const file = join(agentsDir, `${name}.md`);
      writeFileSync(file, [
        '---',
        `name: ${name}`,
        'description: Oversized approval test',
        `tools: ${JSON.stringify(oversizedToolName)}`,
        '---',
        'Prompt.',
        '',
      ].join('\n'));
      return file;
    });
    try {
      confirmation = '';
      approvals = 0;
      const oversized = await invoke('subagent', {
        agentScope: 'project',
        chain: [
          { agent: 'approval-oversized-a', task: 'first oversized summary' },
          { agent: 'approval-oversized-b', task: 'second oversized summary' },
        ],
      }, context);
      assert.equal(oversized.isError, true);
      assert.match(oversized.content[0].text, /approval details exceed the 32 KiB limit/);
      assert.equal(approvals, 0, 'never ask to approve a prompt that would hide part of the effective configuration');
      assert.equal(traces().length, 0, 'oversized approval details must fail before any child launch');
    } finally {
      for (const file of oversizedFiles) rmSync(file, { force: true });
    }
  } finally {
    rmSync(longToolsFile, { force: true });
    rmSync(finalFile, { force: true });
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
    const listing = await invoke('subagent_agents', {});
    const listed = listing.structuredContent.agents.find(agent => agent.name === 'limited');
    assert.equal(listed.thinking, 'off');
    assert.match(listing.content[0].text, /thinking=off/);
    const listingSchema = tools.get('subagent_agents').definition.outputSchema;
    assert.equal(Value.Check(listingSchema, listing.structuredContent), true);
    const invalidListing = structuredClone(listing.structuredContent);
    invalidListing.agents.find(agent => agent.name === 'limited').thinking = 'unsupported';
    assert.equal(Value.Check(listingSchema, invalidListing), false, 'the output schema must constrain thinking to supported levels');
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

test('per-call tool overrides resolve across single, parallel, and chain dispatch', async () => {
  await invoke('subagent', { agent: 'pinned', task: 'single override', tools: 'custom-read, custom-write,custom-read' });
  let child = traces().find(entry => entry.task === 'single override');
  assert.equal(child.tools, 'custom-read,custom-write', 'comma-separated overrides are normalized and deduplicated');
  assert.equal(child.noTools, false);

  await invoke('subagent', { agent: 'pinned', task: 'disable tools', tools: [] });
  child = traces().find(entry => entry.task === 'disable tools');
  assert.equal(child.noTools, true);
  assert.equal(child.tools, undefined);

  await invoke('subagent', { agent: 'pinned', task: 'use child defaults', tools: null });
  child = traces().find(entry => entry.task === 'use child defaults');
  assert.equal(child.tools, undefined);
  assert.equal(child.noTools, false, 'null removes the agent allowlist without disabling tools');

  await invoke('subagent', { agent: 'pinned', task: 'agent allowlist remains' });
  child = traces().find(entry => entry.task === 'agent allowlist remains');
  assert.equal(child.tools, 'read,bash', 'per-call overrides do not mutate agent configuration');

  const parallelResult = await invoke('subagent', { tools: ['batch-tool'], tasks: [
    { agent: 'pinned', task: 'entry override', tools: ['entry-tool'] },
    { agent: 'pinned', task: 'batch override' },
    { agent: 'pinned', task: 'entry defaults', tools: null },
  ] });
  assert.equal(parallelResult.isError, false, parallelResult.content[0].text);
  const parallel = new Map(traces().filter(entry => entry.event === 'start' && ['entry override', 'batch override', 'entry defaults'].includes(entry.task))
    .map(entry => [entry.task, entry]));
  assert.equal(parallel.get('entry override').tools, 'entry-tool');
  assert.equal(parallel.get('batch override').tools, 'batch-tool');
  assert.equal(parallel.get('entry defaults').tools, undefined);
  assert.equal(parallel.get('entry defaults').noTools, false);

  await invoke('subagent', { tools: ['chain-default'], chain: [
    { agent: 'pinned', task: 'chain no tools', tools: [] },
    { agent: 'pinned', task: 'chain inherits' },
  ] });
  const chain = new Map(traces().filter(entry => entry.event === 'start' && ['chain no tools', 'chain inherits'].includes(entry.task))
    .map(entry => [entry.task, entry]));
  assert.equal(chain.get('chain no tools').noTools, true);
  assert.equal(chain.get('chain inherits').tools, 'chain-default');

  const background = await invoke('subagent', {
    background: true, notify: false, agent: 'pinned', task: 'background override', tools: ['background-tool'],
  });
  await invoke('subagent_jobs', { action: 'wait', jobId: background.details.background.id, timeoutMs: 5000 });
  child = traces().find(entry => entry.event === 'start' && entry.task === 'background override');
  assert.equal(child.tools, 'background-tool');
});

test('invalid per-call tool overrides fail preflight and the schema bounds tool selections', async () => {
  const invalid = [
    ['comma', ['read,bash']],
    ['modifier', ['+bash']],
    ['control', [`read${String.fromCharCode(27)}bash`]],
    ['oversized entry', ['x'.repeat(MAX_AGENT_TOOL_LIST_BYTES + 1)]],
    ['oversized aggregate', ['x'.repeat(MAX_AGENT_TOOL_LIST_BYTES - 1), 'yy']],
    ['too many entries', Array.from({ length: MAX_AGENT_TOOL_COUNT + 1 }, (_, index) => `tool-${index}`)],
  ];
  const schema = tools.get('subagent').definition.parameters;
  assert.equal(Value.Check(schema, { agent: 'pinned', task: 'valid', tools: ['read', 'bash'] }), true);
  assert.equal(Value.Check(schema, { agent: 'pinned', task: 'valid', tools: 'read, bash' }), true);
  assert.equal(Value.Check(schema, { agent: 'pinned', task: 'valid', tools: [] }), true);
  assert.equal(Value.Check(schema, { agent: 'pinned', task: 'valid', tools: null }), true);
  assert.equal(Value.Check(schema, { agent: 'pinned', task: 'valid', tools: invalid.at(-1)[1] }), false);
  for (const [label, selected] of invalid) {
    const result = await invoke('subagent', { agent: 'pinned', task: `invalid ${label}`, tools: selected });
    assert.equal(result.isError, true, label);
    assert.match(result.content[0].text, /Invalid tools override/);
    assert.equal(traces().length, 0, `${label} must be rejected before launch`);
  }
});

test('thinking null ignores agent and batch defaults while inheriting parent settings only with an inherited model', async () => {
  const definition = tools.get('subagent').definition;
  assert.equal(Value.Check(definition.parameters, { agent: 'thinking-default', task: 'null thinking', thinking: null }), true);
  assert.equal(Value.Check(definition.parameters, { thinking: 'medium', tasks: [
    { agent: 'thinking-default', task: 'nested null thinking', thinking: null },
  ] }), true);
  assert.equal(Value.Check(definition.parameters, { thinking: 'medium', chain: [
    { agent: 'thinking-default', task: 'chain null thinking', thinking: null },
  ] }), true);

  const file = join(sandbox, 'agent/agents/thinking-default.md');
  writeFileSync(file, '---\nname: thinking-default\ndescription: Thinking defaults\nthinking: low\n---\nThinking test instructions.\n');
  try {
    await invoke('subagent', { agent: 'thinking-default', task: 'configured thinking' });
    assert.equal(traces().filter(entry => entry.event === 'start').at(-1).thinking, 'low');

    await invoke('subagent', { agent: 'thinking-default', task: 'null inherits parent thinking', thinking: null });
    const inherited = traces().filter(entry => entry.event === 'start').at(-1);
    assert.equal(inherited.model, 'fake/parent');
    assert.equal(inherited.thinking, 'high');

    await invoke('subagent', { agent: 'thinking-default', task: 'null leaves explicit model thinking alone', model: 'fake/explicit:low', thinking: null });
    const explicit = traces().filter(entry => entry.event === 'start').at(-1);
    assert.equal(explicit.model, 'fake/explicit:low');
    assert.equal(explicit.thinking, undefined, 'Pi should use the explicit model suffix/default');

    await invoke('subagent', { model: 'fake/batch', thinking: 'medium', tasks: [
      { agent: 'thinking-default', task: 'parallel null thinking', thinking: null },
      { agent: 'thinking-default', task: 'parallel inherited thinking' },
    ] });
    const parallel = traces().filter(entry => entry.event === 'start');
    assert.equal(parallel.find(entry => entry.task === 'parallel null thinking').thinking, undefined,
      'entry null should override batch thinking and leave the explicit batch model unmodified');
    assert.equal(parallel.find(entry => entry.task === 'parallel inherited thinking').thinking, 'medium');

    await invoke('subagent', { thinking: 'medium', chain: [
      { agent: 'thinking-default', task: 'chain null thinking', thinking: null },
      { agent: 'thinking-default', task: 'chain batch thinking' },
    ] });
    const chain = traces().filter(entry => entry.event === 'start');
    assert.equal(chain.find(entry => entry.task === 'chain null thinking').thinking, 'high');
    assert.equal(chain.find(entry => entry.task === 'chain batch thinking').thinking, 'medium');
  } finally { rmSync(file); }
});

test('model null ignores agent and batch model defaults while inheriting the parent model', async () => {
  const definition = tools.get('subagent').definition;
  assert.equal(Value.Check(definition.parameters, { agent: 'pinned', task: 'inherit parent model', model: null }), true);

  await invoke('subagent', { agent: 'pinned', task: 'ignore pinned model', model: null });
  const single = traces().filter(entry => entry.event === 'start').at(-1);
  assert.equal(single.model, 'fake/parent');
  assert.equal(single.thinking, 'high', 'the parent thinking level follows the inherited parent model');

  await invoke('subagent', { model: 'fake/batch', thinking: 'medium', tasks: [
    { agent: 'pinned', task: 'entry null model', model: null },
    { agent: 'pinned', task: 'top-level model fallback' },
  ] });
  const parallel = traces().filter(entry => entry.event === 'start');
  assert.equal(parallel.find(entry => entry.task === 'entry null model').model, 'fake/parent');
  assert.equal(parallel.find(entry => entry.task === 'entry null model').thinking, 'medium',
    'model and thinking overrides resolve independently');
  assert.equal(parallel.find(entry => entry.task === 'top-level model fallback').model, 'fake/batch');

  await invoke('subagent', { model: 'fake/chain', chain: [
    { agent: 'pinned', task: 'chain null model', model: null },
    { agent: 'pinned', task: 'chain top-level model' },
  ] });
  const chain = traces().filter(entry => entry.event === 'start');
  assert.equal(chain.find(entry => entry.task === 'chain null model').model, 'fake/parent');
  assert.equal(chain.find(entry => entry.task === 'chain top-level model').model, 'fake/chain');
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
  let confirmation = '';
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false,
    ui: { confirm: async (_title, body) => { approvals++; confirmation = body; return true; } } };
  const schema = tools.get('subagent').definition.parameters;
  const bypass = { agent: 'project', task: 'must not run', agentScope: 'project', confirmProjectAgents: false };
  assert.equal(Value.Check(schema, bypass), false, 'the tool schema must not expose a per-call approval bypass');
  const rejected = await invoke('subagent', bypass, context);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /confirmProjectAgents is no longer supported/);
  assert.equal(approvals, 0);
  assert.equal(traces().length, 0);

  const approved = await invoke('subagent', { agent: 'project', task: 'approved', agentScope: 'project', tools: null }, context);
  assert.notEqual(approved.isError, true);
  assert.equal(approved.details.results[0].exitCode, 0);
  assert.equal(approvals, 1, 'an untrusted project agent requires an actual UI approval');
  assert.equal(traces().filter(entry => entry.event === 'start').length, 1);
  assert.equal((await invoke('subagent_jobs', { action: 'list' })).structuredContent.jobs.length, 0);

  const configuredAgentFile = join(sandbox, 'project/.pi/agents/project-cwd.md');
  const configuredDirectory = join(sandbox, 'project/configured-cwd');
  mkdirSync(configuredDirectory, { recursive: true });
  writeFileSync(configuredAgentFile, '---\nname: project-cwd\ndescription: Project working directory\ncwd: configured-cwd\nunsetEnv: [PI_SUBAGENTS_PROJECT_TEST_ENV]\n---\nProject cwd worker.\n');
  try {
    const cwdApproved = await invoke('subagent', {
      agent: 'project-cwd', task: 'project cwd still requires approval', agentScope: 'project',
      unsetEnv: ['PI_SUBAGENTS_TEST_CALL_ENV'],
    }, context);
    assert.notEqual(cwdApproved.isError, true);
    assert.equal(cwdApproved.details.projectAgentsDir, join(sandbox, 'project/.pi/agents'));
    assert.equal(approvals, 2, 'a configured child cwd must not bypass project-agent approval');
    assert.match(confirmation, /Effective child working directories:/);
    assert.ok(confirmation.includes(configuredDirectory), 'the approval prompt should disclose the resolved configured child directory');
    assert.match(confirmation, /Inherited environment variables removed:/);
    assert.ok(confirmation.includes('PI_SUBAGENTS_PROJECT_TEST_ENV'));
    assert.ok(confirmation.includes('PI_SUBAGENTS_TEST_CALL_ENV'));
    assert.equal(traces().filter(entry => entry.event === 'start').length, 2);
    assertSameDirectory(traces().find(entry => entry.task === 'project cwd still requires approval').cwd, configuredDirectory);

    const callDirectory = join(sandbox, 'project/call-override');
    const parallelDirectory = join(sandbox, 'project/parallel-override');
    const chainDirectory = join(sandbox, 'project/chain-override');
    mkdirSync(callDirectory, { recursive: true });
    mkdirSync(parallelDirectory, { recursive: true });
    mkdirSync(chainDirectory, { recursive: true });

    const singleOverride = await invoke('subagent', {
      agent: 'project-cwd', task: 'project call cwd override', agentScope: 'project', cwd: 'call-override',
    }, context);
    assert.notEqual(singleOverride.isError, true);
    assert.ok(confirmation.includes(callDirectory));
    assert.equal(confirmation.includes(configuredDirectory), false,
      'approval should show the effective call override, not an unused agent default');
    assertSameDirectory(traces().find(entry => entry.task === 'project call cwd override').cwd, callDirectory);

    const parallelOverrides = await invoke('subagent', {
      tasks: [
        { agent: 'project-cwd', task: 'project parallel entry cwd', cwd: 'parallel-override' },
        { agent: 'project-cwd', task: 'project parallel call cwd' },
      ],
      cwd: 'call-override', agentScope: 'project',
    }, context);
    assert.notEqual(parallelOverrides.isError, true);
    assert.ok(confirmation.includes(parallelDirectory));
    assert.ok(confirmation.includes(callDirectory));
    assert.equal(confirmation.includes(configuredDirectory), false);
    assertSameDirectory(traces().find(entry => entry.task === 'project parallel entry cwd').cwd, parallelDirectory);
    assertSameDirectory(traces().find(entry => entry.task === 'project parallel call cwd').cwd, callDirectory);

    const chainOverrides = await invoke('subagent', {
      chain: [
        { agent: 'project-cwd', task: 'project chain entry cwd', cwd: 'chain-override' },
        { agent: 'project-cwd', task: 'project chain call cwd' },
      ],
      cwd: 'call-override', agentScope: 'project',
    }, context);
    assert.notEqual(chainOverrides.isError, true);
    assert.ok(confirmation.includes(chainDirectory));
    assert.ok(confirmation.includes(callDirectory));
    assert.equal(confirmation.includes(configuredDirectory), false);
    assertSameDirectory(traces().find(entry => entry.task === 'project chain entry cwd').cwd, chainDirectory);
    assertSameDirectory(traces().find(entry => entry.task === 'project chain call cwd').cwd, callDirectory);
  } finally { rmSync(configuredAgentFile, { force: true }); }
});

test('invalid dispatch overrides fail before project approval or any child launch', async () => {
  let approvals = 0;
  const context = { ...ctx(), cwd: join(sandbox, 'project'), hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { approvals++; return true; } } };
  for (const overrides of [
    { model: '' }, { model: '  ' }, { model: 42 }, { thinking: 'invalid' }, { thinking: 42 },
    { tools: ['read,write'] }, { tools: ['+bash'] }, { tools: [42] },
  ]) {
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
  const definition = tools.get('subagent_jobs').definition;
  assert.equal(Value.Check(definition.parameters, { action: 'output', jobId: id, stepId: 'reuse' }), true);
  assert.equal(Value.Check(definition.parameters, { action: 'output', jobId: id, stepId: 'bad id' }), false);
  const output = await invoke('subagent_jobs', { action: 'output', jobId: id, stepId: 'reuse' });
  assert.equal(output.structuredContent.output.stepId, 'reuse');
  assert.equal(output.structuredContent.output.taskIndex, 2, 'named lookup reports the original result index');
  assert.match(output.structuredContent.output.text, /^result: reuse /);
  assert.equal(Value.Check(definition.outputSchema, output.structuredContent), true);
  const nextOffset = output.structuredContent.output.nextOffset;
  assert.notEqual(nextOffset, null, 'the large named result requires additional pages');
  const nextPage = await invoke('subagent_jobs', { action: 'output', jobId: id, stepId: 'reuse', offset: nextOffset, limit: 4096 });
  assert.equal(nextPage.structuredContent.output.stepId, 'reuse');
  assert.equal(nextPage.structuredContent.output.taskIndex, 2);
  assert.equal(nextPage.structuredContent.output.offset, nextOffset);
  assert.equal(Value.Check(definition.outputSchema, nextPage.structuredContent), true);
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
  const taskCount = 8;
  const modelBytes = 33 * 1024 * 1024 / taskCount;
  const launched = await invoke('subagent', {
    background: true,
    notify: false,
    tasks: Array.from({ length: taskCount }, () => ({ agent: 'worker', task: 'unretained-model' })),
  }, { ...ctx(), model: undefined });
  const id = launched.details.background.id;
  const sawUnretainedModel = await waitFor(async () => {
    const job = await status(id);
    return job.latest?.details?.results.some(task => task.model?.length === modelBytes &&
      task.capture?.messagesDropped > 0 && task.capture.retainedMessageBytes < 1024 * 1024) ?? false;
  });
  assert.equal(sawUnretainedModel, true, 'The oversized source record is absent from history while its model metadata remains');
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
  assert.match(overflow.content[0].text, /not retained in bounded history capture/);
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

test('background job response schema enforces runtime collection and page limits', () => {
  const schema = tools.get('subagent_jobs').definition.outputSchema;
  const metadata = {
    id: 'j'.repeat(36), label: 'l'.repeat(1024), notify: true, state: 'completed',
    startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:00:01.000Z',
    error: 'e'.repeat(2048), outputEvicted: true, resultCount: 32,
  };
  const response = {
    action: 'output', jobs: Array(40).fill(metadata), job: metadata,
    output: {
      taskIndex: 31, agent: 'a'.repeat(256), exitCode: 0, partial: false, timedOut: false,
      stepId: 's'.repeat(64), stream: 'result', text: 'x'.repeat(MAX_PAGE_BYTES),
      offset: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER,
      nextOffset: Number.MAX_SAFE_INTEGER,
    },
    cleared: 32, error: 'e'.repeat(2048),
  };
  assert.equal(Value.Check(schema, response), true, 'values at schema caps must remain valid');

  const invalid = [
    ['too many retained job records', candidate => candidate.jobs.push(metadata)],
    ['overlong job label', candidate => { candidate.job.label += 'x'; }],
    ['overlong diagnostic', candidate => { candidate.job.error += 'x'; }],
    ['too many results', candidate => { candidate.job.resultCount++; }],
    ['oversized agent name', candidate => { candidate.output.agent += 'x'; }],
    ['out-of-range task index', candidate => { candidate.output.taskIndex++; }],
    ['overlong chain step ID', candidate => { candidate.output.stepId += 'x'; }],
    ['invalid chain step ID format', candidate => { candidate.output.stepId = 'step name'; }],
    ['oversized output page', candidate => { candidate.output.text += 'x'; }],
    ['unsafe byte offset', candidate => { candidate.output.offset++; }],
    ['unsafe total byte count', candidate => { candidate.output.totalBytes++; }],
    ['unsafe next offset', candidate => { candidate.output.nextOffset++; }],
    ['too many cleared records', candidate => { candidate.cleared++; }],
    ['oversized response error', candidate => { candidate.error += 'x'; }],
  ];
  for (const [message, mutate] of invalid) {
    const candidate = structuredClone(response);
    mutate(candidate);
    assert.equal(Value.Check(schema, candidate), false, message);
  }
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

test('background output can page captured stderr without changing the default result stream', async () => {
  const id = await launch({ task: 'stderr-output', notify: false });
  await finish(id);
  const resultPage = await invoke('subagent_jobs', { action: 'output', jobId: id });
  assert.equal(resultPage.structuredContent.output.stream, 'result');
  assert.equal(resultPage.structuredContent.output.text, 'result: stderr-output');

  let offset = 0, stderr = '', controlPage;
  do {
    const page = await invoke('subagent_jobs', { action: 'output', jobId: id, stream: 'stderr', offset, limit: 7 });
    assert.equal(Value.Check(tools.get('subagent_jobs').definition.outputSchema, page.structuredContent), true);
    const output = page.structuredContent.output;
    assert.equal(output.stream, 'stderr');
    assert.equal(output.stderrTruncated, false);
    assert.ok(Buffer.byteLength(output.text) <= 7);
    if (output.text.includes(String.fromCharCode(27))) controlPage = page;
    stderr += output.text;
    if (output.nextOffset === null) break;
    offset = output.nextOffset;
  } while (true);

  const esc = String.fromCharCode(27), bell = String.fromCharCode(7), c1 = String.fromCharCode(0x9b);
  const expected = `warning: café 🛰️\nterminal ${esc}]52;c;pi-subagents-test${bell} ${esc}[2J${c1}2J\nnext line`;
  assert.equal(stderr, expected, 'UTF-8 stderr pages reconstruct the original captured stream');
  assert.ok(controlPage, 'The hostile stderr controls were present in a paginated response');
  const definition = tools.get('subagent_jobs').definition;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const rendered = definition.renderResult(controlPage, { expanded: true }, theme, { isError: false }).render(100).join('\n');
  assert.equal(rendered.includes(esc), false, 'stderr terminal controls must be escaped for display');
  assert.equal(rendered.includes(bell), false);
  assert.equal(rendered.includes(c1), false);
  const renderedCall = definition.renderCall({ action: 'output', jobId: id, stream: 'stderr' }, theme, {}).render(100).join('\n');
  assert.match(renderedCall, /stderr/, 'The TUI call preview identifies the selected output stream');
});

test('invalid output queries do not mutate jobs or launch children', async () => {
  const id = await launch({ task: 'small result' });
  await finish(id);
  for (const query of [
    { offset: -1 }, { offset: 1.5 }, { limit: 3 }, { limit: 32769 }, { taskIndex: -1 }, { taskIndex: 1 },
    { stepId: 'missing' }, { stepId: 'bad id' }, { taskIndex: 0, stepId: 'step' },
    { offset: 999999 }, { stream: 'stdout' },
  ]) {
    const result = await invoke('subagent_jobs', { action: 'output', jobId: id, ...query });
    assert.equal(result.isError, true);
    assert.ok(result.structuredContent.error);
  }
  const misuse = await invoke('subagent_jobs', { action: 'cancel', jobId: id, offset: 1 });
  assert.equal(misuse.isError, true);
  const wrongAction = await invoke('subagent_jobs', { action: 'status', jobId: id, stream: 'stderr' });
  assert.equal(wrongAction.isError, true);
  assert.match(wrongAction.structuredContent.error, /apply only to action: output/);
  const wrongStepAction = await invoke('subagent_jobs', { action: 'status', jobId: id, stepId: 'step' });
  assert.equal(wrongStepAction.isError, true);
  assert.match(wrongStepAction.structuredContent.error, /apply only to action: output/);
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
