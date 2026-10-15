import {
  findLocalEpisodeVideos,
  isNonRetryableBaiduNetdiskResourceError,
  prepareEpisodeVideos,
  validateLocalEpisodeMinimumDuration,
  VideoTranscodeQueue,
  type VideoSizePolicy,
} from "@drama/drama-media-assets";
import PQueue from "p-queue";
import {
  mingxingshuoContractSubject,
  normalizeClaimedTaskConfig,
  normalizeContractSubject,
  resolveRunDataPath,
  type ServiceConfig,
} from "../shared/config.js";
import { createLogger, runWithLogContext } from "../shared/logger.js";
import { validateLocalEpisodeVideos } from "../shared/local-episode-videos.js";
import { FeishuNotifier } from "@drama/feishu-notifier";
import {
  claimNextWechatMiniProgramTaskApi,
  reportClaimedTaskErrorApi,
  reportClaimedTaskSuccessApi,
} from "../api/task.js";
import type { WechatMiniProgramAccount } from "../api/mini-program-accounts.js";
import { BrowserContextManager } from "../automation/browser-context-manager.js";
import { TaskService } from "./task-service.js";
import { classifyError, ErrorType, inferRpaFailStage } from "../shared/errors.js";
import { getWechatMiniProgramRuntimeSettings } from "../shared/runtime-settings.js";
import { integerSetting } from "../shared/settings-value.js";
import type { CleanupBaiduNetdiskResource, EnsureBaiduNetdiskResource } from "./runtime.js";
import {
  cleanupWechatProductionProofMaterials,
  prepareWechatProductionProofMaterials,
  wechatOwnershipRequirements,
} from "../shared/production-proof-materials.js";
import { prepareWechatPosterMaterials } from "../shared/poster-materials.js";
import {
  prepareWechatAiProductionProofMaterials,
  wechatAiProductionProofRequirements,
} from "../shared/ai-production-proof-materials.js";

const logger = createLogger("worker");
const claimErrorDelayMs = 10000;
const loginRequiredDelayMs = 30 * 60_000;
const baiduNetdiskDownloadRetryDelayMs = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function episodeVideoSizePolicy(
  settings = getWechatMiniProgramRuntimeSettings(),
): VideoSizePolicy {
  return {
    maxFileBytes:
      Math.max(1, integerSetting(settings.episodeVideoMaxFileMegabytes, 490)) * 1_000_000,
    targetFileBytes:
      Math.max(1, integerSetting(settings.episodeVideoTargetFileMegabytes, 480)) * 1_000_000,
    audioBitrateKbps: 128,
    threadsPerJob: Math.max(1, integerSetting(settings.videoTranscodeThreadsPerJob, 2)),
  };
}

interface AccountWorkerControl {
  videoAccount: WechatMiniProgramAccount;
  stopped: boolean;
  promise: Promise<void>;
  abortController: AbortController;
  activeAccountTaskIds: Set<number>;
}

type ClaimedTask = NonNullable<Awaited<ReturnType<typeof claimNextWechatMiniProgramTaskApi>>>;

type PreparedClaimedTask = {
  playletConfig: ReturnType<typeof normalizeClaimedTaskConfig>;
  baiduNetdiskResource?: unknown;
  episodeVideos: Array<{
    index: number;
    title: string;
    file: string;
    sourceFile: string;
    originalSize: number;
    outputSize: number;
    transcoded: boolean;
    cacheKey: string;
  }>;
};

export class TaskWorkerPool {
  private stopped = true;
  private readonly accountWorkersByVideoAccountId = new Map<string, AccountWorkerControl>();
  private readonly publishQueuesByVideoAccountId = new Map<string, PQueue>();
  private readonly materialPreparationQueue: PQueue;
  private readonly videoTranscodeQueue: VideoTranscodeQueue;

