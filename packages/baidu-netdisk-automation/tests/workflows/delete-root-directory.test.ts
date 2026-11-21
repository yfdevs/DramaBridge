import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baiduPageRequest } from "../../src/infrastructure/page-request.js";
import { deleteBaiduRootDirectoryInPage } from "../../src/workflows/delete-root-directory.js";

const target = { path: "/测试中转目录", fsId: "123", targetLabel: "中转目录", token: "fixture-token", maxPages: 2, pageSize: 2, pollIntervalMs: 0 };
const directory = { path: target.path, fs_id: target.fsId, isdir: 1 };
const context = { __name: (value: unknown) => value, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console, location: { href: "https://pan.baidu.com/s/fixture" } };

function removeWith(request: (url: string, init?: RequestInit) => Promise<unknown>, options: Parameters<typeof deleteBaiduRootDirectoryInPage>[1] = target) {
  return runInNewContext(`(${deleteBaiduRootDirectoryInPage.toString()})(request, options)`, { ...context, request, options });
}

test("root deletion never treats a truncated directory listing as missing", async () => {
  let reads = 0, writes = 0;
  await assert.rejects(removeWith(async (_url, init) => {
    if (init?.method === "POST") { writes++; return { errno: 0 }; }
    reads++;
    return { errno: 0, list: [{ path: "/other1" }, { path: "/other2" }], has_more: true };
  }), /超过安全分页上限.*不能确认目录不存在/);
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

test("a genuinely exhausted listing confirms absence without issuing deletion", async () => {
  let reads = 0;
  const result = await removeWith(async (_url, init) => {
    assert.notEqual(init?.method, "POST"); reads++;
    return { errno: 0, list: [{ path: "/other" }], has_more: false };
  });
  assert.equal(reads, 1);
  assert.equal(result.alreadyMissing, true);
  assert.equal(result.deleted, false);
});

test("changed fsId and file replacements remain protected before any deletion", async () => {
  for (const item of [{ ...directory, fs_id: "changed" }, { ...directory, isdir: 0 }]) {
    await assert.rejects(removeWith(async (_url, init) => {
      assert.notEqual(init?.method, "POST"); return { errno: 0, list: [item] };
    }), /fsId 已变化|路径不再是目录/);
  }
});

test("an accepted delete still fails closed when the confirmation listing is truncated", async () => {
  let reads = 0, writes = 0;
  await assert.rejects(removeWith(async (_url, init) => {
    if (init?.method === "POST") { writes++; return { errno: 0 }; }
    reads++;
    return reads === 1 ? { errno: 0, list: [directory] } : { errno: 0, list: [{ path: "/other1" }, { path: "/other2" }], has_more: true };
  }), /超过安全分页上限/);
  assert.equal(writes, 1);
});

test("successful deletion requires a subsequent exhausted read to verify absence", async () => {
  let reads = 0, writes = 0;
  const result = await removeWith(async (_url, init) => {
    if (init?.method === "POST") {
      writes++;
      assert.deepEqual(JSON.parse(String((init.body as URLSearchParams).get("filelist"))), [target.path]);
      return { errno: 0 };
    }
    reads++;
    return { errno: 0, list: reads === 1 ? [directory] : [], has_more: false };
  });
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  assert.equal(result.deleted, true);
});

test("the serialized delete uses shared identity classification and never replays errno 132", async () => {
  let writes = 0;
  const operation = runInNewContext(`(async () => {
    const request = ${baiduPageRequest.toString()};
    const remove = ${deleteBaiduRootDirectoryInPage.toString()};
    return remove((url, init, timeout) => request(url, init, "json", timeout), options);
  })()`, {
    ...context, options: target,
    fetch: async (_url: string, init: RequestInit) => {
      if (init.method === "POST") { writes++; return Response.json({ errno: 132, request_id: "fixture" }); }
      return Response.json({ errno: 0, list: [directory] });
    },
  });
  await assert.rejects(operation, /BAIDU_NETDISK_IDENTITY_VERIFICATION.*errno=132/);
  assert.equal(writes, 1);
});

test("a stalled delete is cancelled at the total deadline without replaying the write", async () => {
  let writes = 0;
  const operation = removeWith(async (_url, init) => {
    if (init?.method !== "POST") return { errno: 0, list: [directory] };
    writes++;
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }, { ...target, timeoutMs: 100 });
  await assert.rejects(operation, /结果确认超时.*不会自动重发删除/);
  assert.equal(writes, 1);
});

test("an asynchronous delete polls its task and performs only one complete final directory check", async () => {
  let reads = 0, writes = 0, queries = 0;
  const result = await removeWith(async (url, init) => {
    if (init?.method === "POST") { writes++; return { errno: 0, taskid: "delete-task" }; }
    if (url.startsWith("/api/taskquery?")) {
      assert.equal(new URL(url, "https://pan.baidu.com").searchParams.get("taskid"), "delete-task");
      return { errno: 0, status: ++queries === 1 ? "running" : "success", list: [{ error_code: 0 }] };
    }
    reads++;
    return { errno: 0, list: reads === 1 ? [directory] : [], has_more: false };
  });
  assert.equal(result.deleted, true);
  assert.equal(writes, 1);
  assert.equal(queries, 2);
  assert.equal(reads, 2);
});

test("failed or unknown asynchronous task states never replay deletion or claim success", async () => {
  for (const state of [{ errno: 0, status: "failed" }, { errno: 0, status: "unknown" }, { errno: 0, status: "success", list: [{ error_code: -30 }] }]) {
    let writes = 0, reads = 0;
    await assert.rejects(removeWith(async (url, init) => {
      if (init?.method === "POST") { writes++; return { errno: 0, taskid: 123 }; }
      if (url.startsWith("/api/taskquery?")) return state;
      reads++; return { errno: 0, list: [directory] };
    }), /任务失败|状态无法识别/);
    assert.equal(writes, 1);
    assert.equal(reads, 1);
  }
});

test("asynchronous success does not override a still-present directory or truncated final list", async () => {
  for (const truncated of [false, true]) {
    let writes = 0, reads = 0;
    await assert.rejects(removeWith(async (url, init) => {
      if (init?.method === "POST") { writes++; return { errno: 0, taskid: 123 }; }
      if (url.startsWith("/api/taskquery?")) return { errno: 0, status: "success" };
      reads++;
      return reads === 1 || !truncated ? { errno: 0, list: [directory] } : { errno: 0, list: [{ path: "/other1" }, { path: "/other2" }], has_more: true };
    }), /目录仍然存在|超过安全分页上限/);
    assert.equal(writes, 1);
  }
});
