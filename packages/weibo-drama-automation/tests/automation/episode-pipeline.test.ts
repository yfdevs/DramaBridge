import assert from "node:assert/strict";
import test from "node:test";
import { runWeiboEpisodePipeline } from "../../src/shared/episode-pipeline.js";

test("later valid episodes upload while the first three episodes are still converting", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready: number[] = [];
  let active = 0;
  let maxActive = 0;
  let readyActive = 0;
  let maxReadyActive = 0;
  const pending = runWeiboEpisodePipeline({
    episodes: [1, 2, 3, 4, 5, 6, 7, 8],
    inspect: async (episode) => episode > 3,
    repair: async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      await gate;
      active--;
    },
    onReady: async (episode) => {
      readyActive++;
      maxReadyActive = Math.max(maxReadyActive, readyActive);
      await Promise.resolve();
      ready.push(episode);
      readyActive--;
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ready, [4, 5, 6, 7, 8], "valid files must not wait for any early repair");
    assert.equal(active, 3);
  } finally {
    release();
    await pending;
  }
  assert.deepEqual(
    [...ready].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(maxActive, 3);
  assert.equal(maxReadyActive, 1, "the browser file input must have a single writer");
});

test("a failed upload callback cancels and joins background conversions before returning", async () => {
  let active = 0;
  let stopped = 0;
  const failure = new Error("upload rejected");
  await assert.rejects(
    runWeiboEpisodePipeline({
      episodes: [1, 2, 3, 4],
      inspect: async (episode) => episode === 4,
      repair: async (_episode, signal) => {
        active++;
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.throwIfAborted();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally {
          active--;
          stopped++;
        }
      },
      onReady: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(active, 0);
  assert.ok(stopped > 0);
});

test("stopping a task cancels queued repairs and never schedules further uploads", async () => {
  const controller = new AbortController();
  const reason = new Error("user stopped");
  let ready = 0;
  await assert.rejects(
    runWeiboEpisodePipeline({
      episodes: [1, 2, 3, 4, 5],
      signal: controller.signal,
      inspect: async () => true,
      repair: async () => {
        throw new Error("unexpected repair");
      },
      onReady: async () => {
        ready++;
        controller.abort(reason);
      },
    }),
    (error) => error === reason,
  );
  assert.equal(ready, 1);
});
