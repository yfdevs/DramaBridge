import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleClient } from "../src/index.js";

function client(timeoutMs?: number) {
  return createOpenAiCompatibleClient({ apiKey: "test-key", baseURL: "https://ai.example.test/v1", model: "test-model", maxRetries: 0, timeoutMs });
}

const completion = {
  id: "test-completion", object: "chat.completion", created: 0, model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content: "生成完成" }, finish_reason: "stop" }],
};

test("text generation can finish after more than a minute without premature timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started = false;
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    started = true;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(completion)), 65_000);
      init.signal!.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  });
  const result = client().generateText({ prompt: "生成分集文案" }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  t.mock.timers.tick(65_000);
  const settled = await result;
  assert.equal(settled.error, undefined);
  assert.equal(settled.value?.text, "生成完成");
  assert.equal(aborted, false);
});

test("image recognition stays pending until the five-minute request deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started = false;
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    started = true;
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  });
  const pending = client().analyzeImages({ prompt: "识别封面", images: [{ type: "data-url", dataUrl: "data:image/png;base64,aW1hZ2U=" }] });
  const rejected = assert.rejects(pending, /timed out/i);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  t.mock.timers.tick(299_999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(aborted, true);
});

test("explicit request timeouts still override the default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  let started = false;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    started = true;
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  });
  const rejected = assert.rejects(client(12_000).generateText({ prompt: "测试" }), /timed out/i);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  t.mock.timers.tick(11_999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(aborted, true);
});

test("image generation and its SDK fallback both receive the five-minute timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directTimeouts: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    directTimeouts.push(ms);
    return timeout(ms);
  });
  let calls = 0;
  let aborted = false;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls += 1;
    if (calls === 1) return Response.json({ error: "compatibility fallback required" }, { status: 400 });
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  });
  const rejected = assert.rejects(client().generateImage({ prompt: "生成封面" }), /DRAMA_AI_IMAGE_GENERATION_FAILED/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(directTimeouts, [300_000]);
  t.mock.timers.tick(299_999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(aborted, true);
});
