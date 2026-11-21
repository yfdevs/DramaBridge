import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { deleteBaiduCleanupTreeInPage } from "../../src/workflows/delete-cleanup-tree.js";
import { baiduCleanupProtection } from "../../src/workflows/cleanup-policy.js";

const old = Math.floor((Date.now() - 86400_000) / 1000);
const root = { path: "/旧剧", fs_id: "1", isdir: 1, server_ctime: old, server_mtime: old };
const file = (id: number, size: number) => ({ ...root, path: `/旧剧/${id}.mp4`, fs_id: String(id), isdir: 0, size });
function fixture(entries = [file(2, 1_200_000_000), file(3, 1_200_000_000)]) {
  const live = new Map<string, any>([root, ...entries].map(e => [e.path, { ...e }]));
  const writes: string[][] = [];
  let errno = 0, taskState: string | undefined;
  const context: any = { __name: (fn: unknown) => fn, URLSearchParams, AbortController, setTimeout, clearTimeout, Date, options: { root, entries, pollIntervalMs: 0 } };
  context.request = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "https://pan.baidu.com");
    if (u.pathname === "/api/list") {
      const dir = u.searchParams.get("dir");
      return { errno: 0, has_more: false, list: [...live.values()].filter(e => (e.path.slice(0, e.path.lastIndexOf("/")) || "/") === dir) };
    }
    if (u.pathname === "/api/taskquery") return { errno: 0, status: taskState };
    const paths = JSON.parse(new URLSearchParams(String(init.body)).get("filelist")!);
    writes.push(paths);
    if (!errno) { for (const path of paths) live.delete(path); if (live.has(root.path)) live.get(root.path).server_mtime = Math.floor(Date.now() / 1000); }
    return { errno, ...(taskState ? { taskid: "task" } : {}) };
  };
  return { live, writes, context, errno: (value: number) => { errno = value; }, task: (value: string) => { taskState = value; }, run: () => runInNewContext(`(${deleteBaiduCleanupTreeInPage.toString()})(request,${baiduCleanupProtection.toString()},options)`, context) };
}
test("serialized cleanup caps each file batch at 2GB then deletes only empty directories", async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.deleted, true); assert.equal(result.bytes, 2_400_000_000);
  assert.deepEqual(f.writes.map(batch => batch.length), [1, 1, 1]);
  assert.equal(f.live.size, 0);
});
test("official single-file mode never combines even small files", async () => {
  const f = fixture([file(2, 100), file(3, 100), file(4, 100)]);
  f.context.options.singleFile = true;
  await f.run(); assert.deepEqual(f.writes.map(batch => batch.length), [1, 1, 1, 1]);
});
test("large single-file plans have enough time for normal pacing instead of the old three-minute cutoff", async () => {
  const f = fixture(Array.from({ length: 120 }, (_, i) => file(i + 2, 100)));
  f.context.options.singleFile = true;
  let deadline = 0;
  f.context.setTimeout = (callback: () => void, ms: number) => { deadline = ms; return setTimeout(callback, ms); };
  await f.run(); assert.ok(deadline > 120 * 2000); assert.ok(deadline <= 900_000);
  assert.equal(f.writes.length, 121);
});
test("subdirectories are removed bottom-up after bounded file batches", async () => {
  const child = { ...root, path: "/旧剧/全集", fs_id: "4" };
  const f = fixture([child, { ...file(2, 100), path: "/旧剧/全集/2.mp4" }] as any);
  await f.run(); assert.deepEqual(f.writes, [["/旧剧/全集/2.mp4"], ["/旧剧/全集"], ["/旧剧"]]);
});
test("identity verification and failed or unknown tasks never continue with another batch", async () => {
  for (const scenario of ["132", "failed", "unknown"]) {
    const f = fixture(); if (scenario === "132") f.errno(132); else f.task(scenario);
    await assert.rejects(f.run(), error => {
      const message = String(error);
      assert.match(message, /VERIFICATION|删除任务失败|删除结果未确认/);
      assert.match(message, /BAIDU_CLEANUP_BATCH/);
      assert.match(message, /"bytes":1200000000/);
      assert.match(message, /"confirmedBatches":0/);
      return true;
    });
    assert.equal(f.writes.length, 1);
  }
});
test("oversized single files, unknown sizes and changed identities issue no delete", async () => {
  for (const scenario of ["large", "unknown", "changed", "today"]) {
    const f = fixture();
    if (scenario === "large") f.context.options.entries[0] = file(2, 2_000_000_001);
    if (scenario === "unknown") f.context.options.entries[0] = { ...file(2, 1), size: undefined };
    if (scenario === "changed") f.live.get("/旧剧/2.mp4").fs_id = "99";
    if (scenario === "today") f.live.get("/旧剧/2.mp4").server_mtime = Date.now() / 1000;
    await assert.rejects(f.run()); assert.equal(f.writes.length, 0, scenario);
  }
});
test("verification on an empty directory reports a zero-byte directory batch and does not retry", async () => {
  const f = fixture([]); f.errno(132);
  await assert.rejects(f.run(), error => {
    assert.match(String(error), /"kind":"empty-directory"/);
    assert.match(String(error), /"bytes":0/);
    assert.match(String(error), /"filePath":"\/旧剧"/);
    return true;
  });
  assert.equal(f.writes.length, 1); assert.ok(f.live.has(root.path));
});
test("root identity lookups stop on a found page, while post-delete absence verification reads all pages", async () => {
  const f = fixture([]); const original = f.context.request;
  let rootReads = 0;
  f.context.request = async (url: string, init?: RequestInit) => {
    const u = new URL(url, "https://pan.baidu.com");
    if (u.pathname === "/api/list" && u.searchParams.get("dir") === "/") {
      rootReads++;
      const firstPage = u.searchParams.get("page") === "1";
      return { errno: 0, has_more: firstPage, list: firstPage ? [...f.live.values()].filter(entry => entry.path === root.path) : [] };
    }
    return original(url, init);
  };
  await f.run();
  // Two one-page identity lookups, then two pages to prove absence after deletion.
  assert.equal(rootReads, 4); assert.equal(f.writes.length, 1);
});
test("new children are preserved and prevent the parent directory from being deleted", async () => {
  const f = fixture([file(2, 100)]);
  f.live.set("/旧剧/新文件.mp4", { ...file(99, 10), path: "/旧剧/新文件.mp4", server_ctime: Date.now() / 1000 });
  await assert.rejects(f.run(), /出现新文件/);
  assert.ok(f.live.has("/旧剧/新文件.mp4")); assert.ok(f.live.has(root.path)); assert.equal(f.writes.length, 1);
});
test("closing the cleanup switch stops before any new write", async () => {
  const f = fixture(); f.context.__dramaBridgeAutoCleanupContinue = false;
  await assert.rejects(f.run(), /已关闭/); assert.equal(f.writes.length, 0);
});
