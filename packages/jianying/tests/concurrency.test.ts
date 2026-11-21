import assert from "node:assert/strict";
import { test } from "node:test";
import { runConcurrent } from "../src/concurrency.js";

test("six episodes overlap with at most two active workers", async () => {
  let active = 0, peak = 0;
  const completed: number[] = [];
  await runConcurrent([1, 2, 3, 4, 5, 6], 2, undefined, async episode => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    completed.push(episode); active--;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5, 6]);
});

test("failure cancels and drains siblings before reporting the original error", async () => {
  const started: number[] = [];
  let drained = false;
  const error = new Error("encoder failed");
  await assert.rejects(runConcurrent([1, 2, 3, 4], 2, undefined, async (episode, signal) => {
    started.push(episode);
    if (episode === 1) { await Promise.resolve(); throw error; }
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
    drained = true;
  }), value => value === error);
  assert.deepEqual(started, [1, 2]);
  assert.ok(drained);
});

test("cancellation prevents queued episodes from starting", async () => {
  const controller = new AbortController();
  const started: number[] = [];
  await assert.rejects(runConcurrent([1, 2, 3], 2, controller.signal, async episode => {
    started.push(episode); controller.abort();
  }), { name: "AbortError" });
  assert.deepEqual(started, [1]);
});
