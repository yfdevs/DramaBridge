import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import {
  findExistingKuaishouDrama,
  kuaishouQuerySaleType,
  queryExistingKuaishouDrama,
} from "../../src/automation/existing-drama.js";
import type { KuaishouDramaPublishVariant } from "../../src/shared/types.js";

function variant(kind: KuaishouDramaPublishVariant["kind"]): KuaishouDramaPublishVariant {
  return {
    kind,
    title: kind === "full-paid" ? "《测试短剧》" : "测试短剧",
    saleMode: kind === "full-paid" ? "全剧付费" : "观看广告解锁",
    episodePriceRanges: [{ startEpisode: 1, endEpisode: 10, price: "免费" }],
  };
}

void test("maps paid and ad variants to Kuaishou list sale types", () => {
  assert.equal(kuaishouQuerySaleType(variant("full-paid")), 0);
  assert.equal(kuaishouQuerySaleType(variant("ad-unlock")), 1);
  assert.equal(kuaishouQuerySaleType(variant("ad-unlock-5")), 1);
  assert.equal(kuaishouQuerySaleType(variant("ad-unlock-6")), 1);
  assert.equal(kuaishouQuerySaleType(variant("ad-unlock-7")), 1);
  assert.equal(kuaishouQuerySaleType(variant("ad-unlock-8")), 1);
});

void test("returns the exact draft drama and uses seriesPackageSaleType", () => {
  const response = {
    result: 1,
    successful: true,
    error_msg: "success",
    data: {
      data: [
        {
          miniSeriesId: 45026051,
          courseName: "极寒求生：囤煤后我无敌了",
          auditStatus: 1,
          saleType: 3,
          seriesPackageSaleType: [0],
        },
        {
          miniSeriesId: 45026052,
          courseName: "极寒求生：囤煤后我无敌了续集",
          auditStatus: 1,
          seriesPackageSaleType: [0],
        },
      ],
    },
  };

  assert.deepEqual(findExistingKuaishouDrama(response, "极寒求生：囤煤后我无敌了", 0), {
    miniSeriesId: 45026051,
    title: "极寒求生：囤煤后我无敌了",
    saleType: 0,
    auditStatus: 1,
    state: "draft",
    rejectionReason: undefined,
  });
  assert.equal(findExistingKuaishouDrama(response, "极寒求生：囤煤后我无敌了", 1), null);
});

void test("recognizes submitted versions without uploading them again", () => {
  for (const auditStatus of [2, 3, 5]) {
    const existing = findExistingKuaishouDrama(
      {
        result: 1,
        successful: true,
        data: {
          data: [
            {
              miniSeriesId: 123,
              courseName: "测试短剧",
              auditStatus,
              seriesPackageSaleType: [1],
            },
          ],
        },
      },
      "测试短剧",
      1,
    );
    assert.equal(existing?.state, "submitted");
    assert.equal(existing?.auditStatus, auditStatus);
  }
});

void test("does not count rejected or unknown versions as successfully submitted", () => {
  const response = (auditStatus: number) => ({
    result: 1,
    successful: true,
    data: {
      data: [
        {
          miniSeriesId: 123,
          courseName: "测试短剧",
          auditStatus,
          seriesPackageSaleType: [1],
          failReasonSummary: { reviewReason: "内容不符合要求" },
        },
      ],
    },
  });
  const rejected = findExistingKuaishouDrama(response(4), "测试短剧", 1);
  assert.equal(rejected?.state, "rejected");
  assert.match(rejected!.rejectionReason!, /内容不符合要求/u);
  assert.throws(
    () => findExistingKuaishouDrama(response(99), "测试短剧", 1),
    /EXISTING_STATUS_UNKNOWN/u,
  );
});

void test("prefers a submitted version over an older same-title draft", () => {
  const result = findExistingKuaishouDrama(
    {
      result: 1,
      successful: true,
      data: {
        data: [1, 2].map((auditStatus) => ({
          miniSeriesId: auditStatus,
          courseName: "测试短剧",
          auditStatus,
          seriesPackageSaleType: [1],
        })),
      },
    },
    "测试短剧",
    1,
  );
  assert.equal(result?.miniSeriesId, 2);
  assert.equal(result?.state, "submitted");
});

void test("queries all statuses and searches later pages before declaring a version missing", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    return new Response(
      JSON.stringify({
        result: 1,
        successful: true,
        data: {
          totalCount: 101,
          data:
            request.pageNum === 1
              ? Array.from({ length: 100 }, (_, index) => ({
                  miniSeriesId: index + 1,
                  courseName: `其他剧${index}`,
                  auditStatus: 1,
                  seriesPackageSaleType: [1],
                }))
              : [
                  {
                    miniSeriesId: 101,
                    courseName: "测试短剧",
                    auditStatus: 2,
                    seriesPackageSaleType: [1],
                  },
                ],
        },
      }),
    );
  });
  const page = {
    evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg),
  } as unknown as Page;
  const result = await queryExistingKuaishouDrama(page, variant("ad-unlock"), {});
  assert.equal(result?.state, "submitted");
  assert.equal(result?.miniSeriesId, 101);
  assert.deepEqual(
    requests.map((request) => request.pageNum),
    [1, 2],
  );
  assert.ok(requests.every((request) => request.auditStatus === 0 && request.saleType === 1));
});

void test("fails closed when Kuaishou query fails or is ambiguous", () => {
  assert.throws(
    () =>
      findExistingKuaishouDrama(
        { result: 0, successful: false, error_msg: "登录失效" },
        "测试短剧",
        1,
      ),
    /KUAISHOU_DRAMA_EXISTING_QUERY_FAILED: 登录失效/,
  );

  assert.throws(
    () =>
      findExistingKuaishouDrama(
        {
          result: 1,
          successful: true,
          data: {
            data: [1, 2].map((miniSeriesId) => ({
              miniSeriesId,
              courseName: "测试短剧",
              auditStatus: 1,
              seriesPackageSaleType: [1],
            })),
          },
        },
        "测试短剧",
        1,
      ),
    /KUAISHOU_DRAMA_EXISTING_QUERY_AMBIGUOUS/,
  );
});
