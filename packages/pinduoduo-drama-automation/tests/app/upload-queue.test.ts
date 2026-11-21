import assert from "node:assert/strict";
import test from "node:test";
import { PinduoduoUploadQueue } from "../../src/app/upload-queue.js";

function fixture(initial: number[]) {
  let now = 0;
  let records = [...initial];
  const events: string[] = [];
  const queue = new PinduoduoUploadQueue(100, () => now);
  const actions = {
    recover: async () => { events.push("recover"); },
    read: async () => [...records],
    key: (id: number) => id,
    sync: async () => { events.push("sync"); },
    process: async (id: number) => { events.push(`upload:${id}`); records = records.filter(record => record !== id); return true; },
  };
  return { queue, actions, events, advance: (time: number) => { now = time; }, set: (next: number[]) => { records = next; } };
}

test("resumes persisted backlog before querying approved dramas and immediately checks when drained", async () => {
  const f = fixture([1, 2]);
  assert.equal(await f.queue.run(f.actions), 2);
  assert.deepEqual(f.events, ["recover", "upload:1", "upload:2", "sync"]);
  await f.queue.run(f.actions);
  assert.equal(f.events.filter(event => event === "sync").length, 1);
  assert.equal(f.events.filter(event => event === "recover").length, 1);
});

test("empty startup queries once, then waits for the configured interval", async () => {
  const f = fixture([]);
  await f.queue.run(f.actions);
  f.advance(99); await f.queue.run(f.actions);
  assert.deepEqual(f.events, ["recover", "sync"]);
  f.advance(100); await f.queue.run(f.actions);
  assert.deepEqual(f.events, ["recover", "sync", "sync"]);
});

test("empty-queue discovery continues new work promptly without waiting another full interval", async () => {
  const f = fixture([1]);
  f.actions.sync = async () => { f.events.push("sync"); f.set([2]); };
  await f.queue.run(f.actions);
  assert.equal(f.queue.nextDelayMs, 1000);
  f.actions.sync = async () => { f.events.push("sync"); };
  await f.queue.run(f.actions);
  assert.deepEqual(f.events, ["recover", "upload:1", "sync", "upload:2", "sync"]);
});

test("long backlogs check the platform interval between records instead of deferring until all uploads finish", async () => {
  const f = fixture([1, 2]);
  const process = f.actions.process;
  f.actions.process = async id => { const result = await process(id); if (id === 1) f.advance(100); return result; };
  await f.queue.run(f.actions);
  assert.deepEqual(f.events.slice(0, 5), ["recover", "upload:1", "sync", "upload:2", "sync"]);
});

test("failed tasks are not tight-loop retried and cancellation prevents further queries", async () => {
  const f = fixture([1]);
  f.actions.process = async () => false;
  await f.queue.run(f.actions);
  assert.equal(f.queue.nextDelayMs, 1000);
  assert.deepEqual(f.events, ["recover"]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.queue.run({ ...f.actions, signal: controller.signal }));
  assert.deepEqual(f.events, ["recover"]);
});

test("platform query failures never claim an empty queue was checked successfully", async () => {
  const f = fixture([]);
  f.actions.sync = async () => { throw new Error("offline"); };
  await assert.rejects(f.queue.run(f.actions), /offline/);
  f.actions.sync = async () => { f.events.push("sync"); };
  await f.queue.run(f.actions);
  assert.deepEqual(f.events, ["recover", "recover", "sync"]);
});

test("a failed task status write schedules recovery before reading work again", async () => {
  const f = fixture([1]);
  f.actions.process = async () => { f.set([]); throw new Error("cloud status write failed"); };
  await assert.rejects(f.queue.run(f.actions), /cloud status write failed/);
  assert.equal(f.queue.nextDelayMs, 15_000);
  f.actions.recover = async () => { f.events.push("recover interrupted"); f.set([1]); };
  f.actions.process = async id => { f.events.push(`retry:${id}`); f.set([]); return true; };
  await f.queue.run(f.actions);
  assert.deepEqual(f.events.slice(0, 3), ["recover", "recover interrupted", "retry:1"]);
});
