import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@dramabridge/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import type { Page } from "playwright";
import {
  claimNextDouyinDramaTaskApi,
  reportDouyinDramaTaskErrorApi,
  reportDouyinDramaTaskSuccessApi,
} from "../api/task.js";
import {
  douyinDramaLoginStateFromUrl,
  ensureDouyinDramaCreatePage,
  launchDouyinDramaBrowserContext,
  openDouyinDramaCreatePage,
  waitForDouyinDramaLogin,
} from "../automation/browser-session.js";
import { runDouyinDramaPublishTask } from "../automation/publish-runner.js";
import { DOUYIN_DRAMA_CREATE_URL, DOUYIN_DRAMA_LOGIN_URL } from "../shared/constants.js";
import {
  cleanupOldDouyinDramaLogFiles,
  errorLog,
  flushDouyinDramaLogs,
  log,
  warn,
} from "../shared/logger.js";
import {
  douyinDramaLocalRoot,
  douyinDramaResourceName,
  prepareDouyinDramaResources,
} from "../shared/resources.js";
import {
  collectDouyinNetdiskMetadataInputs,
  douyinTaskNeedsNetdiskMetadata,
  enrichDouyinTaskFromNetdisk,
} from "../shared/netdisk-metadata.js";
import type {
  ClaimedDouyinDramaTask,
  DouyinDramaRuntime,
  DouyinDramaRuntimeOptions,
  DouyinDramaRuntimeStatus,
  DouyinDramaTaskFailStage,
} from "../shared/types.js";

export const douyinNetdiskOwnershipDownloadRequirements = {
  minimumImages: 4,
} as const;

const defaultNetdiskStallTimeoutMs = 10 * 60_000;
const defaultNetdiskProgressLogIntervalMs = 30_000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function classifyDouyinDramaFailStage(error: unknown): DouyinDramaTaskFailStage {
  const message = errorMessage(error);
  if (/LOGIN/i.test(message)) return "LOGIN";
  if (/NETDISK|DOWNLOAD|网盘|下载/i.test(message)) return "UPLOAD_FILE";
  if (/FILE|UPLOAD|VIDEO|COVER|POSTER|MATERIAL|IMAGE|文件|上传|视频|封面|海报|头像|图片|素材|合同|承诺/i.test(message)) {
    return "UPLOAD_FILE";
  }
  if (/FORM|FIELD|LOCATOR|STRICT MODE|SELECT|OPTION|表单|字段|填写|选择/i.test(message)) {
    return "FILL_FORM";
  }
  if (/SUBMIT|提交/i.test(message)) return "SUBMIT";
  return "OTHER";
}

