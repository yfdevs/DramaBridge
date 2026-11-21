import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  findExistingWeiboCollection,
  isWeiboCollectionComplete,
  assertWeiboCollectionCanSubmit,
} from "../../src/automation/existing-collection.js";

test("blocks the observed 61+61 duplicate publication and a second submission from a stale page", () => {
  const info = {
    detail_info: { id: 24812, name: "第19个电话", pub_uid: "uid", status: 0, total_num: 61 },
    video_list: Array.from({ length: 61 }, (_, index) => ({ status: 6, index_num: index + 1 })),
  };
  const check = (data: typeof info) => assertWeiboCollectionCanSubmit(data, "24812", "第19个电话", "uid", 61);
  assert.throws(() => check({ ...info, video_list: [...info.video_list, ...info.video_list] }), /COLLECTION_DUPLICATE/);
  assert.throws(() => check(info), /ALREADY_SUBMITTED/);
  assert.throws(() => check({ ...info, detail_info: { ...info.detail_info, status: 2 }, video_list: [] }), /ALREADY_SUBMITTED/);
  assert.doesNotThrow(() => check({ ...info, video_list: [] }));
  assert.doesNotThrow(() => check({ ...info, video_list: info.video_list.map(v => ({ ...v, status: 0 })) }));
  assert.throws(() => check({ ...info, detail_info: { ...info.detail_info, pub_uid: "other" } }), /LOOKUP_FAILED/);
});

test("same-name lookup searches every page and never edits a partial name or another account", async () => {
  const pages: number[] = [];
  const exact = { id: 23, name: "测试剧", pub_uid: "uid", status: 0, total_num: 5 };
  const page = {
    evaluate: async (_fn: unknown, endpoint: string) => {
      const query = new URL(endpoint, "https://api-duanju.weibo.com").searchParams;
      assert.equal(query.get("pub_uid"), "uid");
      assert.equal(query.get("keyword"), "测试剧");
      const current = Number(query.get("page"));
      pages.push(current);
      return {
        total: 11,
        list:
          current === 1
            ? [
                { ...exact, id: 1, name: "测试剧续集" },
                { ...exact, id: 2, pub_uid: "other" },
              ]
            : [exact],
      };
    },
  } as unknown as Page;
  assert.deepEqual(await findExistingWeiboCollection(page, "测试剧", "uid"), exact);
  assert.deepEqual(pages, [1, 2]);
});

test("ambiguous matches and malformed list data cannot turn into a new collection", async () => {
  const exact = { id: 23, name: "测试剧", pub_uid: "uid", status: 0, total_num: 5 };
  for (const [data, error] of [
    [{ total: 2, list: [exact, { ...exact, id: 24 }] }, /AMBIGUOUS/],
    [{}, /LOOKUP_FAILED/],
  ] as const) {
    await assert.rejects(
      findExistingWeiboCollection(
        { evaluate: async () => data } as unknown as Page,
        "测试剧",
        "uid",
      ),
      error,
    );
  }
  assert.equal(
    await findExistingWeiboCollection(
      { evaluate: async () => ({ list: [], total: 0 }) } as unknown as Page,
      "测试剧",
      "uid",
    ),
    undefined,
  );
});

test("existing publication is reusable only for the exact account, title and complete episode sequence", () => {
  const info = {
    detail_info: { id: 23, name: "测试剧", pub_uid: "uid", status: 6, total_num: 5 },
    video_list: Array.from({ length: 5 }, (_, index) => ({ status: 6, index_num: index + 1 })),
  };
  assert.equal(isWeiboCollectionComplete(info, "测试剧", "uid", 5), true);
  assert.equal(isWeiboCollectionComplete(info, "测试剧", "other", 5), false);
  assert.equal(isWeiboCollectionComplete(info, "其他剧", "uid", 5), false);
  assert.equal(isWeiboCollectionComplete(info, "测试剧", "uid", 6), false);
  assert.equal(
    isWeiboCollectionComplete(
      { ...info, detail_info: { ...info.detail_info, status: 0 } },
      "测试剧",
      "uid",
      5,
    ),
    false,
  );
  assert.equal(
    isWeiboCollectionComplete(
      { ...info, video_list: info.video_list.map((video) => ({ ...video, index_num: 1 })) },
      "测试剧",
      "uid",
      5,
    ),
    false,
  );
  assert.equal(
    isWeiboCollectionComplete(
      { ...info, video_list: info.video_list.map((video) => ({ ...video, status: -1 })) },
      "测试剧",
      "uid",
      5,
    ),
    false,
  );
});