  constructor(
    private readonly serviceConfig: ServiceConfig,
    private readonly browserContexts: BrowserContextManager,
    private readonly taskService: TaskService,
    private readonly notifier = new FeishuNotifier(),
    private readonly ensureBaiduNetdiskResource?: EnsureBaiduNetdiskResource,
    private readonly cleanupBaiduNetdiskResourceAfterTaskSuccess?: CleanupBaiduNetdiskResource,
  ) {
    const settings = getWechatMiniProgramRuntimeSettings();
    this.materialPreparationQueue = new PQueue({
      concurrency: Math.max(1, integerSetting(settings.materialPreparationConcurrency, 3)),
    });
    this.videoTranscodeQueue = new VideoTranscodeQueue({
      concurrency: Math.max(1, integerSetting(settings.videoTranscodeConcurrency, 2)),
      onLog: (message) => logger.info(message),
    });
  }

  start(): void {
    if (!this.stopped) return;

    this.stopped = false;

    for (const videoAccount of this.serviceConfig.videoAccounts) {
      this.addAccountWorker(videoAccount);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const worker of this.accountWorkersByVideoAccountId.values()) {
      worker.stopped = true;
      worker.abortController.abort();
    }
  }

  syncVideoAccounts(videoAccounts: WechatMiniProgramAccount[]): void {
    const nextAccountIds = new Set(videoAccounts.map((account) => account.id));

    for (const [videoAccountId, worker] of this.accountWorkersByVideoAccountId) {
      if (!nextAccountIds.has(videoAccountId)) {
        worker.stopped = true;
        worker.abortController.abort();
        logger.info("stopping removed worker", {
          videoAccountId,
          videoAccountName: worker.videoAccount.name,
        });
      }
    }

    for (const videoAccount of videoAccounts) {
      this.addAccountWorker(videoAccount);
    }
  }

  private addAccountWorker(videoAccount: WechatMiniProgramAccount): void {
    const existingWorker = this.accountWorkersByVideoAccountId.get(videoAccount.id);
    if (existingWorker) {
      existingWorker.videoAccount = videoAccount;
      if (existingWorker.stopped && !this.stopped) {
        logger.info("waiting for stopped worker before restarting", {
          videoAccountId: videoAccount.id,
          videoAccountName: videoAccount.name,
        });
        void existingWorker.promise.finally(() => {
          if (!this.stopped && !this.accountWorkersByVideoAccountId.has(videoAccount.id)) {
            this.addAccountWorker(videoAccount);
          }
        });
      }
      return;
    }

    if (this.stopped) return;

    const worker: AccountWorkerControl = {
      videoAccount,
      stopped: false,
      promise: Promise.resolve(),
      abortController: new AbortController(),
      activeAccountTaskIds: new Set(),
    };
    worker.promise = this.runAccountWorker(worker).finally(() => {
      if (this.accountWorkersByVideoAccountId.get(videoAccount.id) === worker) {
        this.accountWorkersByVideoAccountId.delete(videoAccount.id);
      }
    });
    this.accountWorkersByVideoAccountId.set(videoAccount.id, worker);
  }

