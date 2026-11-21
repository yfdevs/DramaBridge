import assert from "node:assert/strict";
import test from "node:test";
import { BaiduAutoCleanup, type AutoCleanupJournal } from "../../electron/platforms/baidu-netdisk/auto-cleanup";
import type { CleanupDirectory } from "@dramabridge/baidu-netdisk-automation";

const now = Date.parse("2026-11-16T04:00:00Z"), old = (now - 86400_000) / 1000;
const directory: CleanupDirectory = { path: "/旧剧", fs_id: "1", isdir: 1, server_ctime: old, server_mtime: old };
function fixture() {
  let enabled = true, used = 90, busy = false;
  let journal: AutoCleanupJournal = { pending: null, pausedReason: "" };
  const calls: string[] = [];
  const runtime = {
    readBaiduCleanup: async (_port: number, action: string) => { calls.push(action); return action === "quota" ? { quota: { used, total: 100 } } : action === "roots" ? { roots: [directory] } : {}; },
    deleteBaiduCleanupDirectory: async (_port?: number, _root?: CleanupDirectory, _allowed?: () => boolean, _inspection?: { entries: Array<CleanupDirectory & { size?: number }>; scannedAt: number }) => { assert.equal(journal.pending?.path, directory.path); calls.push("delete"); used = 70; },
  };
  const deps = { enabled: () => enabled, ready: async () => true, occupied: () => busy, port: () => 9337, runtime: async () => runtime, exclusive: async <T>(fn: () => Promise<T>) => fn(), protectedPaths: () => [] as string[], journal: () => journal, saveJournal: (value: AutoCleanupJournal) => { journal = value; }, warn: () => {}, now: () => now, delay: async () => {} };
  return { monitor: new BaiduAutoCleanup(deps), deps, runtime, calls, journal: () => journal, enable: (value: boolean) => { enabled = value; }, usage: (value: number) => { used = value; }, busy: (value: boolean) => { busy = value; } };
}
test("disabled and busy clients issue no reads or deletes; exactly 80 percent never deletes", async () => {
  const f = fixture(); f.enable(false); await f.monitor.tick(); assert.deepEqual(f.calls, []);
  const b = fixture(); b.busy(true); await b.monitor.tick(); assert.deepEqual(b.calls, []);
  const q = fixture(); q.usage(80); await q.monitor.tick(); assert.deepEqual(q.calls, ["quota"]);
});
test("above 80 percent checks eligibility and journals before deleting", async () => {
  const f = fixture(); await f.monitor.tick();
  assert.deepEqual(f.calls, ["quota", "roots", "inspect", "delete", "quota"]);
  assert.equal(f.monitor.getStatus().deleted, 1); assert.equal(f.journal().pending, null);
});
test("the same exclusive operation forwards its inspected snapshot instead of requiring another full scan", async () => {
  const f = fixture(); const entries = [{ ...directory, path: "/旧剧/1.mp4", fs_id: "2", isdir: 0, size: 100 }];
  let deleted = false;
  f.runtime.readBaiduCleanup = async (_port, action) => action === "quota" ? { quota: { used: deleted ? 70 : 90, total: 100 } } : action === "roots" ? { roots: [directory] } : { entries, scannedAt: now };
  let received: unknown;
  f.runtime.deleteBaiduCleanupDirectory = async (_port, _root, _allowed, inspection) => { received = inspection; deleted = true; };
  await f.monitor.tick();
  assert.deepEqual(received, { entries, scannedAt: now });
  assert.equal(f.monitor.getStatus().phase, "waiting");
});
test("a triggered sweep deletes remaining old directories even after usage drops below 80 percent", async () => {
  const f = fixture();
  let used = 90;
  const roots = [1, 2, 3].map(id => ({ ...directory, path: `/旧剧${id}`, fs_id: String(id) }));
  f.runtime.readBaiduCleanup = async (_port, action) => action === "quota" ? { quota: { used, total: 100 } } : action === "roots" ? { roots } : {};
  f.runtime.deleteBaiduCleanupDirectory = async () => { f.calls.push("delete"); used -= 15; };
  await f.monitor.tick();
  assert.equal(f.calls.length, 3);
  assert.equal(f.monitor.getStatus().used, 45);
  assert.equal(f.journal().sweepActive, false);
});
test("a batch-limited sweep survives restart and finishes below threshold", async () => {
  const f = fixture();
  let used = 90;
  const remaining = Array.from({ length: 21 }, (_, id) => ({ ...directory, path: `/旧剧${id}`, fs_id: String(id + 1) }));
  f.runtime.readBaiduCleanup = async (_port, action) => action === "quota" ? { quota: { used, total: 100 } } : action === "roots" ? { roots: [...remaining] } : {};
  f.runtime.deleteBaiduCleanupDirectory = async () => { f.calls.push("delete"); remaining.shift(); used -= 1; };
  await f.monitor.tick();
  assert.equal(f.calls.length, 20);
  assert.equal(f.journal().sweepActive, true);
  const restarted = new BaiduAutoCleanup(f.deps);
  await restarted.tick();
  assert.equal(f.calls.length, 21);
  assert.equal(f.journal().sweepActive, false);
});
test("today's directory, protected descendants and disabling during inspection never delete", async () => {
  for (const scenario of ["today", "active", "inspect-protected", "disabled"]) {
    const f = fixture();
    if (scenario === "active") f.deps.protectedPaths = () => ["/旧剧/使用中"];
    f.runtime.readBaiduCleanup = async (_port, action) => {
      f.calls.push(action);
      if (action === "quota") return { quota: { used: 90, total: 100 } };
      if (action === "roots") return { roots: [{ ...directory, ...(scenario === "today" ? { server_mtime: now / 1000 } : {}) }] };
      if (scenario === "disabled") f.enable(false);
      return scenario === "inspect-protected" ? { reason: "当天子文件" } : {};
    };
    await f.monitor.tick(); assert.ok(!f.calls.includes("delete"), scenario);
  }
});
test("verification or unknown delete results persist a pause and are never automatically replayed after restart", async () => {
  const f = fixture(); f.runtime.deleteBaiduCleanupDirectory = async () => { f.calls.push("delete"); throw new Error("BAIDU_NETDISK_IDENTITY_VERIFICATION"); };
  await f.monitor.tick(); assert.equal(f.monitor.getStatus().phase, "paused"); assert.ok(f.journal().pending);
  assert.equal(f.monitor.getStatus().pauseKind, "identity");
  assert.doesNotMatch(f.monitor.getStatus().message, /BAIDU_NETDISK_IDENTITY/);
  assert.match(f.journal().pausedReason, /BAIDU_NETDISK_IDENTITY/);
  const restarted = new BaiduAutoCleanup(f.deps); await restarted.tick();
  assert.equal(f.calls.filter(call => call === "delete").length, 1);
  assert.equal(restarted.getStatus().phase, "paused");
  assert.equal(restarted.getStatus().pauseKind, "identity");
});
test("unchanged quota stops further deletion instead of emptying the recycle bin", async () => {
  const f = fixture(); f.runtime.deleteBaiduCleanupDirectory = async () => { f.calls.push("delete"); };
  await f.monitor.tick();
  assert.equal(f.monitor.getStatus().phase, "paused"); assert.match(f.monitor.getStatus().message, /容量尚未下降/);
  assert.equal(f.calls.filter(call => call === "delete").length, 1);
});
