import type { Page } from "playwright";
import { captureAutomationFailureDiagnostics, formatAutomationErrorReport } from "@dramabridge/automation-logging";
import { claimNextTaobaoDramaTaskApi, TaobaoApiBusinessError } from "../api/task.js";
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
import { executeTaobaoClaimedTask, flushPendingTaobaoReports, recoverTaobaoExecutions } from "./task-execution.js";
import { runTaobaoPublishTask } from "../automation/publish-runner.js";

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function classifyTaobaoDramaFailStage(error: unknown): TaobaoDramaTaskFailStage {
  const message = errorMessage(error);
  if (/TAOBAO_DRAMA_CONTENT_TAG_/.test(message)) return "FILL_FORM";
  if (/LOGIN|登录|校验/i.test(message)) return "LOGIN";
  if (/FIELD|TEXTBOX|SELECT|COLLECTION_FORM|CONTENT_TAG|字段|表单|内容标签/i.test(message)) return "FILL_FORM";
  // The task API has no DOWNLOAD stage. Treat source downloads as file preparation/upload failures.
  if (/网盘|下载|DOWNLOAD/i.test(message)) return "UPLOAD_FILE";
  if (/UPLOAD|FILE|VIDEO|COVER|素材|封面|视频/i.test(message)) return "UPLOAD_FILE";
  if (/SUBMIT|PUBLISH|CREATE_RESULT|发布|创建结果/i.test(message)) return "SUBMIT";
  if (/RESULT|RECOGNIZED|识别/i.test(message)) return "RECOGNIZE_RESULT";
  return "OTHER";
}

async function runTask(page: Page, task: ClaimedTaobaoDramaTask, options: TaobaoDramaRuntimeOptions, setLastTask: (task: TaobaoDramaRuntimeStatus["lastTask"]) => void) {
  setLastTask({ accountTaskId: task.accountTaskId, originalTitle: task.originalTitle, status: "running", updatedAt: new Date().toISOString() });
  const store = options.executionStore!;
  const result = await executeTaobaoClaimedTask({
    store, task,
    publish: (checkpoint) => runWithLogContext(
      { taskId: String(task.accountTaskId), title: task.originalTitle },
      () => runTaobaoPublishTask(page, page.context(), task, { ...options, onSubmitCheckpoint: checkpoint }),
    ),
    resultJson: () => ({ activeUrl: page.url(), accountId: task.accountId, accountName: task.accountName }),
    async failure(error) {
      const message = formatAutomationErrorReport(error, { fallbackMessage: "淘宝短剧任务提交失败，未获取到具体错误原因" });
      const stage = classifyTaobaoDramaFailStage(error);
      const diagnostics = await captureAutomationFailureDiagnostics({
        platform: "taobao-drama", error, page, logFilePath: options.logFilePath, stage,
        task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
      });
      errorLog(options, message, { error, failStage: stage, taskId: task.accountTaskId, title: task.originalTitle,
        activeUrl: page.url(), diagnosticDir: diagnostics?.directory, diagnosticRecord: diagnostics?.recordFile,
        screenshotFile: diagnostics?.screenshotFile });
      return { stage, message };
    },
  });
  await flushPendingTaobaoReports({ store, apiBaseUrl: options.apiConfig!.baseUrl, accountId: options.accountId!,
    onError: (message) => errorLog(options, `[taobao-drama] ${message}`) });
  const record = store.get(result.record.id)!;
  const review = record.phase === "review-required" || record.phase === "report-blocked";
  const succeeded = record.report?.success === true;
  setLastTask({ accountTaskId: task.accountTaskId, originalTitle: task.originalTitle,
    status: review ? "review-required" : record.phase === "report-pending" ? "report-pending" : succeeded ? "succeeded" : "failed",
    errorMessage: record.errorMessage, updatedAt: record.updatedAt });
  if (review) errorLog(options, `[taobao-drama] ${record.errorMessage}`);
  if (succeeded && record.phase === "reported") {
    await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(result.value).catch((error) =>
      errorLog(options, `[taobao-drama] 任务成功，但百度网盘剧目目录清理失败：${errorMessage(error)}`));
  }
  return review ? "retain" : succeeded ? "success" : "failure";
}

