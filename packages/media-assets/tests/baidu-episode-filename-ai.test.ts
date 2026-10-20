import assert from "node:assert/strict";
import test from "node:test";
import type { DramaAiClient, TextGenerationOptions } from "@dramabridge/ai";

import { selectBaiduEpisodePathsWithAi } from "../src/index.js";

test("sends every candidate filename to AI and maps selected IDs back to paths", async () => {
  let prompt = "";
  const client = {
    generateText: async (options: TextGenerationOptions) => {
      prompt = options.prompt;
      return {
        finishReason: "stop",
        model: "test",
        text: '{"selected":[{"id":2,"episode":1},{"id":4,"episode":2}],"reason":"统一的正片命名"}',
      };
    },
  } as DramaAiClient;
  const candidates = [
    { id: 1, index: 1, name: "分集-1.mp4", path: "/分集-1.mp4", size: 100 },
    { id: 2, index: 1, name: "剧名-第1集.mp4", path: "/剧名-第1集.mp4", size: 100 },
    { id: 3, index: 2, name: "分集-2.mp4", path: "/分集-2.mp4", size: 200 },
    { id: 4, index: 2, name: "剧名-第2集.mp4", path: "/剧名-第2集.mp4", size: 200 },
  ];

  assert.deepEqual(await selectBaiduEpisodePathsWithAi({
    client,
    resourceName: "剧名",
    expectedEpisodeCount: 2,
    candidates,
  }), [
    { path: "/剧名-第1集.mp4", index: 1 },
    { path: "/剧名-第2集.mp4", index: 2 },
  ]);
  assert.ok(candidates.every((candidate) => prompt.includes(candidate.name)));
  assert.ok(candidates.every((candidate) => prompt.includes(candidate.path)));
  assert.match(prompt, /程序初步集数可能错误/);
});

test("lets AI correct a misleading trailing segment number", async () => {
  const client = {
    generateText: async () => ({
      finishReason: "stop",
      model: "test",
      text: '{"selected":[{"id":1,"episode":14},{"id":2,"episode":58}],"reason":"开头是连续总集数"}',
    }),
  } as DramaAiClient;

  assert.deepEqual(await selectBaiduEpisodePathsWithAi({
    client,
    resourceName: "三分钱的取舍",
    expectedEpisodeCount: 58,
    candidates: [
      { id: 1, index: 1, name: "14·桃-2-1.mp4", path: "/14.mp4", size: 100 },
      { id: 2, index: 22, name: "58·桃-3-22.mp4", path: "/58.mp4", size: 100 },
    ],
  }), [
    { path: "/14.mp4", index: 14 },
    { path: "/58.mp4", index: 58 },
  ]);
});
