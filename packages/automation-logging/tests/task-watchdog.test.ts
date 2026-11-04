/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { ProgressTaskWatchdog, ghostCheckIntervalMs, ghostIdleTimeoutMs, type WatchdogRecord, type WatchedTaskIdentity } from "../src/task-watchdog.js";
const identity: WatchedTaskIdentity = { taskId: 76, accountId: "account", workerId: "local-worker", attemptCount: 1, apiBaseUrl: "https://backend.test" };
function fixture() {
  let now = 0; let records: WatchdogRecord[] = []; let fail = false;
  let remote: { owned: boolean; pending: boolean } | undefined = { owned: true, pending: true };
  const reports: boolean[] = []; let resolved = 0;
  const options = {
    load: () => structuredClone(records), save: (value: WatchdogRecord[]) => { records = structuredClone(value); },
    apiBaseUrl: () => identity.apiBaseUrl, now: () => now, schedule: false,
    inspect: async () => remote,
    report: async (_record: WatchedTaskIdentity, success: boolean) => { if (fail) throw new Error("offline"); reports.push(success); },
    onResolved: () => { resolved++; },
  };
  const monitor = new ProgressTaskWatchdog(options);
  return { monitor, options, reports, time: (value: number) => { now = value; }, records: () => records,
    remote: (value: typeof remote) => { remote = value; }, fail: (value: boolean) => { fail = value; }, resolved: () => resolved };
}

test("runs every three hours and only expires records idle for at least four hours", async () => {
  assert.equal(ghostCheckIntervalMs, 3 * 60 * 60_000); assert.equal(ghostIdleTimeoutMs, 4 * 60 * 60_000);
  const f = fixture(); f.monitor.seed(identity, new Date(0).toISOString());
  await f.monitor.sweep(ghostIdleTimeoutMs - 1); assert.deepEqual(f.reports, []);
  const summary = await f.monitor.sweep(ghostIdleTimeoutMs); assert.deepEqual(f.reports, [false]);
  assert.deepEqual(summary, { busy: false, inspected: 1, failed: 1, succeeded: 0, released: 0, errors: 0 });
  await f.monitor.sweep(ghostIdleTimeoutMs * 2); assert.deepEqual(f.reports, [false]);
});

test("real progress extends the deadline, repeated progress does not, and expired work cannot submit", async () => {
  const f = fixture(); let canceled = 0; let finish!: () => void;
  const run = f.monitor.run(identity, () => new Promise<void>(resolve => { finish = resolve; }), async () => { canceled++; });
  const outcome = run.catch(error => error as Error);
  await Promise.resolve();
  f.time(ghostCheckIntervalMs); f.monitor.progress(identity.taskId, "uploaded 10/60");
  await f.monitor.sweep(ghostIdleTimeoutMs); assert.equal(canceled, 0);
  f.time(ghostCheckIntervalMs + ghostIdleTimeoutMs); f.monitor.progress(identity.taskId, "uploaded 10/60");
  await f.monitor.sweep(); assert.equal(canceled, 1); assert.deepEqual(f.reports, [false]);
  assert.match(String(await outcome), /STALE_TASK_NO_PROGRESS/);
  assert.throws(() => f.monitor.assertActive(identity.taskId, identity.workerId, 1), /STALE_TASK_NO_PROGRESS/);
  finish(); await Promise.resolve(); assert.equal(f.records()[0].state, "reported");
});

for (const state of [{ owned: false, pending: true }, { owned: true, pending: false }]) {
  test(`does not report tasks belonging to another attempt or already finished (${JSON.stringify(state)})`, async () => {
    const f = fixture(); f.monitor.seed(identity, new Date(0).toISOString()); f.remote(state);
    await f.monitor.sweep(ghostIdleTimeoutMs); assert.deepEqual(f.reports, []); assert.equal(f.resolved(), 1);
  });
}

test("retries a failed cleanup after restarting and retains the original ownership", async () => {
  const f = fixture(); f.monitor.seed(identity, new Date(0).toISOString()); f.fail(true);
  await f.monitor.sweep(ghostIdleTimeoutMs); assert.equal(f.records()[0].state, "expired");
  assert.equal(f.records()[0].workerId, identity.workerId); assert.equal(f.records()[0].attemptCount, 1);
  f.fail(false); f.time(ghostIdleTimeoutMs + ghostCheckIntervalMs);
  const restarted = new ProgressTaskWatchdog(f.options); await restarted.sweep();
  assert.deepEqual(f.reports, [false]); assert.equal(f.records()[0].state, "reported");
});

test("a locally successful result is retried as success rather than overwritten as failure", async () => {
  const f = fixture(); await f.monitor.run(identity, async () => "done", async () => {});
  await f.monitor.sweep(ghostIdleTimeoutMs); assert.deepEqual(f.reports, [true]);
});

test("does not touch a different backend or a task missing from the server", async () => {
  const f = fixture(); f.monitor.seed({ ...identity, apiBaseUrl: "https://other.test" }, new Date(0).toISOString());
  f.monitor.seed(identity, new Date(0).toISOString()); f.remote(undefined);
  await f.monitor.sweep(ghostIdleTimeoutMs); assert.deepEqual(f.reports, []);
  assert.equal(f.records().filter(item => item.state === "running").length, 2);
});

test("progress arriving during the backend lookup cancels cleanup", async () => {
  const f = fixture(); let finish!: () => void;
  const monitor = new ProgressTaskWatchdog({ ...f.options, inspect: async () => {
    f.time(ghostIdleTimeoutMs); monitor.progress(identity.taskId, "uploaded 60/60"); return { owned: true, pending: true };
  } });
  const run = monitor.run(identity, () => new Promise<void>(resolve => { finish = resolve; }), async () => {});
  await Promise.resolve(); await monitor.sweep(ghostIdleTimeoutMs); assert.deepEqual(f.reports, []);
  finish(); await run;
});


test("manual cleanup reports an existing sweep instead of submitting twice", async () => {
  const f = fixture(); let finish!: () => void;
  const monitor = new ProgressTaskWatchdog({ ...f.options, inspect: async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { owned: true, pending: true };
  } });
  monitor.seed(identity, new Date(0).toISOString());
  const first = monitor.sweep(ghostIdleTimeoutMs);
  await Promise.resolve();
  assert.equal((await monitor.sweep(ghostIdleTimeoutMs)).busy, true);
  finish();
  assert.equal((await first).failed, 1);
  assert.deepEqual(f.reports, [false]);
});

test("discovers and cleans a remote computer's task without any local claim record", async () => {
  const f = fixture();
  f.monitor.observe({ ...identity, workerId: "remote-computer", accountId: "another-account" }, 0);
  f.time(ghostCheckIntervalMs);
  f.monitor.observe({ ...identity, workerId: "remote-computer", accountId: "another-account" }, 0);
  const result = await f.monitor.sweep(ghostIdleTimeoutMs);
  assert.equal(result.failed, 1); assert.deepEqual(f.reports, [false]);
});

test("backend progress postpones cleanup without resetting timestamps on every scan", async () => {
  const f = fixture(); f.monitor.observe(identity, 0);
  f.monitor.observe(identity, ghostCheckIntervalMs);
  await f.monitor.sweep(ghostIdleTimeoutMs); assert.deepEqual(f.reports, []);
  f.monitor.observe(identity, ghostCheckIntervalMs);
  await f.monitor.sweep(ghostCheckIntervalMs + ghostIdleTimeoutMs);
  assert.deepEqual(f.reports, [false]);
});
