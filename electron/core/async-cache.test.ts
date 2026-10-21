import assert from "node:assert/strict";
import test from "node:test";

import { createAsyncCache } from "./async-cache";

test("deduplicates concurrent async cache loads", async () => {
  let calls = 0;
  let release!: (value: number) => void;
  const loader = () => {
    calls += 1;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  };
  const read = createAsyncCache(loader, 1_000);

  const first = read();
  const second = read();
  assert.equal(calls, 1);
  release(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(await read(), 42);
  assert.equal(calls, 1);
});

test("does not cache rejected async loads", async () => {
  let calls = 0;
  const read = createAsyncCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return "ready";
  }, 1_000);

  await assert.rejects(read(), /temporary failure/);
  assert.equal(await read(), "ready");
  assert.equal(calls, 2);
});
