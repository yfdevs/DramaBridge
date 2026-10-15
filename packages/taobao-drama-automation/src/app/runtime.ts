import type { Page } from "playwright";
import { captureAutomationFailureDiagnostics, formatAutomationErrorReport } from "@drama/automation-logging";
import { claimNextTaobaoDramaTaskApi, reportTaobaoAccountTaskApi } from "../api/task.js";
import {
  TAOBAO_DRAMA_BATCH_PUBLISH_URL,
  TAOBAO_DRAMA_COLLECTION_CREATE_URL,
  TAOBAO_DRAMA_LOGIN_URL,
  TAOBAO_DRAMA_PLATFORM,
} from "../shared/constants.js";
import { cleanupOldLogFiles, errorLog, log, runWithLogContext } from "../shared/logger.js";
import type {
  ClaimedTaobaoDramaTask,
  TaobaoDramaAccount,
  TaobaoDramaRuntime,
  TaobaoDramaRuntimeOptions,
  TaobaoDramaRuntimeStatus,
  TaobaoDramaTaskFailStage,
} from "../shared/types.js";
import {
  launchTaobaoBrowserContext,
  saveTaobaoCredentialState,
  taobaoLoginStateFromUrl,
  waitForTaobaoPage,
} from "../automation/browser-session.js";
import { runTaobaoPublishTask } from "../automation/publish-runner.js";

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

function failStage(error: unknown): TaobaoDramaTaskFailStage {
  const message = errorMessage(error);
  if (/LOGIN|登录|校验/i.test(message)) return "LOGIN";
  if (/FIELD|TEXTBOX|SELECT|COLLECTION_FORM|字段|表单/i.test(message)) return "FILL_FORM";
  if (/网盘|下载|DOWNLOAD/i.test(message)) return "DOWNLOAD";
  if (/UPLOAD|FILE|VIDEO|COVER|素材|封面|视频/i.test(message)) return "UPLOAD_FILE";
  if (/SUBMIT|PUBLISH|CREATE_RESULT|发布|创建结果/i.test(message)) return "SUBMIT";
  if (/RESULT|RECOGNIZED|识别/i.test(message)) return "RECOGNIZE_RESULT";
  return "OTHER";
}

async function reportWithRetry(options: TaobaoDramaRuntimeOptions, report: Parameters<typeof reportTaobaoAccountTaskApi>[0]["report"]) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await reportTaobaoAccountTaskApi({ apiBaseUrl: options.apiConfig!.baseUrl, report });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

async function runTask(page: Page, task: ClaimedTaobaoDramaTask, options: TaobaoDramaRuntimeOptions, setLastTask: (task: TaobaoDramaRuntimeStatus["lastTask"]) => void) {
  setLastTask({ accountTaskId: task.accountTaskId, originalTitle: task.originalTitle, status: "running", updatedAt: new Date().toISOString() });
  try {
    const baiduNetdiskResource = await runWithLogContext(
      { taskId: String(task.accountTaskId), title: task.originalTitle },
      () => runTaobaoPublishTask(page, page.context(), task, options),
    );
    await reportWithRetry(options, {
      taskId: task.accountTaskId, success: true,
      resultJson: { activeUrl: page.url(), accountId: task.accountId, accountName: task.accountName },
    });
    await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(baiduNetdiskResource).catch((error) =>
      errorLog(options, `[taobao-drama] 任务成功，但百度网盘剧目目录清理失败：${errorMessage(error)}`),
    );
    setLastTask({ accountTaskId: task.accountTaskId, originalTitle: task.originalTitle, status: "succeeded", updatedAt: new Date().toISOString() });
  } catch (error) {
    const message = formatAutomationErrorReport(error, { fallbackMessage: "淘宝短剧任务提交失败，未获取到具体错误原因" });
    const stage = failStage(error);
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "taobao-drama", error, page, logFilePath: options.logFilePath, stage,
      task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
    });
    setLastTask({ accountTaskId: task.accountTaskId, originalTitle: task.originalTitle, status: "failed", errorMessage: message, updatedAt: new Date().toISOString() });
    await reportWithRetry(options, {
      taskId: task.accountTaskId, success: false, failStage: stage, errorMessage: message,
      resultJson: { activeUrl: page.url(), accountId: task.accountId, accountName: task.accountName },
    }).catch((reportError) => errorLog(options, `[taobao-drama] 失败任务回写异常：${errorMessage(reportError)}`));
    errorLog(options, `[taobao-drama] 失败诊断目录：${diagnostics?.directory ?? "不可用"}`);
    return false;
  }
  return true;
}

