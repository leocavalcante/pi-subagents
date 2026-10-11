import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { createAbortableDeferred, waitWithAbort } = await jiti.import('../abort.ts');

test('abortable deferred removes canceled waiters without canceling shared work', async () => {
  const deferred = createAbortableDeferred();
  const canceled = new AbortController();
  const remaining = new AbortController();
  const canceledWait = deferred.wait(canceled.signal).then(
    () => ({ resolved: true }),
    reason => ({ reason }),
  );
  const remainingWait = deferred.wait(remaining.signal);

  assert.equal(getEventListeners(canceled.signal, 'abort').length, 1);
  assert.equal(getEventListeners(remaining.signal, 'abort').length, 1);
  canceled.abort(null);
  assert.deepEqual(await canceledWait, { reason: null });
  assert.equal(getEventListeners(canceled.signal, 'abort').length, 0);
  assert.equal(getEventListeners(remaining.signal, 'abort').length, 1);

  deferred.resolve('compiled supervisor');
  assert.equal(await remainingWait, 'compiled supervisor');
  assert.equal(getEventListeners(remaining.signal, 'abort').length, 0);
  assert.equal(await deferred.wait(), 'compiled supervisor');
});

test('abortable deferred immediately preserves an already-aborted reason', () => {
  const deferred = createAbortableDeferred();
  const controller = new AbortController();
  controller.abort(null);
  assert.throws(() => deferred.wait(controller.signal), reason => reason === null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abortable deferred shares failures with current and later waiters', async () => {
  const deferred = createAbortableDeferred();
  const failure = new Error('compilation failed');
  const first = deferred.wait();
  const second = deferred.wait();
  deferred.reject(failure);
  await assert.rejects(first, error => error === failure);
  await assert.rejects(second, error => error === failure);
  await assert.rejects(deferred.wait(), error => error === failure);
});

test('waitWithAbort preserves null and other falsy cancellation reasons', async () => {
  for (const reason of [null, false, 0, '']) {
    const controller = new AbortController();
    let resolveOperation;
    const operation = new Promise(resolve => { resolveOperation = resolve; });
    const raced = waitWithAbort(operation, controller.signal).then(
      () => ({ resolved: true }),
      rejected => ({ rejected }),
    );
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort(reason);
    resolveOperation('late result');
    assert.deepEqual(await raced, { rejected: reason });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('waitWithAbort preserves the default AbortError and cleans up after settlement', async () => {
  const canceled = new AbortController();
  const pending = waitWithAbort(new Promise(() => {}), canceled.signal).then(
    () => ({ resolved: true }),
    reason => ({ reason }),
  );
  canceled.abort();
  assert.equal((await pending).reason, canceled.signal.reason);
  assert.equal(getEventListeners(canceled.signal, 'abort').length, 0);

  const completed = new AbortController();
  assert.equal(await waitWithAbort(Promise.resolve('done'), completed.signal), 'done');
  assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
});

test('waitWithAbort immediately propagates an already-aborted null reason', () => {
  const controller = new AbortController();
  controller.abort(null);
  let thrown = Symbol('not thrown');
  try { waitWithAbort(Promise.resolve('unused'), controller.signal); }
  catch (error) { thrown = error; }
  assert.equal(thrown, null);
});