  private async runAccountWorker(worker: AccountWorkerControl): Promise<void> {
    return runWithLogContext({
      videoAccountId: worker.videoAccount.id,
      videoAccountName: worker.videoAccount.name,
    }, async () => {
      const videoAccountId = worker.videoAccount.id;
      const inFlightTasks = new Set<Promise<void>>();
      const prefetchLimit = Math.max(
        1,
        integerSetting(getWechatMiniProgramRuntimeSettings().taskPrefetchPerAccount, 2),
      );
      let consecutiveEmptyClaims = 0;
      let nextLoginCheckAt = 0;
      logger.info("worker started", { videoAccountId, prefetchLimit });

      while (!this.stopped && !worker.stopped) {
        if (inFlightTasks.size >= prefetchLimit) {
          await Promise.race(inFlightTasks);
          continue;
        }

        const videoAccount = worker.videoAccount;
        const reservation = this.taskService.tryReserveChannel(videoAccountId, "worker-claim");
        if (!reservation) {
          await sleep(1000);
          continue;
        }

        try {
          if (Date.now() >= nextLoginCheckAt) {
            const loggedIn = await this.browserContexts.refreshLoginStateInTemporaryPage(
              videoAccountId,
              this.serviceConfig.idlePageRefresh.timeoutMs,
            );
            if (!loggedIn) {
              reservation.release();
              logger.info("skip claim, login required", {
                videoAccountId,
                videoAccountName: videoAccount.name,
                loginWaitTimeoutMs: loginRequiredDelayMs,
              });
              await this.browserContexts.waitForAuthenticatedSession(
                videoAccountId,
                loginRequiredDelayMs,
              );
              continue;
            }
            nextLoginCheckAt = Date.now() + loginRequiredDelayMs;
          }

          if (consecutiveEmptyClaims === 0) {
            logger.info("claiming task", {
              videoAccountId,
              videoAccountName: videoAccount.name,
              inFlightCount: inFlightTasks.size,
              prefetchLimit,
            });
          }
          const claimedAccountTask = await claimNextWechatMiniProgramTaskApi(videoAccount, {
            excludedAccountTaskIds: worker.activeAccountTaskIds,
          });
          if (!claimedAccountTask) {
            consecutiveEmptyClaims += 1;
            const retryDelayMs = consecutiveEmptyClaims >= this.serviceConfig.worker.slowEmptyClaimThreshold
              ? this.serviceConfig.worker.slowEmptyClaimDelayMs
              : this.serviceConfig.worker.emptyClaimDelayMs;
            if (
              consecutiveEmptyClaims === 1
              || consecutiveEmptyClaims === this.serviceConfig.worker.slowEmptyClaimThreshold
            ) {
              logger.info("no claimable account task", {
                videoAccountId,
                videoAccountName: videoAccount.name,
                delayMs: retryDelayMs,
              });
            }
            reservation.release();
            await sleep(retryDelayMs);
            continue;
          }

          consecutiveEmptyClaims = 0;
          reservation.release();
          if (worker.activeAccountTaskIds.has(claimedAccountTask.accountTaskId)) {
            logger.warn("skip duplicate claimed account task", {
              accountTaskId: claimedAccountTask.accountTaskId,
              videoAccountId,
              videoAccountName: videoAccount.name,
              activeAccountTaskIds: Array.from(worker.activeAccountTaskIds),
            });
            await sleep(1000);
            continue;
          }
          worker.activeAccountTaskIds.add(claimedAccountTask.accountTaskId);
          logger.info("registered active account task", {
            accountTaskId: claimedAccountTask.accountTaskId,
            videoAccountId,
            activeAccountTaskCount: worker.activeAccountTaskIds.size,
          });
          const releaseActiveAccountTask = () => {
            worker.activeAccountTaskIds.delete(claimedAccountTask.accountTaskId);
            logger.info("released active account task", {
              accountTaskId: claimedAccountTask.accountTaskId,
              videoAccountId,
              activeAccountTaskCount: worker.activeAccountTaskIds.size,
            });
          };
          let lifecycle: Promise<void>;
          try {
            lifecycle = this.enqueueClaimedTask(worker, claimedAccountTask);
          } catch (error) {
            releaseActiveAccountTask();
            throw error;
          }
          inFlightTasks.add(lifecycle);
          void lifecycle.then(
            () => {
              inFlightTasks.delete(lifecycle);
              releaseActiveAccountTask();
            },
            () => {
              inFlightTasks.delete(lifecycle);
              releaseActiveAccountTask();
            },
          );
        } catch (error) {
          reservation.release();
          const errorInfo = classifyError(error, ErrorType.TaskClaim);
          logger.error("claim loop error", {
            videoAccountId,
            errorType: errorInfo.type,
            errorMessage: errorInfo.message,
          });
          await sleep(claimErrorDelayMs);
        }
      }

      await Promise.allSettled(inFlightTasks);
      logger.info("worker stopped", { videoAccountId });
    });
  }

  private getPublishQueue(videoAccountId: string) {
    let queue = this.publishQueuesByVideoAccountId.get(videoAccountId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.publishQueuesByVideoAccountId.set(videoAccountId, queue);
    }
    return queue;
  }

