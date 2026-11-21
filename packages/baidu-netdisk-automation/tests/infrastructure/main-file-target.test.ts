import assert from "node:assert/strict";
import test from "node:test";
import { isBaiduFileRenderer, isBaiduMainFileTarget } from "../../src/infrastructure/main-file-target.js";
test("main window identity survives folder and tab navigation without confusing auxiliary windows", () => {
  for (const hash of ["#/", "#/?category=all&path=%2F", "#/?path=%2Fold", "#/downloading"]) {
    const target = { url: "file:///C:/Baidu/core.asar/index.html" + hash, webSocketDebuggerUrl: "ws://local", windowId: 1, mainWindowId: 1 };
    assert.equal(isBaiduMainFileTarget(target), true);
    assert.equal(isBaiduMainFileTarget({ ...target, windowId: 5 }), false);
  }
  assert.equal(isBaiduMainFileTarget({ url: "file:///C:/Baidu/core.asar/index.html#/", webSocketDebuggerUrl: "ws://local" }), false);
  assert.equal(isBaiduFileRenderer({ url: "https://pan.baidu.com/", webSocketDebuggerUrl: "ws://local" }), false);
});
