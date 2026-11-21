import type { BrowserContext, Page } from "playwright";
import {
  PINDUODUO_DRAMA_PLATFORM,
  PINDUODUO_LOGIN_EXPIRED_URL,
  PINDUODUO_SHORTPLAY_MANAGE_URL,
} from "../shared/constants.js";
import { cleanupOldLogFiles, log } from "../shared/logger.js";
import type {
  PinduoduoDramaRuntime,
  PinduoduoDramaRuntimeOptions,
  PinduoduoDramaRuntimeStatus,
  PinduoduoUploadProgress,
} from "../shared/types.js";
import { pinduoduoTaskPollIntervalMs } from "../shared/polling.js";
import {
  launchPinduoduoBrowserContext,
  pinduoduoDramaLoginStateFromUrl,
  saveCredentialState,
} from "./browser-session.js";
import { runApprovedShortplayCycle } from "./approved-shortplay-cycle.js";
import { PinduoduoUploadQueue } from "./upload-queue.js";

export async function startPinduoduoDramaRuntime(
  options: PinduoduoDramaRuntimeOptions = {},
): Promise<PinduoduoDramaRuntime> {
  if (!options.userDataDir) {
    throw new Error("Pinduoduo drama userDataDir is required.");
  }
  if (!options.uploadRecords) throw new Error("请先连接拼多多飞书任务表");

  const userDataDir = options.userDataDir;
  let running = true;
  let lastError: string | undefined;
  let uploadProgress: PinduoduoUploadProgress | undefined;
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  let taskLoopPromise: Promise<void> | null = null;
  let taskLoopTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeTaskLoop: (() => void) | null = null;
  const stopController = new AbortController();
  const uploadQueue = new PinduoduoUploadQueue(pinduoduoTaskPollIntervalMs(options));
  let lastSubmitAt = 0;
  const cycleOptions: PinduoduoDramaRuntimeOptions = {
    ...options,
    signal: stopController.signal,
    onUploadProgress: progress => { uploadProgress = progress; options.onUploadProgress?.(progress); },
    onFinalSubmit: () => { lastSubmitAt = Date.now(); options.onFinalSubmit?.(); },
  };

  async function waitForNextTaskPoll(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      wakeTaskLoop = resolve;
      taskLoopTimer = setTimeout(resolve, delayMs);
    });
    if (taskLoopTimer) {
      clearTimeout(taskLoopTimer);
      taskLoopTimer = null;
    }
    wakeTaskLoop = null;
  }

  function stopTaskLoopWait(): void {
    if (taskLoopTimer) {
      clearTimeout(taskLoopTimer);
      taskLoopTimer = null;
    }
    wakeTaskLoop?.();
    wakeTaskLoop = null;
  }

  await cleanupOldLogFiles(options).catch(() => undefined);
  log(options, "info", "runtime", "starting browser", {
    userDataDir,
    accountProfileName: options.accountProfileName,
  });
  context = await launchPinduoduoBrowserContext(userDataDir, options);

  context.on("close", () => {
    running = false;
  });
  const labelPage = (target: Page) => {
    target.on("domcontentloaded", () => {
      void target.evaluate((name) => { document.title = `${name} · ${document.title}`; }, options.accountProfileName ?? "拼多多")
        .catch(() => undefined);
    });
  };
  context.on("page", labelPage);
  context.pages().forEach(labelPage);

  page = context.pages()[0] ?? (await context.newPage());
  if (context && page) {
    const cyclePage = page;
    const cycleContext = context;
    taskLoopPromise = (async () => {
      while (running) {
        let cycleFailed = false;
        try {
          if (options.shouldRun && !await options.shouldRun()) {
            await waitForNextTaskPoll(10_000);
            continue;
          }
          const uploaded = await runApprovedShortplayCycle(cyclePage, cycleContext, cycleOptions, uploadQueue);
          lastError = undefined;
          log(options, "info", "runtime", "approved shortplay cycle completed", { uploaded });
        } catch (error: unknown) {
          cycleFailed = true;
          uploadProgress = undefined;
          options.onUploadProgress?.(undefined);
          lastError = error instanceof Error ? error.message : String(error);
          if (stopController.signal.aborted) {
            log(options, "info", "runtime", "approved shortplay cycle stopped by service request");
          } else {
            log(options, "error", "runtime", "approved shortplay cycle failed", { error });
          }
        }
        if (!running) break;
        await waitForNextTaskPoll(cycleFailed ? 15_000 : uploadQueue.nextDelayMs);
      }
    })();
  }

  return {
    getStatus(): PinduoduoDramaRuntimeStatus {
      const activeUrl = page?.url();
      return {
        platform: PINDUODUO_DRAMA_PLATFORM,
        running,
        uploadProgress,
        lastError,
        loginState: pinduoduoDramaLoginStateFromUrl(activeUrl),
        activeUrl,
        manageUrl: PINDUODUO_SHORTPLAY_MANAGE_URL,
        loginExpiredUrl: PINDUODUO_LOGIN_EXPIRED_URL,
        userDataDir,
        accountProfileName: options.accountProfileName,
        accountDir: options.accountDir,
        credentialStatePath: options.credentialStatePath,
        logFilePath: options.logFilePath,
      };
    },
    async stop() {
      running = false;
      stopController.abort(new Error("PINDUODUO_DRAMA_RUNTIME_STOPPED"));
      stopTaskLoopWait();
      const settleRemaining = lastSubmitAt ? Math.max(0, 10_000 - (Date.now() - lastSubmitAt)) : 0;
      if (settleRemaining) await new Promise(resolve => setTimeout(resolve, settleRemaining));
      if (context) {
        await saveCredentialState(context, options).catch(() => undefined);
      }
      await context?.close();
      await taskLoopPromise?.catch(() => undefined);
      log(options, "info", "runtime", "runtime stopped");
    },
  };
}
