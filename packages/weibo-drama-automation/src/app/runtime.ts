import type { Page } from "playwright";
import { captureAutomationFailureDiagnostics } from "@dramabridge/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import {
  claimNextWeiboDramaTaskApi,
  reportWeiboDramaTaskErrorApi,
  reportWeiboDramaTaskSuccessApi,
} from "../api/task.js";
import {
  isWeiboLoginPopup,
  launchWeiboDramaBrowserContext,
  prepareWeiboMainPage,
  saveCredentialState,
  waitForLoginIfNeeded,
  weiboSessionReady,
} from "../automation/browser-session.js";
import { openWeiboDramaAddPage, runWeiboDramaPublishTask } from "../automation/publish-runner.js";
import { WEIBO_DRAMA_ADD_URL, WEIBO_DRAMA_LOGIN_URL } from "../shared/constants.js";
import { validateWeiboDramaLocalEpisodeVideos } from "../shared/local-episode-videos.js";
import { cleanupOldLogFiles, configureWeiboDramaLogger, errorLog, log } from "../shared/logger.js";
import { prepareWeiboMaterials } from "../shared/materials.js";
import { withWeiboProgress } from "../shared/progress.js";
import type {
  ClaimedWeiboDramaTask,
  WeiboDramaRuntime,
  WeiboDramaRuntimeOptions,
  WeiboDramaRuntimeStatus,
} from "../shared/types.js";

