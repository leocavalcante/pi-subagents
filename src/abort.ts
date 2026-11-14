export interface AbortableDeferred<T> {
  wait(signal?: AbortSignal): Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export interface SharedAbortableOperationState<T> {
  promise?: Promise<T>;
  deferred?: AbortableDeferred<T>;
}

interface DeferredWaiter<T> {
  resolve(value: T): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type DeferredOutcome<T> =
  { ok: true; value: T } | { ok: false; reason: unknown };

/** Share one eventual result while allowing canceled callers to unsubscribe. */
export function createAbortableDeferred<T>(): AbortableDeferred<T> {
  const waiters = new Set<DeferredWaiter<T>>();
  let outcome: DeferredOutcome<T> | undefined;

  const removeWaiter = (waiter: DeferredWaiter<T>) => {
    waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener("abort", waiter.onAbort);
  };
  const settle = (result: DeferredOutcome<T>) => {
    if (outcome) return;
    outcome = result;
    for (const waiter of [...waiters]) {
      removeWaiter(waiter);
      if (result.ok) waiter.resolve(result.value);
      else waiter.reject(result.reason);
    }
  };

  return {
    wait(signal) {
      signal?.throwIfAborted();
      if (outcome)
        return outcome.ok
          ? Promise.resolve(outcome.value)
          : // Preserve arbitrary rejection reasons from the shared operation.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- callers may reject with non-Error values.
            Promise.reject(outcome.reason);
      return new Promise<T>((resolve, reject) => {
        const waiter: DeferredWaiter<T> = { resolve, reject, signal };
        if (signal) {
          waiter.onAbort = () => {
            removeWaiter(waiter);
            // Preserve the explicit abort reason, including non-Error values.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- abort reasons are part of the caller-facing contract.
            reject(
              signal.reason !== undefined
                ? signal.reason
                : new Error("Subagent was aborted"),
            );
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiters.add(waiter);
      });
    },
    resolve(value) {
      settle({ ok: true, value });
    },
    reject(reason) {
      settle({ ok: false, reason });
    },
  };
}

/** Share a cached operation across abortable callers, clearing it after failure so the next call can retry. */
export function waitForSharedOperation<T>(
  state: SharedAbortableOperationState<T>,
  start: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!state.deferred) {
    const deferred = createAbortableDeferred<T>();
    state.deferred = deferred;
    let compilation = state.promise;
    if (!compilation) {
      try {
        compilation = start();
      } catch (error) {
        // Preserve the exact value thrown by a synchronous start() implementation.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrowing a non-Error value must remain observable.
        compilation = Promise.reject(error);
      }
    }
    state.promise = compilation;
    compilation.then(
      (value) => {
        deferred.resolve(value);
      },
      (error: unknown) => {
        if (state.deferred === deferred) {
          state.promise = undefined;
          state.deferred = undefined;
        }
        deferred.reject(error);
      },
    );
  }
  return state.deferred.wait(signal);
}

/** Race an operation against cancellation while preserving any explicit abort reason. */
export function waitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      // Preserve the explicit abort reason, including non-Error values.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- abort reasons are part of the caller-facing contract.
      reject(
        signal.reason !== undefined
          ? signal.reason
          : new Error("Subagent was aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        // Preserve the exact rejection reason from the original operation.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the returned race preserves arbitrary Promise rejection values.
        reject(error);
      },
    );
  });
}
