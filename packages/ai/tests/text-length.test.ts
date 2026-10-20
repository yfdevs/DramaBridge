// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import test from "node:test";

import type { TextGenerationOptions } from "../src/index.js";
import { optimizeTextLength, truncateTextToLength } from "../src/index.js";

function fakeTextClient(outputs: Array<string | Error>) {
  const requests: TextGenerationOptions[] = [];
  return {
    requests,
    client: {
      async generateText(options: TextGenerationOptions) {
        requests.push(options);
        const output = outputs.shift() ?? "";
        if (output instanceof Error) throw output;
        return {
          finishReason: "stop",
          model: "test-model",
          text: output,
        };
      },
    },
  };
}

test("returns valid text without calling AI", async () => {
  const fake = fakeTextClient([]);
  const result = await optimizeTextLength({
    client: fake.client,
    text: "  已经符合长度  ",
    maxLength: 20,
  });

  assert.equal(result, "已经符合长度");
  assert.equal(fake.requests.length, 0);
});

test("asks AI to rewrite overlong text and retries invalid output", async () => {
  const fake = fakeTextClient([
    "第一次输出仍然明显超过限制",
    "优化后：精炼剧情简介",
  ]);
  const result = await optimizeTextLength({
    client: fake.client,
    text: "这是一段需要被精炼处理的很长剧情简介",
    maxLength: 8,
    fieldName: "作品简介",
  });

  assert.equal(result, "精炼剧情简介");
  assert.equal(fake.requests.length, 2);
  assert.match(fake.requests[0]?.prompt ?? "", /作品简介/u);
  assert.match(fake.requests[1]?.prompt ?? "", /上一次输出不符合长度要求/u);
});

test("uses a safe deterministic length guard when AI stays over the limit", async () => {
  const fake = fakeTextClient(["剧情😀仍然太长", "剧情😀仍然太长", "剧情😀仍然太长"]);
  const result = await optimizeTextLength({
    client: fake.client,
    text: "原始剧情简介明显超长",
    maxLength: 5,
  });

  assert.equal(result, "剧情😀仍");
  assert.equal(result.length, 5);
  assert.equal(fake.requests.length, 3);
  assert.equal(truncateTextToLength("剧情😀结局", 5), "剧情😀结");
});

test("falls back to bounded original text when the AI service fails", async () => {
  const fake = fakeTextClient([new Error("network"), new Error("network"), new Error("network")]);
  const result = await optimizeTextLength({
    client: fake.client,
    text: "一二三四五六七八",
    maxLength: 5,
  });

  assert.equal(result, "一二三四五");
  assert.equal(fake.requests.length, 3);
});
