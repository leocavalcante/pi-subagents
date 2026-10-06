import assert from 'node:assert/strict';
import test from 'node:test';
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
