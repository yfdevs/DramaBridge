// oxlint-disable typescript/no-floating-promises
import type { DramaAiClient, TextGenerationOptions } from "@dramabridge/ai";
import assert from "node:assert/strict";
import test from "node:test";

import { claimQqDramaTaskByIdApi } from "../../src/api/task.js";
import type { QqDramaHttpClient } from "../../src/api/http-client.js";

function taskPayload(summary: string) {
  return {
    qqPlaylet: {
      title: "测试漫剧",
      secondVersionEnabled: true,
      secondVersionTitle: "测试漫剧第二版",
      summary,
      audienceType: "通用",
      episodeCount: 12,
      updateStatus: "已完结",
      primaryCategory: "剧情",
      productionOrganization: "无",
      producers: ["测试制片人"],
      directors: ["测试导演"],
      productionCostRange: "< 30 万",
      productionCostWan: 1,
      productionYear: 2026,
      contractName: "测试合同",
    },
    productionCost: { proofFiles: ["D:/materials/cost.pdf"] },
    copyright: { productionProofFiles: ["D:/materials/contract.pdf"] },
  };
}

function claimClient(summary: string): QqDramaHttpClient {
  return {
    async post<T>(path: string) {
      assert.match(path, /\/claim$/u);
      return {
        code: 0,
        msg: null,
        data: {
          accountTaskId: 7,
          originalTitle: "测试原剧名",
          accountId: "qq-account-1",
          rpaProfileKey: null,
          accountConfigJson: null,
          payloadJson: taskPayload(summary),
        },
      } as T;
    },
  };
}

function textClient(output: string, requests: TextGenerationOptions[]): DramaAiClient {
  return {
    async generateText(options) {
      requests.push(options);
      return { finishReason: "stop", model: "test-model", text: output };
    },
    async analyzeImages() {
      throw new Error("not implemented");
    },
    async generateImage() {
      throw new Error("not implemented");
    },
  };
}

test("optimizes an overlong claimed summary before schema validation", async () => {
  const requests: TextGenerationOptions[] = [];
  const task = await claimQqDramaTaskByIdApi({
    accountTaskId: 7,
    client: claimClient("剧情内容".repeat(60)),
    runtimeOptions: {
      qqAccountId: "qq-account-1",
      aiClientFactory: () => textClient("一段忠于原剧情且长度合规的简介。", requests),
    },
  });

  assert.equal(task?.playlet.summary, "一段忠于原剧情且长度合规的简介。");
  assert.equal(task?.playlet.secondVersionEnabled, true);
  assert.equal(task?.playlet.secondVersionTitle, "测试漫剧第二版");
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.prompt ?? "", /QQ 短剧作品简介/u);
});

test("does not call AI for an already valid claimed summary", async () => {
  let createdAiClient = false;
  const task = await claimQqDramaTaskByIdApi({
    accountTaskId: 7,
    client: claimClient("合规剧情简介"),
    runtimeOptions: {
      qqAccountId: "qq-account-1",
      aiClientFactory: () => {
        createdAiClient = true;
        return textClient("不应使用", []);
      },
    },
  });

  assert.equal(task?.playlet.summary, "合规剧情简介");
  assert.equal(createdAiClient, false);
});
