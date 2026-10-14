// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import test from "node:test";

import {
  createQqDramaPublishVariants,
  shouldOpenNewQqDramaVariantPage,
} from "../../src/shared/publish-variants.js";
import { claimedQqDramaTaskSchema } from "../../src/shared/types.js";

function task(secondVersionEnabled: boolean, secondVersionTitle?: string) {
  return claimedQqDramaTaskSchema.parse({
    accountTaskId: 1,
    originalTitle: "原始素材剧名",
    playlet: {
      title: "第一版剧名",
      secondVersionEnabled,
      secondVersionTitle,
      summary: "用于测试 QQ 漫剧双版本发布。",
      audienceType: "通用",
      episodeCount: 12,
      updateStatus: "已完结",
      primaryCategory: "剧情",
      productionOrganization: "无",
      producers: ["制片人"],
      directors: ["导演"],
      productionCostRange: "< 30 万",
      productionCostWan: 1,
      productionYear: 2026,
      costAllocationReportFiles: ["D:/materials/cost.pdf"],
      productionProofFiles: ["D:/materials/contract.pdf"],
      contractName: "测试合同",
    },
  });
}

test("creates two QQ publish variants when the second version is enabled", () => {
  assert.deepEqual(createQqDramaPublishVariants(task(true, "第二版剧名")), [
    { kind: "primary", title: "第一版剧名" },
    { kind: "secondary", title: "第二版剧名" },
  ]);
});

test("keeps legacy and explicitly disabled QQ tasks single-version", () => {
  assert.deepEqual(createQqDramaPublishVariants(task(false)), [
    { kind: "primary", title: "第一版剧名" },
  ]);
});

test("forces a QQ task to single-version when second versions are not accepted", () => {
  assert.deepEqual(createQqDramaPublishVariants(task(true, "第二版剧名"), false), [
    { kind: "primary", title: "第一版剧名" },
  ]);
});

test("rejects an enabled QQ second version without a distinct title", () => {
  assert.equal(
    claimedQqDramaTaskSchema.safeParse({
      ...task(false),
      playlet: { ...task(false).playlet, secondVersionEnabled: true },
    }).success,
    false,
  );
  assert.equal(
    claimedQqDramaTaskSchema.safeParse({
      ...task(false),
      playlet: {
        ...task(false).playlet,
        secondVersionEnabled: true,
        secondVersionTitle: "第一版剧名",
      },
    }).success,
    false,
  );
});

test("opens every additional QQ publish variant in a new task page", () => {
  assert.equal(shouldOpenNewQqDramaVariantPage(0), false);
  assert.equal(shouldOpenNewQqDramaVariantPage(1), true);
});
