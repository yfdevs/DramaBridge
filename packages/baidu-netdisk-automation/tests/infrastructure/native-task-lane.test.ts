import assert from "node:assert/strict";
import test from "node:test";
import { runNativeTaskOperationExclusive } from "../../src/infrastructure/native-task-lane.js";

test("polling and task controls for one native client cannot overwrite each other's callbacks", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = runNativeTaskOperationExclusive(9337, async () => {
    events.push("read start"); await gate; events.push("read end");
  });
  const second = runNativeTaskOperationExclusive(9337, async () => { events.push("control"); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["read start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["read start", "read end", "control"]);
});

test("failed reads release their lane and separate clients remain independent", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failed = runNativeTaskOperationExclusive(9337, async () => {
    await gate; throw new Error("read timeout");
  });
  const failure = assert.rejects(failed, /read timeout/);
  const queued = runNativeTaskOperationExclusive(9337, async () => "next read");
  assert.equal(await runNativeTaskOperationExclusive(9338, async () => "other client"), "other client");
  release();
  await failure;
  assert.equal(await queued, "next read");
});
