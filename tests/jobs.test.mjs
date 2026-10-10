import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { jiti } from './pi-runtime.mjs';
const { JobManager, ProcessPool } = await jiti.import('../jobs.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('jobs return immediately, record progress, and deliver once', async () => {
  const gate = deferred();
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), () => false);
  const initial = jobs.start('worker', async (_signal, update) => { update('progress'); await gate.promise; return 'done'; });
  assert.equal(initial.state, 'running');
  assert.equal(delivered.length, 0);
  await tick();
  assert.equal(jobs.get(initial.id).latest, 'progress');
  gate.resolve();
  await tick();
  assert.equal(jobs.get(initial.id).state, 'completed');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].latest, 'done');
  await jobs.shutdown();
});

test('silent jobs preserve progress, results, retention and waiters without completion delivery', async () => {
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), value => value === 'bad', 8, 32, { maxBytes: 3, measure: value => value.length });
  const gate = deferred();
  const active = jobs.start('silent', async (_signal, update) => { update('progress'); return gate.promise; }, { notify: false });
  assert.equal(active.notify, false);
  await tick();
  assert.equal(jobs.get(active.id).latest, 'progress');
  const awaited = jobs.wait(active.id, 1000);
  gate.resolve('bad');
  const finished = await awaited;
  assert.equal(finished.job.state, 'failed');
  assert.equal(finished.job.latest, 'bad');
  assert.equal(finished.job.notify, false);
  const huge = jobs.start('evicted silent', async () => 'too large', { notify: false });
  await jobs.wait(huge.id, 1000);
  assert.equal(jobs.get(huge.id).outputEvicted, true);
  const canceled = jobs.start('canceled silent', async () => 'must not run', { notify: false });
  jobs.cancel(canceled.id);
  assert.equal((await jobs.wait(canceled.id, 1000)).job.state, 'canceled');
  const thrown = jobs.start('thrown silent', async () => { throw new Error('silent failure'); }, { notify: false });
  assert.equal((await jobs.wait(thrown.id, 1000)).job.error, 'silent failure');
  assert.equal(delivered.length, 0);
  const normal = jobs.start('default notification', async () => 'ok');
  await jobs.wait(normal.id, 1000);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].notify, true);
  assert.throws(() => jobs.start('bad notification', async () => 'ok', { notify: 'false' }), /notify/);
  await jobs.shutdown();
});

test('failed results and exceptions are retained without unhandled rejections', async () => {
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), result => result === 'bad');
  const a = jobs.start('failed result', async () => 'bad');
  const b = jobs.start('exception', async () => { throw new Error('broken'); });
  await tick();
  assert.equal(jobs.get(a.id).state, 'failed');
  assert.equal(jobs.get(b.id).error, 'broken');
  assert.equal(delivered.length, 2);
  await jobs.shutdown();
});

test('unprintable thrown values cannot reject job cleanup or leave stale running states', async () => {
  const malformedError = new Error();
  Object.defineProperty(malformedError, 'message', { get() { throw new Error('getter failed'); } });
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), () => false);
  const values = [Object.create(null), malformedError, { toString() { throw new Error('coercion failed'); } }];
  const ids = values.map(value => jobs.start('malformed error', async () => { throw value; }).id);
  await tick();
  for (const id of ids) {
    assert.equal(jobs.get(id).state, 'failed');
    assert.match(jobs.get(id).error, /Unable to describe thrown value/);
    assert.ok(jobs.get(id).finishedAt);
  }
  assert.equal(delivered.length, 3);
  await jobs.shutdown();
});

test('job diagnostics are UTF-8 bounded and retain the run failure when delivery also fails', async () => {
  const jobs = new JobManager(() => { throw new Error('delivery failed'); }, () => false);
  const first = jobs.start('two failures', async () => { throw new Error('run failed'); });
  const large = jobs.start('large failure', async () => { throw new Error('😀'.repeat(10000)); });
  await tick();
  assert.match(jobs.get(first.id).error, /run failed/);
  assert.match(jobs.get(first.id).error, /Completion delivery failed: delivery failed/);
  assert.ok(Buffer.byteLength(jobs.get(large.id).error) <= 2048);
  assert.equal(jobs.get(large.id).error.includes('�'), false);
  assert.match(jobs.get(large.id).error, /truncated/);
  await jobs.shutdown();
});

