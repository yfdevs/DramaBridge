import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";

import {
  findReusableTaobaoCollection,
  findExistingTaobaoCollectionPlan,
  runTaobaoPublishTask,
  taobaoBaiduResourceRequest,
} from "../../src/automation/publish-runner.js";

test("requests collection materials and episode videos from Baidu for Taobao publishing", () => {
  const request = taobaoBaiduResourceRequest({
    id: "task-1",
    originalTitle: "测试短剧",
    baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
    episodeCount: 66,
  }, {
    localMaterialRoot: "D:\\短剧素材",
  });

  assert.equal(request.downloadAssetMaterials, true);
  assert.equal(request.forceAssetDownload, true);
  assert.equal(request.requireAllDiscoveredAssets, true);
  assert.equal(request.requiredMetadataTextFiles, 0);
  assert.equal(request.requiredPosterImages, 0);
  assert.equal(request.episodeCount, 66);
});

for (const reusable of [false, true]) {
  test(`opens only the ${reusable ? "upload" : "collection creation"} page before preparing task materials`, async () => {
    const navigations: string[] = [];
    let url = "about:blank";
    const context = {
      cookies: async () => [{ name: "_m_h5_tk", value: "token_1999999999999" }],
      request: { get: async (url: string) => ({
        ok: () => true,
        text: async () => JSON.stringify({ ret: ["SUCCESS"], data: { model: url.includes("collection.detail") ? {
          collectionInfo: { collectionId: 1, contentCount: 0, title: "测试短剧", episodeCount: 1, contentIds: [] },
        } : {
          data: reusable ? [{ collectionInfo: { collectionId: 1, contentCount: 0, title: "测试短剧" } }] : [],
          pageCount: 1, pageIndex: 1, totalCount: reusable ? 1 : 0,
        } } }),
      }) },
      newPage: () => { throw new Error("must reuse the supplied task page"); },
    } as unknown as BrowserContext;
    const locator = { filter: () => locator, first: () => locator, isVisible: async () => true };
    const page = {
      url: () => url, isClosed: () => false,
      locator: () => ({ innerText: async () => "合集类型 短剧类型 上传视频", evaluateAll: async () => true }),
      getByRole: () => locator, getByText: () => locator,
      goto: async (nextUrl: string) => { url = nextUrl; navigations.push(nextUrl); },
      close: () => { throw new Error("must not close the task during preparation"); },
    } as unknown as Page;
    await assert.rejects(runTaobaoPublishTask(page, context, {
      id: "task", originalTitle: "测试短剧", baiduPanResourceLink: "resource", episodeCount: 1,
      productionCostProofFiles: [],
    }, {
      localMaterialRoot: "D:\\test-taobao-materials",
      baiduNetdiskDownloadRetryAttempts: 0,
      ensureBaiduNetdiskResource: async () => { throw new Error("STOP_AFTER_PAGE_SELECTION"); },
    }), /STOP_AFTER_PAGE_SELECTION/);
    assert.equal(navigations.length, 1);
    assert.equal(new URL(navigations[0]!).pathname,
      reusable ? "/page/unify/creation-tool/batch-publish" : "/page/unify/collect-create");
  });
}

test("reuses an exact-title collection and rejects ambiguous same-title targets", () => {
  const reusable = findReusableTaobaoCollection([
    { collectionInfo: { collectionId: 1, contentCount: 0, title: "冷库春秋续集" } },
    { collectionInfo: { collectionId: 3, contentCount: 0, title: " 冷库春秋 " } },
  ], "冷库春秋");

  assert.equal(reusable?.collectionInfo.collectionId, 3);
  assert.throws(() => findReusableTaobaoCollection([
    { collectionInfo: { collectionId: 2, contentCount: 8, title: "冷库春秋" } },
    { collectionInfo: { collectionId: 3, contentCount: 0, title: "冷库春秋" } },
  ], "冷库春秋"), /找到 2 个同名合集/);
});

test("reuses a same-title collection that already has works for missing-episode recovery", () => {
  const reusable = findReusableTaobaoCollection([
    { collectionInfo: { collectionId: 2, contentCount: 8, title: "冷库春秋" } },
  ], "冷库春秋");

  assert.equal(reusable?.collectionInfo.collectionId, 2);
});

test("a collection query failure cannot fall back to creating a duplicate collection", async () => {
  const context = { cookies: async () => [] } as unknown as BrowserContext;
  await assert.rejects(findExistingTaobaoCollectionPlan(context, "兽语少年勇夺珍宝", 127, {}), /LOGIN_TOKEN_REQUIRED/);
});

test("a full collection finishes without navigation, downloads, AI or another upload", async () => {
  const detail = { collectionInfo: { collectionId: 1, title: "完整剧", episodeCount: 2, contentCount: 2, contentIds: [11, 12] },
    contentCards: [1, 2].map((episode) => ({ baseInfo: { id: episode + 10, collectionId: 1, title: `第${episode}集|简介` } })) };
  const context = {
    cookies: async () => [{ name: "_m_h5_tk", value: "token_1999999999999" }],
    request: { get: async (url: string) => ({ ok: () => true, text: async () => JSON.stringify({ ret: ["SUCCESS"],
      data: { model: url.includes("collection.detail") ? detail : {
        data: [{ collectionInfo: detail.collectionInfo }], totalCount: 1, pageIndex: 1, pageCount: 1,
      } } }) }) },
  } as unknown as BrowserContext;
  const page = { goto: () => { throw new Error("must not navigate"); } } as unknown as Page;
  await runTaobaoPublishTask(page, context, { id: "full", originalTitle: "完整剧", episodeCount: 2,
    baiduPanResourceLink: "unused", productionCostProofFiles: [] }, {
    ensureBaiduNetdiskResource: async () => { throw new Error("must not download"); },
    aiClientFactory: () => { throw new Error("must not request AI"); },
  });
});
