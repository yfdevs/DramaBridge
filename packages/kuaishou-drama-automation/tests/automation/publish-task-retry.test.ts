import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import { runPublishTask } from "../../src/automation/publish-runner.js";
import { KuaishouDramaVariantFailures } from "../../src/automation/variant-results.js";
import { kuaishouDramaTaskSchema } from "../../src/shared/types.js";

const taskConfig = kuaishouDramaTaskSchema.parse({
  title: "测试短剧",
  episodeCount: 10,
  publishType: "三个广告版本",
  adVersion2Title: "测试剧二",
  adVersion3Title: "测试剧三",
  summary: "这是一段用于验证快手短剧发布版本重试逻辑的剧情简介。".repeat(4),
  genderChannel: "不限",
  categories: ["脑洞"],
  plotTags: ["其他"],
  productionOrganization: "测试制作方",
});

function pageWithoutUpload() {
  return Object.assign(new EventEmitter(), {
    isClosed: () => false,
    close: async () => {},
    locator: () => ({}),
    addLocatorHandler: async () => {},
    goto: async () => {},
    getByText: () => ({ waitFor: async () => {} }),
    waitForLoadState: async () => {},
    evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg),
  }) as unknown as Page;
}

const contextWithoutUpload = Object.assign(new EventEmitter(), {
  browser: () => null,
  newPage: async () => {
    assert.fail("no upload tab should be opened");
  },
}) as unknown as BrowserContext;

test("an entirely submitted task succeeds on retry without downloading or preparing materials", async (t) => {
  const queried: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    queried.push(request.miniSeriesTitle);
    return new Response(
      JSON.stringify({
        result: 1,
        successful: true,
        data: {
          data: [
            {
              miniSeriesId: queried.length,
              courseName: request.miniSeriesTitle,
              auditStatus: [2, 3, 5][queried.length - 1],
              seriesPackageSaleType: [1],
            },
          ],
        },
      }),
    );
  });
  const result = await runPublishTask(
    contextWithoutUpload,
    pageWithoutUpload(),
    {},
    { taskConfig, resourceName: "无需本地素材" },
    async () => {
      assert.fail("completed versions must not depend on local materials");
    },
  );
  assert.deepEqual(queried, ["测试短剧", "测试剧二", "测试剧三"]);
  assert.deepEqual(result, ["ad-unlock", "ad-unlock-2", "ad-unlock-3"]);
});

test("recovers a stale query tab and checks every version while the browser remains open", async (t) => {
  const initial = pageWithoutUpload();
  initial.evaluate = async () => { throw new Error("Target page, context or browser has been closed"); };
  const replacement = pageWithoutUpload();
  let opened = 0;
  let closed = 0;
  replacement.close = async () => { closed++; };
  const context = Object.assign(new EventEmitter(), {
    browser: () => ({ isConnected: () => true }),
    newPage: async () => { opened++; return replacement; },
  }) as unknown as BrowserContext;
  const queried: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    queried.push(request.miniSeriesTitle);
    return new Response(JSON.stringify({ result: 1, successful: true, data: { data: [{
      miniSeriesId: queried.length, courseName: request.miniSeriesTitle,
      auditStatus: 2, seriesPackageSaleType: [1],
    }] } }));
  });
  const result = await runPublishTask(context, initial, {}, { taskConfig, resourceName: "任务页恢复测试" }, async () => {
    assert.fail("submitted versions must not upload again");
  });
  assert.deepEqual(result, ["ad-unlock", "ad-unlock-2", "ad-unlock-3"]);
  assert.deepEqual(queried, ["测试短剧", "测试剧二", "测试剧三"]);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

test("material preparation failure affects missing versions while submitted versions still count as success", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const { miniSeriesTitle } = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        result: 1,
        successful: true,
        data: {
          data:
            miniSeriesTitle === "测试短剧"
              ? [
                  {
                    miniSeriesId: 1,
                    courseName: miniSeriesTitle,
                    auditStatus: 2,
                    seriesPackageSaleType: [1],
                  },
                ]
              : [],
        },
      }),
    );
  });
  let preparations = 0;
  await assert.rejects(
    runPublishTask(
      contextWithoutUpload,
      pageWithoutUpload(),
      {},
      { taskConfig, resourceName: "缺少素材" },
      async (needsForm) => {
        preparations += 1;
        assert.equal(needsForm, true);
        throw new Error("缺少视频素材");
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof KuaishouDramaVariantFailures);
      assert.deepEqual(error.succeeded, ["ad-unlock"]);
      assert.deepEqual(
        error.failures.map((f) => f.variant.kind),
        ["ad-unlock-2", "ad-unlock-3"],
      );
      assert.ok(error.failures.every((f) => String(f.error).includes("缺少视频素材")));
      return true;
    },
  );
  assert.equal(preparations, 1);
});