  private enqueueClaimedTask(worker: AccountWorkerControl, claimedAccountTask: ClaimedTask) {
    const videoAccount = worker.videoAccount;
    const videoAccountId = videoAccount.id;
    let playletConfigForCleanup: ReturnType<typeof normalizeClaimedTaskConfig> | undefined;
    let baiduNetdiskResource: unknown;
    const preparation = this.materialPreparationQueue.add(
      async () => {
        const playletConfig = normalizeClaimedTaskConfig(
          claimedAccountTask,
          videoAccount.contractSubject,
        );
        playletConfigForCleanup = playletConfig;
        await prepareWechatAiProductionProofMaterials(playletConfig, { allowMissing: true });
        baiduNetdiskResource = await this.ensureBaiduNetdiskResourceReady(
          videoAccount,
          claimedAccountTask,
          playletConfig,
          worker.abortController.signal,
        );
        await validateLocalEpisodeVideos(playletConfig);
        const settings = getWechatMiniProgramRuntimeSettings();
        await validateLocalEpisodeMinimumDuration({
          localEpisodeVideoRoot: settings.localEpisodeVideoRoot,
          resourceName: playletConfig.originalTitle,
          episodeCount: playletConfig.playlet.episodeCount,
          minimumDurationSeconds: Number(settings.episodeVideoMinimumDurationSeconds),
          concurrency: 4,
          signal: worker.abortController.signal,
          onLog: (message) => logger.info(message, {
            accountTaskId: claimedAccountTask.accountTaskId,
            videoAccountId,
          }),
        });
        await prepareWechatPosterMaterials(playletConfig);
        const aiProductionProofFiles = await prepareWechatAiProductionProofMaterials(playletConfig);
        const productionProofFiles = await prepareWechatProductionProofMaterials(
          playletConfig,
          videoAccount.contractSubject,
        );
        logger.info("all task materials ready", {
          accountTaskId: claimedAccountTask.accountTaskId,
          videoAccountId,
          aiProductionProofFiles,
          productionProofFiles,
        });
        return playletConfig;
      },
      {
        id: `materials:${claimedAccountTask.accountTaskId}`,
        signal: worker.abortController.signal,
      },
    ).then(async (playletConfig): Promise<PreparedClaimedTask> => {
      const settings = getWechatMiniProgramRuntimeSettings();
      const policy = episodeVideoSizePolicy(settings);
      const cacheRootDir = resolveRunDataPath("media-cache", "video-transcodes");
      const episodes = await findLocalEpisodeVideos({
        localEpisodeVideoRoot: settings.localEpisodeVideoRoot,
        resourceName: playletConfig.originalTitle,
      });
      const episodeVideos = await prepareEpisodeVideos({
        episodes,
        queue: this.videoTranscodeQueue,
        cacheRootDir,
        policy,
        replaceSource: true,
        signal: worker.abortController.signal,
        onLog: (message) => logger.info(message, {
          accountTaskId: claimedAccountTask.accountTaskId,
          videoAccountId,
        }),
      });
      logger.info("episode videos prepared", {
        accountTaskId: claimedAccountTask.accountTaskId,
        videoAccountId,
        episodeCount: episodeVideos.length,
        transcodedCount: episodeVideos.filter((episode) => episode.transcoded).length,
      });
      return { playletConfig, episodeVideos, baiduNetdiskResource };
    });

    const lifecycle = this.getPublishQueue(videoAccountId).add(
      async () => {
        const prepared = await preparation;
        await this.publishPreparedTask(worker, claimedAccountTask, prepared);
      },
      {
        id: `publish:${claimedAccountTask.accountTaskId}`,
        signal: worker.abortController.signal,
      },
    ) as Promise<void>;

    return lifecycle.catch(async (error) => {
      if (playletConfigForCleanup) {
        await cleanupWechatProductionProofMaterials(playletConfigForCleanup).catch(() => undefined);
      }
      await this.handleClaimedTaskFailure(worker, claimedAccountTask, error);
    });
  }

  private async reserveChannelForPublish(worker: AccountWorkerControl) {
    while (!this.stopped && !worker.stopped && !worker.abortController.signal.aborted) {
      const reservation = this.taskService.tryReserveChannel(worker.videoAccount.id, "worker-publish");
      if (reservation) return reservation;
      await sleep(1000);
    }
    throw Object.assign(new Error("微信任务准备完成后服务已停止。"), {
      errorType: ErrorType.Interrupted,
    });
  }

