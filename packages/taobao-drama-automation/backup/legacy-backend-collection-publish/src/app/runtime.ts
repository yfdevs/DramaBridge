import type { BrowserContext, Page } from "playwright";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@dramabridge/automation-logging";
import {
  claimNextTaobaoDramaTaskApi,
  reportTaobaoAccountTaskApi,
} from "../api/task.js";
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failStage(error: unknown): TaobaoDramaTaskFailStage {
  const message = errorMessage(error);
  if (/LOGIN|登录|校验/i.test(message)) return "LOGIN";
  if (/UPLOAD|FILE|VIDEO|COVER|素材|封面|视频|网盘/i.test(message)) return "UPLOAD_FILE";
  if (/SUBMIT|PUBLISH|CREATE_RESULT|发布|创建结果/i.test(message)) return "SUBMIT";
  if (/RESULT|RECOGNIZED|识别/i.test(message)) return "RECOGNIZE_RESULT";
  if (/FORM|FIELD|SELECT|TEXTBOX|表单|字段/i.test(message)) return "FILL_FORM";
  return "OTHER";
}

async function reportWithRetry(
  options: TaobaoDramaRuntimeOptions,
  report: Parameters<typeof reportTaobaoAccountTaskApi>[0]["report"],
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await reportTaobaoAccountTaskApi({
        apiBaseUrl: options.apiConfig!.baseUrl,
        report,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

async function runTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedTaobaoDramaTask,
  options: TaobaoDramaRuntimeOptions,
  setLastTask: (task: TaobaoDramaRuntimeStatus["lastTask"]) => void,
) {
  setLastTask({
    accountTaskId: task.accountTaskId,
    originalTitle: task.originalTitle,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  try {
    await runWithLogContext(
      { accountId: task.accountId, accountName: task.accountName, accountTaskId: task.accountTaskId },
      () => runTaobaoPublishTask(page, context, task, options),
    );
    await reportWithRetry(options, {
      taskId: task.accountTaskId,
      success: true,
      resultJson: { activeUrl: page.url(), accountId: task.accountId },
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = formatAutomationErrorReport(error, {
      fallbackMessage: "淘宝短剧任务提交失败，未获取到具体错误原因",
    });
    const stage = failStage(error);
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "taobao-drama",
      error,
      page,
      logFilePath: options.logFilePath,
      stage,
      task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
    });
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "failed",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
    await reportWithRetry(options, {
      taskId: task.accountTaskId,
      success: false,
      failStage: stage,
      errorMessage: message,
      resultJson: { activeUrl: page.url(), accountId: task.accountId },
    }).catch((reportError) => {
      errorLog(options, `[taobao-drama] 失败任务回写异常：${errorMessage(reportError)}`);
    });
    errorLog(options, `[taobao-drama] 失败诊断目录：${diagnostics?.directory ?? "不可用"}`);
    throw error;
  }
}

export async function startTaobaoDramaRuntime(
  options: TaobaoDramaRuntimeOptions = {},
): Promise<TaobaoDramaRuntime> {
  if (!options.userDataDir) throw new Error("TAOBAO_DRAMA_USER_DATA_DIR_REQUIRED");
  if (!options.apiConfig?.baseUrl.trim()) throw new Error("TAOBAO_DRAMA_API_BASE_URL_REQUIRED");
  if (!options.accountId?.trim()) throw new Error("TAOBAO_DRAMA_ACCOUNT_ID_REQUIRED");
  await cleanupOldLogFiles(options);

  const account: TaobaoDramaAccount = {
    id: 0,
    accountId: options.accountId,
    accountName: options.accountName?.trim() || options.accountId,
  };
  let running = true;
  let lastTask: TaobaoDramaRuntimeStatus["lastTask"];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const context = await launchTaobaoBrowserContext(options.userDataDir, options);
  const page = context.pages()[0] ?? await context.newPage();
  context.on("close", () => {
    running = false;
    wake?.();
  });

  const waitPoll = () => new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000));
  }).finally(() => {
    if (timer) clearTimeout(timer);
    timer = null;
    wake = null;
  });

  const loop = (async () => {
    await waitForTaobaoPage(page, "collection", options);
    await saveTaobaoCredentialState(context, options).catch(() => undefined);
    while (running && !page.isClosed()) {
      try {
        const task = await claimNextTaobaoDramaTaskApi({
          apiBaseUrl: options.apiConfig!.baseUrl,
          account,
          runtimeOptions: options,
        });
        if (!task) {
          log(options, "[taobao-drama] 暂无可领取任务");
        } else {
          const taskPage = await context.newPage();
          let failed = false;
          try {
            await runTask(taskPage, context, task, options, (value) => { lastTask = value; });
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            if (!taskPage.isClosed() && (!failed || options.closeFailedTaskPages === true)) {
              await taskPage.close().catch(() => undefined);
            } else if (!taskPage.isClosed()) {
              log(options, "[taobao-drama] 已保留失败任务页面供排查", {
                accountTaskId: task.accountTaskId,
                activeUrl: taskPage.url(),
              });
            }
          }
        }
      } catch (error) {
        errorLog(options, `[taobao-drama] 任务轮询失败：${errorMessage(error)}`);
      }
      if (running && !page.isClosed()) await waitPoll();
    }
  })();
  void loop.catch((error) => {
    running = false;
    errorLog(options, `[taobao-drama] 账号任务循环已停止：${errorMessage(error)}`);
  });

  return {
    getStatus() {
      const openPages = context.pages().filter((item) => !item.isClosed());
      const activePage = openPages[openPages.length - 1] ?? page;
      return {
        platform: TAOBAO_DRAMA_PLATFORM,
        running,
        loginState: taobaoLoginStateFromUrl(activePage.url()),
        activeUrl: activePage.url(),
        collectionCreateUrl: TAOBAO_DRAMA_COLLECTION_CREATE_URL,
        batchPublishUrl: TAOBAO_DRAMA_BATCH_PUBLISH_URL,
        loginUrl: TAOBAO_DRAMA_LOGIN_URL,
        userDataDir: options.userDataDir!,
        accountProfileName: options.accountProfileName,
        lastTask,
      };
    },
    async stop() {
      running = false;
      wake?.();
      await saveTaobaoCredentialState(context, options).catch(() => undefined);
      await context.close();
      await loop.catch(() => undefined);
      log(options, "[taobao-drama] 运行时已停止");
    },
  };
}