export async function ensureDouyinNetdiskResource(
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  signal?: AbortSignal,
) {
  const shareText = task.playlet.baiduPanResourceLink?.trim();
  if (!shareText) return;
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘链接，但抖音运行时未接入网盘下载能力");
  }
  const maxAttempts = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3) + 1;
  const ensureWithRetry = async (request: Parameters<NonNullable<
    DouyinDramaRuntimeOptions["ensureBaiduNetdiskResource"]
  >>[0]) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const attemptController = new AbortController();
      const stallTimeoutMs = Math.max(
        1,
        options.baiduNetdiskDownloadStallTimeoutMs ?? defaultNetdiskStallTimeoutMs,
      );
      const progressLogIntervalMs = Math.max(
        1,
        options.baiduNetdiskProgressLogIntervalMs ?? defaultNetdiskProgressLogIntervalMs,
      );
      const startedAt = Date.now();
      let lastProgressAt = startedAt;
      let stableEpisodeCount = 0;
      const forwardAbort = () => attemptController.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const heartbeat = setInterval(() => {
        const now = Date.now();
        const stalledMs = now - lastProgressAt;
        log(
          options,
          `[douyin-drama] 百度网盘资源仍在准备：attempt=${attempt}/${maxAttempts}，`
            + `已等待=${Math.round((now - startedAt) / 1_000)}秒，`
            + `已稳定=${stableEpisodeCount}/${task.playlet.episodeCount}集`,
          {
            accountTaskId: task.accountTaskId,
            attempt,
            maxAttempts,
            stableEpisodeCount,
            expectedEpisodeCount: task.playlet.episodeCount,
            stalledSeconds: Math.round(stalledMs / 1_000),
          },
          "download",
        );
        if (stalledMs >= stallTimeoutMs && !attemptController.signal.aborted) {
          attemptController.abort(new Error(
            `DOUYIN_DRAMA_NETDISK_DOWNLOAD_STALLED: `
              + `${Math.round(stalledMs / 1_000)}秒没有识别到新的完整剧集；`
              + `stable=${stableEpisodeCount}/${task.playlet.episodeCount}`,
          ));
        }
      }, progressLogIntervalMs);
      heartbeat.unref();
      log(
        options,
        `[douyin-drama] 开始准备百度网盘资源：attempt=${attempt}/${maxAttempts}，`
          + `无进度超时=${Math.round(stallTimeoutMs / 1_000)}秒`,
        {
          accountTaskId: task.accountTaskId,
          resourceName: request.resourceName,
          episodeCount: task.playlet.episodeCount,
          attempt,
          maxAttempts,
        },
        "download",
      );
      try {
        const resource = await options.ensureBaiduNetdiskResource!({
          ...request,
          signal: attemptController.signal,
          onStableEpisodeFiles: (files) => {
            const nextCount = files.length;
            if (nextCount > stableEpisodeCount) lastProgressAt = Date.now();
            stableEpisodeCount = Math.max(stableEpisodeCount, nextCount);
            request.onStableEpisodeFiles?.(files);
          },
        });
        attemptController.signal.throwIfAborted();
        return resource;
      } catch (error) {
        lastError = error;
        if (
          signal?.aborted
          || errorMessage(error).includes("DOUYIN_DRAMA_NETDISK_DOWNLOAD_STALLED")
          || isNonRetryableBaiduNetdiskResourceError(error)
          || attempt === maxAttempts
        ) break;
        warn(
          options,
          `[douyin-drama] 百度网盘下载失败，准备重试：${attempt}/${maxAttempts}`,
          { error },
          "download",
        );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      } finally {
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }
    throw lastError;
  };

  let resource = await ensureWithRetry({
    shareText,
    resourceName: douyinDramaResourceName(task),
    localEpisodeVideoRoot: douyinDramaLocalRoot(options),
    episodeCount: task.playlet.episodeCount,
    // The source can place Jianying and Juchuang screenshots in one directory
    // whose name contains both platform labels. Filename-only classification is
    // intentionally ambiguous in that case, so the download gate must only wait
    // for enough ownership images. prepareDouyinDramaResources performs the
    // definitive image-content classification and still requires four Jianying
    // screenshots before platform automation starts.
    requiredOwnership: douyinNetdiskOwnershipDownloadRequirements,
    requiredPosterImages: 1,
    posterFallback: {
      title: task.playlet.title,
      summary: task.playlet.summary || task.playlet.title,
    },
    requiredAiProductionProofFiles: 0,
    requiredMetadataTextFiles: task.playlet.summary.trim().length <= 100 ? 1 : 0,
    mergeOwnershipMaterials: false,
    signal,
  });

  if (!douyinTaskNeedsNetdiskMetadata(task)) return resource;
  const resourceDir = path.join(douyinDramaLocalRoot(options), douyinDramaResourceName(task));
  const inputs = await collectDouyinNetdiskMetadataInputs(resourceDir);
  const missingRequiredText = task.playlet.summary.trim().length <= 100 && inputs.texts.length === 0;
  if (!missingRequiredText) return resource;

  log(options, "[douyin-drama] 后端简介不足且本地没有剧情资料，补拉网盘简介目录。", {
    accountTaskId: task.accountTaskId,
    missingRequiredText,
  }, "download");
  resource = await ensureWithRetry({
    shareText,
    resourceName: douyinDramaResourceName(task),
    localEpisodeVideoRoot: douyinDramaLocalRoot(options),
    episodeCount: task.playlet.episodeCount,
    downloadEpisodeVideos: false,
    downloadAssetMaterials: true,
    forceAssetDownload: true,
    requiredOwnership: { minimumImages: 0 },
    requiredPosterImages: 1,
    posterFallback: {
      title: task.playlet.title,
      summary: task.playlet.summary || task.playlet.title,
    },
    requiredAiProductionProofFiles: 0,
    requiredMetadataTextFiles: missingRequiredText ? 1 : 0,
    mergeOwnershipMaterials: false,
    signal,
  });
  return resource;
}

