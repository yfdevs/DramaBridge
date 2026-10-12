import assert from "node:assert/strict";
import test from "node:test";

import {
  findExistingKuaishouDrama,
  kuaishouQuerySaleType,
} from "../../src/automation/existing-drama.js";
import type { KuaishouDramaPublishVariant } from "../../src/shared/types.js";

function variant(
  kind: KuaishouDramaPublishVariant["kind"],
): KuaishouDramaPublishVariant {
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

void test("returns the exact pending drama and uses seriesPackageSaleType", () => {
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

  assert.deepEqual(
    findExistingKuaishouDrama(response, "极寒求生：囤煤后我无敌了", 0),
    {
      miniSeriesId: 45026051,
      title: "极寒求生：囤煤后我无敌了",
      saleType: 0,
    },
  );
  assert.equal(findExistingKuaishouDrama(response, "极寒求生：囤煤后我无敌了", 1), null);
});

void test("ignores a same-title drama outside pending audit status", () => {
  assert.equal(findExistingKuaishouDrama({
    result: 1,
    successful: true,
    data: {
      data: [{
        miniSeriesId: 123,
        courseName: "测试短剧",
        auditStatus: 2,
        seriesPackageSaleType: [1],
      }],
    },
  }, "测试短剧", 1), null);
});

void test("fails closed when Kuaishou query fails or is ambiguous", () => {
  assert.throws(
    () => findExistingKuaishouDrama({ result: 0, successful: false, error_msg: "登录失效" }, "测试短剧", 1),
    /KUAISHOU_DRAMA_EXISTING_QUERY_FAILED: 登录失效/,
  );

  assert.throws(
    () => findExistingKuaishouDrama({
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
    }, "测试短剧", 1),
    /KUAISHOU_DRAMA_EXISTING_QUERY_AMBIGUOUS/,
  );
});
