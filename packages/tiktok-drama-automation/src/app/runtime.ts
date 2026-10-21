import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  captureAutomationFailureDiagnostics,
  formatDateKey,
} from "@dramabridge/automation-logging";
import type { BrowserContext, Page } from "playwright";
import { config, configureTiktokDramaCenterRuntimeSettings, logger } from "../config.js";
import { formatReadableLogEntry } from "@dramabridge/automation-logging";
import { claimNextTiktokDramaTaskApi } from "../api/index.js";
import { fillDraft, waitForDraftPage } from "../draft-form.js";
import { matchVideos, resolveCoverFile } from "../media.js";
import type { Scheme } from "../scheme.js";

export type TiktokDramaCenterLoginState = "login-required" | "logged-in" | "unknown";

export type TiktokDramaCenterRuntimeStatus = {
  platform: "tiktok-drama";
  running: boolean;
  loginState: TiktokDramaCenterLoginState;
  activeUrl?: string;
  userDataDir: string;
};

export type TiktokDramaCenterRuntime = {
  getStatus: () => TiktokDramaCenterRuntimeStatus;
  stop: () => Promise<void>;
};

type TiktokDramaCenterRuntimeConfig = {
  browser?: {
    headless?: boolean;
    slowMo?: number;
  };
  draftUrl?: string;
  headless?: boolean;
  keepBrowserOpen?: boolean;
  logFile?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  loginUrl?: string;
  postTaskWatchMs?: number;
  schemeApi?: string;
  schemeFile?: string;
  submit?: boolean;
  tempDir?: string;
  userDataDir?: string;
  videoDir?: string;
};

export type TiktokDramaCenterRuntimeOptions = {
  config?: TiktokDramaCenterRuntimeConfig;
  credentialStatePath?: string;
  onLog?: (message: string) => void;
  userDataDir?: string;
};

export async function startTiktokDramaCenterRuntime(
  options: TiktokDramaCenterRuntimeOptions = {},
): Promise<TiktokDramaCenterRuntime> {
  if (!options.userDataDir) {
    throw new Error("TikTok userDataDir is required.");
  }

  const userDataDir = options.userDataDir;
  const runDataDir = runDataDirFromUserDataDir(userDataDir);
  const { browser, ...runtimeSettings } = options.config ?? {};
  const slowMo = browser?.slowMo ?? 20;
  let running = true;
  let page: Page | null = null;
  let context: BrowserContext | null = null;

  configureTiktokDramaCenterRuntimeSettings(
    {
      ...runtimeSettings,
      userDataDir,
      headless: browser?.headless ?? runtimeSettings.headless ?? false,
      logFile:
        runtimeSettings.logFile ?? path.join(runDataDir, "logs", `app-${formatDateKey()}.json`),
      schemeFile: runtimeSettings.schemeFile ?? path.join(runDataDir, "scheme.local.json"),
      tempDir: runtimeSettings.tempDir ?? path.join(runDataDir, "tmp"),
      videoDir: runtimeSettings.videoDir ?? path.join(runDataDir, "videos"),
    },
    options.onLog ? (entry) => options.onLog?.(formatReadableLogEntry(entry)) : undefined,
  );
  await mkdir(userDataDir, { recursive: true });
  log(options, "[tiktok-drama] starting browser");
  context = await launchPlatformBrowserContext(userDataDir, {
    acceptDownloads: true,
    headless: config.headless,
    slowMo,
    timeout: 0,
    viewport: null,
  });
  context.on("close", () => {
    running = false;
  });

  page = context.pages()[0] ?? (await context.newPage());
  void runDraftTask(page, options).catch((error) => {
    log(options, `[tiktok-drama] task failed: ${errorMessage(error)}`);
    logger.error({ err: error }, "task failed");
  });

  return {
    getStatus(): TiktokDramaCenterRuntimeStatus {
      const activeUrl = page?.url();
      return {
        platform: "tiktok-drama",
        running,
        loginState: loginStateFromUrl(activeUrl),
        activeUrl,
        userDataDir,
      };
    },
    async stop() {
      if (context && options.credentialStatePath) {
        await mkdir(path.dirname(options.credentialStatePath), { recursive: true });
        await context.storageState({ path: options.credentialStatePath }).catch(() => undefined);
      }
      running = false;
      await context?.close();
      log(options, "[tiktok-drama] runtime stopped");
    },
  };
}

