import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baiduCleanupProtection } from "../../src/workflows/cleanup-policy.js";
import { inspectBaiduCleanupInPage } from "../../src/workflows/cleanup-account.js";

const now = Date.parse("2026-11-16T04:00:00Z");
const old = Date.parse("2026-11-15T04:00:00Z") / 1000;
const root = { path: "/旧剧", fs_id: "123", isdir: 1, server_ctime: old, server_mtime: old };
test("protects the Shanghai calendar day, unknown dates, unsafe identities and active descendants", () => {
  assert.equal(baiduCleanupProtection(root, now, []), undefined);
  for (const entry of [
    { ...root, server_ctime: Date.parse("2026-11-15T16:00:00Z") / 1000 },
    { ...root, server_mtime: now }, { ...root, server_mtime: undefined },
    { ...root, path: "/剧2026-11-16" }, { ...root, path: "/20261116素材" },
    { ...root, path: "/apps" }, { ...root, path: "/文档加工" }, { ...root, path: "/_pcs_.safebox/材料" }, { ...root, path: "/../素材" }, { ...root, fs_id: 9007199254740992 },
  ]) assert.ok(baiduCleanupProtection(entry, now, []));
  assert.equal(baiduCleanupProtection(root, now, ["/旧剧/正在上传"]), "任务正在使用");
});

function inspect(children: Record<string, unknown>[], options: Record<string, unknown> = {}) {
  const request = async (url: string) => {
    const dir = new URL(url, "https://pan.baidu.com").searchParams.get("dir");
    return { errno: 0, list: dir === "/" ? [root] : children, has_more: false };
  };
  return runInNewContext(`(${inspectBaiduCleanupInPage.toString()})(request,${baiduCleanupProtection.toString()},options)`, {
    __name: (fn: unknown) => fn, request, options: { action: "inspect", root, now, ...options }, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
  });
}
test("a new file inside an old directory protects the whole directory", async () => {
  const result = await inspect([{ ...root, path: "/旧剧/新视频.mp4", fs_id: "124", isdir: 0, server_ctime: now / 1000 }]);
  assert.equal(result.reason, "当天新建或更新");
});
test("only a completely inspected old tree is eligible; unknown or mismatched entries stay protected", async () => {
  assert.equal((await inspect([{ ...root, path: "/旧剧/1.mp4", fs_id: "124", isdir: 0, size: 100 }])).files, 1);
  assert.ok((await inspect([{ ...root, path: "/旧剧/1.mp4", fs_id: "124", isdir: 0 }])).reason);
  assert.ok((await inspect([{ ...root, path: "/旧剧/1.mp4", fs_id: "124", isdir: 0, size: 2_000_000_001 }])).reason);
  assert.ok((await inspect([{ path: "/旧剧/1.mp4", fs_id: "124" }])).reason);
  assert.ok((await inspect([{ ...root, path: "/其他目录/1.mp4", isdir: 0 }])).reason);
  assert.ok((await inspect([], { root: { ...root, fs_id: "999" } })).reason);
});
test("incomplete pagination never supplies a deletion candidate", async () => {
  let requests = 0;
  await assert.rejects(runInNewContext(`(${inspectBaiduCleanupInPage.toString()})(request,${baiduCleanupProtection.toString()},options)`, {
    __name: (fn: unknown) => fn, options: { action: "roots", now }, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
    request: async () => { requests++; return { errno: 0, list: [root], has_more: true }; },
  }), /扫描未完成/);
  assert.equal(requests, 100);
});

test("independent directories overlap at most two reads and retain a complete deterministic plan", async () => {
  const children = Array.from({ length: 5 }, (_, index) => ({ ...root, path: `/旧剧/目录${index}`, fs_id: String(200 + index) }));
  let active = 0, peak = 0, reads = 0;
  const request = async (url: string) => {
    const dir = new URL(url, "https://pan.baidu.com").searchParams.get("dir");
    if (dir === "/") return { errno: 0, list: [root], has_more: false };
    if (dir === root.path) return { errno: 0, list: children, has_more: false };
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { errno: 0, has_more: false, list: [{ ...root, path: dir + "/1.mp4", fs_id: String(300 + Number(dir!.slice(-1))), isdir: 0, size: 100 }] };
  };
  const result = await runInNewContext(`(${inspectBaiduCleanupInPage.toString()})(request,${baiduCleanupProtection.toString()},options)`, {
    __name: (fn: unknown) => fn, request, options: { action: "inspect", root, now }, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
  });
  assert.equal(peak, 2); assert.equal(active, 0); assert.equal(reads, 5);
  assert.equal(result.files, 5); assert.equal(result.entries.length, 10);
  assert.equal(result.entries.at(-1).path, "/旧剧/目录4/1.mp4");
});

test("a failed parallel read never returns an eligible plan or leaves its sibling running", async () => {
  const children = [0, 1].map(index => ({ ...root, path: `/旧剧/${index}`, fs_id: String(200 + index) }));
  let siblingSettled = false;
  const request = async (url: string) => {
    const dir = new URL(url, "https://pan.baidu.com").searchParams.get("dir");
    if (dir === "/") return { errno: 0, list: [root], has_more: false };
    if (dir === root.path) return { errno: 0, list: children, has_more: false };
    if (dir === "/旧剧/0") throw new Error("read failed");
    await new Promise(resolve => setTimeout(resolve, 10)); siblingSettled = true;
    return { errno: 0, list: [], has_more: false };
  };
  await assert.rejects(runInNewContext(`(${inspectBaiduCleanupInPage.toString()})(request,${baiduCleanupProtection.toString()},options)`, {
    __name: (fn: unknown) => fn, request, options: { action: "inspect", root, now }, URLSearchParams, AbortController, setTimeout, clearTimeout, Date,
  }), /read failed/);
  assert.equal(siblingSettled, true);
});