  private async publishPreparedTask(
    worker: AccountWorkerControl,
    claimedAccountTask: ClaimedTask,
    prepared: PreparedClaimedTask,
  ) {
    const videoAccount = worker.videoAccount;
    const reservation = await this.reserveChannelForPublish(worker);
    try {
      const { taskRecord, taskFinished } = await this.taskService.createTaskFromClaim(
        videoAccount.id,
        claimedAccountTask,
        prepared.playletConfig,
        reservation,
        prepared.episodeVideos,
      );
      reservation.release();
      logger.info("prepared task entered publish stage", {
        accountTaskId: claimedAccountTask.accountTaskId,
        videoAccountId: taskRecord.channelId,
        originalTitle: claimedAccountTask.originalTitle,
      });
      await taskFinished;
      await reportClaimedTaskSuccessApi({
        accountTaskId: claimedAccountTask.accountTaskId,
      });
      await this.cleanupBaiduNetdiskResourceAfterTaskSuccess?.(prepared.baiduNetdiskResource)
        .catch((error) => logger.warn("task succeeded but baidu netdisk cleanup failed", {
          accountTaskId: claimedAccountTask.accountTaskId,
          error,
        }));
      await this.notifier.notifyTaskSucceeded({
        accountTaskId: claimedAccountTask.accountTaskId,
        dramaId: claimedAccountTask.dramaId,
        originalTitle: claimedAccountTask.originalTitle,
        videoAccountId: videoAccount.id,
        videoAccountName: videoAccount.name,
      });
    } finally {
      reservation.release();
    }
  }

  private async handleClaimedTaskFailure(
    worker: AccountWorkerControl,
    claimedAccountTask: ClaimedTask,
    error: unknown,
  ) {
    const errorInfo = classifyError(error, ErrorType.TaskExecution);
    const videoAccount = worker.videoAccount;
    if (
      errorInfo.type === ErrorType.Interrupted
      || this.stopped
      || worker.stopped
      || worker.abortController.signal.aborted
    ) {
      logger.warn("task interrupted, skip failure callback", {
        accountTaskId: claimedAccountTask.accountTaskId,
        videoAccountId: videoAccount.id,
        errorMessage: errorInfo.message,
      });
      return;
    }

    await reportClaimedTaskErrorApi({
      accountTaskId: claimedAccountTask.accountTaskId,
      dramaId: claimedAccountTask.dramaId,
      failStage: inferRpaFailStage(errorInfo.type, errorInfo.failStage),
      resultJson: { errorType: errorInfo.type },
      videoAccountId: videoAccount.id,
      errorMessage: errorInfo.message,
    });
    await this.notifier.notifyTaskFailed({
      accountTaskId: claimedAccountTask.accountTaskId,
      dramaId: claimedAccountTask.dramaId,
      originalTitle: claimedAccountTask.originalTitle,
      videoAccountId: videoAccount.id,
      videoAccountName: videoAccount.name,
      errorMessage: errorInfo.message,
      errorType: errorInfo.type,
    }).catch(() => undefined);
    logger.error("task failed, pipeline continues", {
      accountTaskId: claimedAccountTask.accountTaskId,
      videoAccountId: videoAccount.id,
      errorType: errorInfo.type,
      errorMessage: errorInfo.message,
    });
  }

