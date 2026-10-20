// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import test from "node:test";
import type { DramaAiClient, TextGenerationOptions } from "@dramabridge/ai";

import { resolveTencentHuolongCreativeMetadata } from "../../src/shared/subtitle.js";
import type { TencentHuolongTaskPayload } from "../../src/shared/types.js";

function payload(overrides: Partial<TencentHuolongTaskPayload> = {}): TencentHuolongTaskPayload {
  return {
    title: "车位风波",
    summary: "沈悦因车位被占和家人发生冲突，最终通过规则维护权益。",
    episodeCount: 40,
    isAiRealPersonShortDrama: "否",
    themeType: "都市",
    keywords: [],
    costAnalysisFiles: [],
    copyrightProofFiles: [],
    productionProcessFiles: [],
    ...overrides,
  };
}

function aiClientReturning(text: string, calls: TextGenerationOptions[]): DramaAiClient {
  return {
    async generateText(options) {
      calls.push(options);
      return {
        finishReason: "stop",
        model: "test-model",
        text,
      };
    },
    async analyzeImages() {
      throw new Error("not used");
    },
    async generateImage() {
      throw new Error("not used");
    },
  };
}

test("uses backend keywords without calling AI when metadata is complete", async () => {
  const result = await resolveTencentHuolongCreativeMetadata(payload({
    protagonistName: "沈悦",
    isAiRealPersonShortDrama: "是",
    keywords: ["都市", "情感"],
  }), {});

  assert.equal(result.subtitle, "沈悦逆袭人生");
  assert.deepEqual(result.keywords, ["都市", "情感"]);
});

test("gets protagonist and exactly two platform keywords in one AI call", async () => {
  const calls: TextGenerationOptions[] = [];
  const result = await resolveTencentHuolongCreativeMetadata(
    payload({ isAiRealPersonShortDrama: "是" }),
    { aiClient: aiClientReturning(
      '{"protagonistName":"沈悦","keywords":["都市","情感"]}',
      calls,
    ) },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.prompt ?? "", /主旋律、脱贫攻坚/u);
  assert.equal(result.subtitle, "沈悦逆袭人生");
  assert.deepEqual(result.keywords, ["都市", "情感"]);
});

test("falls back to title, summary and theme when AI keyword output is unusable", async () => {
  const calls: TextGenerationOptions[] = [];
  const result = await resolveTencentHuolongCreativeMetadata(
    payload({ protagonistName: "沈悦", isAiRealPersonShortDrama: "是" }),
    { aiClient: aiClientReturning(
      '{"protagonistName":"沈悦","keywords":["未知标签"]}',
      calls,
    ) },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(result.keywords, ["都市", "情感"]);
});

test("does not request or return keywords for a non-AI-real-person drama", async () => {
  const result = await resolveTencentHuolongCreativeMetadata(payload({
    protagonistName: "沈悦",
    isAiRealPersonShortDrama: "否",
  }), {});

  assert.deepEqual(result.keywords, []);
});
