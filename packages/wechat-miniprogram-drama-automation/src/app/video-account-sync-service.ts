import {
  fetchWechatMiniProgramAccountsApi,
  type WechatMiniProgramAccount,
} from "../api/mini-program-accounts.js";
import { BrowserContextManager } from "../automation/browser-context-manager.js";
import type { ServiceConfig } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { TaskWorkerPool } from "./task-worker-pool.js";

const logger = createLogger("video-account-sync");

export class VideoAccountSyncService {
  private timer: NodeJS.Timeout | undefined;
  private syncing: Promise<void> | undefined;

  constructor(
    private readonly serviceConfig: ServiceConfig,
    private readonly browserContexts: BrowserContextManager,
    private readonly taskWorkerPool: TaskWorkerPool,
    private readonly idlePageRefreshService?: { syncVideoAccounts(): void },
  ) {}

  start(): void {
    if (this.timer || this.serviceConfig.videoAccountSync.intervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.sync().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("sync failed", { errorMessage: message });
      });
    }, this.serviceConfig.videoAccountSync.intervalMs);
    logger.info("started", { intervalMs: this.serviceConfig.videoAccountSync.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sync(): Promise<void> {
    while (this.syncing) await this.syncing;
    const operation = this.syncAccounts();
    this.syncing = operation;
    try {
      await operation;
    } finally {
      if (this.syncing === operation) this.syncing = undefined;
    }
  }

  private async syncAccounts(): Promise<void> {
    const videoAccounts = await fetchWechatMiniProgramAccountsApi();
    this.validateVideoAccounts(videoAccounts);
    const changes = this.browserContexts.syncVideoAccounts(videoAccounts);
    this.taskWorkerPool.syncVideoAccounts(videoAccounts);
    await this.browserContexts.closeRemovedVideoAccounts(changes.removed);
    this.serviceConfig.videoAccounts = videoAccounts;
    this.idlePageRefreshService?.syncVideoAccounts();
    logger.info("synced video accounts", {
      accountCount: videoAccounts.length,
      source: "wechat-mini-program-account-api",
    });

    if (changes.added.length || changes.removed.length || changes.renamed.length) {
      logger.info("video accounts changed", {
        added: changes.added.map((account) => ({
          videoAccountId: account.id,
          videoAccountName: account.name,
        })),
        removed: changes.removed.map((account) => ({
          videoAccountId: account.id,
          videoAccountName: account.name,
        })),
        renamed: changes.renamed.map((change) => ({
          videoAccountId: change.previous.id,
          previousName: change.previous.name,
          nextName: change.next.name,
        })),
      });
    }
  }

  private validateVideoAccounts(videoAccounts: WechatMiniProgramAccount[]): void {
    const accountIds = videoAccounts.map((account) => account.id);
    if (new Set(accountIds).size !== accountIds.length) {
      throw new Error("Video account list must not contain duplicate account ids.");
    }
    if (videoAccounts.some((account) => !account.id || !account.name)) {
      throw new Error("Video account id and name are required.");
    }
  }
}
