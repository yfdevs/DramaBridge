import { BrowserContextManager, type VideoAccountRuntimeStatus } from "../automation/browser-context-manager.js";
import { loadServiceConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import {
  configureWechatMiniProgramRuntimeSettings,
  type WechatMiniProgramRuntimeSettings,
} from "../shared/runtime-settings.js";
import { IdlePageRefreshService } from "./idle-page-refresh-service.js";
import { TaskService } from "./task-service.js";
import { TaskWorkerPool } from "./task-worker-pool.js";
import { VideoAccountSyncService } from "./video-account-sync-service.js";
import { resetMockWechatMiniProgramTaskApi } from "../api/task.js";

export type EnsureBaiduNetdiskResourceRequest = {
  shareText: string;
  resourceName: string;
  localEpisodeVideoRoot: string;
  episodeCount: number;
  requiredOwnership?: {
    minimumImages?: number;
  };
  requiredPosterImages?: number;
  requiredAiProductionProofFiles?: number;
  mergeOwnershipMaterials?: boolean;
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

export type WechatMiniProgramRuntime = {
  addAccount: (id: string) => Promise<void>;
  setAccountPaused: (id: string, paused: boolean) => void;
  getStatus: () => WechatMiniProgramRuntimeStatus;
  focusVideoAccount: (videoAccountId: string) => Promise<void>;
  stop: () => Promise<void>;
}

export type WechatMiniProgramRuntimeStatus = {
  videoAccounts: Array<VideoAccountRuntimeStatus & { paused?: boolean }>;
}

export type WechatMiniProgramRuntimeOptions = {
  onLog?: (message: string) => void;
  settings?: Partial<WechatMiniProgramRuntimeSettings>;
  ensureBaiduNetdiskResource?: EnsureBaiduNetdiskResource;
  cleanupBaiduNetdiskResourceAfterTaskSuccess?: CleanupBaiduNetdiskResource;
}

const logger = createLogger("runtime");

function log(options: WechatMiniProgramRuntimeOptions, message: string) {
  options.onLog?.(message);
}

export async function startWechatMiniProgramRuntime(options: WechatMiniProgramRuntimeOptions = {}): Promise<WechatMiniProgramRuntime> {
  configureWechatMiniProgramRuntimeSettings(options.settings);
  resetMockWechatMiniProgramTaskApi();
  const serviceConfig = await loadServiceConfig();
  const browserContexts = new BrowserContextManager(serviceConfig);
  await browserContexts.initialize();

  const taskService = new TaskService(browserContexts);
  const pausedAccounts = new Set<string>();
  const taskWorkerPool = new TaskWorkerPool(
    serviceConfig,
    browserContexts,
    taskService,
    options.ensureBaiduNetdiskResource,
    options.cleanupBaiduNetdiskResourceAfterTaskSuccess,
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

  taskWorkerPool.start();
  videoAccountSyncService.start();
  idlePageRefreshService.start();
  logger.info("started");
  log(options, "[runtime] started");

  return {
    async addAccount(id: string) {
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
      idlePageRefreshService.stop();
      videoAccountSyncService.stop();
      taskWorkerPool.stop();
      await browserContexts.close();
      logger.info("stopped");
      log(options, "[runtime] stopped");
    },
  };
}
