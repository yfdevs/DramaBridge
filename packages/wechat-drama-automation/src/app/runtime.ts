import { configureWechatTaskWatchdog } from "../api/task.js";
import type { TaskWatchdog } from "@dramabridge/automation-logging";
import { configureWechatTaskProgress } from "../shared/logger.js";
import { configureWechatReportStore, flushWechatTaskReports, type WechatReportStore } from "../api/task-reports.js";
import { BrowserContextManager, type VideoAccountRuntimeStatus } from "../automation/browser-context-manager.js";
import type { findOwnershipProjectProofFiles } from "@dramabridge/media-assets";
import { loadServiceConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import {
  getWechatVideoRuntimeSettings,
  configureWechatVideoRuntimeSettings,
  type WechatVideoRuntimeSettings,
} from "../shared/runtime-settings.js";
import { IdlePageRefreshService } from "./idle-page-refresh-service.js";
import { TaskService } from "./task-service.js";
import { TaskWorkerPool } from "./task-worker-pool.js";
import { VideoAccountSyncService } from "./video-account-sync-service.js";

export type EnsureBaiduNetdiskResourceRequest = {
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot: string;
  episodeCount: number;
  requiredOwnership?: {
    minimumImages?: number;
  };
  requiredPosterImages?: number;
  posterFallback?: { title?: string; summary: string };
  requiredAiProductionProofFiles?: number;
  onStableEpisodeFiles?: (files: Array<{
    index: number;
    file: string;
    size: number;
    modifiedAtMs: number;
  }>) => void;
};

export type EnsureBaiduNetdiskResource = (
  request: EnsureBaiduNetdiskResourceRequest,
) => Promise<unknown>;
export type CleanupBaiduNetdiskResource = (resource: unknown) => Promise<void>;

export type WechatVideoRuntime = {
  addAccount: (id: string) => Promise<void>;
  setAccountPaused: (id: string, paused: boolean) => void;
  getStatus: () => WechatVideoRuntimeStatus;
  focusVideoAccount: (videoAccountId: string) => Promise<void>;
  stop: () => Promise<void>;
}

export type WechatVideoRuntimeStatus = {
  videoAccounts: Array<VideoAccountRuntimeStatus & { paused?: boolean }>;
}

export type WechatVideoRuntimeOptions = {
  reportStore?: WechatReportStore;
  taskWatchdog?: TaskWatchdog;
  onLog?: (message: string) => void;
  settings?: Partial<WechatVideoRuntimeSettings>;
  ensureBaiduNetdiskResource?: EnsureBaiduNetdiskResource;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: CleanupBaiduNetdiskResource;
  classifyOwnershipLocally?: Parameters<typeof findOwnershipProjectProofFiles>[0]["classifyLocally"];
  ownershipAiClient?: NonNullable<Parameters<typeof findOwnershipProjectProofFiles>[0]["aiClient"]>;
}

const logger = createLogger("runtime");

function log(options: WechatVideoRuntimeOptions, message: string) {
  options.onLog?.(message);
}

export async function startWechatVideoRuntime(options: WechatVideoRuntimeOptions = {}): Promise<WechatVideoRuntime> {
  configureWechatVideoRuntimeSettings(options.settings);
  const serviceConfig = await loadServiceConfig();
  configureWechatReportStore(options.reportStore);
  configureWechatTaskWatchdog(options.taskWatchdog);
  configureWechatTaskProgress((id, signature) => options.taskWatchdog?.progress(id, signature));
  const browserContexts = new BrowserContextManager(serviceConfig);
  await browserContexts.initialize();

  const taskService = new TaskService(browserContexts);
  const pausedAccounts = new Set<string>();
  const taskWorkerPool = new TaskWorkerPool(
    serviceConfig,
    browserContexts,
    taskService,
    options.ensureBaiduNetdiskResource,
    options.ownershipAiClient,
    options.cleanupBaiduNetdiskResourceAfterTaskSuccess,
    options.classifyOwnershipLocally,
    options.taskWatchdog,
    id => !pausedAccounts.has(id),
  );
  const idlePageRefreshService = new IdlePageRefreshService(serviceConfig, browserContexts, taskService);
  const videoAccountSyncService = new VideoAccountSyncService(
    serviceConfig,
    browserContexts,
    taskWorkerPool,
    idlePageRefreshService,
  );

  logger.info("initialized video accounts", {
    videoAccountCount: serviceConfig.videoAccounts.length,
  });
  log(options, "[runtime] initialized video accounts");
  for (const videoAccount of serviceConfig.videoAccounts) {
    logger.info("video account loaded", {
      videoAccountId: videoAccount.id,
      videoAccountName: videoAccount.name,
      contractSubject: videoAccount.contractSubject,
    });
  }

  await flushWechatTaskReports();
  const reportTimer = setInterval(() => { void flushWechatTaskReports().catch(error => logger.error("任务回写重试失败", { error })); }, 30_000);
  taskWorkerPool.start();
  videoAccountSyncService.start();
  idlePageRefreshService.start();
  logger.info("started");
  log(options, "[runtime] started");

  return {
    async addAccount(id: string) {
      const settings = getWechatVideoRuntimeSettings();
      const selectedVideoAccountIds = [...new Set([...settings.selectedVideoAccountIds.split(",").filter(Boolean), id])].join(",");
      configureWechatVideoRuntimeSettings({ ...settings, selectedVideoAccountIds });
      await videoAccountSyncService.sync();
      if (!browserContexts.has(id)) throw new Error("账号已停用或不存在，请刷新列表");
      await browserContexts.getOrLaunch(id);
    },
    setAccountPaused(id: string, paused: boolean) {
      if (!browserContexts.has(id)) throw new Error("账号不存在");
      if (paused) pausedAccounts.add(id); else pausedAccounts.delete(id);
    },
    getStatus() {
      return {
        videoAccounts: browserContexts.getRuntimeStatuses().map(account => ({ ...account, paused: pausedAccounts.has(account.videoAccountId) })),
      };
    },
    async focusVideoAccount(videoAccountId: string) {
      await browserContexts.focusVideoAccount(videoAccountId);
    },
    async stop() {
      logger.info("stopping");
      log(options, "[runtime] stopping");
      clearInterval(reportTimer);
      idlePageRefreshService.stop();
      videoAccountSyncService.stop();
      taskWorkerPool.stop();
      await browserContexts.close();
      logger.info("stopped");
      log(options, "[runtime] stopped");
    },
  };
}
