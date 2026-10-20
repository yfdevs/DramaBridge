import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { launchContext, maybePauseForInspection, saveStorageState, waitForLoginIfNeeded } from "./browser-session.js";
import { playletUrl } from "./constants.js";
import { fillBasicInfoStep } from "./steps/basic-info.js";
import { confirmAndMaybeSubmitStep } from "./steps/confirm.js";
import {
  selectUploadedEpisodeFilesStep,
  uploadEpisodeFilesStep,
} from "./steps/episodes.js";
import { loadConfigFromDramaAiRpa, resolveRunDataPath } from "../shared/config.js";
import type { TaskRunOptions } from "../shared/types.js";
import { createLogger, runWithLogContext } from "../shared/logger.js";
import { attachFailStage } from "../shared/errors.js";
import { getWechatMiniProgramRuntimeSettings } from "../shared/runtime-settings.js";
import { booleanSetting, secondsSettingToMs } from "../shared/settings-value.js";
import { cleanupWechatProductionProofMaterials } from "../shared/production-proof-materials.js";
import { captureAutomationFailureDiagnostics } from "@dramabridge/automation-logging";

const publishLogger = createLogger("publish");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runLoggedStep<T>(step: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  publishLogger.info("自动化步骤开始", { step });
  try {
    const result = await action();
    publishLogger.info("自动化步骤完成", {
      step,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    publishLogger.error("自动化步骤失败", {
      step,
      durationMs: Date.now() - startedAt,
      errorMessage: errorMessage(error),
    });
    throw error;
  }
}

function shouldCloseFailedTaskPages(): boolean {
  return booleanSetting(getWechatMiniProgramRuntimeSettings().closeFailedTaskPages);
}

function getBasicInfoStepTimeoutMs(): number {
  return secondsSettingToMs(getWechatMiniProgramRuntimeSettings().basicInfoStepTimeoutSeconds, 600);
}

const episodeSelectionStepTimeoutMs = 5 * 60 * 1000;

async function runStepWithTimeout<T>(
  name: string,
  timeoutMs: number,
  action: () => Promise<T>,
  onTimeout?: () => Promise<void> | void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const actionPromise = action();
  const actionResult = actionPromise.then((value) => ({ type: "action" as const, value }));
  const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ type: "timeout" });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([actionResult, timeoutPromise]);
    if (result.type === "timeout") {
      await onTimeout?.();
      void actionPromise.catch(() => undefined);
      throw new Error(`[step-timeout] ${name} exceeded ${Math.round(timeoutMs / 1000)}s`);
    }
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeTimedOutTaskPage(page: Page, stepName: string): Promise<void> {
  publishLogger.warn("步骤执行超时，正在关闭任务页", { step: stepName });
  await page.close({ runBeforeUnload: false }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    publishLogger.warn("步骤超时后关闭任务页失败", { step: stepName, errorMessage: message });
  });
}

async function openManagedTaskPage(browserContext: BrowserContext): Promise<Page> {
  const previousPages = browserContext.pages();
  const page = await browserContext.newPage();
  if (shouldCloseFailedTaskPages()) {
    await Promise.all(previousPages.map((previousPage) => previousPage.close().catch(() => undefined)));
  } else if (previousPages.length > 0) {
    publishLogger.info("已保留失败任务页", { count: previousPages.length });
  }
  return page;
}

export async function runPlayletTask(runOptions: TaskRunOptions, managedBrowserContext?: BrowserContext): Promise<void> {
  return runWithLogContext({
    videoAccountId: runOptions.channelId,
    videoAccountName: runOptions.videoAccountName,
  }, () => runPlayletTaskInContext(runOptions, managedBrowserContext));
}

