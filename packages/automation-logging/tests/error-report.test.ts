import assert from "node:assert/strict";
import test from "node:test";

import { formatAutomationErrorReport } from "../src/index.js";

test("formats nested iQiyi AI cover failures with the real cause", () => {
  const cause = new Error(
    "IQIYI_DRAMA_AI_COVER_TEXT_VALIDATION_FAILED: 剧名不准确；检测到剧名以外的文字",
  );
  const error = Object.assign(new Error("IQIYI_DRAMA_AI_COVER_GENERATION_FAILED"), { cause });

  assert.equal(
    formatAutomationErrorReport(error),
    "爱奇艺 AI 横版封面生成失败；根因：AI 横版封面文字验收未通过：剧名不准确；检测到剧名以外的文字" +
      "（错误码：IQIYI_DRAMA_AI_COVER_GENERATION_FAILED → IQIYI_DRAMA_AI_COVER_TEXT_VALIDATION_FAILED）",
  );
});

test("turns an AI provider HTTP error into an actionable Chinese report", () => {
  const cause = new Error("DRAMA_AI_IMAGE_GENERATION_FAILED: HTTP 401; invalid api key");
  const error = Object.assign(new Error("IQIYI_DRAMA_AI_COVER_GENERATION_FAILED"), { cause });

  assert.equal(
    formatAutomationErrorReport(error),
    "爱奇艺 AI 横版封面生成失败；根因：AI 图片生成服务调用失败：服务鉴权失败（HTTP 401），请检查 API Key" +
      "（错误码：IQIYI_DRAMA_AI_COVER_GENERATION_FAILED → DRAMA_AI_IMAGE_GENERATION_FAILED）",
  );
});

test("formats common Playwright timeouts and removes call logs", () => {
  assert.equal(
    formatAutomationErrorReport(
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button')",
    ),
    "页面或服务响应超时（等待 30 秒），请检查网络和当前页面后重试",
  );
});

test("keeps an existing Chinese error detail and appends its diagnostic code", () => {
  assert.equal(
    formatAutomationErrorReport("IQIYI_DRAMA_FORM_INVALID: 演员姓名不能为空"),
    "爱奇艺提交表单校验未通过：演员姓名不能为空（错误码：IQIYI_DRAMA_FORM_INVALID）",
  );
});

test("explains a Baidu cover upload that never becomes confirmable", () => {
  const report = formatAutomationErrorReport(
    'BAIDU_DRAMA_COVER_CONFIRM_NOT_READY: file=cover.jpg dialog="本地图片 0张上传成功 去编辑 确认"',
  );
  assert.match(report, /^百度封面上传未完成，图片选择后仍显示 0 张上传成功/);
  assert.match(report, /错误码：BAIDU_DRAMA_COVER_CONFIRM_NOT_READY/);
});

test("explains a Taobao video rejection without suggesting a retry", () => {
  const report = formatAutomationErrorReport(
    "TAOBAO_DRAMA_VIDEO_UPLOAD_REJECTED: 上传失败 上传视频的宽高是720x1280不符合要求，视频宽高均要大于1080 我知道了",
  );

  assert.match(report, /淘宝拒绝上传视频/);
  assert.match(report, /不会自动删除或重新上传/);
  assert.match(report, /720x1280/);
  assert.match(report, /错误码：TAOBAO_DRAMA_VIDEO_UPLOAD_REJECTED/);
});

test("removes unknown internal prefixes and remains stable when formatted twice", () => {
  const formatted = formatAutomationErrorReport("[local-video-invalid] 第 3 集视频不存在");
  assert.equal(formatted, "任务执行失败：第 3 集视频不存在（错误码：local-video-invalid）");
  assert.equal(formatAutomationErrorReport(formatted), formatted);
});

test("explains exhausted Douyin episode delete-and-reupload attempts", () => {
  const report = formatAutomationErrorReport(
    'DOUYIN_DRAMA_EPISODE_UPLOAD_REUPLOADS_EXHAUSTED: file="一颗榴莲，撕开保姆真面目-第3集.mp4"; reuploadAttempts=5; maximum=5',
  );

  assert.match(report, /第 3 集视频/);
  assert.match(report, /自动删除并重新上传 5 次/);
  assert.match(report, /检查该集源视频能否正常播放/);
  assert.match(report, /错误码：DOUYIN_DRAMA_EPISODE_UPLOAD_REUPLOADS_EXHAUSTED/);
});

test("explains that a short Douyin episode is not retried", () => {
  const report = formatAutomationErrorReport(
    'DOUYIN_DRAMA_EPISODE_DURATION_TOO_SHORT: file="测试剧-第3集.mp4"; duration=00:00:29; minimumSeconds=30',
  );

  assert.match(report, /第 3 集视频/);
  assert.match(report, /不足 30 秒/);
  assert.match(report, /不会自动删除或重传/);
  assert.match(report, /错误码：DOUYIN_DRAMA_EPISODE_DURATION_TOO_SHORT/);
});

test("explains a disabled Douyin scheduled publish hour", () => {
  assert.equal(
    formatAutomationErrorReport(
      "DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_DISABLED: column=0; value=18",
    ),
    "平台当前不允许选择定时发布小时“18”。该时间可能已过、距离当前时间太近，或超出平台允许的预约范围，请调整发布时间后重新执行任务" +
      "（错误码：DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_DISABLED）",
  );
});

test("explains a disabled Douyin scheduled publish date", () => {
  assert.equal(
    formatAutomationErrorReport("DOUYIN_DRAMA_SCHEDULED_PUBLISH_DATE_DISABLED: 2026-10-03"),
    "平台当前不允许选择定时发布日期“2026-10-03”。抖音要求发布时间至少晚于当前时间 72 小时，" +
      "系统会将过近日期按整天顺延后重试（错误码：DOUYIN_DRAMA_SCHEDULED_PUBLISH_DATE_DISABLED）",
  );
});