async function runTask(
  taskPage: Page,
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  setLastTask: (lastTask: NonNullable<DouyinDramaRuntimeStatus["lastTask"]>) => void,
  signal?: AbortSignal,
) {
  log(
    options,
    `[douyin-drama] 任务开始：taskId=${task.accountTaskId}，剧名=${task.originalTitle}`,
    { accountTaskId: task.accountTaskId, title: task.originalTitle },
    "task",
  );
  setLastTask({
    accountTaskId: task.accountTaskId,
    originalTitle: task.originalTitle,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  try {
    log(options, "[douyin-drama] 阶段开始：准备百度网盘资源。", {
      accountTaskId: task.accountTaskId,
    }, "task");
    const baiduNetdiskResource = await ensureDouyinNetdiskResource(task, options, signal);
    signal?.throwIfAborted();
    log(options, "[douyin-drama] 阶段完成：百度网盘资源已就绪。", {
      accountTaskId: task.accountTaskId,
    }, "task");
    log(options, "[douyin-drama] 阶段开始：读取并补全任务资料。", {
      accountTaskId: task.accountTaskId,
    }, "task");
    const enrichedTask = await enrichDouyinTaskFromNetdisk(task, options);
    signal?.throwIfAborted();
    log(options, "[douyin-drama] 阶段开始：校验视频、封面和权属素材。", {
      accountTaskId: task.accountTaskId,
    }, "task");
    const resources = await prepareDouyinDramaResources(enrichedTask, options);
    signal?.throwIfAborted();
    log(
      options,
      "[douyin-drama] 任务资源准备完成。",
      { accountTaskId: task.accountTaskId, ...resources },
      "task",
    );
    log(options, "[douyin-drama] 阶段开始：填写抖音表单并上传。", {
      accountTaskId: task.accountTaskId,
    }, "task");
    await runDouyinDramaPublishTask(taskPage, enrichedTask, options);
    await reportDouyinDramaTaskSuccessApi({
      apiConfig: options.apiConfig,
      runtimeOptions: options,
      accountTaskId: task.accountTaskId,
    });
    await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(baiduNetdiskResource).catch(
      (error) => warn(options, "[douyin-drama] 任务成功，但百度网盘剧目目录清理失败。", { error }, "task"),
    );
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
    });
    log(
      options,
      `[douyin-drama] 任务成功：taskId=${task.accountTaskId}，剧名=${task.originalTitle}`,
      { accountTaskId: task.accountTaskId, title: task.originalTitle },
      "task",
    );
    return true;
  } catch (error) {
    if (signal?.aborted) {
      const message = errorMessage(signal.reason ?? error);
      setLastTask({
        accountTaskId: task.accountTaskId,
        originalTitle: task.originalTitle,
        status: "failed",
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      });
      log(options, `[douyin-drama] 任务已随运行时停止而取消：taskId=${task.accountTaskId}`, {
        accountTaskId: task.accountTaskId,
        reason: message,
      }, "task");
      return false;
    }
    const message = formatAutomationErrorReport(error, {
      fallbackMessage: "抖音任务提交失败，未获取到具体错误原因",
    });
    const stage = classifyDouyinDramaFailStage(error);
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "douyin-drama",
      error,
      page: taskPage,
      logFilePath: options.logFilePath,
      stage,
      task: { accountTaskId: task.accountTaskId, title: task.originalTitle },
    });
    try {
      await reportDouyinDramaTaskErrorApi({
        apiConfig: options.apiConfig,
        runtimeOptions: options,
        accountTaskId: task.accountTaskId,
        failStage: stage,
        errorMessage: message,
      });
    } catch (reportError) {
      errorLog(
        options,
        `[douyin-drama] 任务失败结果上报失败：taskId=${task.accountTaskId}，错误=${errorMessage(reportError)}`,
        { accountTaskId: task.accountTaskId, failStage: stage, reportError },
        "task",
      );
    }
    setLastTask({
      accountTaskId: task.accountTaskId,
      originalTitle: task.originalTitle,
      status: "failed",
      errorMessage: message,
      updatedAt: new Date().toISOString(),
    });
    errorLog(
      options,
      `[douyin-drama] 任务失败：taskId=${task.accountTaskId}，阶段=${stage}，错误=${message}`,
      {
        accountTaskId: task.accountTaskId,
        title: task.originalTitle,
        failStage: stage,
        diagnosticDir: diagnostics?.directory,
        error,
      },
      "task",
    );
    return false;
  }
}

