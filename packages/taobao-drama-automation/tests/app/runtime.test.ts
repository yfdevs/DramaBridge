import assert from "node:assert/strict";
import test from "node:test";

import { classifyTaobaoDramaFailStage, taobaoDownloadInfrastructurePauseReason } from "../../src/app/runtime.js";

test("pauses new tasks for a broken Baidu client but not for an individual invalid resource", () => {
  for (const message of [
    "[BAIDU_NETDISK_CLIENT_RESTART_REQUIRED] 百度网盘客户端下载组件不可用",
    "端口 9337 不是可用百度网盘 CDP",
    "Error parsing C:\\client\\app.asar\\node_modules\\@electron\\remote\\package.json: Unexpected token 'e'",
  ]) {
    assert.match(taobaoDownloadInfrastructurePauseReason(new Error(message))!, /已暂停领取新任务/);
  }
  assert.equal(taobaoDownloadInfrastructurePauseReason(new Error("百度网盘剧集视频数量不正确")), undefined);
  assert.equal(taobaoDownloadInfrastructurePauseReason(new Error("网络或服务响应超时")), undefined);
});

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
