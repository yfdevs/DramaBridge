import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createBaiduShareDirectoryReader } from "../../src/workflows/share-directory-reader.js";
import { createBaiduDirectoryCache } from "../../src/workflows/download-directory-cache.js";
import { matchBaiduEpisodeIndex } from "../../src/workflows/episode-index.js";

const factory = runInNewContext(`(${createBaiduShareDirectoryReader.toString()})`, {
  URLSearchParams,
}) as typeof createBaiduShareDirectoryReader;
const virtual = "/sharelink1099807332123-176267936097208/周丽君-被断销路，我建冷库破局";
const real = "/原始素材/周丽君-被断销路，我建冷库破局";

test("serialized reader uses root=1 instead of dir=/ and uses the server's full path for children", async () => {
  const calls: URLSearchParams[] = [];
  const reader = factory({
    shareId: "123",
    shareUk: "456",
    token: "token",
    maxPages: 2,
    fallbackRoots: [{ fs_id: "10", path: virtual }],
    request: async (url) => {
      const params = new URL(url, "https://pan.baidu.com").searchParams;
      calls.push(params);
      if (params.get("root") === "1") {
        assert.equal(params.has("dir"), false);
        return { errno: 0, list: [{ fs_id: "10", path: real, isdir: 1 }] };
      }
      // Reproduces the reported -9 for the wrong virtual/stripped path.
      if (params.get("root") !== "0" || params.get("dir") !== real) return { errno: -9 };
      return { errno: 0, list: [{ fs_id: "11", path: real + "/第1集.mp4" }] };
    },
  });
  const root = await reader.load("/");
  const children = await reader.load(String(root[0].path));
  assert.equal(children.length, 1);
  assert.equal((await reader.load(virtual))[0].fs_id, "11");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((params) => params.get("shareid") === "123" && params.get("uk") === "456"));
});

test("cached virtual aliases require matching fs_id, never a guessed basename or stripped prefix", async () => {
  let requests = 0;
  const reader = factory({
    shareId: "123",
    shareUk: "456",
    token: "",
    maxPages: 2,
    fallbackRoots: [{ fs_id: "old-share-file", path: virtual }],
    request: async () => {
      requests++;
      return { errno: 0, list: [{ fs_id: "different-file", path: real }] };
    },
  });
  await reader.load("/");
  await assert.rejects(reader.load(virtual), /客户端临时路径/);
  assert.equal(requests, 1, "unresolved virtual paths must not reach /share/list");
});

test("pagination carries root flags and aliases are published only after a complete list", async () => {
  let fail = true;
  const pages: string[] = [];
  const reader = factory({
    shareId: "123",
    shareUk: "456",
    token: "",
    maxPages: 3,
    fallbackRoots: [{ fs_id: "10", path: virtual }],
    request: async (url) => {
      const params = new URL(url, "https://pan.baidu.com").searchParams;
      pages.push(params.get("page")!);
      assert.equal(params.get("root"), "1");
      return params.get("page") === "1"
        ? { errno: 0, list: [{ fs_id: "10", path: real }], has_more: 1 }
        : fail
          ? { errno: -9, request_id: "987" }
          : { errno: 0, list: [], has_more: 0 };
    },
  });
  const cache = createBaiduDirectoryCache(reader.load);
  await assert.rejects(cache.get("/"), /errno=-9.*request_id=987/);
  await assert.rejects(reader.load(virtual), /客户端临时路径/);
  fail = false;
  assert.equal((await cache.get("/")).length, 1);
  assert.deepEqual(pages, ["1", "2", "1", "2"]);
});

test("malformed and over-budget listings fail; risk responses propagate without retries", async () => {
  for (const response of [{ errno: 0 }, { errno: 0, list: [], has_more: 1 }]) {
    const reader = factory({
      shareId: "123",
      shareUk: "456",
      token: "",
      maxPages: 1,
      fallbackRoots: [],
      request: async () => response,
    });
    await assert.rejects(reader.load("/"), /不完整|分页超出/);
  }
  let calls = 0;
  const reader = factory({
    shareId: "123",
    shareUk: "456",
    token: "",
    maxPages: 2,
    fallbackRoots: [],
    request: async () => {
      calls++;
      throw new Error("[BAIDU_NETDISK_RISK_CONTROL] errno=8001");
    },
  });
  await assert.rejects(reader.load("/"), /BAIDU_NETDISK_RISK_CONTROL/);
  assert.equal(calls, 1);
});

test("reads all 105 episodes when share/list caps pages at 100 and omits has_more", async () => {
  const files = Array.from({ length: 105 }, (_, i) => ({ fs_id: String(i + 1),
    path: `/成片/一碗甜粥暖余生-${i + 1}.mp4` }))
    .sort((a, b) => a.path < b.path ? 1 : a.path > b.path ? -1 : 0);
  assert.deepEqual(files.slice(100).map(file => matchBaiduEpisodeIndex(file.path)), [102, 101, 100, 10, 1]);
  const pages: number[] = [];
  const reader = factory({ shareId: '123', shareUk: '456', token: '', maxPages: 3, fallbackRoots: [],
    request: async url => {
      const params = new URL(url, 'https://pan.baidu.com').searchParams;
      assert.equal(params.get('num'), '100');
      const page = Number(params.get('page'));
      pages.push(page);
      return { errno: 0, list: files.slice((page - 1) * 100, page * 100) };
    },
  });
  const actual = await reader.load('/成片');
  assert.equal(actual.length, 105);
  assert.equal(new Set(actual.map(file => file.fs_id)).size, 105);
  assert.deepEqual(Array.from(actual, file => matchBaiduEpisodeIndex(String(file.path)))
    .sort((a, b) => a! - b!), Array.from({ length: 105 }, (_, i) => i + 1));
  assert.deepEqual(pages, [1, 2]);
});

test("a full final page is followed by an empty-page check; repeated pages fail safely", async () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ fs_id: String(i + 1), path: `/成片/${i + 1}.mp4` }));
  for (const repeats of [false, true]) {
    let calls = 0;
    const reader = factory({ shareId: '123', shareUk: '456', token: '', maxPages: 3, fallbackRoots: [],
      request: async () => ({ errno: 0, list: ++calls === 1 || repeats ? files : [] }),
    });
    if (repeats) await assert.rejects(reader.load('/成片'), /分页重复/);
    else assert.equal((await reader.load('/成片')).length, 100);
    assert.equal(calls, 2);
  }
});