export async function startTaobaoDramaRuntime(options: TaobaoDramaRuntimeOptions = {}): Promise<TaobaoDramaRuntime> {
  if (!options.userDataDir) throw new Error("TAOBAO_DRAMA_USER_DATA_DIR_REQUIRED");
  if (!options.apiConfig?.baseUrl.trim()) throw new Error("TAOBAO_DRAMA_API_BASE_URL_REQUIRED");
  if (!options.accountId?.trim()) throw new Error("TAOBAO_DRAMA_ACCOUNT_ID_REQUIRED");
  await cleanupOldLogFiles(options);
  const account: TaobaoDramaAccount = {
    id: 0, accountId: options.accountId, accountName: options.accountName?.trim() || options.accountId,
  };
  let running = true;
  let lastTask: TaobaoDramaRuntimeStatus["lastTask"];
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const context = await launchTaobaoBrowserContext(options.userDataDir, options);
  const homePage = context.pages()[0] ?? await context.newPage();
  context.on("close", () => { running = false; wake?.(); });
  await waitForTaobaoPage(homePage, "collection", options);
  await saveTaobaoCredentialState(context, options).catch(() => undefined);

  const waitPoll = () => new Promise<void>((resolve) => {
    wake = resolve;
    pollTimer = setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000));
  }).finally(() => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    wake = null;
  });

  const loop = (async () => {
    while (running && !homePage.isClosed()) {
      try {
        const task = await claimNextTaobaoDramaTaskApi({ apiBaseUrl: options.apiConfig!.baseUrl, account, runtimeOptions: options });
        if (task) {
          const taskPage = await context.newPage();
          const succeeded = await runTask(taskPage, task, options, (value) => { lastTask = value; });
          if (!taskPage.isClosed() && (succeeded || options.closeFailedTaskPages === true)) {
            await taskPage.close().catch(() => undefined);
          } else if (!taskPage.isClosed()) {
            log(options, "[taobao-drama] 已保留失败任务页面供排查", { accountTaskId: task.accountTaskId, activeUrl: taskPage.url() });
          }
        } else {
          log(options, "[taobao-drama] 暂无可领取任务");
        }
      } catch (error) {
        errorLog(options, `[taobao-drama] 任务轮询失败：${errorMessage(error)}`);
      }
      if (running && !homePage.isClosed()) await waitPoll();
    }
  })();
  void loop.catch((error) => { running = false; errorLog(options, `[taobao-drama] 账号任务循环已停止：${errorMessage(error)}`); });

  return {
    getStatus() {
      const pages = context.pages().filter((item) => !item.isClosed());
      const activePage = pages[pages.length - 1] ?? homePage;
      return {
        platform: TAOBAO_DRAMA_PLATFORM, running, loginState: taobaoLoginStateFromUrl(activePage.url()),
        activeUrl: activePage.url(), collectionCreateUrl: TAOBAO_DRAMA_COLLECTION_CREATE_URL,
        batchPublishUrl: TAOBAO_DRAMA_BATCH_PUBLISH_URL, loginUrl: TAOBAO_DRAMA_LOGIN_URL,
        userDataDir: options.userDataDir!, accountProfileName: options.accountProfileName, lastTask,
      };
    },
    async stop() {
      running = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      wake?.();
      await saveTaobaoCredentialState(context, options).catch(() => undefined);
      await context.close(); await loop.catch(() => undefined);
      log(options, "[taobao-drama] 运行时已停止");
    },
  };
}