export async function startDouyinDramaRuntime(
  options: DouyinDramaRuntimeOptions = {},
): Promise<DouyinDramaRuntime> {
  const userDataDir =
    options.userDataDir ??
    path.resolve(process.cwd(), ".drama-runs/douyin-drama/auth/chromium-profile");
  await cleanupOldDouyinDramaLogFiles(options).catch(() => undefined);
  log(
    options,
    `[douyin-drama] 运行时启动：userDataDir=${userDataDir}，logFile=${options.logFilePath ?? "未配置"}`,
    { userDataDir, logFilePath: options.logFilePath },
  );
  await mkdir(userDataDir, { recursive: true });
  const context = await launchDouyinDramaBrowserContext(userDataDir, options);
  const page = context.pages()[0] ?? (await context.newPage());
  let running = true;
  const runtimeAbortController = new AbortController();
  let lastTask: DouyinDramaRuntimeStatus["lastTask"];
  try {
    await openDouyinDramaCreatePage(page);
    await waitForDouyinDramaLogin(page, context, options);
    await ensureDouyinDramaCreatePage(page, options);
  } catch (error) {
    errorLog(options, `[douyin-drama] 运行时启动失败：${errorMessage(error)}`, { error });
    await context.close().catch(() => undefined);
    await flushDouyinDramaLogs(options);
    throw error;
  }

  const pollLoop = async () => {
    while (running) {
      try {
        const task = await claimNextDouyinDramaTaskApi({
          apiConfig: options.apiConfig,
          runtimeOptions: options,
        });
        if (task) {
          const taskPage = await page.context().newPage();
          const succeeded = await runTask(taskPage, task, options, (value) => {
            lastTask = value;
          }, runtimeAbortController.signal);
          const failedBeforeOpeningPlatformPage = taskPage.url() === "about:blank";
          if (
            !taskPage.isClosed()
            && (succeeded || options.closeFailedTaskPages === true || failedBeforeOpeningPlatformPage)
          ) {
            await taskPage.close().catch(() => undefined);
          } else if (!taskPage.isClosed()) {
            log(options, "[douyin-drama] 已保留失败任务页面供排查。", {
              accountTaskId: task.accountTaskId,
              activeUrl: taskPage.url(),
            }, "task");
          }
          continue;
        }
      } catch (error) {
        warn(options, `[douyin-drama] 任务轮询失败：${errorMessage(error)}`, { error }, "polling");
      }
      if (!running) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1_000, options.taskPollIntervalMs ?? 10_000)),
      );
    }
  };
  const pollLoopPromise = pollLoop();

  return {
    getStatus() {
      return {
        platform: "douyin-drama",
        running,
        loginState: douyinDramaLoginStateFromUrl(page.url()),
        activeUrl: page.url(),
        createUrl: DOUYIN_DRAMA_CREATE_URL,
        loginUrl: DOUYIN_DRAMA_LOGIN_URL,
        userDataDir,
        lastTask,
      };
    },
    async stop() {
      running = false;
      runtimeAbortController.abort(new Error("DOUYIN_DRAMA_RUNTIME_STOPPED"));
      log(options, "[douyin-drama] 运行时停止。", undefined, "runtime");
      await Promise.race([
        pollLoopPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ]).catch(() => undefined);
      await context.close().catch(() => undefined);
      await flushDouyinDramaLogs(options);
    },
  };
}
