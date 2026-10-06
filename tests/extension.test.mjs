import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadExtensions } from './pi-runtime.mjs';

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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await sleep(10); }
  throw new Error('Timed out waiting for test condition');
};
const finish = id => waitFor(async () => { const job = await status(id); return job.finishedAt ? job : undefined; });
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
  assert.equal(traces().filter(t => t.event === 'start').length, 4);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message.content, /canceled/);
  assert.match(messages[0].message.content, /Canceled by request/);
  const next = await launch({ task: 'after cancellation' });
  assert.equal((await finish(next)).state, 'completed');
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
  assert.match(job.latest.content[0].text, /earlier messages omitted/);
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
    assert.match(failed.error, /prompt write failure/);
    assert.equal(existsSync(dirname(promptPath)), false);
  } finally { write.mock.restore(); }
  assert.equal((await finish(await launch({ task: 'after prompt write error' }))).state, 'completed');
});

test('malformed child events fail cleanly without crashing or retaining slots', async () => {
  for (const task of ['malformed-null', 'malformed-content', 'malformed-usage', 'malformed-json', 'malformed-metadata', 'malformed-pending', 'malformed-legacy', 'malformed-message']) {
    const job = await finish(await launch({ task }));
    assert.equal(job.state, 'failed');
    assert.match(job.latest.content[0].text, /Invalid subagent JSON event/);
    assert.match(job.latest.content[0].text, /^Agent failed:/);
  }
  assert.equal((await finish(await launch({ task: 'after malformed output' }))).state, 'completed');
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

test('large tasks use stdin and relative cwd resolves from the parent session', async () => {
  const task = 'x'.repeat(256 * 1024);
  const result = await invoke('subagent', { agent: 'worker', task, cwd: 'project' });
  assert.equal(result.isError, undefined);
  const child = traces().find(t => t.event === 'start');
  assert.equal(child.task, task);
  assert.equal(child.cwd, join(sandbox, 'project'));
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
  const launched = await invoke('subagent', { background: true, tasks: Array.from({ length: 4 }, () => ({ agent: 'worker', task: 'retention-heavy' })) });
  const id = launched.details.background.id;
  const job = await finish(id);
  assert.equal(job.state, 'completed');
  assert.equal(job.outputEvicted, true);
  assert.equal(job.latest, undefined);
  assert.equal(messages[0].message.details.latest.details.results.length, 4);
  assert.match((await invoke('subagent_jobs', { action: 'status', jobId: id })).content[0].text, /evicted/);
  assert.match((await invoke('subagent_jobs', { action: 'list' })).content[0].text, /output evicted/);
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

test('parallel responses share a total text budget and keep every captured result', async () => {
  const result = await invoke('subagent', { tasks: Array.from({ length: 8 }, () => ({ agent: 'worker', task: 'large' })) });
  assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
  assert.match(result.content[0].text, /8\/8 succeeded/);
  assert.match(result.content[0].text, /Output truncated/);
  assert.equal(result.details.results.length, 8);
  assert.ok(result.details.results.every(r => r.messages.at(-1).content[0].text.length === 40000));
  assert.equal(result.content[0].text.match(/### \[worker\] completed/g).length, 8);
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