test('cancel-before-start avoids execution; repeated cancellation is safe', async () => {
  const jobs = new JobManager(() => {}, () => false);
  let ran = false;
  const job = jobs.start('cancel', async () => { ran = true; });
  assert.equal(jobs.cancel(job.id).state, 'canceling');
  jobs.cancel(job.id);
  await tick();
  assert.equal(ran, false);
  assert.equal(jobs.get(job.id).state, 'canceled');
  assert.equal(jobs.cancel('unknown'), undefined);
  await jobs.shutdown();
});

test('shutdown aborts, waits for cleanup, and suppresses late delivery', async () => {
  const cleaned = deferred();
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), () => false);
  let signal;
  jobs.start('pending', async s => { signal = s; await cleaned.promise; return 'late'; });
  await tick();
  let closed = false;
  const shutdown = jobs.shutdown().then(() => { closed = true; });
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  cleaned.resolve();
  await shutdown;
  assert.equal(delivered.length, 0);
  assert.deepEqual(jobs.list(), []);
  assert.throws(() => jobs.start('new', async () => 'x'), /shutdown/);
  await jobs.shutdown();
});

test('job budgets and finished retention are bounded', async () => {
  const jobs = new JobManager(() => {}, () => false, 1, 2);
  const gate = deferred();
  jobs.start('first', async () => gate.promise);
  assert.throws(() => jobs.start('second', async () => 'x'), /Max is 1/);
  gate.resolve();
  await tick();
  for (let i = 0; i < 4; i++) { jobs.start(String(i), async () => 'done'); await tick(); }
  assert.equal(jobs.list().length, 2);
  await jobs.shutdown();
});

test('retention follows completion order when an early-started job finishes last', async () => {
  const jobs = new JobManager(() => {}, () => false, 8, 2);
  const gate = deferred();
  const slow = jobs.start('slow', async () => gate.promise);
  for (let i = 0; i < 4; i++) { jobs.start(String(i), async () => 'done'); await tick(); }
  gate.resolve();
  await tick();
  assert.equal(jobs.get(slow.id).state, 'completed');
  assert.equal(jobs.list().length, 2);
  assert.equal(jobs.list().at(-1).id, slow.id);
  await jobs.shutdown();
});

test('completion delivery failures stay inspectable', async () => {
  const jobs = new JobManager(() => { throw new Error('delivery'); }, () => false);
  const job = jobs.start('job', async () => 'done');
  await tick();
  assert.match(jobs.get(job.id).error, /Completion delivery failed: delivery/);
  await jobs.shutdown();
});

test('finished output retention has a byte budget without dropping job metadata or delivery', async () => {
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), () => false, 8, 32, { maxBytes: 10, measure: result => Buffer.byteLength(result) });
  const a = jobs.start('a', async () => 'aaaaaa');
  await tick();
  const b = jobs.start('b', async () => 'bbbbbb');
  await tick();
  assert.equal(jobs.get(a.id).state, 'completed');
  assert.equal(jobs.get(a.id).outputEvicted, true);
  assert.equal(jobs.get(a.id).latest, undefined);
  assert.equal(jobs.get(b.id).latest, 'bbbbbb');
  assert.equal(delivered[0].latest, 'aaaaaa');
  assert.equal(delivered[1].latest, 'bbbbbb');
  const huge = jobs.start('huge', async () => 'x'.repeat(30));
  await tick();
  assert.equal(jobs.get(huge.id).outputEvicted, true);
  assert.equal(jobs.get(b.id).latest, 'bbbbbb', 'An individually oversized result must not evict useful smaller results');
  await jobs.shutdown();
});

test('waits re-entered from completion delivery resolve after output retention', async () => {
  const delivered = [];
  let jobs;
  let completionWait;
  jobs = new JobManager(job => {
    delivered.push(job);
    completionWait = jobs.wait(job.id, 1000);
  }, () => false, 8, 32, { maxBytes: 3, measure: result => result.length });
  const job = jobs.start('re-entrant wait', async () => 'too large');
  const waiting = jobs.wait(job.id, 1000);
  const finished = await waiting;
  const reentered = await completionWait;
  assert.equal(finished.job.outputEvicted, true);
  assert.equal(reentered.job.outputEvicted, true);
  assert.equal(reentered.job.latest, undefined);
  assert.equal(delivered[0].latest, 'too large', 'Completion delivery still receives the result before eviction');
  await jobs.shutdown();
});

