import assert from "node:assert/strict";
import test from "node:test";

import type { LocalOwnershipMaterialFile } from "@dramabridge/media-assets";

import { prepareWechatAiProductionProofMaterials } from "../../src/shared/ai-production-proof-materials.js";
import { normalizeClaimedTaskConfig } from "../../src/shared/config.js";
import type { ClaimedAccountTask, Config } from "../../src/shared/types.js";

function config(aiContent: boolean | undefined, interfaceFiles: unknown): Config {
  return {
    originalTitle: "权属复用测试剧",
    playlet: {
      aiContent,
      aiProductionProofFiles: interfaceFiles,
      name: "权属复用测试剧",
    },
  } as unknown as Config;
}

const ownership: LocalOwnershipMaterialFile[] = [
  { file: "D:\\materials\\ownership-1.png", name: "ownership-1.png", size: 100 },
  { file: "D:\\materials\\ownership-2.jpg", name: "ownership-2.jpg", size: 200 },
  { file: "D:\\materials\\ownership-3.bmp", name: "ownership-3.bmp", size: 300 },
];

test("ignores interface AI proof files and selects exactly one raw ownership image", async () => {
  const playletConfig = config(true, ["https://example.com/interface-ai-proof.pdf"]);
  const selected = await prepareWechatAiProductionProofMaterials(playletConfig, ownership);

  assert.equal(selected.length, 1);
  assert.ok(ownership.some((material) => material.file === selected[0]));
  assert.notEqual(selected[0], "https://example.com/interface-ai-proof.pdf");
  assert.deepEqual(playletConfig.playlet.aiProductionProofFiles, selected);
});

test("does not select or require an AI proof when AI declaration is disabled", async () => {
  const playletConfig = config(false, { invalid: "interface value" });
  const selected = await prepareWechatAiProductionProofMaterials(playletConfig, []);

  assert.deepEqual(selected, []);
  assert.deepEqual(playletConfig.playlet.aiProductionProofFiles, []);
});

test("defaults AI declaration to enabled and requires the already validated ownership pool", async () => {
  const playletConfig = config(undefined, undefined);

  await assert.rejects(
    () => prepareWechatAiProductionProofMaterials(playletConfig, []),
    /\[production-proof-invalid\].*没有可用的权属图片/u,
  );
});

test("normalization discards aiProductionProofFiles without inspecting its shape", () => {
  const task = {
    accountTaskId: 1,
    originalTitle: "接口字段忽略测试剧",
    videoAccountId: "channel-1",
    videoAccountName: "测试视频号",
    playlet: {
      summary: "测试简介",
      episodeCount: 1,
      aiContent: true,
      aiProductionProofFiles: { invalid: [null, 123] },
      copyright: { productionProofFiles: ["contract.jpg"] },
    },
  } satisfies ClaimedAccountTask;

  const normalized = normalizeClaimedTaskConfig(task);
  assert.equal(normalized.playlet.aiContent, true);
  assert.deepEqual(normalized.playlet.aiProductionProofFiles, []);
  assert.deepEqual(normalized.playlet.copyright.productionProofFiles, []);
});

test("accepts a claimed task without contract materials", () => {
  const task = {
    accountTaskId: 3,
    originalTitle: "无合同测试剧",
    videoAccountId: "channel-1",
    videoAccountName: "明星说视频号",
    playlet: {
      summary: "测试简介",
      episodeCount: 1,
      copyright: {},
    },
  } satisfies ClaimedAccountTask;

  const normalized = normalizeClaimedTaskConfig(task);
  assert.deepEqual(normalized.playlet.copyright.productionProofFiles, []);
});

test("normalization preserves only a boolean AI declaration switch", () => {
  const task = {
    accountTaskId: 2,
    originalTitle: "动态开关测试剧",
    videoAccountId: "channel-1",
    videoAccountName: "测试视频号",
    playlet: {
      summary: "测试简介",
      episodeCount: 1,
      aiContent: false,
      copyright: { productionProofFiles: ["contract.jpg"] },
    },
  } satisfies ClaimedAccountTask;

  assert.equal(normalizeClaimedTaskConfig(task).playlet.aiContent, false);
  task.playlet.aiContent = "false" as never;
  assert.equal(normalizeClaimedTaskConfig(task).playlet.aiContent, true);
});