async function runDraftTask(
  page: Page,
  options: TiktokDramaCenterRuntimeOptions,
) {
  await page.goto(config.draftUrl, { waitUntil: "domcontentloaded" });
  await waitForDraftPage(page);

  logger.info("draft ready; claiming task");
  const task = await claimNextTiktokDramaTaskApi();
  if (!task) {
    logger.info("no tiktok drama task claimed");
    log(options, "[tiktok-drama] no task claimed");
    return;
  }

  const scheme = task.scheme;
  logger.info(
    {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      taskId: scheme.id,
      title: scheme.title,
    },
    "claimed task",
  );
  log(options, `[tiktok-drama] claimed task: ${scheme.title}`);

  try {
    const videos = scheme.baiduPanResourceLink
      ? []
      : await resolveTaskVideos(scheme, task.originalTitle, task.allowMissingVideos);
    const coverFile = await resolveCoverFile(scheme.coverFile, scheme.id);

    logger.info(
      {
        accountTaskId: task.accountTaskId,
        dramaId: task.dramaId,
        taskId: scheme.id,
        title: scheme.title,
        videos: videos.length,
      },
      "starting task",
    );
    const stopWatchingToast = new AbortController();
    try {
      await Promise.race([
        fillDraftAndWait(page, scheme, coverFile, videos),
        watchToast(page, stopWatchingToast.signal),
      ]);
    } finally {
      stopWatchingToast.abort();
    }

    log(options, `[tiktok-drama] task finished: ${scheme.id}`);
  } catch (error) {
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "tiktok-drama",
      error,
      page,
      logFilePath: config.logFile,
      task: {
        accountTaskId: task.accountTaskId,
        dramaId: task.dramaId,
        taskId: scheme.id,
        title: scheme.title,
      },
    });
    logger.error({ diagnosticDir: diagnostics?.directory }, "failure diagnostics saved");
    throw error;
  }
}

async function resolveTaskVideos(
  scheme: Scheme,
  originalTitle: string,
  allowMissingVideos = false,
) {
  try {
    return await matchVideos(config.videoDir, originalTitle, scheme.episodeCount);
  } catch (error) {
    if (!allowMissingVideos) throw error;
    logger.warn(
      {
        err: error,
        taskId: scheme.id,
        originalTitle,
        title: scheme.title,
        videoDir: config.videoDir,
      },
      "video files missing; skipping video upload for fake task",
    );
    return [];
  }
}

async function fillDraftAndWait(
  page: Page,
  scheme: Scheme,
  coverFile: string,
  videos: Awaited<ReturnType<typeof matchVideos>>,
) {
  await fillDraft(page, scheme, coverFile, videos);

  if (scheme.submit || config.submit) {
    await page.getByRole("button", { name: "提交" }).click();
    logger.info({ taskId: scheme.id }, "task submitted");
  } else {
    logger.info({ taskId: scheme.id }, "task finished without submit");
  }
  await page.waitForTimeout(config.postTaskWatchMs);
}

async function watchToast(page: Page, signal: AbortSignal) {
  const portal = page.locator("[data-tux-toast-portal]").last();
  while (!signal.aborted) {
    await Promise.race([
      portal.waitFor({ state: "attached", timeout: 0 }),
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
    if (signal.aborted) return await new Promise<never>(() => {});

    const message = (await portal.innerText()).replace(/\s*复制\s*$/, "").trim();
    if (await clickToastConfirm(page, message)) {
      continue;
    }
    logger.error({ toast: message }, "toast error");
    throw new Error(`toast error: ${message}`);
  }

  return await new Promise<never>(() => {});
}

async function clickToastConfirm(page: Page, message: string) {
  const confirmButton = page.getByRole("button", { name: /^(Confirm|确认|确定)$/i }).last();
  if (!(await confirmButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return false;
  }

  await confirmButton.click();
  logger.warn({ toast: message }, "toast confirmed");
  await page.waitForTimeout(500);
  return true;
}

function loginStateFromUrl(url: string | undefined): TiktokDramaCenterLoginState {
  if (!url || url === "about:blank") return "unknown";

  try {
    return new URL(url).pathname === new URL(config.loginUrl).pathname
      ? "login-required"
      : "logged-in";
  } catch {
    return url.includes("login") ? "login-required" : "logged-in";
  }
}

function runDataDirFromUserDataDir(userDataDir: string) {
  const parent = path.dirname(userDataDir);
  return path.basename(parent) === "auth" ? path.dirname(parent) : parent;
}

function log(_options: TiktokDramaCenterRuntimeOptions, message: string) {
  logger.info(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
