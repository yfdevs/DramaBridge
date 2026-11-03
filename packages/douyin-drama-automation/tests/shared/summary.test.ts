import assert from "node:assert/strict";
import test from "node:test";
import { optimizeDouyinSummary } from "../../src/shared/summary.js";

for (const length of [100, 101, 197, 200, 201, 250]) {
  test(`optimizes Douyin synopsis ${length} only outside 101-200`, async () => {
    let calls = 0;
    const result = await optimizeDouyinSummary("剧".repeat(length), {
      generateText: async () => { calls++; return { text: "剧情".repeat(80) }; },
    });
    assert.equal(result.length, length >= 101 && length <= 200 ? length : 160);
    assert.equal(calls, length >= 101 && length <= 200 ? 0 : 1);
  });
}

test("validates the cleaned AI synopsis length before accepting it", async () => {
  let calls = 0;
  const result = await optimizeDouyinSummary("剧".repeat(250), {
    generateText: async () => { calls++; return { text: calls === 1 ? "剧".repeat(90) + " ".repeat(20) : "剧".repeat(150) }; },
  });
  assert.equal(result.length, 150);
  assert.equal(calls, 2);
});
