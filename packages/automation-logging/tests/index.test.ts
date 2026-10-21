import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAutomationLogger, isBrowserClosedError } from "../src/index.js";

test("识别用户关闭 Playwright 浏览器产生的中断错误", () => {
  assert.equal(
    isBrowserClosedError(
      new Error("page.waitForTimeout: Target page, context or browser has been closed"),
    ),
    true,
  );
  assert.equal(isBrowserClosedError("browserContext.newPage: Target closed"), true);
  assert.equal(isBrowserClosedError(new Error("美团页面或浏览器已关闭，无法继续执行页面操作")), true);
  assert.equal(isBrowserClosedError(new Error("locator.click: Timeout 15000ms exceeded")), false);
});

test("平台日志独立写入并统一格式", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "automation-logging-"));
  try {
    const qqFile = path.join(testDir, "qq", "app-2026-08-28.json");
    const kuaishouFile = path.join(testDir, "kuaishou", "app-2026-08-28.json");
    const qqLogger = createAutomationLogger({
      platform: "qq-drama",
      scope: "task",
      logFilePath: qqFile,
      console: false,
    });
    const kuaishouLogger = createAutomationLogger({
      platform: "kuaishou-drama",
      scope: "upload",
      logFilePath: kuaishouFile,
      console: false,
    });

    qqLogger.info("[qq-drama] claimed task: 隔离测试", { taskId: 101, apiToken: "secret-value" });
    kuaishouLogger.info("[kuaishou-drama] video upload finished", { fileCount: 3 });
    await Promise.all([qqLogger.flush(), kuaishouLogger.flush()]);

    const qqText = await readFile(qqFile, "utf8");
    const kuaishouText = await readFile(kuaishouFile, "utf8");
    const qqEntry = JSON.parse(qqText.trim());
    const kuaishouEntry = JSON.parse(kuaishouText.trim());

    assert.equal(qqEntry.platform, "qq-drama");
    assert.equal(qqEntry.scope, "task");
    assert.equal(qqEntry.message, "claimed task: 隔离测试");
    assert.equal(qqEntry.details.apiToken, "[REDACTED]");
    assert.equal(kuaishouEntry.platform, "kuaishou-drama");
    assert.equal(kuaishouEntry.scope, "upload");
    assert.deepEqual(await readdir(path.join(testDir, "qq")), ["app-2026-08-28.json"]);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("日志回调异常不影响文件写入", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "automation-logging-"));
  try {
    const logFile = path.join(testDir, "app-2026-08-28.json");
    const logger = createAutomationLogger({
      platform: "wechat-drama",
      scope: "runtime",
      logFilePath: logFile,
      console: false,
      onEntry: () => {
        throw new Error("sink unavailable");
      },
    });

    assert.doesNotThrow(() => logger.info("runtime stopped"));
    await logger.flush();
    const entry = JSON.parse((await readFile(logFile, "utf8")).trim());
    assert.equal(entry.message, "服务停止");
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("错误日志同时提供简短说明和可解析错误码", async () => {
  const testDir = await mkdtemp(path.join(tmpdir(), "automation-logging-error-"));
  try {
    const logFile = path.join(testDir, "logs", "app-2026-08-28.json");
    const logger = createAutomationLogger({
      platform: "douyin-drama",
      scope: "upload",
      logFilePath: logFile,
      console: false,
    });

    logger.error("任务失败", {
      accountTaskId: 104,
      failStage: "UPLOAD",
      errorMessage: "DOUYIN_DRAMA_EPISODE_VIDEO_INVALID: episode=40; reason=duration-read-failed",
    });
    await logger.flush();

    const entry = JSON.parse((await readFile(logFile, "utf8")).trim());
    assert.equal(entry.message, "任务失败");
    assert.equal(entry.error.code, "DOUYIN_DRAMA_EPISODE_VIDEO_INVALID");
    assert.deepEqual(entry.error.codes, ["DOUYIN_DRAMA_EPISODE_VIDEO_INVALID"]);
    assert.equal(entry.error.stage, "UPLOAD");
    assert.match(entry.error.summary, /无法读取视频时长/);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("通用冗长文案通过集中规则转换为短消息", () => {
  const entries: Array<{ message: string }> = [];
  const logger = createAutomationLogger({
    platform: "taobao-drama",
    scope: "runtime",
    console: false,
    onEntry: (entry) => entries.push(entry),
  });

  logger.info("运行时启动：userDataDir=D:\\profile，logFile=D:\\logs\\app.json", {
    userDataDir: "D:\\profile",
    logFilePath: "D:\\logs\\app.json",
  });
  logger.info("任务开始：taskId=104，剧名=测试剧", { taskId: 104, title: "测试剧" });

  assert.deepEqual(entries.map((entry) => entry.message), ["服务启动", "任务开始"]);
});
