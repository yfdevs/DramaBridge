import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@drama/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@drama/drama-media-assets";
import type { Page } from "playwright";
import {
  claimNextBaiduDramaTaskApi,
  reportBaiduDramaTaskErrorApi,
  reportBaiduDramaTaskSuccessApi,
} from "../api/task.js";
import {
  baiduDramaLoginStateFromUrl,
  ensureBaiduDramaCreatePage,
  launchBaiduDramaBrowserContext,
  openBaiduDramaCreatePage,
  waitForBaiduDramaLogin,
} from "../automation/browser-session.js";
import { runBaiduDramaPublishTask } from "../automation/publish-runner.js";
import { BAIDU_DRAMA_CREATE_URL, BAIDU_DRAMA_LOGIN_URL } from "../shared/constants.js";
import {
  cleanupOldBaiduDramaLogFiles,
  errorLog,
  flushBaiduDramaLogs,
  log,
  warn,
} from "../shared/logger.js";
import {
  baiduDramaLocalRoot,
  baiduDramaResourceName,
  prepareBaiduDramaResources,
} from "../shared/resources.js";
import type {
  BaiduDramaRuntime,
  BaiduDramaRuntimeOptions,
  BaiduDramaRuntimeStatus,
  BaiduDramaTaskFailStage,
  ClaimedBaiduDramaTask,
} from "../shared/types.js";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isBaiduInformationConfirmNotClosedError(error: unknown) {
  return errorMessage(error).includes("BAIDU_DRAMA_INFORMATION_CONFIRM_NOT_CLOSED");
}

export function isBaiduCoverSlotNotReadyError(error: unknown) {
  return /BAIDU_DRAMA_COVER_SLOT_(?:NOT_READY|LOST)/.test(errorMessage(error));
}

export function isBaiduDropdownOptionNotFoundError(error: unknown) {
  return errorMessage(error).includes("BAIDU_DRAMA_DROPDOWN_OPTION_NOT_FOUND");
}

