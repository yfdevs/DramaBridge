import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleClient } from "../src/openai-compatible-client.js";

test("group image requests enable sequential generation with a bounded output count", async t => {
  const bodies: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ data: [{ b64_json: "AQ==" }, { b64_json: "Ag==" }] });
  });
  const client = new OpenAiCompatibleClient({ apiKey: "test", model: "seedream", baseURL: "https://example.invalid/v1" });
  const result = await client.generateImage({ prompt: "两个独立剧名版本", count: 2, referenceImages: [{ type: "data-url", dataUrl: "data:image/png;base64,AQ==" }] });
  assert.equal(result.images.length, 2);
  assert.equal(bodies[0].sequential_image_generation, "auto");
  assert.deepEqual(bodies[0].sequential_image_generation_options, { max_images: 2 });
  await client.generateImage({ prompt: "单图" });
  assert.equal(bodies[1].sequential_image_generation, "disabled");
  assert.equal(bodies[1].sequential_image_generation_options, undefined);
  await assert.rejects(client.generateImage({ prompt: "超额", count: 15, referenceImages: [{ type: "data-url", dataUrl: "data:image/png;base64,AQ==" }] }), /COUNT_INVALID/);
});

test("unsupported groups never silently fall back to copies of one prompt", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "unsupported" }, { status: 400 }); });
  const client = new OpenAiCompatibleClient({ apiKey: "test", model: "test", baseURL: "https://example.invalid/v1" });
  await assert.rejects(client.generateImage({ prompt: "两个不同剧名", count: 2 }), /BATCH_FAILED/);
  assert.equal(calls, 1);
});
