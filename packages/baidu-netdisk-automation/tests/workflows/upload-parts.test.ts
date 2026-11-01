import assert from "node:assert/strict";
import test from "node:test";
import { uploadBaiduParts, UPLOAD_PART_CONCURRENCY } from "../../src/workflows/upload-parts.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("warms up one part then overlaps at most four, accepting out-of-order completion", async () => {
  const releases = new Map<number, () => void>();
  const starts: number[] = [];
  let active = 0, maximum = 0;
  const pending = uploadBaiduParts([0, 1, 2, 3, 4, 5], async index => {
    starts.push(index);
    maximum = Math.max(maximum, ++active);
    try { await new Promise<void>(resolve => releases.set(index, resolve)); }
    finally { active--; }
  });
  assert.deepEqual(starts, [0]);
  releases.get(0)!();
  await tick();
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  releases.get(3)!();
  await tick();
  assert.equal(starts.at(-1), 5);
  releases.get(2)!();
  await tick();
  assert.equal(starts.at(-1), 5);
  for (const index of [1, 4, 5]) releases.get(index)!();
  await pending;
  assert.equal(maximum, UPLOAD_PART_CONCURRENCY);
  assert.equal(active, 0);
});

test("a failed part cancels peers and preserves the original failure before any commit", async () => {
  const failure = new Error("[BAIDU_NETDISK_RISK_CONTROL] errno=8001");
  const starts: number[] = [], stopped: number[] = [];
  let rejectPart: (error: unknown) => void = () => undefined;
  let committed = false;
  const pending = uploadBaiduParts([0, 1, 2, 3, 4, 5], async (index, signal) => {
    starts.push(index);
    if (index === 0) return;
    try {
      await new Promise<void>((_resolve, reject) => {
        if (index === 1) rejectPart = reject;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } finally { stopped.push(index); }
  }).then(() => { committed = true; });
  await tick();
  const rejection = assert.rejects(pending, error => error === failure);
  rejectPart(failure);
  await rejection;
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  assert.deepEqual(stopped.sort(), [1, 2, 3, 4]);
  assert.equal(committed, false);
});

test("external cancellation stops warmup, and a resumed subset uploads only requested indices", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = uploadBaiduParts([0, 1, 2], async (_index, signal) => {
    calls++;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, controller.signal);
  const rejection = assert.rejects(pending, /用户停止/);
  controller.abort(new Error("用户停止"));
  await rejection;
  assert.equal(calls, 1);
  const uploaded: number[] = [];
  await uploadBaiduParts([5, 2, 9], async index => { uploaded.push(index); });
  assert.deepEqual(uploaded.sort((a, b) => a - b), [2, 5, 9]);
});
