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

test("directory HTTP 500 retries exactly three times, with no credential leakage", async () => {
  let calls = 0;
  const request = requestInPage(async () => {
    calls++;
    return new Response('server error', { status: 500 });
  });
  await assert.rejects(request('/api/list?bdstoken=secret'), error => {
    assert.match(String(error), /HTTP 500/);
    assert.doesNotMatch(String(error), /secret/);
    return true;
  });
  assert.equal(calls, 3);
});

test("directory retry succeeds on the third attempt", async () => {
  let calls = 0;
  const request = requestInPage(async () => ++calls < 3
    ? new Response('unavailable', { status: 503 }) : new Response('{"errno":0,"list":[]}'));
  assert.deepEqual(JSON.parse(JSON.stringify(await request('/api/list'))), { errno: 0, list: [] });
  assert.equal(calls, 3);
});

test("mixed directory errno and HTTP errors share one three-attempt budget", async () => {
  let calls = 0;
  const request = requestInPage(async () => ++calls === 1
    ? new Response('{"errno":4}') : new Response('unavailable', { status: 500 }));
  await assert.rejects(request('/api/list'), /HTTP 500/);
  assert.equal(calls, 3);
});

test("read timeout retries three times but caller cancellation is never retried", async () => {
  let calls = 0;
  const request = requestInPage(async (_, init) => {
    calls++;
    return new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  await assert.rejects(request('/api/list', {}, 'json', 10), /接口请求超时/);
  assert.equal(calls, 3);
  const controller = new AbortController();
  const pending = request('/api/list', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('user stopped')), 500);
  await assert.rejects(pending, /user stopped/);
  assert.equal(calls, 4);
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

test("8001 opens a circuit so subsequent reads and writes do not reach Baidu", async () => {
  let calls = 0;
  const request = requestInPage(async () => {
    calls++;
    return new Response(JSON.stringify({ errno: 8001, request_id: "risk-trace", bdstoken: "secret" }));
  });
  await assert.rejects(request("/api/list?bdstoken=secret"), error => {
    assert.match(String(error), /BAIDU_NETDISK_RISK_CONTROL.*errno=8001.*request_id=risk-trace/);
    assert.doesNotMatch(String(error), /secret/);
    return true;
  });
  await assert.rejects(request("/share/transfer", { method: "POST" }), /BAIDU_NETDISK_RISK_CONTROL/);
  assert.equal(calls, 1);
});

test("filemanager 132 never replays the delete or blocks a subsequent directory read", async () => {
  let calls = 0;
  const request = requestInPage(async input => { calls++; return new Response(String(input).includes("filemanager") ? '{"errno":132}' : '{"errno":0}'); });
  await assert.rejects(request("/api/filemanager?opera=delete", { method: "POST" }), /BAIDU_NETDISK_IDENTITY_VERIFICATION.*验证身份.*errno=132/);
  assert.equal(calls, 1);
  assert.equal((await request<{ errno: number }>("/api/list")).errno, 0);
  assert.equal(calls, 2);
});

test("transfer uses official XHR transport once, preserving body and credentials", async () => {
  let sent = 0;
  class Xhr {
    status = 200; responseURL = 'https://pan.baidu.com/share/transfer'; responseText = '{"errno":0}';
    withCredentials = false; onload = () => {}; headers: Record<string,string> = {};
    open(method: string, url: string) { assert.equal(method,'POST'); assert.match(url,/pan.baidu.com\/share\/transfer/); }
    setRequestHeader(key: string,value: string) { this.headers[key] = value; }
    getResponseHeader() { return 'application/json'; }
    send(body: string) { sent++; assert.equal(body,'fsidlist=%5B1%5D'); assert.equal(this.withCredentials,true); assert.equal(this.headers['x-requested-with'],'XMLHttpRequest'); this.onload(); }
    abort() {}
  }
  const request = runInNewContext(`(${baiduPageRequest.toString()})`, {
    __name: (value: unknown) => value, XMLHttpRequest:Xhr, Headers, AbortController, setTimeout, clearTimeout, URL,
    location:{href:'https://pan.baidu.com/s/1example'}, fetch:()=>{throw new Error('must not fetch transfer');},
  }) as typeof baiduPageRequest;
  assert.equal((await request<{errno:number}>('/share/transfer',{method:'POST',body:'fsidlist=%5B1%5D'})).errno,0);
  assert.equal(sent,1);
});