test('compact observations are detached, survive output eviction, and share job lifetime', async () => {
  const jobs = new JobManager(() => {}, () => false, 8, 32,
    { maxBytes: 0, measure: () => 1 }, result => result.total === undefined ? undefined : result);
  const gate = deferred();
  let progress;
  const job = jobs.start('observed', async (_signal, update) => {
    progress = { total: 2, cost: { total: 2 } };
    update(progress);
    await gate.promise;
    return { total: 5, cost: { total: 5 } };
  });
  await tick();
  progress.cost.total = 99;
  assert.equal(jobs.getObservation(job.id).cost.total, 2, 'Mutating a progress result must not change its retained observation');
  gate.resolve();
  await jobs.wait(job.id, 1000);
  assert.equal(jobs.get(job.id).outputEvicted, true);
  assert.equal(jobs.get(job.id).latest, undefined);
  const observation = jobs.getObservation(job.id);
  assert.equal(observation.total, 5, 'Final observation is retained independently of output');
  observation.cost.total = 99;
  assert.equal(jobs.getObservation(job.id).cost.total, 5, 'Mutating a returned observation must not alter retained metadata');
  assert.equal(jobs.forget(job.id), true);
  assert.equal(jobs.getObservation(job.id), undefined, 'Forgetting a job releases its observation');

  const unavailable = jobs.start('unavailable observation', async (_signal, update) => {
    update({ total: 7 });
    update({});
    return {};
  });
  await jobs.wait(unavailable.id, 1000);
  assert.equal(jobs.getObservation(unavailable.id), undefined, 'A missing summary must clear a stale partial value');
  await jobs.shutdown();
});

test('forget and clear only remove finished jobs', async () => {
  const jobs = new JobManager(() => {}, () => false);
  const gate = deferred();
  const active = jobs.start('active', async () => gate.promise);
  const finished = jobs.start('finished', async () => 'done');
  await tick();
  assert.throws(() => jobs.forget(active.id), /active/);
  assert.equal(jobs.forget('unknown'), false);
  assert.equal(jobs.forget(finished.id), true);
  assert.equal(jobs.get(finished.id), undefined);
  jobs.start('second finished', async () => 'done');
  await tick();
  assert.equal(jobs.clearFinished(), 1);
  assert.equal(jobs.get(active.id).state, 'running');
  gate.resolve('done');
  await tick();
  assert.equal(jobs.clearFinished(), 1);
  await jobs.shutdown();
});

test('late updates cannot restore evicted output after completion', async () => {
  let update;
  const jobs = new JobManager(() => {}, () => false, 8, 32, { maxBytes: 0, measure: () => 1 });
  const job = jobs.start('late', async (_signal, callback) => { update = callback; return 'done'; });
  await tick();
  update('late output');
  assert.equal(jobs.get(job.id).latest, undefined);
  assert.equal(jobs.get(job.id).outputEvicted, true);
  await jobs.shutdown();
});

test('retention measurement failures remain safe and inspectable', async () => {
  for (const measure of [() => NaN, () => { throw new Error('measurement'); }]) {
    const jobs = new JobManager(() => {}, () => false, 8, 32, { maxBytes: 10, measure });
    const job = jobs.start('bad measurement', async () => 'done');
    await tick();
    assert.equal(jobs.get(job.id).outputEvicted, true);
    assert.match(jobs.get(job.id).error, /retention/);
    await jobs.shutdown();
  }
  assert.throws(() => new JobManager(() => {}, () => false, 0), /positive/);
  assert.throws(() => new JobManager(() => {}, () => false, 8, -1), /non-negative/);
});

test('wait resolves every observer after completion and retention, including failed jobs', async () => {
  const gate = deferred();
  const delivered = [];
  const jobs = new JobManager(job => delivered.push(job), value => value === 'bad', 8, 32, { maxBytes: 0, measure: () => 1 });
  const job = jobs.start('waited', async () => gate.promise);
  const controller = new AbortController();
  const first = jobs.wait(job.id, 1000, controller.signal);
  const second = jobs.wait(job.id, 1000);
  gate.resolve('bad');
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.timedOut, false);
    assert.equal(result.job.state, 'failed');
    assert.equal(result.job.outputEvicted, true);
    assert.equal(result.job.latest, undefined);
    assert.ok(result.job.finishedAt);
  }
  assert.equal(delivered.length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal((await jobs.wait(job.id, 1000)).timedOut, false);
  assert.equal(await jobs.wait('unknown', 1000), undefined);
  await jobs.shutdown();
});

