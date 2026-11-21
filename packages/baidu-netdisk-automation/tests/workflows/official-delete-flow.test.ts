import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { deleteThroughOfficialClient } from "../../src/workflows/official-delete-flow.js";
function fixture(mode = "success") {
  let calls = 0, confirms = 0, cancels = 0, callback: ((ok: boolean) => void) | undefined;
  let security = mode === "existing-security";
  const state: any = { ifShowHintDialog: mode === "busy", ifShowSkipFileDialog: false, confirmed: false, scheduledFiles: [], scene: -1, skipFiles: [], delSharedFiles: false };
  const vm: any = { $options: { name: "mainPage" }, deletion: state, selectedFiles: [], $children: [], $route: { query: { path: "/旧剧" } }, files: [{ path: "/旧剧/1.png", fs_id: "123", isdir: 0, size: 100, server_ctime: (Date.now() - 172800000) / 1000, server_mtime: (Date.now() - 172800000) / 1000 }],
    deleteFile(paths: string[], cb: (ok: boolean) => void) {
      calls++; callback = cb; state.scheduledFiles = paths;
      state.ifShowHintDialog = true; state.scene = mode === "safebox" ? 2 : 1;
      state.delSharedFiles = mode !== "failed-precheck"; state.ifShowSkipFileDialog = mode === "shared";
    },
    handleDelConfirm() { confirms++; state.ifShowHintDialog = false; state.confirmed = true; if (mode === "security") security = true; else if (mode !== "unknown") callback?.(mode !== "failure"); },
    handleDelCancel() { cancels++; state.ifShowHintDialog = false; callback?.(false); },
  };
  const context: any = { __name: (fn: unknown) => fn, encodeURIComponent, setTimeout, clearTimeout, setInterval: (fn: () => void) => setInterval(fn, 1), clearInterval,
    document: { querySelectorAll: () => [{ __vue__: vm }] },
    require: () => ({ BrowserWindow: { getAllWindows: () => security ? [{ webContents: { getURL: () => "file:///core.asar/index.html#/deleteFileSecurity" } }] : [] } }),
  };
  return { context, state, vm, run: () => runInNewContext(`(${deleteThroughOfficialClient.toString()})('/旧剧/1.png',undefined,50,'123')`, context), stats: () => ({ calls, confirms, cancels }) };
}
test("serialized flow calls the original client precheck and confirms exactly one matching ordinary dialog", async () => {
  const f = fixture(); const result = await f.run(); assert.equal(result.errno, 0);
  assert.deepEqual(Array.from(f.state.scheduledFiles), [encodeURIComponent("/旧剧/1.png")]);
  assert.deepEqual(f.stats(), { calls: 1, confirms: 1, cancels: 0 });
});
test("existing user dialogs and identity windows are never taken over", async () => {
  for (const mode of ["busy", "existing-security"]) { const f = fixture(mode); await assert.rejects(f.run()); assert.equal(f.stats().calls, 0); }
});
test("shared, safebox and failed prechecks never reach the confirm action", async () => {
  for (const mode of ["shared", "safebox", "failed-precheck"]) { const f = fixture(mode); await assert.rejects(f.run()); assert.equal(f.stats().confirms, 0); }
});
test("identity, client failure and timeout never retry the original action", async () => {
  for (const mode of ["security", "failure", "unknown"]) {
    const f = fixture(mode); await assert.rejects(f.run(), mode === "security" ? /IDENTITY_VERIFICATION/ : /未确认/);
    assert.equal(f.stats().calls, 1); assert.equal(f.stats().confirms, 1);
    assert.equal(f.context.__dramaBridgeOfficialDeleteBusy, false);
  }
});
test("disabled cleanup does not enter the original delete flow", async () => {
  const f = fixture(); f.context.__dramaBridgeAutoCleanupContinue = false;
  await assert.rejects(f.run(), /已关闭/); assert.equal(f.stats().calls, 0);
});
test("a replaced file or knowledge-protected file never enters the delete flow", async () => {
  for (const item of [{ path: "/旧剧/1.png", fs_id: "999" }, { path: "/旧剧/1.png", fs_id: "123", knowledge_type: 1 }]) {
    const f = fixture(); f.vm.files = [item]; await assert.rejects(f.run()); assert.equal(f.stats().calls, 0);
  }
});
test("folder navigation uses the client router and waits for the expected file", async () => {
  const f = fixture(); f.vm.$route.query.path = "/"; let navigated = false;
  f.vm.$router = { push: async (to: any) => { navigated = true; f.vm.$route.query.path = to.query.path; } };
  await f.run(); assert.equal(navigated, true); assert.equal(f.stats().confirms, 1);
});
test("unresolved navigation is bounded and never reaches delete", async () => {
  const f = fixture(); f.vm.$route.query.path = "/"; f.vm.$router = { push: async () => new Promise(() => {}) };
  await assert.rejects(f.run(), /目录切换未完成/); assert.equal(f.stats().calls, 0); assert.equal(f.context.__dramaBridgeOfficialDeleteBusy, false);
});
test("consecutive deletes wait for the client to reset its confirmation state", async () => {
  const f = fixture(); await f.run();
  await assert.rejects(f.run(), /正在进行/); assert.equal(f.stats().calls, 1);
  f.state.confirmed = false; // Simulate the client's own dialog-close event.
  await f.run(); assert.equal(f.stats().calls, 2);
});
test("a file updated today while the client loads it is retained", async () => {
  const f = fixture(); f.vm.files[0].server_mtime = Date.now() / 1000;
  await assert.rejects(f.run(), /日期或大小已变化/); assert.equal(f.stats().calls, 0);
});
