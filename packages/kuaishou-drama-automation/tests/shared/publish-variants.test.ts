import assert from "node:assert/strict";
import test from "node:test";

import { createKuaishouDramaPublishVariants } from "../../src/shared/publish-variants.js";
import {
  kuaishouDramaTaskSchema,
  type KuaishouDramaPublishType,
} from "../../src/shared/types.js";

function task(publishType?: KuaishouDramaPublishType) {
  return kuaishouDramaTaskSchema.parse({
    title: "测试短剧",
    episodeCount: 10,
    publishType,
    adVersion2Title: "雨夜归人",
    adVersion3Title: "旧城来信",
    adVersion4Title: "长街灯火",
    adVersion5Title: "故园春深",
    adVersion6Title: "星河入梦",
    adVersion7Title: "山海重逢",
    adVersion8Title: "明日序章",
    fullDramaPriceYuan: 4.9,
    summary: "这是一段用于验证快手短剧发布版本选择逻辑的剧情简介。".repeat(4),
    genderChannel: "不限",
    categories: ["脑洞"],
    plotTags: ["其他"],
    productionOrganization: "测试制作方",
  });
}

void test("publishes one paid and eight ad variants when publishType is empty", () => {
  const variants = createKuaishouDramaPublishVariants(task());
  assert.deepEqual(variants.map((item) => item.kind), [
    "full-paid", "ad-unlock", "ad-unlock-2", "ad-unlock-3", "ad-unlock-4", "ad-unlock-5", "ad-unlock-6", "ad-unlock-7", "ad-unlock-8",
  ]);
  assert.deepEqual(variants.map((item) => item.title), [
    "《测试短剧》", "测试短剧", "雨夜归人", "旧城来信", "长街灯火", "故园春深", "星河入梦", "山海重逢", "明日序章",
  ]);

  for (const publishType of [null, "", "   "]) {
    const parsed = kuaishouDramaTaskSchema.parse({
      ...task(),
      publishType,
    });
    assert.equal(parsed.publishType, undefined);
  }
});

void test("publishes only six ad variants when selected", () => {
  const variants = createKuaishouDramaPublishVariants(task("六个广告版本"));
  assert.deepEqual(variants.map((item) => item.kind), [
    "ad-unlock", "ad-unlock-2", "ad-unlock-3", "ad-unlock-4", "ad-unlock-5", "ad-unlock-6",
  ]);
  assert.ok(variants.every((item) => item.saleMode === "观看广告解锁"));
});

void test("publishes only eight ad variants when selected", () => {
  const variants = createKuaishouDramaPublishVariants(task("八个广告版本"));
  assert.deepEqual(variants.map((item) => item.kind), [
    "ad-unlock", "ad-unlock-2", "ad-unlock-3", "ad-unlock-4", "ad-unlock-5", "ad-unlock-6", "ad-unlock-7", "ad-unlock-8",
  ]);
  assert.ok(variants.every((item) => item.saleMode === "观看广告解锁"));
});

void test("keeps legacy three-ad and five-ad tasks retryable", () => {
  const threeAdTask = kuaishouDramaTaskSchema.parse({
    ...task("广告"),
    publishType: "三个广告版本",
    adVersion4Title: undefined,
    adVersion5Title: undefined,
    adVersion6Title: undefined,
  });
  assert.deepEqual(
    createKuaishouDramaPublishVariants(threeAdTask).map((item) => item.kind),
    ["ad-unlock", "ad-unlock-2", "ad-unlock-3"],
  );

  const fiveAdTask = kuaishouDramaTaskSchema.parse({
    ...task("广告"),
    publishType: "五个广告版本",
    adVersion6Title: undefined,
  });
  assert.deepEqual(
    createKuaishouDramaPublishVariants(fiveAdTask).map((item) => item.kind),
    ["ad-unlock", "ad-unlock-2", "ad-unlock-3", "ad-unlock-4", "ad-unlock-5"],
  );
});