test('wait timeouts and aborted waits remove observers without canceling the job', async () => {
  const gate = deferred();
  const jobs = new JobManager(() => {}, () => false);
  let jobSignal;
  const job = jobs.start('long', async signal => { jobSignal = signal; return gate.promise; });
  const controller = new AbortController();
  const timed = await jobs.wait(job.id, 1, controller.signal);
  assert.equal(timed.timedOut, true);
  assert.equal(timed.job.state, 'running');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(jobs.jobs.get(job.id).waiters.size, 0);
  for (let i = 0; i < 20; i++) await jobs.wait(job.id, 1);
  assert.equal(jobs.jobs.get(job.id).waiters.size, 0, 'Expired observers must not accumulate until job completion');
  const aborted = jobs.wait(job.id, 1000, controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  const nullReasonController = new AbortController();
  const nullReasonWait = jobs.wait(job.id, 1000, nullReasonController.signal).then(
    () => ({ resolved: true }),
    reason => ({ reason }),
  );
  nullReasonController.abort(null);
  assert.deepEqual(await nullReasonWait, { reason: null });
  assert.equal(jobSignal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(jobs.jobs.get(job.id).waiters.size, 0);
  const next = jobs.wait(job.id, 1000);
  gate.resolve('done');
  assert.equal((await next).job.state, 'completed');
  await jobs.shutdown();
});

test('wait observes explicit job cancellation and shutdown after cleanup', async () => {
  for (const shutdown of [false, true]) {
    const cleaned = deferred();
    const jobs = new JobManager(() => {}, () => false);
    const job = jobs.start('cleanup', async signal => { await cleaned.promise; signal.throwIfAborted(); });
    await tick();
    let resolved = false;
    const waiter = jobs.wait(job.id, 1000).then(result => { resolved = true; return result; });
    const close = shutdown ? jobs.shutdown() : Promise.resolve(jobs.cancel(job.id));
    await tick();
    assert.equal(resolved, false, 'A cancellation request is not completed cleanup');
    cleaned.resolve();
    const result = await waiter;
    assert.equal(result.job.state, 'canceled');
    assert.equal(result.job.error, undefined, 'The expected abort reason is not a job failure diagnostic');
    await close;
    await jobs.shutdown();
  }
});

test('wait validates bounds and preserves abort-before-wait and abort-after-finish semantics', async () => {
  const jobs = new JobManager(() => {}, () => false);
  const job = jobs.start('instant', async () => 'done');
  for (const timeout of [0, -1, 1.5, NaN, Infinity, 60001]) await assert.rejects(jobs.wait(job.id, timeout), /timeoutMs/);
  await assert.rejects(jobs.wait(job.id, 1000, AbortSignal.abort()), { name: 'AbortError' });
  await tick();
  const controller = new AbortController();
  const result = await jobs.wait(job.id, 1000, controller.signal);
  controller.abort();
  assert.equal(result.job.state, 'completed');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await jobs.shutdown();
});

test('process pool shares slots fairly and cancels queued requests', async () => {
  const pool = new ProcessPool(1);
  const release = await pool.acquire();
  const canceled = new AbortController();
  const queued = pool.acquire(canceled.signal);
  const next = pool.acquire();
  canceled.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  let granted = false;
  next.then(() => { granted = true; });
  await tick();
  assert.equal(granted, false);
  release(); release();
  const releaseNext = await next;
  releaseNext();
  (await pool.acquire())();
  const alreadyAborted = AbortSignal.abort();
  await assert.rejects(pool.acquire(alreadyAborted), { name: 'AbortError' });
  assert.throws(() => new ProcessPool(0), /positive integer/);
});

test('process pool releases a slot if cancellation races with grant', async () => {
  const pool = new ProcessPool(1);
  const release = await pool.acquire();
  const controller = new AbortController();
  const queued = pool.acquire(controller.signal);
  release();
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  (await pool.acquire())();
});

test('queued process acquisitions preserve explicit null abort reasons', async () => {
  const pool = new ProcessPool(1);
  const release = await pool.acquire();
  const controller = new AbortController();
  const queued = pool.acquire(controller.signal).then(
    () => ({ resolved: true }),
    reason => ({ reason }),
  );
  controller.abort(null);
  assert.deepEqual(await queued, { reason: null });
  release();
  (await pool.acquire())();
});

test('process pool bounds queued acquisitions without disturbing fair waiters', async () => {
  const pool = new ProcessPool(1, 2);
  const release = await pool.acquire();
  const canceled = new AbortController();
  const first = pool.acquire(canceled.signal);
  const second = pool.acquire();
  await assert.rejects(pool.acquire(), /queue is full \(maximum 2 waiting tasks\)/);
  canceled.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  const releaseSecond = await second;
  releaseSecond();
  (await pool.acquire())();
  assert.throws(() => new ProcessPool(1, -1), /queue limit/);
  assert.throws(() => new ProcessPool(1, 1.5), /queue limit/);
  assert.throws(() => new ProcessPool(1, Infinity), /queue limit/);
});