  private async ensureBaiduNetdiskResourceReady(
    videoAccount: WechatMiniProgramAccount,
    claimedAccountTask: NonNullable<Awaited<ReturnType<typeof claimNextWechatMiniProgramTaskApi>>>,
    playletConfig: ReturnType<typeof normalizeClaimedTaskConfig>,
    signal: AbortSignal,
  ): Promise<unknown> {

    const baiduPanResourceLink = stringValue(claimedAccountTask.playlet.baiduPanResourceLink);
    if (!baiduPanResourceLink) return;

    if (!this.ensureBaiduNetdiskResource) {
      throw new Error("任务包含百度网盘资源链接，但当前运行时未接入百度网盘下载能力。");
    }

    logger.info("ensure baidu netdisk resource before task", {
      accountTaskId: claimedAccountTask.accountTaskId,
      originalTitle: claimedAccountTask.originalTitle,
      baiduPanResourceLink,
    });

    const settings = getWechatMiniProgramRuntimeSettings();
    const retryAttempts = integerSetting(settings.baiduNetdiskDownloadRetryAttempts, 3);
    const maxAttempts = retryAttempts + 1;
    const videoPolicy = episodeVideoSizePolicy(settings);
    const videoTranscodeCacheRootDir = resolveRunDataPath("media-cache", "video-transcodes");
    const isMingxingshuo = Boolean(
      videoAccount.contractSubject
      && normalizeContractSubject(videoAccount.contractSubject) === mingxingshuoContractSubject,
    );
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        logger.info("baidu netdisk resource attempt", {
          accountTaskId: claimedAccountTask.accountTaskId,
          originalTitle: claimedAccountTask.originalTitle,
          attempt,
          maxAttempts,
        });

        const resource = await this.ensureBaiduNetdiskResource({
          shareText: baiduPanResourceLink,
          resourceName: claimedAccountTask.originalTitle,
          localEpisodeVideoRoot: settings.localEpisodeVideoRoot,
          episodeCount: playletConfig.playlet.episodeCount,
          requiredOwnership: wechatOwnershipRequirements,
          requiredPosterImages: 1,
          requiredAiProductionProofFiles:
            (playletConfig.playlet.aiContent ?? true)
            && !(playletConfig.playlet.aiProductionProofFiles?.length)
              ? wechatAiProductionProofRequirements.minimumFiles
              : 0,
          mergeOwnershipMaterials: !isMingxingshuo && !["false", "0", "no", "off"].includes(
            String(settings.mergeOwnershipMaterials ?? "true").trim().toLowerCase(),
          ),
          onStableEpisodeFiles: (files) => {
            for (const file of files) {
              if (file.size <= videoPolicy.maxFileBytes) continue;
              logger.info("download scan queued oversized episode video", {
                accountTaskId: claimedAccountTask.accountTaskId,
                videoAccountId: videoAccount.id,
                episodeIndex: file.index,
                file: file.file,
                size: file.size,
                maxFileBytes: videoPolicy.maxFileBytes,
              });
              void this.videoTranscodeQueue.add({
                inputFile: file.file,
                cacheRootDir: videoTranscodeCacheRootDir,
                policy: videoPolicy,
                replaceSource: true,
                signal,
                onLog: (message) => logger.info(message, {
                  accountTaskId: claimedAccountTask.accountTaskId,
                  videoAccountId: videoAccount.id,
                  episodeIndex: file.index,
                }),
              }).catch((error) => {
                logger.error("download-time episode transcode failed; final preparation will retry", {
                  accountTaskId: claimedAccountTask.accountTaskId,
                  videoAccountId: videoAccount.id,
                  episodeIndex: file.index,
                  errorMessage: error instanceof Error ? error.message : String(error),
                });
              });
            }
          },
        });

        logger.info("baidu netdisk resource ready", {
          accountTaskId: claimedAccountTask.accountTaskId,
          originalTitle: claimedAccountTask.originalTitle,
          attempt,
        });
        return resource;
      } catch (error) {
        lastError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const nonRetryable = isNonRetryableBaiduNetdiskResourceError(error);

        if (nonRetryable || attempt >= maxAttempts) {
          logger.error(nonRetryable ? "baidu netdisk resource failed without retry" : "baidu netdisk resource failed after retries", {
            accountTaskId: claimedAccountTask.accountTaskId,
            originalTitle: claimedAccountTask.originalTitle,
            attempt,
            maxAttempts,
            nonRetryable,
            errorMessage,
          });
          break;
        }

        logger.warn("baidu netdisk resource failed, retry", {
          accountTaskId: claimedAccountTask.accountTaskId,
          originalTitle: claimedAccountTask.originalTitle,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          retryDelayMs: baiduNetdiskDownloadRetryDelayMs,
          errorMessage,
        });
        await sleep(baiduNetdiskDownloadRetryDelayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
