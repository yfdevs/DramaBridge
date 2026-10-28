import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baiduNativeDownloaderProbeExpression } from "../../src/infrastructure/native-downloader.js";

test("detects the stale archive error without submitting a download", () => {
  const state = runInNewContext(baiduNativeDownloaderProbeExpression, {
    require: () => { throw new SyntaxError("Error parsing app.asar/node_modules/@electron/remote/package.json: Unexpected token 'e'"); },
  });
  assert.equal(state.ready, false);
  assert.match(state.error, /Error parsing.*@electron\/remote/);
});

test("probes both downloader methods without calling either one", () => {
  const unexpectedCall = () => { throw new Error("probe must not touch download tasks"); };
  const state = runInNewContext(baiduNativeDownloaderProbeExpression, {
    require: () => ({ app: { $downloader: { addDownloadTask: unexpectedCall, getDownloadTasks: unexpectedCall } } }),
  });
  assert.equal(state.ready, true);
});

test("rejects a client that exposes an incomplete download API", () => {
  const state = runInNewContext(baiduNativeDownloaderProbeExpression, {
    require: () => ({ app: { $downloader: { getDownloadTasks() {} } } }),
  });
  assert.equal(state.ready, false);
});
