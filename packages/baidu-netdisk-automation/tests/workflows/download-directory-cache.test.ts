import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createBaiduDirectoryCache } from "../../src/workflows/download-directory-cache.js";

test("serialized directory cache deduplicates concurrent and repeated tree inspections", async () => {
  const create = runInNewContext(`(${createBaiduDirectoryCache.toString()})`) as typeof createBaiduDirectoryCache;
  let calls = 0;
  const cache = create(async (key: string) => { calls++; return [key]; });
  const first = cache.get("/剧名/正片");
  const second = cache.get("/剧名/正片");
  assert.equal(first, second);
  assert.deepEqual(await first, ["/剧名/正片"]);
  await cache.get("/剧名/正片");
  assert.equal(calls, 1);
});

test("failed and incomplete inventories are not reused", async () => {
  let calls = 0;
  const cache = createBaiduDirectoryCache(async () => {
    if (++calls === 1) throw new Error("目录分页失败");
    return ["verified"];
  });
  await assert.rejects(cache.get("/"), /分页失败/);
  assert.deepEqual(await cache.get("/"), ["verified"]);
  assert.equal(calls, 2);
});

test("mutations invalidate negative directory and search results without flushing unrelated directories", async () => {
  const calls = new Map<string, number>();
  let created = false;
  const cache = createBaiduDirectoryCache(async (key: string) => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return created ? ["new file"] : [];
  });
  await cache.get("/剧名");
  await cache.get("/其他剧名");
  created = true;
  cache.invalidate("/剧名");
  assert.deepEqual(await cache.get("/剧名"), ["new file"]);
  await cache.get("/其他剧名");
  assert.equal(calls.get("/剧名"), 2);
  assert.equal(calls.get("/其他剧名"), 1);
  cache.invalidate();
  assert.deepEqual(await cache.get("/其他剧名"), ["new file"]);
});

test("an old failed request cannot evict a refresh performed after transfer", async () => {
  let rejectOld!: (error: Error) => void;
  let calls = 0;
  const cache = createBaiduDirectoryCache(async () => {
    if (++calls === 1) return new Promise<string[]>((_resolve, reject) => { rejectOld = reject; });
    return ["after transfer"];
  });
  const old = cache.get("/剧名");
  await Promise.resolve();
  const refreshed = cache.get("/剧名", true);
  assert.deepEqual(await refreshed, ["after transfer"]);
  rejectOld(new Error("stale request failed"));
  await assert.rejects(old, /stale request/);
  assert.equal(cache.get("/剧名"), refreshed);
  assert.equal(calls, 2);
});
