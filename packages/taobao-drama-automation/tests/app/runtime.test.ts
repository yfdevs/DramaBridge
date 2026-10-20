import assert from "node:assert/strict";
import test from "node:test";

import { classifyTaobaoDramaFailStage } from "../../src/app/runtime.js";

test("reports Baidu download failures as an API-supported upload stage", () => {
  assert.equal(
    classifyTaobaoDramaFailStage(new Error("等待百度网盘资源下载完成超时（60分钟）")),
    "UPLOAD_FILE",
  );
});
