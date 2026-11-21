import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baiduOfficialCleanupRequest } from "../../src/infrastructure/official-cleanup-request.js";

function fixture(net?: (options: any) => Promise<any>) {
  const calls: any[] = [];
  const nativeCalls: any[] = [];
  const app = { $Net: async function(this: unknown, options: any) { assert.equal(this, app); nativeCalls.push(options); return { data: { errno: 0, list: [] } }; } };
  const context: any = { __name: (fn: unknown) => fn, URL, URLSearchParams, Date, AbortController, setTimeout, clearTimeout, require: (name: string) => { assert.equal(name, "@electron/remote"); return { app }; } };
  context.deleteFlow = async (path: string) => { calls.push(path); const result = net ? await net({ path }) : { data: { errno: 0 } }; if (result?.ajaxError) throw new Error("Client failure"); return result?.data; };
  return { calls, nativeCalls, context, run: (url = "/api/filemanager?opera=delete&async=2&bdstoken=secret&clienttype=0", paths: unknown = ["/旧剧/第1集.mp4"], timeout = 1000) => runInNewContext(`(${baiduOfficialCleanupRequest.toString()})(url,init,'json',timeout,deleteFlow)`, Object.assign(context, { url, init: { method: "POST", body: new URLSearchParams({ filelist: JSON.stringify(paths) }) }, timeout })) };
}
test("serialized deletion delegates one path without directly posting to the network layer", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ["/旧剧/第1集.mp4"]); assert.equal(f.nativeCalls.length, 0);
});
test("a missing client flow is not replaced by a direct delete", async () => {
  const f = fixture(); f.context.deleteFlow = undefined;
  await assert.rejects(f.run(), /不降级/); assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls.length, 0);
});
test("verification, server failures and unknown write results are never retried", async () => {
  for (const response of [{ data: { errno: 132 } }, { data: { errno: 12 } }, { data: { errno: 0 }, ajaxError: true }, {}]) {
    const f = fixture(async () => response); await assert.rejects(f.run()); assert.equal(f.calls.length, 1);
  }
  const f = fixture(async () => new Promise(() => {}));
  await assert.rejects(f.run(undefined, undefined, 10), /结果未确认/); assert.equal(f.calls.length, 1);
});
test("unsafe paths, multi-file writes and unapproved endpoints never reach the native network layer", async () => {
  for (const paths of [["/"], ["/../其他文件"], ["/安全", "/另一个"], null]) {
    const f = fixture(); await assert.rejects(f.run(undefined, paths)); assert.equal(f.calls.length, 0);
  }
  for (const url of ["https://example.com/api/filemanager?opera=delete", "/api/filemanager?opera=move", "/api/recycle/clear"]) {
    const f = fixture(); await assert.rejects(f.run(url)); assert.equal(f.calls.length, 0);
  }
});
test("an unavailable official bridge fails closed without a web fetch fallback", async () => {
  const f = fixture(); f.context.require = undefined;
  await assert.rejects(f.run(), /不会改用分享页/); assert.equal(f.calls.length, 0);
});
test("turning cleanup off during write pacing prevents the queued deletion", async () => {
  const f = fixture(); f.context.__dramaBridgeNativeCleanupNextWrite = Date.now() + 30;
  setTimeout(() => { f.context.__dramaBridgeAutoCleanupContinue = false; }, 1);
  await assert.rejects(f.run(), /已关闭/); assert.equal(f.calls.length, 0);
});
test("identity failures retain bounded request timing and reference data without verification secrets", async () => {
  const f = fixture(async () => ({ data: { errno: 132, request_id: "123456", authwidget: { safesign: "do-not-log" } } }));
  await assert.rejects(f.run(), error => {
    assert.match(String(error), /"requestId":"123456"/);
    assert.match(String(error), /"flowAttemptsInLastMinute":1/);
    assert.doesNotMatch(String(error), /do-not-log|authwidget|safesign/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});
test("outer timeout aborts the client flow before it can confirm a late dialog", async () => {
  const f = fixture(); let confirmed = false, flowSignal: AbortSignal | undefined;
  f.context.deleteFlow = async (_path: string, signal: AbortSignal) => {
    flowSignal = signal;
    await new Promise(resolve => setTimeout(resolve, 30));
    if (!signal.aborted) confirmed = true;
    return { errno: 0 };
  };
  await assert.rejects(f.run(undefined, undefined, 5), /结果未确认/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(flowSignal?.aborted, true); assert.equal(confirmed, false);
});
