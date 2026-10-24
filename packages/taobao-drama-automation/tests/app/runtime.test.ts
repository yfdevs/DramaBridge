import assert from "node:assert/strict";
import test from "node:test";

import { classifyTaobaoDramaFailStage } from "../../src/app/runtime.js";

test("reports Baidu download failures as an API-supported upload stage", () => {
  assert.equal(
    classifyTaobaoDramaFailStage(new Error("等待百度网盘资源下载完成超时（60分钟）")),
    "UPLOAD_FILE",
  );
});

test("content tag failures remain form failures even when the tag mentions login or video", () => {
  assert.equal(classifyTaobaoDramaFailStage(new Error(
    "TAOBAO_DRAMA_CONTENT_TAG_NOT_FOUND: 填写视频内容标签失败：目标标签“#登录人生”",
  )), "FILL_FORM");
});