void test("explicit 全部 uses the nine-variant sequence", () => {
  assert.deepEqual(
    createKuaishouDramaPublishVariants(task("全部")).map((item) => item.kind),
    ["full-paid", "ad-unlock", "ad-unlock-2", "ad-unlock-3", "ad-unlock-4", "ad-unlock-5", "ad-unlock-6", "ad-unlock-7", "ad-unlock-8"],
  );
});

void test("requires distinct extra ad titles for six-ad, eight-ad, and all modes", () => {
  const base = task("广告");
  assert.equal(kuaishouDramaTaskSchema.safeParse({ ...base, publishType: "全部", adVersionCount: 3, adVersionTitles: ["雨夜归人"] }).success, false);
  assert.equal(kuaishouDramaTaskSchema.safeParse({ ...base, publishType: "六个广告版本", adVersion6Title: "测试短剧" }).success, false);
  assert.equal(kuaishouDramaTaskSchema.safeParse({ ...base, publishType: "八个广告版本", adVersion8Title: "测试短剧" }).success, false);
});

void test("publishes a dynamically configured number of ad variants", () => {
  const dynamicTask = kuaishouDramaTaskSchema.parse({
    ...task("广告"),
    publishType: "广告多版本",
    adVersionCount: 10,
    adVersionTitles: Array.from({ length: 9 }, (_, index) => `动态剧名${index + 2}`),
  });
  const variants = createKuaishouDramaPublishVariants(dynamicTask);
  assert.equal(variants.length, 10);
  assert.equal(variants.at(-1)?.kind, "ad-unlock-10");
  assert.equal(variants.at(-1)?.title, "动态剧名10");
});

void test("treats backend 广告 tasks with a version count as dynamic multi-version tasks", () => {
  const dynamicTask = kuaishouDramaTaskSchema.parse({
    ...task("广告"),
    adVersionCount: 8,
    adVersionTitles: ["剧名二", "剧名三", "剧名四", "剧名五", "剧名六", "剧名七", "剧名八"],
  });
  assert.deepEqual(
    createKuaishouDramaPublishVariants(dynamicTask).map((variant) => variant.kind),
    [
      "ad-unlock",
      "ad-unlock-2",
      "ad-unlock-3",
      "ad-unlock-4",
      "ad-unlock-5",
      "ad-unlock-6",
      "ad-unlock-7",
      "ad-unlock-8",
    ],
  );
});

void test("infers a dynamic ad-version count from backend titles when the count is missing", () => {
  const dynamicTask = kuaishouDramaTaskSchema.parse({
    ...task("广告"),
    adVersionCount: undefined,
    adVersionTitles: ["剧名二", "剧名三", "剧名四"],
  });
  assert.equal(dynamicTask.adVersionCount, 4);
  assert.deepEqual(
    createKuaishouDramaPublishVariants(dynamicTask).map((variant) => variant.kind),
    ["ad-unlock", "ad-unlock-2", "ad-unlock-3", "ad-unlock-4"],
  );
});

void test("publishes only the paid variant when publishType is 付费", () => {
  assert.deepEqual(
    createKuaishouDramaPublishVariants(task("付费")).map((item) => ({
      kind: item.kind,
      title: item.title,
    })),
    [{ kind: "full-paid", title: "《测试短剧》" }],
  );
});

void test("publishes only the ad variant when publishType is 广告", () => {
  assert.deepEqual(
    createKuaishouDramaPublishVariants(task("广告")).map((item) => ({
      kind: item.kind,
      title: item.title,
    })),
    [{ kind: "ad-unlock", title: "测试短剧" }],
  );
});

void test("normalizes existing book-title marks before formatting each variant", () => {
  const markedTask = task();
  markedTask.title = "《测试短剧》";
  assert.deepEqual(
    createKuaishouDramaPublishVariants(markedTask).map((item) => item.title),
    ["《测试短剧》", "测试短剧", "雨夜归人", "旧城来信", "长街灯火", "故园春深", "星河入梦", "山海重逢", "明日序章"],
  );
});