export async function startTaobaoDramaRuntime(options: TaobaoDramaRuntimeOptions = {}): Promise<TaobaoDramaRuntime> {
  if (!options.userDataDir) throw new Error("TAOBAO_DRAMA_USER_DATA_DIR_REQUIRED");
  if (!options.apiConfig?.baseUrl.trim()) throw new Error("TAOBAO_DRAMA_API_BASE_URL_REQUIRED");
  if (!options.accountId?.trim()) throw new Error("TAOBAO_DRAMA_ACCOUNT_ID_REQUIRED");
  if (!options.workerId?.trim()) throw new Error("TAOBAO_DRAMA_WORKER_ID_REQUIRED");
  if (!options.executionStore) throw new Error("TAOBAO_DRAMA_EXECUTION_STORE_REQUIRED");
  const executionStore = options.executionStore;
  recoverTaobaoExecutions(executionStore, options.apiConfig.baseUrl, options.accountId);
  await cleanupOldLogFiles(options);
  const account: TaobaoDramaAccount = {
    id: 0, accountId: options.accountId, accountName: options.accountName?.trim() || options.accountId,
  };
  let running = true;
  let claimPausedReason: string | undefined;
  let lastTask: TaobaoDramaRuntimeStatus["lastTask"];
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const context = await launchTaobaoBrowserContext(options.userDataDir, options);
  const homePage = context.pages()[0] ?? await context.newPage();
  context.on("close", () => { running = false; wake?.(); });
  try {
    await waitForTaobaoPage(homePage, "home", options);
    await saveTaobaoCredentialState(context, options).catch(() => undefined);
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }

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
        await flushPendingTaobaoReports({ store: executionStore, apiBaseUrl: options.apiConfig!.baseUrl, accountId: account.accountId,
          onError: (message) => errorLog(options, `[taobao-drama] ${message}`) });
        if (claimPausedReason) { await waitPoll(); continue; }
        const task = await claimNextTaobaoDramaTaskApi({ apiBaseUrl: options.apiConfig!.baseUrl, account,
          workerId: options.workerId!, executionStore, runtimeOptions: options });
        if (task) {
          const taskPage = await context.newPage();
          log(options, "[taobao-drama] 已领取任务，在独立任务标签页执行", { accountTaskId: task.accountTaskId });
          const outcome = await runTask(taskPage, task, options, (value) => { lastTask = value; });
          if (!taskPage.isClosed() && (outcome === "success" || (outcome === "failure" && options.closeFailedTaskPages === true))) {
            await taskPage.close().catch(() => undefined);
          } else if (!taskPage.isClosed()) {
            log(options, "[taobao-drama] 已保留失败任务页面供排查", { accountTaskId: task.accountTaskId, activeUrl: taskPage.url() });
          }
        } else {
          log(options, "[taobao-drama] 暂无可领取任务");
        }
      } catch (error) {
        if (error instanceof TaobaoApiBusinessError) {
          claimPausedReason = `后台拒绝领取，已暂停领取，请处理后重启服务：${error.businessMessage}`;
        }
        errorLog(options, `[taobao-drama] ${claimPausedReason || `任务轮询失败：${errorMessage(error)}`}`);
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
        userDataDir: options.userDataDir!, accountProfileName: options.accountProfileName, workerId: options.workerId, claimPausedReason, lastTask,
      };
    },
    async stop() {
      running = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      wake?.();
      await saveTaobaoCredentialState(context, options).catch(() => undefined);
      await context.close(); await loop.catch(() => undefined);
      recoverTaobaoExecutions(executionStore, options.apiConfig!.baseUrl, account.accountId);
      log(options, "[taobao-drama] 运行时已停止");
    },
  };
}