async function runPublishTaskWithPageRefreshRetry(
  page: Page,
  task: ClaimedBaiduDramaTask,
  options: BaiduDramaRuntimeOptions,
) {
  try {
    await runBaiduDramaPublishTask(page, task, options);
  } catch (error) {
    const informationConfirmNotClosed = isBaiduInformationConfirmNotClosedError(error);
    const coverSlotNotReady = isBaiduCoverSlotNotReadyError(error);
    const dropdownOptionNotFound = isBaiduDropdownOptionNotFoundError(error);
    if (
      (!informationConfirmNotClosed && !coverSlotNotReady && !dropdownOptionNotFound)
      || page.isClosed()
    ) throw error;

    const retryReason = coverSlotNotReady
      ? "cover-slot-not-ready"
      : dropdownOptionNotFound
        ? "dropdown-option-not-found"
        : "information-confirm-not-closed";

    warn(
      options,
      coverSlotNotReady
        ? "[baidu-drama] 封面上传后未回填，刷新任务页面并从头重填一次。"
        : dropdownOptionNotFound
          ? "[baidu-drama] 页面下拉选项未加载，刷新任务页面并从头重填一次。"
        : "[baidu-drama] 短剧信息确认弹窗未关闭，刷新任务页面并从头重试一次。",
      {
        accountTaskId: task.accountTaskId,
        error,
        retryReason,
      },
      "task",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await runBaiduDramaPublishTask(page, task, options);
  }
}

function failStage(error: unknown): BaiduDramaTaskFailStage {
  const message = errorMessage(error);
  if (/LOGIN/i.test(message)) return "LOGIN";
  if (/FILE|UPLOAD|VIDEO|COVER|POSTER|文件|上传|视频|封面|海报/i.test(message))
    return "UPLOAD_FILE";
  if (/FORM|FIELD|LOCATOR|STRICT MODE|SELECT|OPTION|表单|字段|填写|选择/i.test(message)) {
    return "FILL_FORM";
  }
  if (/SUBMIT|CAPTCHA|安全验证|提交/i.test(message)) return "SUBMIT";
  return "OTHER";
}

async function ensureNetdiskResource(
  task: ClaimedBaiduDramaTask,
  options: BaiduDramaRuntimeOptions,
) {
  const shareText = task.playlet.baiduPanResourceLink?.trim();
  if (!shareText) return;
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘链接，但百度短剧运行时未接入网盘下载能力");
  }
  const maxAttempts = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await options.ensureBaiduNetdiskResource({
        shareText,
        resourceName: baiduDramaResourceName(task),
        localEpisodeVideoRoot: baiduDramaLocalRoot(options),
        episodeCount: task.playlet.episodeCount,
        requiredPosterImages: 1,
        posterFallback: {
          title: task.playlet.title,
          summary: task.playlet.summary,
        },
      });
      return;
    } catch (error) {
      lastError = error;
      if (isNonRetryableBaiduNetdiskResourceError(error) || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

async function runTask(
  basePage: Page,
  task: ClaimedBaiduDramaTask,
  options: BaiduDramaRuntimeOptions,
  setLastTask: (lastTask: NonNullable<BaiduDramaRuntimeStatus["lastTask"]>) => void,
) {
  log(
    options,
    `[baidu-drama] 任务开始：taskId=${task.accountTaskId}，剧名=${task.originalTitle}`,
    { accountTaskId: task.accountTaskId, title: task.originalTitle },
    "task",
  );
  setLastTask({
    accountTaskId: task.accountTaskId,
    originalTitle: task.originalTitle,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  const taskPage = await basePage.context().newPage();
  try {
    log(
      options,
      "[baidu-drama] 任务资源准备开始：检查百度网盘与本地剧集、封面文件。",
      { accountTaskId: task.accountTaskId },
      "task",
    );
    await ensureNetdiskResource(task, options);
    await prepareBaiduDramaResources(task, options);
    log(
      options,
      `[baidu-drama] 任务资源准备完成：横屏封面=${task.playlet.localLandscapeCoverFile ?? "未找到"}，` +
        `竖屏封面=${task.playlet.localPortraitCoverFile ?? "未找到"}`,
      {
        accountTaskId: task.accountTaskId,
        landscapeCoverFile: task.playlet.localLandscapeCoverFile,
        portraitCoverFile: task.playlet.localPortraitCoverFile,
      },
      "task",
    );
    await runPublishTaskWithPageRefreshRetry(taskPage, task, options);
    await reportBaiduDramaTaskSuccessApi({
      runtimeOptions: options,
      apiConfig: options.apiConfig,
      accountTaskId: task.accountTaskId,
      resultJson: { message: "提交成功" },
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
    log(
      options,
      `[baidu-drama] 任务成功：taskId=${task.accountTaskId}，剧名=${task.originalTitle}`,
      { accountTaskId: task.accountTaskId, title: task.originalTitle },
      "task",
    );
  } catch (error) {
    const message = formatAutomationErrorReport(error, {
      fallbackMessage: "百度任务提交失败，未获取到具体错误原因",
    });
    const stage = failStage(error);
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "baidu-drama",
      error,
      page: taskPage,
      logFilePath: options.logFilePath,
      stage,
      task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
    });
    await reportBaiduDramaTaskErrorApi({
      runtimeOptions: options,
      apiConfig: options.apiConfig,
      accountTaskId: task.accountTaskId,
      failStage: stage,
      errorMessage: message,
      resultJson: {},
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "failed",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
    errorLog(
      options,
      `[baidu-drama] 任务失败：taskId=${task.accountTaskId}，阶段=${stage}，` +
        `剧名=${task.originalTitle}，错误=${message}`,
      {
        accountTaskId: task.accountTaskId,
        title: task.originalTitle,
        failStage: stage,
        diagnosticDir: diagnostics?.directory,
        error,
      },
      "task",
    );
  } finally {
    if (!taskPage.isClosed()) await taskPage.close().catch(() => undefined);
  }
}

export async function startBaiduDramaRuntime(
  options: BaiduDramaRuntimeOptions = {},
): Promise<BaiduDramaRuntime> {
  const userDataDir =
    options.userDataDir ??
    path.resolve(process.cwd(), ".drama-runs/baidu-drama/auth/chromium-profile");
  await cleanupOldBaiduDramaLogFiles(options).catch(() => undefined);
  log(
    options,
    `[baidu-drama] 运行时启动：userDataDir=${userDataDir}，logFile=${options.logFilePath ?? "未配置"}`,
    { userDataDir, logFilePath: options.logFilePath },
  );
  await mkdir(userDataDir, { recursive: true });
  const context = await launchBaiduDramaBrowserContext(userDataDir, options);
  const page = context.pages()[0] ?? (await context.newPage());
  let running = true;
  let lastTask: BaiduDramaRuntimeStatus["lastTask"];

  try {
    await openBaiduDramaCreatePage(page);
    await waitForBaiduDramaLogin(page, context, options);
    await ensureBaiduDramaCreatePage(page, options);
  } catch (error) {
    errorLog(options, `[baidu-drama] 运行时启动失败：${errorMessage(error)}`, { error });
    await context.close().catch(() => undefined);
    await flushBaiduDramaLogs(options);
    throw error;
  }

  const pollLoop = async () => {
    while (running) {
      try {
        const task = await claimNextBaiduDramaTaskApi({
          runtimeOptions: options,
          apiConfig: options.apiConfig,
        });
        if (task) {
          await runTask(page, task, options, (value) => {
            lastTask = value;
          });
          continue;
        }
      } catch (error) {
        warn(options, `[baidu-drama] 任务轮询失败：${errorMessage(error)}`, { error }, "polling");
      }
      if (!running) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000)),
      );
    }
  };
  void pollLoop();

  return {
    getStatus() {
      return {
        platform: "baidu-drama",
        running,
        loginState: baiduDramaLoginStateFromUrl(page.url()),
        activeUrl: page.url(),
        createUrl: BAIDU_DRAMA_CREATE_URL,
        loginUrl: BAIDU_DRAMA_LOGIN_URL,
        userDataDir,
        lastTask,
      };
    },
    async stop() {
      running = false;
      log(options, "[baidu-drama] 运行时停止。", undefined, "runtime");
      await context.close().catch(() => undefined);
      await flushBaiduDramaLogs(options);
    },
  };
}
