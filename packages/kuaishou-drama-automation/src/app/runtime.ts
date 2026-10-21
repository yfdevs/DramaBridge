import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import type { BrowserContext, Page } from "playwright";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@dramabridge/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import { KUAISHOU_DRAMA_PLATFORM } from "../shared/constants.js";
import { createKuaishouDramaPublishVariants } from "../shared/publish-variants.js";
import { parseTaskConfig } from "../shared/task-config.js";
import type {
  ClaimedKuaishouDramaTask,
  KuaishouDramaRuntime,
  KuaishouDramaRuntimeOptions,
  KuaishouDramaRuntimeStatus,
  KuaishouDramaPublishVariant,
  KuaishouDramaTaskConfig,
} from "../shared/types.js";
import {
  cleanupOldLogFiles,
  loginStateFromUrl,
  log,
  saveCredentialState,
} from "../automation/browser-session.js";
import { prepareKuaishouDramaIdlePage, runPublishTask } from "../automation/publish-runner.js";
import {
  getKuaishouDramaLocalEpisodeVideoRoot,
  validateKuaishouDramaLocalEpisodeVideos,
} from "../shared/local-episode-videos.js";
import { prepareKuaishouDramaTaskMaterials } from "../shared/poster-materials.js";
import { isKuaishouDailyUploadLimitError } from "../automation/warning-guard.js";

const baiduNetdiskRetryDelayMs = 5_000;

function millisecondsUntilNextLocalDay(now = new Date()) {
  const nextDay = new Date(now);
  nextDay.setDate(nextDay.getDate() + 1);
  nextDay.setHours(0, 0, 0, 0);
  return nextDay.getTime() - now.getTime();
}