async function runPlayletTaskInContext(runOptions: TaskRunOptions, managedBrowserContext?: BrowserContext): Promise<void> {
  const playletConfig = runOptions.playletConfig ?? (runOptions.dramaAiRpaId
    ? await loadConfigFromDramaAiRpa(runOptions.dramaAiRpaId)
    : undefined);
  if (!playletConfig && (!managedBrowserContext || runOptions.mode === "run")) {
    throw new Error("playletConfig or dramaAiRpaId is required to start a run task.");
  }
  await mkdir(resolveRunDataPath(), { recursive: true });
  const standaloneUserDataDir = playletConfig?.browser?.userDataDir ?? ".auth/weixin-miniprogram";
  const standaloneStateFile = path.join(standaloneUserDataDir, "storage-state.json");

  const ownsBrowserContext = managedBrowserContext === undefined;
  let browserContext: BrowserContext;
  if (managedBrowserContext) {
    browserContext = managedBrowserContext;
  } else {
    if (!playletConfig) {
      throw new Error("playletConfig or dramaAiRpaId is required to launch a standalone browser task.");
    }
    browserContext = await launchContext(playletConfig);
  }
  const page = ownsBrowserContext
    ? (browserContext.pages()[0] ?? await browserContext.newPage())
    : await openManagedTaskPage(browserContext);
  let failed = false;

  try {
    try {
      await runLoggedStep("打开小程序管理后台并确认登录", async () => {
        await page.goto(playletUrl, { waitUntil: "domcontentloaded" });
        const loggedIn = await waitForLoginIfNeeded(page);
        if (loggedIn && runOptions.channelId) {
          publishLogger.info("登录状态已保存", { accountId: runOptions.channelId });
        }
      });
    } catch (error) {
      throw attachFailStage(error, "LOGIN");
    }
    if (ownsBrowserContext) await saveStorageState(browserContext, standaloneStateFile);

    if (runOptions.mode === "login") {
      return;
    }
    if (!playletConfig) {
      throw new Error("playletConfig or dramaAiRpaId is required to start a run task.");
    }

    publishLogger.info("小程序发布流程开始", {
      title: playletConfig.playlet.name,
      episodeCount: playletConfig.playlet.episodeCount,
      mode: runOptions.mode,
    });
    try {
      await runLoggedStep(
        "上传剧集到微信小程序素材库",
        () => uploadEpisodeFilesStep(page, playletConfig, {
          episodeVideos: runOptions.preparedEpisodeVideos,
          videoAccountLabel: runOptions.channelId
            ? `videoAccountId=${runOptions.channelId} name=${runOptions.videoAccountName ?? runOptions.channelId}`
            : undefined,
        }),
      );
    } catch (error) {
      throw attachFailStage(error, "UPLOAD_FILE");
    }

    try {
      await runLoggedStep(
        "填写剧目信息",
        () => runStepWithTimeout(
          "fillBasicInfoStep",
          getBasicInfoStepTimeoutMs(),
          () => fillBasicInfoStep(page, playletConfig),
          () => closeTimedOutTaskPage(page, "fillBasicInfoStep"),
        ),
      );
    } catch (error) {
      throw attachFailStage(error, "FILL_FORM");
    }
    try {
      await runLoggedStep(
        "从已上传文件库选择剧集",
        () => runStepWithTimeout(
          "selectUploadedEpisodeFilesStep",
          episodeSelectionStepTimeoutMs,
          () => selectUploadedEpisodeFilesStep(page, playletConfig),
          () => closeTimedOutTaskPage(page, "selectUploadedEpisodeFilesStep"),
        ),
      );
    } catch (error) {
      throw attachFailStage(error, "UPLOAD_FILE");
    }
    try {
      await runLoggedStep("检查并提交审核", async () => {
        if (playletConfig.mockTask) {
          publishLogger.info("模拟任务已完成，跳过最终确认提审");
        } else {
          await confirmAndMaybeSubmitStep(page);
        }
      });
    } catch (error) {
      throw attachFailStage(error, "SUBMIT");
    }
    publishLogger.info("小程序发布流程完成", {
      title: playletConfig.playlet.name,
      episodeCount: playletConfig.playlet.episodeCount,
    });
  } catch (error) {
    failed = true;
    const diagnostics = await captureAutomationFailureDiagnostics({
      platform: "wechat-miniprogram-drama",
      error,
      page,
      runDataDir: resolveRunDataPath(),
      stage:
        typeof error === "object" && error && "failStage" in error
          ? String(error.failStage)
          : undefined,
      task: {
        accountTaskId: runOptions.accountTaskId,
        title: playletConfig?.playlet.name,
        videoAccountId: runOptions.channelId,
        videoAccountName: runOptions.videoAccountName,
      },
    });
    publishLogger.error("失败诊断已保存", {
      diagnosticDir: diagnostics?.directory,
      screenshotFile: diagnostics?.screenshotFile,
    });
    throw error;
  } finally {
    if (playletConfig) {
      await cleanupWechatProductionProofMaterials(playletConfig).catch(() => undefined);
    }
    if (ownsBrowserContext) {
      await saveStorageState(browserContext, standaloneStateFile).catch(() => undefined);
      if (playletConfig) {
        await maybePauseForInspection(runOptions, playletConfig, failed);
      }
      await browserContext.close();
    } else {
      if (shouldCloseFailedTaskPages()) {
        publishLogger.info("当前任务页将在下个任务开始时关闭");
      } else {
        publishLogger.info("已保留当前任务页以便检查");
      }
    }
  }
}
