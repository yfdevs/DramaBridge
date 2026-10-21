import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeController } from "./runtime-controller";

type TestRuntime = {
  stop: () => Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("coalesces concurrent runtime starts", async () => {
  const controller = new RuntimeController<TestRuntime>();
  const pending = deferred<TestRuntime>();
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls += 1;
    return pending.promise;
  };
  const runtime = { stop: async () => undefined };

  const first = controller.start(factory);
  const second = controller.start(factory);
  pending.resolve(runtime);

  assert.equal(await first, runtime);
  assert.equal(await second, runtime);
  assert.equal(factoryCalls, 1);
  assert.equal(controller.current, runtime);
});

test("cleans up a runtime that finishes starting after background shutdown", async () => {
  const controller = new RuntimeController<TestRuntime>();
  const pending = deferred<TestRuntime>();
  let stopCalls = 0;
  const runtime = {
    stop: async () => {
      stopCalls += 1;
    },
  };

  const starting = controller.start(() => pending.promise);
  controller.stopInBackground();
  pending.resolve(runtime);

  await assert.rejects(starting, /start was cancelled/i);
  assert.equal(stopCalls, 1);
  assert.equal(controller.current, null);
  assert.equal(controller.running, false);
});

test("deduplicates concurrent runtime stops", async () => {
  const controller = new RuntimeController<TestRuntime>();
  const pendingStop = deferred<void>();
  let stopCalls = 0;
  await controller.start(async () => ({
    stop: () => {
      stopCalls += 1;
      return pendingStop.promise;
    },
  }));

  const first = controller.stop();
  const second = controller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1);
  pendingStop.resolve();
  await Promise.all([first, second]);
  assert.equal(stopCalls, 1);
  assert.equal(controller.running, false);
});
