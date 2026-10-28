import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeClaimedTaskConfig,
  normalizeContractSubject,
} from "../../src/shared/config.js";
import type { ClaimedAccountTask } from "../../src/shared/types.js";

function task(productionCost: unknown): ClaimedAccountTask {
  return {
    accountTaskId: 1,
    originalTitle: "材料校验测试剧",
    videoAccountId: "channel-1",
    videoAccountName: "测试视频号",
    playlet: {
      summary: "测试简介",
      episodeCount: 1,
      productionCost,
      copyright: { licenseProofFiles: { invalid: true } },
      qualification: { type: "其他微短剧", proofFiles: 123 },
      otherMaterials: "ignored",
    },
  };
}

test("requires backend production cost proof files before preparing a task", () => {
  for (const productionCost of [
    undefined,
    {},
    { proofFiles: [] },
    { proofFiles: "https://example.com/cost.pdf" },
    { proofFiles: [null] },
    { proofFiles: ["  "] },
    { proofFiles: ["https://example.com/cost.pdf", 123] },
  ]) {
    assert.throws(
      () => normalizeClaimedTaskConfig(task(productionCost)),
      /\[production-cost-proof-invalid\].*productionCost.proofFiles/u,
    );
  }
});

test("accepts backend cost files while ignoring the shape of optional attachment fields", () => {
  const proofFiles = ["https://example.com/cost.pdf", "D:\\materials\\cost.png"];
  const config = normalizeClaimedTaskConfig(task({ amountWan: 30, proofFiles }));
  assert.deepEqual(config.playlet.productionCost?.proofFiles, proofFiles);
});

test("normalizes new contract subjects and both historical ZHENCUIYIHAO labels", () => {
  for (const [label, subject] of [
    ["广州元漫科技有限公司", "YUANMAN"],
    ["北京云起漫影科技有限公司", "YUNQIMANYING"],
    ["广州梦动科技有限公司", "MENGDONG"],
    ["广州冲宝科技有限公司", "CHONGBAO"],
    ["广州豆燃科技有限公司", "DOURAN"],
    ["珍萃", "ZHENCUIYIHAO"],
    ["珍萃一号", "ZHENCUIYIHAO"],
  ]) {
    assert.equal(normalizeContractSubject(label), subject);
    assert.equal(normalizeContractSubject(` ${subject.toLowerCase()} `), subject);
  }
});
