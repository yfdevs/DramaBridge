// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureWechatMiniProgramRuntimeSettings } from "../../src/shared/runtime-settings.js";
import { normalizeClaimedTaskConfig } from "../../src/shared/config.js";
import { prepareWechatAiProductionProofMaterials } from "../../src/shared/ai-production-proof-materials.js";
import {
  claimNextWechatMiniProgramTaskApi,
  createMockWechatMiniProgramClaimResponse,
  createMockWechatMiniProgramTask,
  reportClaimedTaskErrorApi,
  reportClaimedTaskSuccessApi,
  resetMockWechatMiniProgramTaskApiForTesting,
} from "../../src/api/task.js";
import type { WechatMiniProgramAccount } from "../../src/api/mini-program-accounts.js";

const accounts: WechatMiniProgramAccount[] = [
  { id: "wxmp-mock-002", name: "微信小程序测试账号 02" },
  { id: "wxmp-task-factory-test", name: "微信小程序任务工厂测试账号" },
];

let mockAssetRoot: string;
before(async () => {
  mockAssetRoot = await mkdtemp(path.join(os.tmpdir(), "wechat-miniprogram-mock-assets-"));
  // Test fixtures must not depend on optional files in the developer's public/ directory.
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/YQAAAAASUVORK5CYII=", "base64");
  for (const file of ["模拟版权授权书.jpg", "模拟短剧制作合同.jpg", "模拟制作成本证明.jpg", "模拟AI制作证明.png"]) {
    await writeFile(path.join(mockAssetRoot, file), image);
  }
  configureWechatMiniProgramRuntimeSettings({ mockAssetRoot });
});
after(async () => {
  configureWechatMiniProgramRuntimeSettings();
  assert.equal(path.dirname(mockAssetRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(mockAssetRoot).startsWith("wechat-miniprogram-mock-assets-"));
  await rm(mockAssetRoot, { recursive: true, force: true });
});

test("creates a complete realistic WeChat Mini Program mock task", () => {
  const response = createMockWechatMiniProgramClaimResponse(accounts[0]);
  const task = createMockWechatMiniProgramTask(accounts[0]);
  const config = normalizeClaimedTaskConfig(task);

  assert.equal(response.code, 0);
  assert.equal(response.msg, "操作成功");
  assert.equal(response.data?.accountId, accounts[0].id);
  assert.equal(typeof response.data?.payloadJson, "object");
  assert.equal(task.videoAccountId, accounts[0].id);
  assert.equal(task.videoAccountName, accounts[0].name);
  assert.ok(task.accountTaskId > 0);
  assert.ok(task.dramaId && task.dramaId > 0);
  assert.equal(config.originalTitle, task.originalTitle);
  assert.equal(config.playlet.name, task.originalTitle);
  assert.equal(config.playlet.episodeCount, 11);
  assert.match(
    String(task.playlet.baiduPanResourceLink),
    /https:\/\/pan\.baidu\.com\/s\/1DqxBmsaWkLKKol5uHKxDNQ\?pwd=hm6f/,
  );
  assert.equal(config.mockTask, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.publish?.submit, false);
  assert.equal(config.playlet.aiContent, true);
  assert.equal(config.playlet.aiProductionProofFiles?.length, 1);
  assert.ok(config.playlet.aiProductionProofFiles?.every(existsSync));
  assert.equal(config.playlet.copyright.productionProofFiles?.length, 1);
  assert.equal(config.playlet.copyright.licenseProofFiles?.length, 1);
  assert.equal(config.playlet.productionCost?.proofFiles?.length, 1);
});

test("defaults AI declaration to enabled and honors an explicit false", () => {
  const defaultTask = createMockWechatMiniProgramTask(accounts[0]);
  delete defaultTask.playlet.aiContent;
  delete defaultTask.playlet.aiProductionProofFiles;
  const defaultConfig = normalizeClaimedTaskConfig(defaultTask);
  assert.equal(defaultConfig.playlet.aiContent, true);
  assert.deepEqual(defaultConfig.playlet.aiProductionProofFiles, []);

  const disabledTask = createMockWechatMiniProgramTask(accounts[0]);
  disabledTask.playlet.aiContent = false;
  disabledTask.playlet.aiProductionProofFiles = ["should-not-be-uploaded.png"];
  const disabledConfig = normalizeClaimedTaskConfig(disabledTask);
  assert.equal(disabledConfig.playlet.aiContent, false);
  assert.deepEqual(disabledConfig.playlet.aiProductionProofFiles, []);
});

test("prepares the built-in mock AI proof for the upload step", async () => {
  const config = normalizeClaimedTaskConfig(createMockWechatMiniProgramTask(accounts[0]));
  const files = await prepareWechatAiProductionProofMaterials(config);
  assert.equal(files.length, 1);
  assert.ok(files.every(existsSync));
  assert.match(files[0], /模拟AI制作证明\.png$/u);
});

test("returns one independent mock task per account and then returns no task", async () => {
  resetMockWechatMiniProgramTaskApiForTesting();

  const first = await claimNextWechatMiniProgramTaskApi(accounts[0]);
  const duplicate = await claimNextWechatMiniProgramTaskApi(accounts[0]);
  const second = await claimNextWechatMiniProgramTaskApi(accounts[1]);

  assert.ok(first);
  assert.equal(duplicate, null);
  assert.ok(second);
  assert.notEqual(first.accountTaskId, second.accountTaskId);
  const firstPlaylet = first.playlet as {
    aiContent: boolean;
    aiProductionProofFiles: string[];
    copyright: { productionProofFiles: string[]; licenseProofFiles: string[] };
    productionCost: { proofFiles: string[] };
  };
  assert.equal(firstPlaylet.aiContent, true);
  assert.ok(firstPlaylet.aiProductionProofFiles.every(existsSync));
  assert.ok(firstPlaylet.copyright.productionProofFiles.every(existsSync));
  assert.ok(firstPlaylet.copyright.licenseProofFiles.every(existsSync));
  assert.ok(firstPlaylet.productionCost.proofFiles.every(existsSync));

  await reportClaimedTaskSuccessApi({ accountTaskId: first.accountTaskId });
  await reportClaimedTaskErrorApi({
    accountTaskId: second.accountTaskId,
    failStage: "OTHER",
    videoAccountId: second.videoAccountId,
    errorMessage: "模拟错误",
  });
});

test("allows the mock task to be claimed again after a runtime restart reset", async () => {
  resetMockWechatMiniProgramTaskApiForTesting();
  assert.ok(await claimNextWechatMiniProgramTaskApi(accounts[0]));
  assert.equal(await claimNextWechatMiniProgramTaskApi(accounts[0]), null);

  resetMockWechatMiniProgramTaskApiForTesting();
  assert.ok(await claimNextWechatMiniProgramTaskApi(accounts[0]));
});
