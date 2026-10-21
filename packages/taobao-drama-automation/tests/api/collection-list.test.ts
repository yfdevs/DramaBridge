import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createTaobaoMtopRequest,
  queryTaobaoCollectionList,
} from "../../src/api/collection-list.js";

test("builds the Taobao MTop collection request with the H5 token signature", () => {
  const input = {
    api: "mtop.taobao.gcm.collection.list.query",
    version: "1.0",
    data: { pageNo: 1, pageSize: 10 },
    token: "test-token",
    timestamp: 1_798_000_000_000,
    callback: "mtopjsonp7",
  };
  const request = createTaobaoMtopRequest(input);
  const data = JSON.stringify(input.data);
  const expectedSign = createHash("md5")
    .update(`${input.token}&${input.timestamp}&12574478&${data}`)
    .digest("hex");
  const url = new URL(request.url);

  assert.equal(url.pathname, "/h5/mtop.taobao.gcm.collection.list.query/1.0/");
  assert.equal(url.searchParams.get("appKey"), "12574478");
  assert.equal(url.searchParams.get("sign"), expectedSign);
  assert.equal(url.searchParams.get("data"), data);
  assert.equal(url.searchParams.get("callback"), "mtopjsonp7");
});

test("queries and parses one Taobao collection page with context cookies", async () => {
  let requestedUrl = "";
  const context = {
    cookies: async () => [{ name: "_m_h5_tk", value: "login-token_1999999999999" }],
    request: {
      get: async (url: string) => {
        requestedUrl = url;
        return {
          ok: () => true,
          status: () => 200,
          text: async () => `mtopjsonp1(${JSON.stringify({
            api: "mtop.taobao.gcm.collection.list.query",
            ret: ["SUCCESS::调用成功"],
            data: {
              model: {
                data: [{ collectionInfo: { collectionId: 101, contentCount: 0, title: "测试合集" } }],
                pageCount: 1,
                pageIndex: 1,
                totalCount: 1,
              },
            },
          })})`,
        };
      },
    },
  };

  const result = await queryTaobaoCollectionList(context as never);
  const payload = JSON.parse(new URL(requestedUrl).searchParams.get("data")!);
  assert.equal(result.totalCount, 1);
  assert.equal(result.data[0]?.collectionInfo.title, "测试合集");
  assert.deepEqual(JSON.parse(payload.bizCondition), {
    typeList: [1, 3],
    keyword: "",
    auditStatus: null,
  });
  assert.equal(payload.pageNo, 1);
  assert.equal(payload.pageSize, 10);
});

test("rejects collection page sizes that make the production MTop endpoint unstable", async () => {
  await assert.rejects(
    queryTaobaoCollectionList({} as never, { pageSize: 100 }),
    /TAOBAO_COLLECTION_PAGE_SIZE_INVALID/u,
  );
});