function classifyFailStage(error: unknown) {
  const message = errorMessage(error);
  if (/login|登录/i.test(message)) return "LOGIN" as const;
  if (/upload|file|视频|封面|海报|版权|授权|素材/i.test(message)) return "UPLOAD_FILE" as const;
  if (/form|field|填写|表单/i.test(message)) return "FILL_FORM" as const;
  return "OTHER" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureBaiduNetdiskResourceReady(
  task: KuaishouDramaTaskConfig,
  resourceName: string,
  accountTaskId: number | undefined,
  options: KuaishouDramaRuntimeOptions,
) {
  const shareText = task.baiduPanResourceLink?.trim();
  if (!shareText) {
    log(options, "[kuaishou-drama] task has no baidu netdisk resource; download check skipped");
    return;
  }
  if (!/https?:\/\/pan\.baidu\.com\/s\//i.test(shareText)) {
    throw new Error("分享文本中没有找到百度网盘链接。");
  }
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("任务包含百度网盘资源链接，但当前快手运行时未接入百度网盘下载能力。");
  }

  const localEpisodeVideoRoot = getKuaishouDramaLocalEpisodeVideoRoot(options);
  const retryAttempts = Math.max(0, options.baiduNetdiskDownloadRetryAttempts ?? 3);
  const maxAttempts = retryAttempts + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(
        options,
        `[kuaishou-drama] ensuring baidu netdisk resource: ` +
          `accountTaskId=${accountTaskId ?? "configured"} resourceName=${resourceName} ` +
          `episodeCount=${task.episodeCount} attempt=${attempt}/${maxAttempts}`,
      );
      const resource = await options.ensureBaiduNetdiskResource({
        shareText,
        resourceName,
        localEpisodeVideoRoot,
        episodeCount: task.episodeCount,
        requiredPosterImages: 1,
        posterFallback: {
          title: task.title,
          summary: task.summary,
        },
      });
      await validateKuaishouDramaLocalEpisodeVideos(task, resourceName, options);
      log(
        options,
        `[kuaishou-drama] baidu netdisk resource ready: ` +
          `resourceName=${resourceName} episodes=${task.episodeCount}`,
      );
      return resource;
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      const nonRetryable = isNonRetryableBaiduNetdiskResourceError(error);
      if (nonRetryable || attempt >= maxAttempts) break;
      log(
        options,
        `[kuaishou-drama] baidu netdisk resource failed, retrying: ` +
          `attempt=${attempt}/${maxAttempts} error=${message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, baiduNetdiskRetryDelayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function startKuaishouDramaRuntime(
  options: KuaishouDramaRuntimeOptions = {},
): Promise<KuaishouDramaRuntime> {
  if (!options.userDataDir) {
    throw new Error("Kuaishou drama userDataDir is required.");
  }

  const configuredTask = parseTaskConfig(options);
  const userDataDir = options.userDataDir;
  let running = true;
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  const taskState: { claimed?: ClaimedKuaishouDramaTask } = {};
  const currentClaimedTask = (): ClaimedKuaishouDramaTask | undefined => taskState.claimed;
  let lastTask: KuaishouDramaRuntimeStatus["lastTask"];
  let configuredTaskConsumed = false;
  let taskLoopPromise: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let wakePoll: (() => void) | null = null;
  let dailyUploadLimitResumeAt =
    options.dailyUploadLimitResumeAt && options.dailyUploadLimitResumeAt > Date.now()
      ? options.dailyUploadLimitResumeAt
      : null;

  await cleanupOldLogFiles(options).catch(() => undefined);
  log(options, "[kuaishou-drama] starting browser");
  context = await launchPlatformBrowserContext(userDataDir, {
    viewport: null,
    headless: options.config?.browser?.headless ?? false,
    slowMo: options.config?.browser?.slowMo ?? 0,
  });
  context.on("close", () => {
    running = false;
    wakePoll?.();
  });

  page = context.pages()[0] ?? (await context.newPage());

  const resolveTask = async () => {
    if (configuredTask && !configuredTaskConsumed) {
      configuredTaskConsumed = true;
      return { taskConfig: configuredTask, resourceName: configuredTask.title };
    }
    if (!options.claimTask) return null;

    log(options, "[kuaishou-drama] polling for next task");
    const claimedTask = await options.claimTask();
    if (!claimedTask) return null;
    const isClaimedTask = "accountTaskId" in claimedTask && "task" in claimedTask;
    const taskInput = isClaimedTask
      ? (() => {
          taskState.claimed = claimedTask;
          lastTask = {
            accountTaskId: claimedTask.accountTaskId,
            originalTitle: claimedTask.originalTitle,
            status: "running",
            updatedAt: new Date().toISOString(),
          };
          return claimedTask.task;
        })()
      : claimedTask;
    const taskConfig = parseTaskConfig({
      ...options,
      claimTask: undefined,
      reportTaskError: undefined,
      config: { task: taskInput },
    });
    if (!taskConfig) return null;
    const resourceName = isClaimedTask ? claimedTask.originalTitle : taskConfig.title;
    return {
      taskConfig,
      resourceName,
      claimedTask: isClaimedTask ? claimedTask : undefined,
    };
  };

  const prepareTask = async (
    resolvedTask: NonNullable<Awaited<ReturnType<typeof resolveTask>>>,
    needsFormMaterials: boolean,
  ) => {
    const baiduNetdiskResource = await ensureBaiduNetdiskResourceReady(
      resolvedTask.taskConfig,
      resolvedTask.resourceName,
      resolvedTask.claimedTask?.accountTaskId,
      options,
    );
    if (!needsFormMaterials) {
      log(
        options,
        "[kuaishou-drama] all drama records already exist; form material preparation skipped",
      );
      return baiduNetdiskResource;
    }
    const covers = await prepareKuaishouDramaTaskMaterials(
      resolvedTask.taskConfig,
      resolvedTask.resourceName,
      options,
    );
    log(
      options,
      `[kuaishou-drama] local drama and episode covers ready: ` +
        `drama=${covers.dramaCover} episode=${covers.episodeCover}`,
    );
    return baiduNetdiskResource;
  };

  const waitForNextPoll = async (delayMs = options.taskPollIntervalMs ?? 10_000) => {
    await new Promise<void>((resolve) => {
      wakePoll = resolve;
      pollTimer = setTimeout(resolve, Math.max(1_000, delayMs));
    });
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    wakePoll = null;
  };

  taskLoopPromise = (async () => {
    try {
      await prepareKuaishouDramaIdlePage(context!, page!, options);
    } catch (error) {
      running = false;
      log(options, `[kuaishou-drama] browser preparation failed: ${errorMessage(error)}`);
      return;
    }

    while (running && page && !page.isClosed()) {
      taskState.claimed = undefined;
      let taskPage: Page | null = null;
      let publishedVariants: KuaishouDramaPublishVariant["kind"][] = [];
      let baiduNetdiskResource: unknown;
      try {
        const resolvedTask = await resolveTask();
        if (!resolvedTask) {
          log(options, "[kuaishou-drama] no claimable task; idle page left unchanged");
        } else {
          taskPage = await context!.newPage();
          log(
            options,
            `[kuaishou-drama] opened dedicated task tab: ` +
              `accountTaskId=${resolvedTask.claimedTask?.accountTaskId ?? "configured"}`,
          );
          publishedVariants = await runPublishTask(
            context!,
            taskPage,
            options,
            resolvedTask,
            async (needsFormMaterials) => {
              baiduNetdiskResource = await prepareTask(resolvedTask, needsFormMaterials);
            },
          );
          const expectedVariants = createKuaishouDramaPublishVariants(resolvedTask.taskConfig)
            .map((variant) => variant.kind);
          if (
            publishedVariants.length !== expectedVariants.length
            || publishedVariants.some((variant, index) => variant !== expectedVariants[index])
          ) {
            throw new Error(
              `KUAISHOU_DRAMA_PUBLISH_VARIANTS_INCOMPLETE: `
                + `expected=${expectedVariants.join(",")} actual=${publishedVariants.join(",") || "none"}`,
            );
          }
        }
        if (resolvedTask?.claimedTask) {
          const completedTask = resolvedTask.claimedTask;
          await options.reportTaskSuccess?.({
            accountTaskId: completedTask.accountTaskId,
            resultJson: {
              accountId: options.kuaishouAccountId,
              accountName: options.kuaishouAccountName,
              requestedAdVersionCount: completedTask.task.adVersionCount,
              variants: publishedVariants,
            },
          });
          await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(baiduNetdiskResource).catch(
            (error) => log(options, `[kuaishou-drama] task succeeded but baidu netdisk cleanup failed: ${errorMessage(error)}`),
          );
          lastTask = {
            accountTaskId: completedTask.accountTaskId,
            originalTitle: completedTask.originalTitle,
            status: "succeeded",
            updatedAt: new Date().toISOString(),
          };
          log(options, `[kuaishou-drama] task succeeded: ${completedTask.accountTaskId}`);
        }
      } catch (error) {
        const message = formatAutomationErrorReport(error, {
          fallbackMessage: "快手任务提交失败，未获取到具体错误原因",
        });
        const failedTask = currentClaimedTask();
        const stage = classifyFailStage(error);
        const diagnostics = await captureAutomationFailureDiagnostics({
          platform: "kuaishou-drama",
          error,
          page: taskPage,
          logFilePath: options.logFilePath,
          stage,
          task: {
            accountTaskId: failedTask?.accountTaskId,
            title: failedTask?.originalTitle,
          },
        });
        log(
          options,
          `[kuaishou-drama] task failed: ${message} diagnostics=${diagnostics?.directory ?? "unavailable"}`,
        );
        if (isKuaishouDailyUploadLimitError(error)) {
          dailyUploadLimitResumeAt = Date.now() + millisecondsUntilNextLocalDay();
          options.onDailyUploadLimitReached?.(dailyUploadLimitResumeAt);
          log(
            options,
            `[kuaishou-drama] daily upload limit reached; task claims paused until ` +
              `${new Date(dailyUploadLimitResumeAt).toLocaleString()}`,
          );
        }
        if (failedTask) {
          lastTask = {
            accountTaskId: failedTask.accountTaskId,
            originalTitle: failedTask.originalTitle,
            status: "failed",
            errorMessage: message,
            updatedAt: new Date().toISOString(),
          };
          await options
            .reportTaskError?.({
              accountTaskId: failedTask.accountTaskId,
              failStage: stage,
              errorMessage: message,
            })
            .catch((reportError) => {
              log(
                options,
                `[kuaishou-drama] task error report failed: ${errorMessage(reportError)}`,
              );
            });
        }
      } finally {
        if (taskPage) {
          const accountTaskId = currentClaimedTask()?.accountTaskId ?? "configured";
          await taskPage.close().catch(() => undefined);
          log(
            options,
            `[kuaishou-drama] closed dedicated task tab: accountTaskId=${accountTaskId}`,
          );
        }
      }
      if (!running || page.isClosed()) break;
      if (dailyUploadLimitResumeAt && dailyUploadLimitResumeAt > Date.now()) {
        await waitForNextPoll(dailyUploadLimitResumeAt - Date.now());
        dailyUploadLimitResumeAt = null;
      } else {
        await waitForNextPoll();
      }
    }
  })();

  return {
    getStatus(): KuaishouDramaRuntimeStatus {
      const activeUrl = page?.url();
      return {
        platform: KUAISHOU_DRAMA_PLATFORM,
        running,
        loginState: loginStateFromUrl(activeUrl),
        activeUrl,
        userDataDir,
        accountProfileName: options.accountProfileName,
        accountDir: options.accountDir,
        credentialStatePath: options.credentialStatePath,
        assetDownloadDir: options.assetDownloadDir,
        logFilePath: options.logFilePath,
        lastTask,
      };
    },
    async stop() {
      if (context) {
        await saveCredentialState(context, options).catch(() => undefined);
      }
      running = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      wakePoll?.();
      wakePoll = null;
      await context?.close();
      await taskLoopPromise?.catch(() => undefined);
      log(options, "[kuaishou-drama] runtime stopped");
    },
  };
}
