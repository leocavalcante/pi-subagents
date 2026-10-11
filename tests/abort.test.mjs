import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { jiti } from './pi-runtime.mjs';
const { waitWithAbort } = await jiti.import('../abort.ts');

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
