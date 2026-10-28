import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baiduPageRequest } from "../../src/infrastructure/page-request.js";

function requestInPage(fetch: typeof globalThis.fetch) {
  return runInNewContext(`(${baiduPageRequest.toString()})`, {
    fetch, AbortController, setTimeout, clearTimeout, URL,
    location: { href: "https://pan.baidu.com/s/1example" },
  }) as typeof baiduPageRequest;
}

test("serialized page request preserves cookies, method and JSON body", async () => {
  const request = requestInPage(async (_, init) => {
    assert.equal(init?.credentials, "include");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "payload");
    assert.ok(init?.signal);
    return new Response('{"errno":0}');
  });
  assert.equal((await request<{ errno: number }>("/api/list", { method: "POST", body: "payload" })).errno, 0);
});

test("page request aborts a stalled connection without replaying the operation", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const request = requestInPage(async (_, init) => {
    calls += 1;
    signal = init!.signal!;
    return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  await assert.rejects(request("/share/transfer?token=secret", { method: "POST" }, "json", 10), /接口请求超时.*\/share\/transfer/);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("page request also bounds a stalled body after successful headers", async () => {
  const request = requestInPage(async (_, init) => ({
    ok: true,
    text: () => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
  } as Response));
  await assert.rejects(request("/s/1example", {}, "text", 10), /接口请求超时/);
});

test("page request reports HTTP errors without exposing query credentials", async () => {
  const request = requestInPage(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(request("/api/list?token=secret"), error => {
    assert.match(String(error), /HTTP 503.*\/api\/list/);
    assert.doesNotMatch(String(error), /secret/);
    return true;
  });
});