async function retryReport(action: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await action();
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}
async function downloadResource(task: ClaimedWeiboDramaTask, options: WeiboDramaRuntimeOptions) {
  if (!task.playlet.baiduPanResourceLink) return;
  if (!options.ensureBaiduNetdiskResource || !options.localEpisodeVideoRoot)
    throw new Error("WEIBO_DRAMA_RESOURCE_DOWNLOADER_REQUIRED");
  for (let attempt = 0; ; attempt++) {
    try {
      return await options.ensureBaiduNetdiskResource({
        shareText: task.playlet.baiduPanResourceLink,
        resourceName: task.originalTitle,
        localEpisodeVideoRoot: options.localEpisodeVideoRoot,
        episodeCount: task.playlet.episodeCount,
        requiredPosterImages: 1,
        // Probe the share even when episodes/poster are cached. Optional proofs
        // must be discovered and downloaded before deciding to use the cover fallback.
        forceAssetDownload: true,
        requireAllDiscoveredAssets: true,
        mergeOwnershipMaterials: false,
        posterFallback: { title: task.playlet.title, summary: task.playlet.summary },
      });
    } catch (error) {
      if (
        isNonRetryableBaiduNetdiskResourceError(error) ||
        attempt >= (options.baiduNetdiskDownloadRetryAttempts ?? 3)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

export async function startWeiboDramaRuntime(
  inputOptions: WeiboDramaRuntimeOptions = {},
): Promise<WeiboDramaRuntime> {
  const abort = new AbortController();
  const options = { ...inputOptions, signal: abort.signal };
  if (!options.userDataDir) throw new Error("WEIBO_DRAMA_USER_DATA_DIR_REQUIRED");
  configureWeiboDramaLogger(options);
  await cleanupOldLogFiles(options);
  const context = await launchWeiboDramaBrowserContext(options.userDataDir, options);
  const main = await prepareWeiboMainPage(context);
  let running = true;
  let loginState: WeiboDramaRuntimeStatus["loginState"] = "unknown";
  let lastTask: WeiboDramaRuntimeStatus["lastTask"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  context.on("close", () => {
    running = false;
    abort.abort();
    wake?.();
  });
  const loop = (async () => {
    loginState = "login-required";
    await openWeiboDramaAddPage(main, context, options);
    loginState = "logged-in";
    while (running && !main.isClosed()) {
      let taskPage: Page | undefined;
      let task: ClaimedWeiboDramaTask | null = null;
      let published = false;
      let succeeded = false;
      try {
        loginState = (await weiboSessionReady(
          main,
          options.weiboAccountId,
          options.weiboAccountName,
        ))
          ? "logged-in"
          : "login-required";
        await waitForLoginIfNeeded(main, context, options);
        loginState = "logged-in";
        log(
          options,
          options.canClaimTask?.() === false
            ? "[weibo-drama] 账号已暂停领取任务"
            : "[weibo-drama] 开始查询后台待领取任务",
        );
        task =
          options.canClaimTask?.() === false
            ? null
            : await claimNextWeiboDramaTaskApi({
                apiConfig: options.apiConfig,
                runtimeOptions: options,
              });
        if (!task && options.canClaimTask?.() !== false)
          log(options, "[weibo-drama] 当前账号暂无可领取任务");
        if (task && !abort.signal.aborted) {
          lastTask = {
            accountTaskId: task.accountTaskId,
            originalTitle: task.originalTitle,
            status: "running",
            updatedAt: new Date().toISOString(),
          };
          const taskFields = {
            accountTaskId: task.accountTaskId,
            originalTitle: task.originalTitle,
          };
          const resource = await withWeiboProgress(
            options,
            "检查及下载网盘素材",
            () => downloadResource(task!, options),
            taskFields,
          );
          await withWeiboProgress(
            options,
            "校验本地剧集",
            () => validateWeiboDramaLocalEpisodeVideos(task!, options),
            taskFields,
          );
          await withWeiboProgress(
            options,
            "准备封面和权属文件",
            () => prepareWeiboMaterials(task!, options),
            taskFields,
          );
          if (abort.signal.aborted) break;
          taskPage = await context.newPage();
          const result = await runWeiboDramaPublishTask(taskPage, context, task, options);
          published = true;
          await retryReport(() =>
            reportWeiboDramaTaskSuccessApi({
              apiConfig: options.apiConfig,
              accountTaskId: task!.accountTaskId,
              workerId: task!.workerId,
              attemptCount: task!.attemptCount,
              externalId: result.albumId,
              platformDramaId: result.albumId,
              resultJson: result,
            }),
          );
          succeeded = true;
          lastTask = { ...lastTask, status: "succeeded", updatedAt: new Date().toISOString() };
          if (resource)
            await options
              .cleanupBaiduNetdiskResourceAfterTaskSuccess?.(resource)
              .catch((error) => errorLog(options, `微博任务成功，网盘清理失败：${String(error)}`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errorLog(options, message);
        if (task && !abort.signal.aborted) {
          lastTask = {
            accountTaskId: task.accountTaskId,
            originalTitle: task.originalTitle,
            status: "failed",
            errorMessage: message,
            updatedAt: new Date().toISOString(),
          };
          const failStage = /LOGIN/.test(message)
            ? "LOGIN"
            : /UPLOAD|FILE|COVER|素材|权属/.test(message)
              ? "UPLOAD_FILE"
              : /RECOGNIZE/.test(message)
                ? "RECOGNIZE_RESULT"
                : /SUBMIT/.test(message)
                  ? "SUBMIT"
                  : "FILL_FORM";
          await captureAutomationFailureDiagnostics({
            platform: "weibo-drama",
            error,
            page: taskPage ?? main,
            stage: failStage,
            logFilePath: options.logFilePath,
            task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
          }).catch(() => undefined);
          if (!published)
            await retryReport(() =>
              reportWeiboDramaTaskErrorApi({
                apiConfig: options.apiConfig,
                accountTaskId: task!.accountTaskId,
                workerId: task!.workerId,
                attemptCount: task!.attemptCount,
                failStage,
                errorMessage: message,
              }),
            ).catch((error) => errorLog(options, `微博失败回调失败：${String(error)}`));
        }
      } finally {
        if (taskPage && (succeeded || options.failedTaskPageRetention === "close"))
          await taskPage.close().catch(() => undefined);
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000));
      });
      clearTimeout(timer);
      wake = undefined;
    }
  })().catch((error) => {
    errorLog(options, String(error));
    running = false;
  });
  log(options, "[weibo-drama] runtime started");
  return {
    getStatus: () => ({
      platform: "weibo-drama",
      running,
      loginState:
        loginState !== "logged-in" && context.pages().some((page) => isWeiboLoginPopup(page.url()))
          ? "login-required"
          : loginState,
      activeUrl: main.url(),
      addUrl: WEIBO_DRAMA_ADD_URL,
      loginUrl: WEIBO_DRAMA_LOGIN_URL,
      userDataDir: options.userDataDir!,
      accountProfileName: options.accountProfileName,
      accountDir: options.accountDir,
      credentialStatePath: options.credentialStatePath,
      assetDownloadDir: options.assetDownloadDir,
      logFilePath: options.logFilePath,
      lastTask,
    }),
    stop: async () => {
      running = false;
      abort.abort();
      clearTimeout(timer);
      wake?.();
      await saveCredentialState(context, options).catch(() => undefined);
      await context.close();
      await loop;
    },
  };
}
