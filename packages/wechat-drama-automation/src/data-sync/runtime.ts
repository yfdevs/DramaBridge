import { createWechatDataImportClient } from "./import-client.js";
import { assertCompleteStatistics } from "./validation.js";
import { createWriteStream } from "node:fs";
import { resolveDataSyncBrowserExecutable } from "./browser.js";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Download, Locator, Page, Request, Response } from "playwright";
import type {
  WeixinChannelsCustomDateRange,
  WeixinChannelsDatePreset,
  WeixinChannelsSettings,
  WeixinChannelsSyncEvent,
  WeixinChannelsSyncMode,
} from "./types.js";
import {
  clearPromoteDataAnalysisDimensions,
  getPromoteDataAnalysisExactLabelPattern,
  setPromoteDataAnalysisOption,
} from "./options.js";

import type { DarenCenterClient } from "./client.js";
export interface WechatDataSyncHost {
  userDataDirectory: string;
  defaultDownloadDirectory?: string;
  profileRoot: string;
  browsersPath: string;
  dryRun?: boolean;
  closeFailedTaskPages?: boolean;
  launchContext?: typeof import("playwright").chromium.launchPersistentContext;
  client: DarenCenterClient;
  getSettings(): unknown;
  saveSettings(settings: WeixinChannelsSettings): void;
  logger: {
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
    error(message: string, details?: unknown): void;
  };
}
export interface StartWeixinChannelsSyncOptions {
  sendEvent(event: WeixinChannelsSyncEvent): void;
}
// Each runtime owns its jobs and settings snapshot. No business environment variables.
export function createWechatDataSyncRuntime(host: WechatDataSyncHost) {
  const client = createWechatDataImportClient(host.client, host.dryRun === true);

  interface WeixinAuthData {
    errCode: number;
    errMsg?: string;
    data?: {
      finderUser?: {
        nickname?: string;
        uniqId?: string;
      };
      userAttr?: {
        nickname?: string;
      };
    };
  }

  interface ActiveWeixinSyncJob {
    abortController: AbortController;
    mode: WeixinChannelsSyncMode;
    promise: Promise<void>;
  }

  const loginUrl = "https://channels.weixin.qq.com/login.html";
  const promoteLoginUrl = "https://channels.weixin.qq.com/login.html?from=promote";
  const promoteStatisticUrl =
    "https://channels.weixin.qq.com/promote/pages/platform/short-video/promote-statistic";
  const promoteDataAnalysisUrl =
    "https://channels.weixin.qq.com/promote/pages/platform/data-analysis";
  const promoteUserPrepareUrl =
    "https://channels.weixin.qq.com/promote/api/web/transfer/MMFinderPromotionDspApisvr/getUserPrepare";
  const statisticUrl = "https://channels.weixin.qq.com/platform/playlet/statistic";
  const authDataUrl = "https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data";
  const statisticListApiName = "get-finder-native-drama-statistics-list";
  const promoteOrderListApiName = "searchFeedPromotionOrderList";
  const promoteDataAnalysisQueryApiName = "MMFinderPromotionOrderApiSvr/queryIndicator";
  const statisticLoadingSelector = ".common-table-loading";
  const playletExcelTaskName = "助手 · Excel 下载导入";
  const playletExcelTaskType = "weixin-channels-playlet-statistic";
  const playletJsonTaskName = "助手 · JSON 抓取导入";
  const playletJsonTaskType = "weixin-channels-playlet-statistic-json";
  const promoteStatisticTaskName = "加热平台 · 数据明细处理";
  const promoteStatisticTaskType = "weixin-channels-promote-statistic";
  const promoteDataAnalysisTaskName = "加热平台 · 标准看板数据处理";
  const promoteDataAnalysisTaskType = "weixin-channels-promote-standard-analysis";
  const downloadEventTimeoutMs = 120_000;
  const promoteDataAnalysisDateApplyMaxAttempts = 2;
  const promoteDataAnalysisResponseGraceMs = 10_000;
  const statisticDateApplyMaxAttempts = 3;
  const statisticAuthPollIntervalMs = 500;
  const statisticResponseTimeoutMs = 60_000;

  const testImportSourceName = "测试导入数据的来源";
  const syncLogger = host.logger;

  const promoteDataAnalysisDimensionLabels = [
    "订单/计划",
    "按天",
    "短剧组件",
    "加热对象",
    "视频",
    "作者",
    "出价方式",
    "订单类型",
    "创建人",
  ] as const;

  const promoteDataAnalysisIndicatorLabels = [
    "消耗金额",
    "短剧广告变现金额",
    "短剧广告变现ROI",
    "播放数",
  ] as const;

  const promoteDataAnalysisExcludedIndicatorLabels = ["平均千次展示费用"] as const;

  const promoteDataAnalysisDimensionTypes = [
    20_003, // 订单/计划
    10_003, // 按天
    20_015, // 短剧组件
    20_001, // 加热对象
    20_007, // 视频
    20_009, // 作者
    30_002, // 出价方式
    20_004, // 订单类型
    30_003, // 创建人
  ] as const;

  const promoteDataAnalysisIndicatorTypes = [
    200_005, // 消耗金额
    501_008, // 短剧广告变现金额
    501_009, // 短剧广告变现ROI
    201_004, // 播放数
  ] as const;

  const activeJobs = new Map<WeixinChannelsSyncMode, ActiveWeixinSyncJob>();
  const retainedContexts = new Map<string, import("playwright").BrowserContext>();

  const defaultSettings: WeixinChannelsSettings = {
    assistantDatePreset: "previous-day",
    assistantUseTestImportSource: false,
    promoteStandardDatePreset: "previous-day",
    promoteDatePreset: "previous-day",
  };

  function getWeixinChannelsSettings(): WeixinChannelsSettings {
    return normalizeWeixinChannelsSettings(host.getSettings());
  }

  function saveWeixinChannelsSettings(settings: unknown): WeixinChannelsSettings {
    const normalized = normalizeWeixinChannelsSettings(settings);
    for (const group of ["assistant", "promoteStandard"] as const) {
      if (normalized[`${group}DatePreset`] !== "custom") continue;
      const range = normalized[`${group}CustomDateRange`];
      if (!range || range.endDate < range.startDate || range.endDate > formatDate(new Date())) {
        throw new Error("自定义日期无效：请填写完整日期，结束日期不能早于开始日期或晚于今天");
      }
    }
    host.saveSettings(normalized);
    return normalized;
  }

  function normalizeWeixinChannelsSettings(value: unknown): WeixinChannelsSettings {
    const raw = isRecord(value) ? value : {};
    const downloadDirectory =
      typeof raw.downloadDirectory === "string" && raw.downloadDirectory.trim()
        ? path.resolve(raw.downloadDirectory.trim())
        : undefined;

    return {
      assistantCustomDateRange: normalizeCustomDateRange(raw.assistantCustomDateRange),
      assistantDatePreset: normalizeDatePreset(raw.assistantDatePreset),
      assistantUseTestImportSource: raw.assistantUseTestImportSource === true,
      downloadDirectory,
      promoteStandardCustomDateRange: normalizeCustomDateRange(raw.promoteStandardCustomDateRange),
      promoteStandardDatePreset: normalizeDatePreset(raw.promoteStandardDatePreset),
      promoteCustomDateRange: normalizeCustomDateRange(raw.promoteCustomDateRange),
      promoteDatePreset: normalizeDatePreset(raw.promoteDatePreset),
    };
  }

  function normalizeCustomDateRange(value: unknown): WeixinChannelsCustomDateRange | undefined {
    if (!isRecord(value) || !isIsoDate(value.startDate) || !isIsoDate(value.endDate)) {
      return undefined;
    }

    return {
      endDate: value.endDate,
      startDate: value.startDate,
    };
  }

  function isIsoDate(value: unknown): value is string {
    return (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      formatDate(new Date(`${value}T12:00:00`)) === value
    );
  }

  function normalizeDatePreset(value: unknown): WeixinChannelsDatePreset {
    return value === "today" ||
      value === "last-7-days" ||
      value === "month-to-date" ||
      value === "previous-month" ||
      value === "custom"
      ? value
      : defaultSettings.assistantDatePreset;
  }

  function resolveWeixinChannelsDownloadRoot(settings: WeixinChannelsSettings): string {
    return (
      settings.downloadDirectory ??
      host.defaultDownloadDirectory ??
      path.join(host.userDataDirectory, "下载", "微信视频号", "数据同步")
    );
  }

  interface ResolvedDateRange {
    endDate: string;
    label: string;
    startDate: string;
  }

  function resolveDateRange(
    preset: WeixinChannelsDatePreset,
    customRange?: WeixinChannelsCustomDateRange,
  ): ResolvedDateRange {
    if (preset === "custom") {
      if (!customRange || customRange.endDate < customRange.startDate) {
        throw new Error("自定义日期范围无效，请重新配置开始日期和结束日期");
      }

      return {
        ...customRange,
        label:
          customRange.startDate === customRange.endDate
            ? customRange.startDate
            : `${customRange.startDate}至${customRange.endDate}`,
      };
    }

    const today = new Date();
    let start = new Date(today),
      end = new Date(today);
    if (preset === "previous-day") {
      start.setDate(start.getDate() - 1);
      end = new Date(start);
    } else if (preset === "last-7-days") start.setDate(start.getDate() - 6);
    else if (preset === "month-to-date") start.setDate(1);
    else if (preset === "previous-month") {
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      end = new Date(today.getFullYear(), today.getMonth(), 0);
    }
    const startDate = formatDate(start),
      endDate = formatDate(end);
    return {
      startDate,
      endDate,
      label: startDate === endDate ? startDate : `${startDate}至${endDate}`,
    };
  }
  function formatDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function splitDateRangeByDay(range: ResolvedDateRange): ResolvedDateRange[] {
    const result: ResolvedDateRange[] = [];
    const end = new Date(`${range.endDate}T12:00:00`);
    for (
      const day = new Date(`${range.startDate}T12:00:00`);
      day <= end;
      day.setDate(day.getDate() + 1)
    ) {
      const date = formatDate(day);
      result.push({ startDate: date, endDate: date, label: date });
    }
    return result;
  }

  function startWeixinChannelsSync(
    options: StartWeixinChannelsSyncOptions,
    mode: WeixinChannelsSyncMode = "assistant",
  ): {
    mode: WeixinChannelsSyncMode;
    running: boolean;
    started: boolean;
  } {
    const sendEvent = options.sendEvent;
    options = {
      sendEvent: (event) =>
        sendEvent({
          ...event,
          dryRun: host.dryRun === true,
          message:
            host.dryRun && event.type === "imported"
              ? `已验证并保存，未导入：${event.accountName ?? "视频号"}`
              : event.message,
        }),
    };
    const activeJob =
      activeJobs.get(mode) ??
      (mode === "assistant" || mode === "assistant-json"
        ? activeJobs.get(mode === "assistant" ? "assistant-json" : "assistant")
        : undefined);
    if (activeJob) {
      syncLogger.info("Weixin Channels sync start requested while job is already running");
      return {
        mode,
        running: true,
        started: false,
      };
    }

    const abortController = new AbortController();
    const runPromise =
      mode === "promote"
        ? runWeixinPromoteSyncLoop(options, abortController.signal)
        : mode === "promote-standard"
          ? runWeixinPromoteDataAnalysisSyncLoop(options, abortController.signal)
          : runWeixinChannelsSyncLoop(options, abortController.signal, mode);
    let failureMessage: string | undefined;
    const promise = runPromise
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (abortController.signal.aborted) return;
        failureMessage = message;
        syncLogger.error("Weixin Channels sync failed", { error: message });
        options.sendEvent({
          message,
          mode,
          type: "error",
        });
      })
      .finally(() => {
        activeJobs.delete(mode);
        options.sendEvent({
          message: failureMessage
            ? `视频号同步失败，任务已停止：${failureMessage}`
            : "视频号同步任务已停止",
          mode,
          type: "stopped",
        });
      });

    activeJobs.set(mode, {
      abortController,
      mode,
      promise,
    });

    syncLogger.info("Weixin Channels sync job started", { mode });
    options.sendEvent({
      message:
        mode === "promote-standard"
          ? "加热平台标准数据分析任务已启动"
          : mode === "promote"
            ? "加热平台数据处理任务已启动"
            : mode === "assistant-json"
              ? "助手 JSON 数据抓取任务已启动"
              : "助手 Excel 数据下载任务已启动",
      mode,
      type: "started",
    });

    return {
      mode,
      running: true,
      started: true,
    };
  }

  async function stopWeixinChannelsSync(
    mode?: WeixinChannelsSyncMode,
  ): Promise<{ stopped: boolean }> {
    const selectedJob = mode ? activeJobs.get(mode) : undefined;
    const jobs: ActiveWeixinSyncJob[] = mode
      ? selectedJob
        ? [selectedJob]
        : []
      : [...activeJobs.values()];

    if (!mode) {
      await Promise.all(
        [...retainedContexts.values()].map((context) => context.close().catch(() => undefined)),
      );
      retainedContexts.clear();
    }
    if (jobs.length === 0) {
      syncLogger.info("Weixin Channels sync stop requested without an active job");
      return {
        stopped: false,
      };
    }

    syncLogger.info("Stopping Weixin Channels sync job");
    for (const job of jobs) {
      job.abortController.abort();
    }
    await Promise.all(jobs.map((job) => job.promise));

    return {
      stopped: true,
    };
  }

  async function runWeixinChannelsSyncLoop(
    options: StartWeixinChannelsSyncOptions,
    signal: AbortSignal,
    mode: "assistant" | "assistant-json",
  ): Promise<void> {
    const task =
      mode === "assistant-json"
        ? {
            mode,
            taskName: playletJsonTaskName,
            taskType: playletJsonTaskType,
          }
        : {
            mode,
            taskName: playletExcelTaskName,
            taskType: playletExcelTaskType,
          };
    const processedUniqIds = new Set<string>();
    const settings = getWeixinChannelsSettings();
    const dateRange = resolveDateRange(
      settings.assistantDatePreset,
      settings.assistantCustomDateRange,
    );
    const profileRoot = host.profileRoot;
    const profilePath = path.join(profileRoot, "wechat-drama-data-sync", "operator-1");
    const downloadDirectory = path.join(resolveWeixinChannelsDownloadRoot(settings), mode === "assistant-json" ? "助手统计JSON" : "助手数据Excel");
    const temporaryDownloadDirectory = path.join(downloadDirectory, ".playwright");

    await mkdir(downloadDirectory, { recursive: true });
    await mkdir(temporaryDownloadDirectory, { recursive: true });
    syncLogger.info("Weixin Channels sync runtime prepared", {
      downloadDirectory,
      profilePath,
      temporaryDownloadDirectory,
    });

    await retainedContexts
      .get(profilePath)
      ?.close()
      .catch(() => undefined);
    retainedContexts.delete(profilePath);
    const { chromium } = await import("playwright");
    syncLogger.info("Launching Weixin Channels browser", {
      browsersPath: host.browsersPath,
    });
    const context = await (host.launchContext ?? chromium.launchPersistentContext.bind(chromium))(
      profilePath,
      {
        executablePath: host.launchContext
          ? undefined
          : resolveDataSyncBrowserExecutable(host.browsersPath),
        acceptDownloads: true,
        downloadsPath: temporaryDownloadDirectory,
        headless: false,
      },
    );
    if (signal.aborted) {
      await context.close();
      return;
    }
    const page = context.pages()[0] ?? (await context.newPage());

    signal.addEventListener(
      "abort",
      () => {
        void context.close().catch(() => undefined);
      },
      { once: true },
    );

    let completedNormally = false;
    try {
      while (!signal.aborted) {
        syncLogger.info("Preparing next Weixin Channels login");
        await prepareNextLogin(page);
        options.sendEvent({
          message: "请在打开的微信视频号登录页扫码",
          ...task,
          type: "waiting-for-scan",
        });

        await waitForLoginPageCompleted(page, signal);
        syncLogger.info("Weixin Channels login page completed; opening statistic page");
        options.sendEvent({
          message: "扫码完成，正在进入数据页确认视频号身份",
          ...task,
          type: "logged-in",
        });

        syncLogger.info("Opening Weixin Channels statistic page", {
          statisticUrl,
        });
        await page.goto(statisticUrl, {
          waitUntil: "domcontentloaded",
        });
        const [statisticAuthData] = await Promise.all([
          waitForStatisticAuthData(page, signal),
          waitForStatisticPageReady(page),
        ]);
        const { accountName, uniqId } = extractAccountInfo(statisticAuthData);
        const targetDate = dateRange.label;

        if (!uniqId) {
          const failureReason = "未获取到视频号 uniqId，为避免重复处理已跳过";
          syncLogger.warn("Skipping Weixin Channels account without uniqId", {
            accountName,
            targetDate,
          });
          options.sendEvent({
            accountName,
            failureReason,
            message: `处理失败：${accountName}（${failureReason}）`,
            ...task,
            targetDate,
            timestamp: new Date().toISOString(),
            type: "account-failed",
          });
          await signOutAccount(page, options, { accountName }, task);
          continue;
        }

        if (processedUniqIds.has(uniqId)) {
          const failureReason = "本次任务已处理过该视频号，已跳过重复下载和导入";
          syncLogger.warn("Skipping duplicate Weixin Channels account in current job", {
            accountName,
            targetDate,
            uniqId,
          });
          options.sendEvent({
            accountName,
            failureReason,
            message: `处理失败：${accountName}（${failureReason}）`,
            ...task,
            targetDate,
            timestamp: new Date().toISOString(),
            type: "account-failed",
            uniqId,
          });
          await signOutAccount(page, options, { accountName, uniqId }, task);
          continue;
        }

        processedUniqIds.add(uniqId);
        syncLogger.info("Registered Weixin Channels account in current job", {
          accountName,
          processedAccountCount: processedUniqIds.size,
          uniqId,
        });

        syncLogger.info("Using Weixin Channels account info for download/import", {
          accountName,
          targetDate,
          uniqId,
        });
        if (mode === "assistant") {
          try {
            await setPlayletStatisticDateRangeWithRetry(page, dateRange, signal);
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }

            const failureReason = `目标日期数据加载失败：${error instanceof Error ? error.message : String(error)}`;
            syncLogger.error("Failed to load target Weixin Channels statistic date", {
              accountName,
              error: failureReason,
              targetDate,
              uniqId,
            });
            options.sendEvent({
              accountName,
              failureReason,
              message: `处理失败：${accountName}（${failureReason}）`,
              ...task,
              targetDate,
              timestamp: new Date().toISOString(),
              type: "account-failed",
              uniqId,
            });
            if (!host.closeFailedTaskPages) throw error;
            await signOutAccount(page, options, { accountName, uniqId }, task);
            continue;
          }

          let failureStage = "数据下载或保存";
          try {
            syncLogger.info("Starting Weixin Channels statistic Excel download", {
              accountName,
              targetDate,
              uniqId,
            });
            const download = await downloadStatisticFile(page, targetDate);
            const savedFile = await saveDownloadedFile(download, {
              accountName,
              downloadDirectory,
              filenamePrefix: "助手",
              targetDate,
              uniqId,
            });

            syncLogger.info("Weixin Channels statistic Excel download saved", {
              accountName,
              bytes: savedFile.bytes,
              filePath: savedFile.filePath,
              filename: savedFile.filename,
              suggestedFilename: savedFile.suggestedFilename,
              targetDate,
              uniqId,
            });
            options.sendEvent({
              accountName,
              filePath: savedFile.filePath,
              message: `Excel 下载完成：${savedFile.filename}`,
              ...task,
              targetDate,
              type: "downloaded",
              uniqId,
            });

            syncLogger.info("Importing Weixin Channels statistic Excel into Daren Center", {
              accountName,
              filePath: savedFile.filePath,
              targetDate,
              uniqId,
            });
            failureStage = "数据导入";
            const importedAt = new Date().toISOString();
            const importResult = await importAssistantExcelFile(savedFile, {
              signal,
              sourceName: settings.assistantUseTestImportSource
                ? testImportSourceName
                : accountName,
            });

            syncLogger.info("Weixin Channels statistic Excel import completed", {
              accountName,
              body: importResult.result.body,
              filePath: savedFile.filePath,
              sourceId: importResult.sourceId,
              status: importResult.result.status,
              statusText: importResult.result.statusText,
              targetDate,
              uniqId,
            });
            options.sendEvent({
              accountName,
              filename: savedFile.filename,
              filePath: savedFile.filePath,
              message: `Excel 导入完成：${accountName}`,
              result: importResult.result.body,
              sourceId: importResult.sourceId,
              ...task,
              targetDate,
              timestamp: importedAt,
              type: "imported",
              uniqId,
            });
          } catch (error) {
            if (!signal.aborted) {
              const failureReason = `助手 Excel ${failureStage}失败：${error instanceof Error ? error.message : String(error)}`;
              options.sendEvent({
                accountName,
                failureReason,
                message: `处理失败：${accountName}（${targetDate}，${failureReason}）`,
                ...task,
                targetDate,
                timestamp: new Date().toISOString(),
                type: "account-failed",
                uniqId,
              });
            }
            throw error;
          }

          await signOutAccount(page, options, { accountName, uniqId }, task);
          continue;
        }

        for (const dailyRange of splitDateRangeByDay(dateRange)) {
          const dailyTargetDate = dailyRange.label;
          let statisticResponse: Response;
          try {
            statisticResponse = await setPlayletStatisticDateRangeWithRetry(
              page,
              dailyRange,
              signal,
            );
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }

            const failureReason = `目标日期数据加载失败：${error instanceof Error ? error.message : String(error)}`;
            syncLogger.error("Failed to load daily Weixin Channels statistic date", {
              accountName,
              error: failureReason,
              targetDate: dailyTargetDate,
              uniqId,
            });
            options.sendEvent({
              accountName,
              failureReason,
              message: `处理失败：${accountName}（${dailyTargetDate}，${failureReason}）`,
              ...task,
              targetDate: dailyTargetDate,
              timestamp: new Date().toISOString(),
              type: "account-failed",
              uniqId,
            });
            break;
          }

          let failureStage = "数据抓取或保存";
          try {
            syncLogger.info("Fetching complete daily Weixin Channels drama statistics", {
              accountName,
              targetDate: dailyTargetDate,
              uniqId,
            });
            const statisticData = await fetchCompleteStatisticData(page, statisticResponse);
            const savedFile = await saveStatisticJson(statisticData.body, {
              accountName,
              downloadDirectory,
              targetDate: dailyTargetDate,
              uniqId,
            });

            syncLogger.info("Weixin Channels daily drama statistics JSON saved", {
              accountName,
              bytes: savedFile.bytes,
              fetchedCount: statisticData.fetchedCount,
              filePath: savedFile.filePath,
              filename: savedFile.filename,
              targetDate: dailyTargetDate,
              totalCount: statisticData.totalCount,
              uniqId,
            });
            options.sendEvent({
              accountName,
              fetchedCount: statisticData.fetchedCount,
              filePath: savedFile.filePath,
              message: `抓取完成：${savedFile.filename}（${statisticData.totalCount} 条）`,
              ...task,
              targetDate: dailyTargetDate,
              totalCount: statisticData.totalCount,
              type: "downloaded",
              uniqId,
            });

            const statisticTime = dailyRange.startDate;
            syncLogger.info("Importing daily Weixin Channels drama statistics into Daren Center", {
              accountName,
              filePath: savedFile.filePath,
              statisticTime,
              targetDate: dailyTargetDate,
              totalCount: statisticData.totalCount,
              uniqId,
            });
            failureStage = "数据导入";
            const importedAt = new Date().toISOString();
            const importResult = await client.ingestWeChatDramaStatistics(
              {
                ...statisticData.ingestPayload,
                statisticTime,
                wechatVideoAccountName: accountName,
              },
              signal,
            );

            syncLogger.info("Weixin Channels daily drama statistics ingest completed", {
              accountName,
              body: importResult.body,
              filePath: savedFile.filePath,
              statisticTime,
              status: importResult.status,
              statusText: importResult.statusText,
              targetDate: dailyTargetDate,
              totalCount: statisticData.totalCount,
              uniqId,
            });
            options.sendEvent({
              accountName,
              fetchedCount: statisticData.fetchedCount,
              filename: savedFile.filename,
              filePath: savedFile.filePath,
              message: `导入完成：${accountName}（${dailyTargetDate}，${statisticData.fetchedCount} / ${statisticData.totalCount} 条）`,
              ...task,
              targetDate: dailyTargetDate,
              timestamp: importedAt,
              totalCount: statisticData.totalCount,
              type: "imported",
              uniqId,
              result: importResult.body,
            });
          } catch (error) {
            if (!signal.aborted) {
              const failureReason = `助手表格${failureStage}失败：${error instanceof Error ? error.message : String(error)}`;
              options.sendEvent({
                accountName,
                failureReason,
                message: `处理失败：${accountName}（${dailyTargetDate}，${failureReason}）`,
                ...task,
                targetDate: dailyTargetDate,
                timestamp: new Date().toISOString(),
                type: "account-failed",
                uniqId,
              });
            }
            throw error;
          }
        }

        await signOutAccount(page, options, { accountName, uniqId }, task);
      }
      completedNormally = true;
    } finally {
      syncLogger.info("Closing Weixin Channels browser context");
      if (signal.aborted || completedNormally || host.closeFailedTaskPages) {
        await context.close().catch(() => undefined);
      } else {
        retainedContexts.set(profilePath, context);
        context.once("close", () => {
          if (retainedContexts.get(profilePath) === context) retainedContexts.delete(profilePath);
        });
      }
    }
  }

  async function runWeixinPromoteDataAnalysisSyncLoop(
    options: StartWeixinChannelsSyncOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const processedUniqIds = new Set<string>();
    const settings = getWeixinChannelsSettings();
    const dateRange = resolveDateRange(
      settings.promoteStandardDatePreset,
      settings.promoteStandardCustomDateRange,
    );
    const profileRoot = host.profileRoot;
    const profilePath = path.join(
      profileRoot,
      "wechat-drama-data-sync",
      "promote-standard-operator-1",
    );
    const downloadDirectory = path.join(resolveWeixinChannelsDownloadRoot(settings), "加热标准看板CSV");
    const temporaryDownloadDirectory = path.join(downloadDirectory, ".playwright");

    await mkdir(downloadDirectory, { recursive: true });
    await mkdir(temporaryDownloadDirectory, { recursive: true });
    syncLogger.info("Weixin Channels standard data analysis runtime prepared", {
      downloadDirectory,
      profilePath,
      temporaryDownloadDirectory,
    });

    await retainedContexts
      .get(profilePath)
      ?.close()
      .catch(() => undefined);
    retainedContexts.delete(profilePath);
    const { chromium } = await import("playwright");
    const context = await (host.launchContext ?? chromium.launchPersistentContext.bind(chromium))(
      profilePath,
      {
        executablePath: host.launchContext
          ? undefined
          : resolveDataSyncBrowserExecutable(host.browsersPath),
        acceptDownloads: true,
        downloadsPath: temporaryDownloadDirectory,
        headless: false,
      },
    );
    if (signal.aborted) {
      await context.close();
      return;
    }
    const page = context.pages()[0] ?? (await context.newPage());

    signal.addEventListener(
      "abort",
      () => {
        void context.close().catch(() => undefined);
      },
      { once: true },
    );

    let completedNormally = false;
    try {
      while (!signal.aborted) {
        syncLogger.info("Preparing next Weixin Channels standard data analysis login");
        await prepareNextLogin(page, promoteLoginUrl);
        options.sendEvent({
          message: "请在打开的微信视频号加热平台登录页扫码",
          mode: "promote-standard",
          taskName: promoteDataAnalysisTaskName,
          taskType: promoteDataAnalysisTaskType,
          type: "waiting-for-scan",
        });

        await waitForLoginPageCompleted(page, signal);
        options.sendEvent({
          message: "扫码完成，正在进入加热平台标准数据分析页",
          mode: "promote-standard",
          taskName: promoteDataAnalysisTaskName,
          taskType: promoteDataAnalysisTaskType,
          type: "logged-in",
        });

        syncLogger.info("Opening Weixin Channels standard data analysis page", {
          promoteDataAnalysisUrl,
        });
        await page.goto(promoteDataAnalysisUrl, {
          waitUntil: "domcontentloaded",
        });
        await waitForPromoteDataAnalysisPageReady(page);
        const { accountName, uniqId } = await fetchPromoteAccountInfo(page);
        const targetDate = dateRange.label;

        const isDuplicateAccount = Boolean(uniqId && processedUniqIds.has(uniqId));
        if (!uniqId || isDuplicateAccount) {
          const failureReason = !uniqId
            ? "未获取到视频号 uniqId，为避免重复处理已跳过"
            : "本次任务已处理过该视频号，已跳过重复下载";
          options.sendEvent({
            accountName,
            failureReason,
            message: `处理失败：${accountName}（${failureReason}）`,
            mode: "promote-standard",
            taskName: promoteDataAnalysisTaskName,
            taskType: promoteDataAnalysisTaskType,
            targetDate,
            timestamp: new Date().toISOString(),
            type: "account-failed",
            uniqId: uniqId || undefined,
          });
          await signOutAccount(
            page,
            options,
            { accountName, uniqId: uniqId || undefined },
            {
              mode: "promote-standard",
              taskName: promoteDataAnalysisTaskName,
              taskType: promoteDataAnalysisTaskType,
            },
          );
          continue;
        }

        processedUniqIds.add(uniqId);
        syncLogger.info(
          "Registered Weixin Channels standard data analysis account in current job",
          {
            accountName,
            processedAccountCount: processedUniqIds.size,
            uniqId,
          },
        );

        try {
          await setPromoteDataAnalysisDateRangeWithRetry(page, dateRange, signal);
          await configurePromoteDataAnalysisDetail(page, dateRange);
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }

          syncLogger.warn("Weixin Channels standard data analysis preparation failed", {
            accountName,
            error: error instanceof Error ? error.message : String(error),
            targetDate,
            uniqId,
          });
          const failureReason = `标准看板数据准备失败：${error instanceof Error ? error.message : String(error)}`;
          options.sendEvent({
            accountName,
            failureReason,
            message: `处理失败：${accountName}（${failureReason}）`,
            mode: "promote-standard",
            taskName: promoteDataAnalysisTaskName,
            taskType: promoteDataAnalysisTaskType,
            targetDate,
            timestamp: new Date().toISOString(),
            type: "account-failed",
            uniqId,
          });
          if (!host.closeFailedTaskPages) throw error;
          await signOutAccount(
            page,
            options,
            { accountName, uniqId },
            {
              mode: "promote-standard",
              taskName: promoteDataAnalysisTaskName,
              taskType: promoteDataAnalysisTaskType,
            },
          );
          continue;
        }

        let failureStage = "数据下载或校验";
        try {
          const download = await downloadPromoteDataAnalysisFile(page, targetDate, dateRange);
          const savedFile = await saveDownloadedFile(download, {
            accountName,
            downloadDirectory,
            filenamePrefix: "加热平台标准看板",
            targetDate,
            uniqId,
          });
          await assertPromoteDataAnalysisDownloadHasRows(savedFile.filePath);
          syncLogger.info("Weixin Channels standard data analysis download saved", {
            accountName,
            bytes: savedFile.bytes,
            filePath: savedFile.filePath,
            filename: savedFile.filename,
            targetDate,
            uniqId,
          });
          options.sendEvent({
            accountName,
            filePath: savedFile.filePath,
            message: `加热平台标准看板数据下载完成：${savedFile.filename}`,
            mode: "promote-standard",
            taskName: promoteDataAnalysisTaskName,
            taskType: promoteDataAnalysisTaskType,
            targetDate,
            type: "downloaded",
            uniqId,
          });

          failureStage = "数据导入";
          const importedAt = new Date().toISOString();
          const importResult = await importPromoteDataAnalysisFile(savedFile, {
            signal,
            accountName,
            uniqId,
          });
          options.sendEvent({
            accountName,
            filename: savedFile.filename,
            filePath: savedFile.filePath,
            message: `加热平台标准看板数据导入完成：${accountName}`,
            mode: "promote-standard",
            taskName: promoteDataAnalysisTaskName,
            taskType: promoteDataAnalysisTaskType,
            targetDate,
            timestamp: importedAt,
            type: "imported",
            uniqId,
            result: importResult.body,
          });
        } catch (error) {
          if (!signal.aborted) {
            const failureReason = `标准看板${failureStage}失败：${error instanceof Error ? error.message : String(error)}`;
            options.sendEvent({
              accountName,
              failureReason,
              message: `处理失败：${accountName}（${failureReason}）`,
              mode: "promote-standard",
              taskName: promoteDataAnalysisTaskName,
              taskType: promoteDataAnalysisTaskType,
              targetDate,
              timestamp: new Date().toISOString(),
              type: "account-failed",
              uniqId,
            });
          }
          throw error;
        }

        await signOutAccount(
          page,
          options,
          { accountName, uniqId },
          {
            mode: "promote-standard",
            taskName: promoteDataAnalysisTaskName,
            taskType: promoteDataAnalysisTaskType,
          },
        );
      }
      completedNormally = true;
    } finally {
      syncLogger.info("Closing Weixin Channels standard data analysis browser context");
      if (signal.aborted || completedNormally || host.closeFailedTaskPages) {
        await context.close().catch(() => undefined);
      } else {
        retainedContexts.set(profilePath, context);
        context.once("close", () => {
          if (retainedContexts.get(profilePath) === context) retainedContexts.delete(profilePath);
        });
      }
    }
  }

  async function runWeixinPromoteSyncLoop(
    options: StartWeixinChannelsSyncOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const processedUniqIds = new Set<string>();
    const settings = getWeixinChannelsSettings();
    const dateRange = resolveDateRange(settings.promoteDatePreset, settings.promoteCustomDateRange);
    const profileRoot = host.profileRoot;
    const profilePath = path.join(profileRoot, "wechat-drama-data-sync", "promote-operator-1");
    const downloadDirectory = path.join(resolveWeixinChannelsDownloadRoot(settings), "加热推广数据");
    const temporaryDownloadDirectory = path.join(downloadDirectory, ".playwright");

    await mkdir(downloadDirectory, { recursive: true });
    await mkdir(temporaryDownloadDirectory, { recursive: true });
    syncLogger.info("Weixin Channels promote runtime prepared", {
      downloadDirectory,
      profilePath,
      temporaryDownloadDirectory,
    });

    await retainedContexts
      .get(profilePath)
      ?.close()
      .catch(() => undefined);
    retainedContexts.delete(profilePath);
    const { chromium } = await import("playwright");
    const context = await (host.launchContext ?? chromium.launchPersistentContext.bind(chromium))(
      profilePath,
      {
        executablePath: host.launchContext
          ? undefined
          : resolveDataSyncBrowserExecutable(host.browsersPath),
        acceptDownloads: true,
        downloadsPath: temporaryDownloadDirectory,
        headless: false,
      },
    );
    if (signal.aborted) {
      await context.close();
      return;
    }
    const page = context.pages()[0] ?? (await context.newPage());

    signal.addEventListener(
      "abort",
      () => {
        void context.close().catch(() => undefined);
      },
      { once: true },
    );

    let completedNormally = false;
    try {
      while (!signal.aborted) {
        syncLogger.info("Preparing next Weixin Channels promote login");
        await prepareNextLogin(page, promoteLoginUrl);
        options.sendEvent({
          message: "请在打开的微信视频号加热平台登录页扫码",
          mode: "promote",
          taskName: promoteStatisticTaskName,
          taskType: promoteStatisticTaskType,
          type: "waiting-for-scan",
        });

        await waitForLoginPageCompleted(page, signal);
        options.sendEvent({
          message: "扫码完成，正在进入加热平台数据明细页",
          mode: "promote",
          taskName: promoteStatisticTaskName,
          taskType: promoteStatisticTaskType,
          type: "logged-in",
        });

        syncLogger.info("Opening Weixin Channels promote statistic page", {
          promoteStatisticUrl,
        });
        await page.goto(promoteStatisticUrl, {
          waitUntil: "domcontentloaded",
        });
        await waitForPromoteStatisticPageReady(page);
        const { accountName, uniqId } = await fetchPromoteAccountInfo(page);
        const targetDate = dateRange.label;

        if (!uniqId || processedUniqIds.has(uniqId)) {
          const failureReason = !uniqId
            ? "未获取到视频号 uniqId，为避免重复处理已跳过"
            : "本次任务已处理过该视频号，已跳过重复下载";
          options.sendEvent({
            accountName,
            failureReason,
            message: `处理失败：${accountName}（${failureReason}）`,
            mode: "promote",
            taskName: promoteStatisticTaskName,
            taskType: promoteStatisticTaskType,
            targetDate,
            timestamp: new Date().toISOString(),
            type: "account-failed",
            uniqId: uniqId || undefined,
          });
          await signOutAccount(
            page,
            options,
            { accountName, uniqId: uniqId || undefined },
            {
              mode: "promote",
              taskName: promoteStatisticTaskName,
              taskType: promoteStatisticTaskType,
            },
          );
          continue;
        }

        processedUniqIds.add(uniqId);
        syncLogger.info("Registered Weixin Channels promote account in current job", {
          accountName,
          processedAccountCount: processedUniqIds.size,
          uniqId,
        });

        try {
          await setPromoteStatisticDateRangeWithRetry(page, dateRange, signal);
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }

          const failureReason = `目标日期数据加载失败：${error instanceof Error ? error.message : String(error)}`;
          options.sendEvent({
            accountName,
            failureReason,
            message: `处理失败：${accountName}（${failureReason}）`,
            mode: "promote",
            taskName: promoteStatisticTaskName,
            taskType: promoteStatisticTaskType,
            targetDate,
            timestamp: new Date().toISOString(),
            type: "account-failed",
            uniqId,
          });
          await signOutAccount(
            page,
            options,
            { accountName, uniqId },
            {
              mode: "promote",
              taskName: promoteStatisticTaskName,
              taskType: promoteStatisticTaskType,
            },
          );
          continue;
        }

        const download = await downloadPromoteStatisticFile(page, targetDate);
        const savedFile = await saveDownloadedFile(download, {
          accountName,
          downloadDirectory,
          filenamePrefix: "加热平台",
          targetDate,
          uniqId,
        });
        syncLogger.info("Weixin Channels promote statistic download saved", {
          accountName,
          bytes: savedFile.bytes,
          filePath: savedFile.filePath,
          filename: savedFile.filename,
          targetDate,
          uniqId,
        });
        options.sendEvent({
          accountName,
          filePath: savedFile.filePath,
          message: `加热平台数据下载完成：${savedFile.filename}`,
          mode: "promote",
          taskName: promoteStatisticTaskName,
          taskType: promoteStatisticTaskType,
          targetDate,
          type: "downloaded",
          uniqId,
        });

        const importedAt = new Date().toISOString();
        const importResult = await importPromoteStatisticFile(savedFile, {
          signal,
          accountName,
          uniqId,
        });
        options.sendEvent({
          accountName,
          filename: savedFile.filename,
          filePath: savedFile.filePath,
          message: `加热平台数据导入完成：${accountName}`,
          mode: "promote",
          taskName: promoteStatisticTaskName,
          taskType: promoteStatisticTaskType,
          targetDate,
          timestamp: importedAt,
          type: "imported",
          uniqId,
          result: importResult.body,
        });

        await signOutAccount(
          page,
          options,
          { accountName, uniqId },
          {
            mode: "promote",
            taskName: promoteStatisticTaskName,
            taskType: promoteStatisticTaskType,
          },
        );
      }
      completedNormally = true;
    } finally {
      syncLogger.info("Closing Weixin Channels promote browser context");
      if (signal.aborted || completedNormally || host.closeFailedTaskPages) {
        await context.close().catch(() => undefined);
      } else {
        retainedContexts.set(profilePath, context);
        context.once("close", () => {
          if (retainedContexts.get(profilePath) === context) retainedContexts.delete(profilePath);
        });
      }
    }
  }

  async function prepareNextLogin(page: Page, targetLoginUrl = loginUrl): Promise<void> {
    syncLogger.info("Clearing cookies and storage before login page");
    await clearLoginState(page);
    syncLogger.info("Navigating to Weixin Channels login page", { loginUrl: targetLoginUrl });
    await page.goto(targetLoginUrl, {
      waitUntil: "domcontentloaded",
    });
  }

  async function waitForStatisticPageReady(page: Page): Promise<void> {
    syncLogger.info("Waiting for Weixin Channels statistic page to finish loading");

    await page.waitForLoadState("domcontentloaded", {
      timeout: 30_000,
    });

    await page.getByText("下载数据").waitFor({
      state: "visible",
      timeout: 180_000,
    });

    syncLogger.info("Weixin Channels statistic page outer download button is visible");
  }

  async function setPlayletStatisticDateRange(
    page: Page,
    range: ResolvedDateRange,
  ): Promise<Response> {
    syncLogger.info("Setting Weixin Channels playlet statistic date range", {
      endDate: range.endDate,
      startDate: range.startDate,
    });

    const dateRange = await findPlayletStatisticDateRange(page);

    syncLogger.info("Weixin Channels playlet statistic date inputs located", {
      scope: dateRange.scope,
    });

    await waitForStatisticLoadingDetached(page, "before date range change");

    const expectedRange = getStatisticTimestampRange(range);
    syncLogger.info("Waiting for target Weixin Channels statistic response", {
      endTs: expectedRange.endTs,
      startTs: expectedRange.startTs,
      targetDate: range.label,
    });
    const targetResponsePromise = page.waitForResponse(
      (response) => {
        if (!isStatisticListRequest(response.request())) {
          return false;
        }

        const body = parseStatisticRequestBody(response.request());
        const matchesTarget = Boolean(
          body &&
          String(body.startTs) === expectedRange.startTs &&
          String(body.endTs) === expectedRange.endTs,
        );

        syncLogger.info("Observed Weixin Channels statistic response", {
          currentPage: body?.currentPage,
          endTs: body?.endTs,
          matchesTarget,
          startTs: body?.startTs,
          status: response.status(),
          targetEndTs: expectedRange.endTs,
          targetStartTs: expectedRange.startTs,
        });

        return matchesTarget;
      },
      {
        timeout: statisticResponseTimeoutMs,
      },
    );

    const onStatisticRequest = (request: Request) => {
      if (!isStatisticListRequest(request)) {
        return;
      }

      const body = parseStatisticRequestBody(request);
      syncLogger.info("Observed Weixin Channels statistic request", {
        currentPage: body?.currentPage,
        endTs: body?.endTs,
        startTs: body?.startTs,
        targetEndTs: expectedRange.endTs,
        targetStartTs: expectedRange.startTs,
      });
    };
    page.on("request", onStatisticRequest);

    let targetResponse: Response;
    try {
      [targetResponse] = await Promise.all([
        targetResponsePromise,
        setDateRangeInputsDirectly(dateRange.root, range),
      ]);
    } finally {
      page.off("request", onStatisticRequest);
    }

    const [actualStartDate, actualEndDate] = await Promise.all([
      dateRange.startInput.inputValue(),
      dateRange.endInput.inputValue(),
    ]);

    if (actualStartDate !== range.startDate || actualEndDate !== range.endDate) {
      throw new Error(
        `视频号剧集统计日期设置失败：期望 ${range.startDate} 至 ${range.endDate}，实际 ${actualStartDate || "空"} 至 ${
          actualEndDate || "空"
        }`,
      );
    }

    if (!targetResponse.ok()) {
      throw new Error(
        `视频号剧集统计数据请求失败：HTTP ${targetResponse.status()} ${targetResponse.statusText()}`,
      );
    }

    const responseFailure = await targetResponse.finished();
    if (responseFailure) {
      throw new Error(`视频号剧集统计数据响应接收失败：${responseFailure.message}`);
    }

    await assertStatisticResponseSucceeded(targetResponse);
    await waitForStatisticLoadingDetached(page, "after target date response");

    await page.getByText("下载数据").waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });

    syncLogger.info("Weixin Channels playlet statistic date range applied", {
      endDate: actualEndDate,
      endTs: expectedRange.endTs,
      startDate: actualStartDate,
      startTs: expectedRange.startTs,
    });

    return targetResponse;
  }

  async function setPlayletStatisticDateRangeWithRetry(
    page: Page,
    range: ResolvedDateRange,
    signal: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= statisticDateApplyMaxAttempts; attempt += 1) {
      try {
        return await setPlayletStatisticDateRange(page, range);
      } catch (error) {
        lastError = error;
        syncLogger.warn("Weixin Channels target date loading attempt failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
          maxAttempts: statisticDateApplyMaxAttempts,
          targetDate: range.label,
        });

        if (signal.aborted || attempt === statisticDateApplyMaxAttempts) {
          break;
        }

        await wait(1_000, signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  interface StatisticTimestampRange {
    endTs: string;
    startTs: string;
  }

  function getStatisticTimestampRange(range: ResolvedDateRange): StatisticTimestampRange {
    const startMilliseconds = Date.parse(`${range.startDate}T00:00:00+08:00`);
    const endMilliseconds = Date.parse(`${range.endDate}T00:00:00+08:00`);

    if (!Number.isFinite(startMilliseconds) || !Number.isFinite(endMilliseconds)) {
      throw new Error(`无法计算视频号统计日期时间戳：${range.label}`);
    }

    const startTs = Math.floor(startMilliseconds / 1_000);

    return {
      endTs: String(Math.floor(endMilliseconds / 1_000)),
      startTs: String(startTs),
    };
  }

  function isStatisticListRequest(request: Request): boolean {
    return request.method() === "POST" && request.url().includes(statisticListApiName);
  }

  function parseStatisticRequestBody(request: Request): Record<string, unknown> | undefined {
    const postData = request.postData();

    if (!postData) {
      return undefined;
    }

    try {
      const body: unknown = JSON.parse(postData);
      return isRecord(body) ? body : undefined;
    } catch {
      return undefined;
    }
  }

  interface CompleteStatisticData {
    body: Record<string, unknown>;
    fetchedCount: number;
    ingestPayload: {
      list: unknown[];
      totalCount: number;
      [key: string]: unknown;
    };
    totalCount: number;
  }

  async function fetchCompleteStatisticData(
    page: Page,
    initialResponse: Response,
  ): Promise<CompleteStatisticData> {
    const initialBody = await readStatisticResponseBody(initialResponse);
    assertStatisticBodySucceeded(initialBody);

    const initialPayload = extractStatisticIngestPayload(initialBody);
    const totalCount = initialPayload.totalCount;

    const initialRequest = initialResponse.request();
    const initialRequestBody = parseStatisticRequestBody(initialRequest);
    if (!initialRequestBody) {
      throw new Error("无法读取视频号剧集统计请求参数");
    }

    const pageSize = Math.max(1, totalCount);
    const requestBody = {
      ...initialRequestBody,
      currentPage: 1,
      pageSize,
      timestamp: String(Date.now()),
    };

    syncLogger.info("Captured Weixin Channels statistic request and response", {
      currentPage: initialRequestBody.currentPage,
      initialListCount: initialPayload.list.length,
      initialPageSize: initialRequestBody.pageSize,
      requestedPageSize: pageSize,
      responseStatus: initialResponse.status(),
      totalCount,
    });

    if (totalCount === 0) {
      return {
        body: initialBody,
        fetchedCount: initialPayload.list.length,
        ingestPayload: initialPayload,
        totalCount,
      };
    }

    const originalHeaders = await initialRequest.allHeaders();
    const forwardedHeaders: Record<string, string> = {};
    for (const headerName of [
      "accept",
      "cache-control",
      "content-type",
      "finger-print-device-id",
      "pragma",
      "x-wechat-uin",
    ]) {
      const value = originalHeaders[headerName];
      if (value) {
        forwardedHeaders[headerName] = value;
      }
    }
    forwardedHeaders.accept ??= "*/*";
    forwardedHeaders["content-type"] ??= "application/json";

    const fetchResult = await page.evaluate(
      async ({ body, headers, timeoutMs, url }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(url, {
            body: JSON.stringify(body),
            credentials: "include",
            headers,
            method: "POST",
            signal: controller.signal,
          });

          return {
            bodyText: await response.text(),
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        body: requestBody,
        headers: forwardedHeaders,
        timeoutMs: statisticResponseTimeoutMs,
        url: initialRequest.url(),
      },
    );

    if (!fetchResult.ok) {
      throw new Error(
        `视频号完整剧集统计数据请求失败：HTTP ${fetchResult.status} ${fetchResult.statusText}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(fetchResult.bodyText);
    } catch (error) {
      throw new Error(
        `视频号完整剧集统计数据响应不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!isRecord(body)) {
      throw new Error("视频号完整剧集统计数据响应格式无效");
    }
    assertStatisticBodySucceeded(body);

    const ingestPayload = extractStatisticIngestPayload(body);
    const fetchedCount = ingestPayload.list.length;
    assertCompleteStatistics(fetchedCount, totalCount, ingestPayload.totalCount);

    syncLogger.info("Fetched complete Weixin Channels drama statistics response", {
      fetchedCount,
      pageSize,
      totalCount,
    });

    return {
      body,
      fetchedCount,
      ingestPayload,
      totalCount,
    };
  }

  function extractStatisticIngestPayload(body: Record<string, unknown>): {
    list: unknown[];
    totalCount: number;
    [key: string]: unknown;
  } {
    const payload = isRecord(body.data) ? body.data : body;

    if (!Array.isArray(payload.list)) {
      throw new Error("视频号剧集统计响应 data.list 不是有效数组");
    }

    const totalCount = toNonNegativeInteger(payload.totalCount);
    if (totalCount === undefined) {
      throw new Error("视频号剧集统计响应 data.totalCount 不是有效非负整数");
    }

    return {
      ...payload,
      list: payload.list,
      totalCount,
    };
  }

  function toNonNegativeInteger(value: unknown): number | undefined {
    const count = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
  }

  /**
   * The promotion RPC client sends queryIndicator arguments as `{ req: ... }`
   * and also appends a top-level baseReq. Keep the date matcher independent of
   * that transport wrapper so a dashboard request can be recognized reliably.
   */
  function findPromoteDataAnalysisDatePayload(
    body: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const queue: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];
    const visited = new Set<object>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || !isRecord(current.value)) {
        continue;
      }

      if (visited.has(current.value)) {
        continue;
      }
      visited.add(current.value);

      if ("deliveryStartTime" in current.value && "deliveryEndTime" in current.value) {
        return current.value;
      }

      if (current.depth >= 4) {
        continue;
      }

      for (const value of Object.values(current.value)) {
        if (isRecord(value)) {
          queue.push({ depth: current.depth + 1, value });
        }
      }
    }

    return undefined;
  }

  function getPromoteDataAnalysisRequestPayload(
    request: Request,
  ): Record<string, unknown> | undefined {
    const body = parseStatisticRequestBody(request);
    return body ? findPromoteDataAnalysisDatePayload(body) : undefined;
  }

  function isPromoteDataAnalysisDownloadQuery(request: Request): boolean {
    if (!isPromoteDataAnalysisIndicatorRequest(request)) {
      return false;
    }

    const payload = getPromoteDataAnalysisRequestPayload(request);
    const selectContext = isRecord(payload?.selectContext) ? payload.selectContext : undefined;
    return Number(payload?.cardType) === 3 && Number(selectContext?.pageSize) === 50;
  }

  function isPromoteDataAnalysisTableQuery(request: Request): boolean {
    if (!isPromoteDataAnalysisIndicatorRequest(request)) {
      return false;
    }

    const payload = getPromoteDataAnalysisRequestPayload(request);
    const selectContext = isRecord(payload?.selectContext) ? payload.selectContext : undefined;
    return Number(payload?.cardType) === 3 && Number(selectContext?.pageSize) === 10;
  }

  function assertPromoteDataAnalysisRequestFields(request: Request): void {
    const { dimensions: actualDimensions, indicators: actualIndicators } =
      getPromoteDataAnalysisRequestFields(request);
    const expectedDimensions = [...promoteDataAnalysisDimensionTypes];
    const expectedIndicators = [...promoteDataAnalysisIndicatorTypes];

    if (!matchesPromoteDataAnalysisFields(actualDimensions, expectedDimensions)) {
      throw new Error(
        `标准看板下载维度不正确：期望 ${expectedDimensions.join(",")}，实际 ${actualDimensions.join(",")}`,
      );
    }
    if (!matchesPromoteDataAnalysisFields(actualIndicators, expectedIndicators)) {
      throw new Error(
        `标准看板下载指标不正确：期望 ${expectedIndicators.join(",")}，实际 ${actualIndicators.join(",")}`,
      );
    }

    syncLogger.info("Verified Weixin Channels standard data analysis request fields", {
      dimensions: actualDimensions,
      indicators: actualIndicators,
    });
  }

  function getPromoteDataAnalysisRequestFields(request: Request): {
    dimensions: number[];
    indicators: number[];
  } {
    const payload = getPromoteDataAnalysisRequestPayload(request);
    const actualDimensions = Array.isArray(payload?.dimensions)
      ? payload.dimensions.map(Number)
      : [];
    const actualIndicators = Array.isArray(payload?.indicators)
      ? payload.indicators.map(Number)
      : [];

    return {
      dimensions: actualDimensions,
      indicators: actualIndicators,
    };
  }

  function matchesPromoteDataAnalysisFields(
    actual: number[],
    expected: readonly number[],
  ): boolean {
    return actual.length === expected.length && expected.every((value) => actual.includes(value));
  }

  function doesPromoteDataAnalysisRequestHaveExpectedFields(request: Request): boolean {
    const fields = getPromoteDataAnalysisRequestFields(request);
    return (
      matchesPromoteDataAnalysisFields(fields.dimensions, promoteDataAnalysisDimensionTypes) &&
      matchesPromoteDataAnalysisFields(fields.indicators, promoteDataAnalysisIndicatorTypes)
    );
  }

  async function waitForPromoteDataAnalysisResponseWithExpectedFields(
    page: Page,
    isTargetResponse: (response: Response) => boolean,
    timeout: number,
  ): Promise<Response> {
    let lastUnexpectedRequest: Request | undefined;

    return page
      .waitForResponse(
        (response) => {
          if (!isTargetResponse(response)) {
            return false;
          }

          const request = response.request();
          if (doesPromoteDataAnalysisRequestHaveExpectedFields(request)) {
            return true;
          }

          lastUnexpectedRequest = request;
          const fields = getPromoteDataAnalysisRequestFields(request);
          syncLogger.warn(
            "Ignoring Weixin Channels standard data analysis response with stale fields",
            fields,
          );
          return false;
        },
        { timeout },
      )
      .catch((error) => {
        if (lastUnexpectedRequest) {
          assertPromoteDataAnalysisRequestFields(lastUnexpectedRequest);
        }
        throw error;
      });
  }

  async function assertStatisticResponseSucceeded(response: Response): Promise<void> {
    const body = await readStatisticResponseBody(response);
    assertStatisticBodySucceeded(body);
  }

  async function readStatisticResponseBody(response: Response): Promise<Record<string, unknown>> {
    let body: unknown;

    try {
      body = await response.json();
    } catch (error) {
      throw new Error(
        `视频号剧集统计数据响应不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!isRecord(body)) {
      throw new Error("视频号剧集统计数据响应格式无效");
    }

    return body;
  }

  function assertStatisticBodySucceeded(body: Record<string, unknown>): void {
    const errorCode = getStatisticResponseErrorCode(body);
    if (errorCode !== undefined && errorCode !== 0) {
      throw new Error(`视频号剧集统计数据接口返回失败状态：${errorCode}`);
    }
  }

  function findPromoteDataAnalysisDetailRows(value: unknown): unknown[] | undefined {
    const queue: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
    const visited = new Set<object>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || !isRecord(current.value) || visited.has(current.value)) {
        continue;
      }
      visited.add(current.value);

      if (Array.isArray(current.value.detailRows)) {
        return current.value.detailRows;
      }
      if (current.depth >= 4) {
        continue;
      }

      for (const child of Object.values(current.value)) {
        if (isRecord(child)) {
          queue.push({ depth: current.depth + 1, value: child });
        }
      }
    }

    return undefined;
  }

  async function assertPromoteDataAnalysisResponseHasRows(
    response: Response,
    targetDate: string,
  ): Promise<void> {
    const body: unknown = await response.json().catch(() => undefined);
    const rows = findPromoteDataAnalysisDetailRows(body);

    if (!rows) {
      throw new Error("标准看板下载接口响应中未找到数据明细列表");
    }
    if (rows.length === 0) {
      throw new Error(`标准看板下载接口在 ${targetDate} 返回 0 条数据，已阻止空文件入库`);
    }

    syncLogger.info("Verified Weixin Channels standard data analysis response rows", {
      rowCount: rows.length,
      targetDate,
    });
  }

  async function assertPromoteDataAnalysisDownloadHasRows(filePath: string): Promise<void> {
    if (path.extname(filePath).toLowerCase() !== ".csv") {
      return;
    }

    const content = (await readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trimEnd();
    const nonEmptyLines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length <= 1) {
      throw new Error(`标准看板下载文件只有表头、没有数据行：${path.basename(filePath)}`);
    }

    syncLogger.info("Verified Weixin Channels standard data analysis CSV rows", {
      dataLineCount: nonEmptyLines.length - 1,
      filePath,
    });
  }

  function getStatisticResponseErrorCode(body: Record<string, unknown>): number | undefined {
    for (const key of ["errCode", "err_code"]) {
      const value = body[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }

    for (const key of ["baseResp", "base_resp"]) {
      const value = body[key];
      if (!isRecord(value)) {
        continue;
      }

      for (const errorKey of ["errCode", "err_code", "ret"]) {
        const errorCode = value[errorKey];
        if (typeof errorCode === "number" && Number.isFinite(errorCode)) {
          return errorCode;
        }
      }
    }

    return undefined;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  async function waitForStatisticLoadingDetached(page: Page, stage: string): Promise<void> {
    syncLogger.info("Waiting for Weixin Channels statistic loading to disappear", {
      stage,
    });
    await page.locator(statisticLoadingSelector).waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels statistic loading disappeared", {
      stage,
    });
  }

  function getPromoteStatisticLoading(page: Page): Locator {
    return page
      .locator("div.absolute.bottom-0.left-0.right-0.top-0")
      .filter({ has: page.locator("svg.loading.animate-spin") });
  }

  function getPromoteDataAnalysisLoading(page: Page): Locator {
    return page
      .locator("div.absolute.bottom-0.left-0.right-0.top-0")
      .filter({
        has: page.locator("svg.loading.animate-spin, .finder-ui-desktop-loading"),
      })
      .or(page.locator(statisticLoadingSelector))
      .first();
  }

  function getPromoteDataAnalysisDetailCard(page: Page): Locator {
    return page
      .getByRole("heading", { name: "数据明细", exact: true })
      .first()
      .locator("xpath=../../../..");
  }

  function getPromoteDataAnalysisDownloadControl(page: Page): Locator {
    return getPromoteDataAnalysisDetailCard(page).locator('a[title="下载"]:visible').first();
  }

  function getPromoteDataAnalysisEditControl(page: Page): Locator {
    return getPromoteDataAnalysisDetailCard(page).locator('a[title="编辑"]').first();
  }

  function getPromoteDataAnalysisDetailDialog(page: Page): Locator {
    // The dashboard mounts one hidden selector dialog per card. Select the
    // visible, most recently opened dialog so a hidden dialog from another card
    // cannot intercept the automation flow.
    return page
      .locator('[role="dialog"]:visible, .finder-ui-desktop-dialog:visible')
      .filter({ hasText: "选择展示项" })
      .last();
  }

  function isPromoteDataAnalysisIndicatorRequest(request: Request): boolean {
    return (
      request.method() === "POST" &&
      request.url().toLowerCase().includes(promoteDataAnalysisQueryApiName.toLowerCase())
    );
  }

  function getPromoteTimestampRange(range: ResolvedDateRange): {
    endTs: string;
    startTs: string;
  } {
    const startMilliseconds = Date.parse(`${range.startDate}T00:00:00+08:00`);
    const endMilliseconds = Date.parse(`${range.endDate}T23:59:59+08:00`);

    if (!Number.isFinite(startMilliseconds) || !Number.isFinite(endMilliseconds)) {
      throw new Error(`无法转换加热平台目标日期：${range.label}`);
    }

    return {
      endTs: String(Math.floor(endMilliseconds / 1_000)),
      startTs: String(Math.floor(startMilliseconds / 1_000)),
    };
  }

  function doesPromoteDataAnalysisRequestMatchDateRange(
    request: Request,
    range: ResolvedDateRange,
  ): boolean {
    const payload = getPromoteDataAnalysisRequestPayload(request);
    const expectedRange = getPromoteTimestampRange(range);
    return Boolean(
      payload &&
      String(payload.deliveryStartTime) === expectedRange.startTs &&
      String(payload.deliveryEndTime) === expectedRange.endTs,
    );
  }

  async function setPromoteDateRangeDirectly(
    root: Locator,
    range: ResolvedDateRange,
    eventName: "change" | "update:selected" = "change",
  ): Promise<void> {
    const result = await root.evaluate(
      (element, value) => {
        type VueVNode = {
          children?: unknown;
          component?: VueComponentInstance | null;
          dynamicChildren?: VueVNode[] | null;
          el?: Element | null;
          suspense?: { activeBranch?: VueVNode | null } | null;
        };
        type VueComponentInstance = {
          emit?: (event: string, ...args: unknown[]) => void;
          parent?: VueComponentInstance | null;
          subTree?: VueVNode | null;
          type?: { __name?: string; name?: string };
          vnode?: { props?: Record<string, unknown> | null };
        };
        type VueEventHandler =
          | ((...args: unknown[]) => unknown)
          | Array<(...args: unknown[]) => unknown>;
        type ElementWithVue3 = Element & {
          __vueParentComponent?: VueComponentInstance;
        };
        type VueAppContainer = Element & {
          __vue_app__?: { _instance?: VueComponentInstance | null };
          _vnode?: VueVNode | null;
        };

        const startMilliseconds = Date.parse(`${value.startDate}T00:00:00+08:00`);
        const endMilliseconds = Date.parse(`${value.endDate}T00:00:00+08:00`);
        const timestamps = [startMilliseconds, endMilliseconds];
        const componentQueue: VueComponentInstance[] = [];
        const directComponent = (element as ElementWithVue3).__vueParentComponent;
        if (directComponent) {
          componentQueue.push(directComponent);
        }

        const visitedComponents = new Set<VueComponentInstance>();
        const visitedVNodes = new Set<VueVNode>();
        const visitedNames: string[] = [];
        const discoveredVueKeys = new Set<string>();
        const invokeVueEventHandler = (handler: unknown, ...args: unknown[]): boolean => {
          if (typeof handler === "function") {
            handler(...args);
            return true;
          }
          if (Array.isArray(handler) && handler.every((item) => typeof item === "function")) {
            for (const item of handler as VueEventHandler[]) {
              if (typeof item === "function") {
                item(...args);
              }
            }
            return true;
          }
          return false;
        };
        const collectVNodeComponents = (node: unknown) => {
          if (!node || typeof node !== "object" || visitedVNodes.has(node as VueVNode)) {
            return;
          }

          const vnode = node as VueVNode;
          visitedVNodes.add(vnode);
          if (vnode.component) {
            componentQueue.push(vnode.component);
          }
          if (Array.isArray(vnode.children)) {
            vnode.children.forEach(collectVNodeComponents);
          }
          vnode.dynamicChildren?.forEach(collectVNodeComponents);
          collectVNodeComponents(vnode.suspense?.activeBranch);
        };

        const candidateElements = [
          document.documentElement,
          document.body,
          ...document.querySelectorAll("*"),
        ];
        for (const candidateElement of candidateElements) {
          const vueElement = candidateElement as VueAppContainer & ElementWithVue3;
          if (vueElement.__vueParentComponent) {
            componentQueue.push(vueElement.__vueParentComponent);
          }
          if (vueElement.__vue_app__?._instance) {
            componentQueue.push(vueElement.__vue_app__._instance);
          }
          collectVNodeComponents(vueElement._vnode);

          for (const propertyName of Object.getOwnPropertyNames(candidateElement)) {
            if (!/vue|vnode/i.test(propertyName)) {
              continue;
            }

            discoveredVueKeys.add(propertyName);
            const propertyValue = (candidateElement as unknown as Record<string, unknown>)[
              propertyName
            ];
            if (/parentcomponent/i.test(propertyName) && propertyValue) {
              componentQueue.push(propertyValue as VueComponentInstance);
            } else if (/vue.*app/i.test(propertyName)) {
              const appInstance = (
                propertyValue as { _instance?: VueComponentInstance | null } | null
              )?._instance;
              if (appInstance) {
                componentQueue.push(appInstance);
              }
            } else if (/vnode/i.test(propertyName)) {
              collectVNodeComponents(propertyValue);
            }
          }
        }

        while (componentQueue.length > 0) {
          const component = componentQueue.shift();
          if (!component || visitedComponents.has(component)) {
            continue;
          }

          visitedComponents.add(component);
          const componentName = component.type?.name ?? component.type?.__name ?? "anonymous";
          if (visitedNames.length < 40) {
            visitedNames.push(componentName);
          }
          if (/DateRangePicker/i.test(componentName)) {
            const vnodeProps = component.vnode?.props;
            const eventHandler =
              value.eventName === "update:selected"
                ? vnodeProps?.["onUpdate:selected"]
                : vnodeProps?.onChange;
            if (value.eventName === "update:selected" && eventHandler) {
              const daySelectHandler = vnodeProps?.onDaySelect;
              if (!daySelectHandler) {
                collectVNodeComponents(component.subTree);
                continue;
              }

              invokeVueEventHandler(vnodeProps?.onPickerShow);
              const startSelected = invokeVueEventHandler(daySelectHandler, {
                timestamp: startMilliseconds,
              });
              const endSelected = invokeVueEventHandler(daySelectHandler, {
                timestamp: endMilliseconds,
              });
              const rangeUpdated = invokeVueEventHandler(eventHandler, timestamps);
              if (startSelected && endSelected && rangeUpdated) {
                return {
                  componentName,
                  method: "vnode.day-select+update:selected",
                  visitedNames,
                };
              }
            } else if (invokeVueEventHandler(eventHandler, timestamps)) {
              return { componentName, method: `vnode.${value.eventName}`, visitedNames };
            }

            if (value.eventName !== "update:selected" && component.emit) {
              component.emit(value.eventName, timestamps);
              return { componentName, method: `emit:${value.eventName}`, visitedNames };
            }
          }

          collectVNodeComponents(component.subTree);
        }

        throw new Error(
          `Unable to locate MpDateRangePicker Vue component; Vue keys: ${[
            ...discoveredVueKeys,
          ].join(", ")}; visited: ${visitedNames.join(", ")}`,
        );
      },
      { ...range, eventName },
    );

    syncLogger.info("Updated Weixin Channels promote Vue date range", result);
  }

  async function applyPromoteDataAnalysisFilterDateRange(
    page: Page,
    range: ResolvedDateRange,
  ): Promise<void> {
    const dateRange = page.locator(".data-analysis-header-date-range").first();
    const startInput = dateRange.locator('input[placeholder="开始日期"]').first();
    const endInput = dateRange.locator('input[placeholder="结束日期"]').first();
    const filterPanel = page
      .getByRole("heading", { name: "数据筛选", exact: true })
      .first()
      .locator("xpath=../..");
    await filterPanel.waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    await setPromoteDateRangeDirectly(dateRange, range, "update:selected");

    // Vue applies the date header update on the next render tick. Wait until the
    // visible inputs reflect that state before clicking the filter's real query
    // action; clicking it too early submits the previous date range.
    await page.waitForFunction(
      ({ endDate, startDate }) => {
        const root = document.querySelector(".data-analysis-header-date-range");
        const start = root?.querySelector<HTMLInputElement>('input[placeholder="开始日期"]');
        const end = root?.querySelector<HTMLInputElement>('input[placeholder="结束日期"]');
        return start?.value === startDate && end?.value === endDate;
      },
      { endDate: range.endDate, startDate: range.startDate },
      { timeout: promoteDataAnalysisResponseGraceMs },
    );

    const filterButton = filterPanel.getByRole("button", { name: "筛选", exact: true }).first();
    await filterButton.waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    await filterButton.click({ timeout: statisticResponseTimeoutMs });

    syncLogger.info("Submitted Weixin Channels standard data analysis date filter", {
      endDate: await endInput.inputValue(),
      method: "date-picker-update+filter-button-click",
      startDate: await startInput.inputValue(),
    });
  }

  function getPromoteDownloadControl(page: Page): Locator {
    return page
      .getByRole("button", { name: /导出|下载/ })
      .or(page.getByText(/导出|下载/))
      .first();
  }

  function isPromoteOrderListRequest(request: Request): boolean {
    return request.method() === "POST" && request.url().includes(promoteOrderListApiName);
  }

  function doesPromoteOrderListMatchDateRange(request: Request, range: ResolvedDateRange): boolean {
    const body = parseStatisticRequestBody(request);
    const expectedRange = getPromoteTimestampRange(range);

    return Boolean(
      body &&
      String(body.createTsMin) === expectedRange.startTs &&
      String(body.createTsMax) === expectedRange.endTs &&
      Number(body.page) === 1,
    );
  }

  async function waitForPromoteStatisticPageReady(page: Page): Promise<void> {
    syncLogger.info("Waiting for Weixin Channels promote statistic page to finish loading");
    await page.waitForLoadState("domcontentloaded", {
      timeout: 30_000,
    });

    const dateRange = page.locator(".orderlist-filter-container .date-range-picker").first();
    await Promise.all([
      dateRange.locator('input[placeholder="开始日期"]').waitFor({
        state: "visible",
        timeout: 180_000,
      }),
      dateRange.locator('input[placeholder="结束日期"]').waitFor({
        state: "visible",
        timeout: 180_000,
      }),
    ]);
    syncLogger.info("Weixin Channels promote date inputs are visible");
    await getPromoteStatisticLoading(page).waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });
    await getPromoteDownloadControl(page).waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels promote statistic page is ready");
  }

  async function setPromoteStatisticDateRange(page: Page, range: ResolvedDateRange): Promise<void> {
    const root = page.locator(".orderlist-filter-container .date-range-picker").first();
    const startInput = root.locator('input[placeholder="开始日期"]').first();
    const endInput = root.locator('input[placeholder="结束日期"]').first();
    const loading = getPromoteStatisticLoading(page);

    await loading.waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });

    syncLogger.info("Setting Weixin Channels promote statistic date range", {
      endDate: range.endDate,
      startDate: range.startDate,
    });
    const expectedRange = getPromoteTimestampRange(range);
    syncLogger.info("Waiting for target Weixin Channels promote order list response", {
      endTs: expectedRange.endTs,
      startTs: expectedRange.startTs,
    });
    const targetResponsePromise = page.waitForResponse(
      (response) =>
        isPromoteOrderListRequest(response.request()) &&
        doesPromoteOrderListMatchDateRange(response.request(), range),
      { timeout: statisticResponseTimeoutMs },
    );
    const [targetResponse] = await Promise.all([
      targetResponsePromise,
      setPromoteDateRangeDirectly(root, range),
    ]);

    const [actualStartDate, actualEndDate] = await Promise.all([
      startInput.inputValue(),
      endInput.inputValue(),
    ]);
    if (actualStartDate !== range.startDate || actualEndDate !== range.endDate) {
      throw new Error(
        `加热平台日期设置失败：期望 ${range.startDate} 至 ${range.endDate}，实际 ${actualStartDate || "空"} 至 ${actualEndDate || "空"}`,
      );
    }

    if (!targetResponse.ok()) {
      throw new Error(
        `加热平台目标日期数据请求失败：HTTP ${targetResponse.status()} ${targetResponse.statusText()}`,
      );
    }

    const responseFailure = await targetResponse.finished();
    if (responseFailure) {
      throw new Error(`加热平台目标日期数据响应接收失败：${responseFailure.message}`);
    }
    await assertStatisticResponseSucceeded(targetResponse);

    await loading.waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });
    await getPromoteDownloadControl(page).waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels promote statistic date range applied", {
      endDate: actualEndDate,
      startDate: actualStartDate,
    });
  }

  async function setPromoteStatisticDateRangeWithRetry(
    page: Page,
    range: ResolvedDateRange,
    signal: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= statisticDateApplyMaxAttempts; attempt += 1) {
      try {
        await setPromoteStatisticDateRange(page, range);
        return;
      } catch (error) {
        lastError = error;
        syncLogger.warn("Weixin Channels promote target date loading attempt failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
          maxAttempts: statisticDateApplyMaxAttempts,
          targetDate: range.label,
        });
        if (signal.aborted || attempt === statisticDateApplyMaxAttempts) {
          break;
        }
        await wait(1_000, signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function waitForPromoteDataAnalysisPageReady(page: Page): Promise<void> {
    syncLogger.info("Waiting for Weixin Channels standard data analysis page to finish loading");
    await page.waitForLoadState("domcontentloaded", {
      timeout: 30_000,
    });

    await page.getByRole("heading", { name: "标准数据分析", exact: true }).waitFor({
      state: "visible",
      timeout: 180_000,
    });

    const dateRange = page.locator(".data-analysis-header-date-range").first();
    await Promise.all([
      dateRange.locator('input[placeholder="开始日期"]').waitFor({
        state: "visible",
        timeout: 180_000,
      }),
      dateRange.locator('input[placeholder="结束日期"]').waitFor({
        state: "visible",
        timeout: 180_000,
      }),
    ]);
    syncLogger.info("Weixin Channels standard data analysis date inputs are visible");
    await getPromoteDataAnalysisDetailCard(page).waitFor({
      state: "visible",
      timeout: 180_000,
    });
    await getPromoteDataAnalysisLoading(page).waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });
    await getPromoteDataAnalysisDownloadControl(page).waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels standard data analysis page is ready");
  }

  async function setPromoteDataAnalysisDateRange(
    page: Page,
    range: ResolvedDateRange,
  ): Promise<void> {
    const root = page.locator(".data-analysis-header-date-range").first();
    const startInput = root.locator('input[placeholder="开始日期"]').first();
    const endInput = root.locator('input[placeholder="结束日期"]').first();
    const loading = getPromoteDataAnalysisLoading(page);

    await loading.waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });

    const [currentStartDate, currentEndDate] = await Promise.all([
      startInput.inputValue(),
      endInput.inputValue(),
    ]);
    if (currentStartDate === range.startDate && currentEndDate === range.endDate) {
      syncLogger.info("Weixin Channels standard data analysis date range is already selected", {
        endDate: currentEndDate,
        startDate: currentStartDate,
      });
    }

    syncLogger.info("Setting Weixin Channels standard data analysis date range", {
      currentEndDate,
      currentStartDate,
      endDate: range.endDate,
      startDate: range.startDate,
    });
    const targetResponsePromise = page.waitForResponse(
      (response) =>
        isPromoteDataAnalysisIndicatorRequest(response.request()) &&
        doesPromoteDataAnalysisRequestMatchDateRange(response.request(), range),
      { timeout: statisticResponseTimeoutMs },
    );
    const [targetResponse] = await Promise.all([
      targetResponsePromise,
      applyPromoteDataAnalysisFilterDateRange(page, range),
    ]);

    if (!targetResponse.ok()) {
      throw new Error(
        `加热平台目标日期数据请求失败：HTTP ${targetResponse.status()} ${targetResponse.statusText()}`,
      );
    }
    const responseFailure = await targetResponse.finished();
    if (responseFailure) {
      throw new Error(`加热平台目标日期数据响应接收失败：${responseFailure.message}`);
    }
    await assertStatisticResponseSucceeded(targetResponse);

    const [actualStartDate, actualEndDate] = await Promise.all([
      startInput.inputValue(),
      endInput.inputValue(),
    ]);
    if (actualStartDate !== range.startDate || actualEndDate !== range.endDate) {
      throw new Error(
        `加热平台日期设置失败：期望 ${range.startDate} 至 ${range.endDate}，实际 ${actualStartDate || "空"} 至 ${actualEndDate || "空"}`,
      );
    }

    await loading.waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });
    await getPromoteDataAnalysisDownloadControl(page).waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels standard data analysis date range applied", {
      endDate: actualEndDate,
      startDate: actualStartDate,
    });
  }

  function getPromoteDataAnalysisLabelPattern(label: string): RegExp {
    const normalizedLabel = label.replace(/\s+/gu, "").split("");
    const escapedLabel = normalizedLabel
      .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    return new RegExp(escapedLabel, "u");
  }

  async function setPromoteDataAnalysisIndicatorBySearch(
    dialog: Locator,
    label: string,
    selected: boolean,
  ): Promise<void> {
    const selectedTag = dialog
      .locator(".tag-list-tags")
      .getByText(getPromoteDataAnalysisExactLabelPattern(label))
      .last();
    const isSelected = await selectedTag.isVisible().catch(() => false);
    if (isSelected === selected) {
      return;
    }

    const searchInput = dialog.locator('input[placeholder="搜索关键词"]:visible').last();
    await searchInput
      .waitFor({
        state: "visible",
        timeout: statisticResponseTimeoutMs,
      })
      .catch(() => {
        throw new Error("标准看板指标配置中未找到指标搜索框");
      });
    // `fill()` updates the input value but does not trigger the wrapper's click
    // handler. The platform only renders the result dropdown after that handler
    // opens the search state, so explicitly click the input and its search icon.
    await searchInput.click({ timeout: statisticResponseTimeoutMs });
    await searchInput.fill(label);
    const searchIcon = dialog.locator("i.weui-icon-outlined-search:visible").last();
    if (await searchIcon.isVisible().catch(() => false)) {
      await searchIcon.click({ timeout: statisticResponseTimeoutMs });
    }

    const searchDropdown = dialog.locator(".indicator-search-dropdown:visible").last();
    await searchDropdown
      .waitFor({
        state: "visible",
        timeout: promoteDataAnalysisResponseGraceMs,
      })
      .catch(() => {
        throw new Error(`标准看板指标配置中搜索“${label}”后未显示结果`);
      });

    const matchingRows = searchDropdown
      .locator("div.cursor-pointer")
      .filter({ hasText: getPromoteDataAnalysisLabelPattern(label) });
    const exactRowIndex = await matchingRows.evaluateAll((rows, targetLabel) => {
      const normalizedTarget = targetLabel.replace(/\s+/gu, "");
      return rows.findIndex((row) => {
        const pathParts = (row.textContent ?? "")
          .split("/")
          .map((part) => part.replace(/\s+/gu, ""))
          .filter(Boolean);
        return pathParts[pathParts.length - 1] === normalizedTarget;
      });
    }, label);
    const resultRow = matchingRows.nth(exactRowIndex >= 0 ? exactRowIndex : 0);
    await resultRow
      .waitFor({
        state: "visible",
        timeout: promoteDataAnalysisResponseGraceMs,
      })
      .catch(() => {
        throw new Error(`标准看板指标配置中未找到“${label}”`);
      });

    const matchedPath = (await resultRow.innerText()).replace(/\s+/gu, " ").trim();
    await resultRow.click({ timeout: statisticResponseTimeoutMs });
    await selectedTag
      .waitFor({
        state: selected ? "visible" : "hidden",
        timeout: promoteDataAnalysisResponseGraceMs,
      })
      .catch(() => {
        throw new Error(`标准看板指标“${label}”未能${selected ? "选中" : "取消选中"}`);
      });
    await searchInput.fill("");

    syncLogger.info("Updated Weixin Channels standard data analysis indicator", {
      label,
      matchedPath,
      selected,
    });
  }

  async function configurePromoteDataAnalysisDetail(
    page: Page,
    range: ResolvedDateRange,
  ): Promise<void> {
    syncLogger.info("Opening Weixin Channels standard data analysis detail field selector");
    const editControl = getPromoteDataAnalysisEditControl(page);
    await editControl.waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    await editControl.click({ timeout: statisticResponseTimeoutMs });
    syncLogger.info("Clicked Weixin Channels standard data analysis detail edit control");

    const dialog = getPromoteDataAnalysisDetailDialog(page);
    await dialog.waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels standard data analysis detail field selector is visible");

    const dimensionTab = dialog.getByText("维度", { exact: true }).first();
    await dimensionTab.click({ timeout: statisticResponseTimeoutMs });

    const dimensionContent = dialog
      .locator("span.select-label")
      .filter({ hasText: "选择维度" })
      .first()
      .locator("xpath=../../..");

    // The dimensions panel exposes a real “清空” action. Start from an empty
    // selection so repeated sync runs always produce the requested CSV schema.
    await clearPromoteDataAnalysisDimensions(dimensionContent);

    for (const label of promoteDataAnalysisDimensionLabels) {
      await setPromoteDataAnalysisOption(dimensionContent, label, true);
    }
    syncLogger.info("Selected Weixin Channels standard data analysis dimensions", {
      dimensions: [...promoteDataAnalysisDimensionLabels],
    });

    const indicatorTab = dialog.getByText("指标", { exact: true }).first();
    await indicatorTab.click({ timeout: statisticResponseTimeoutMs });

    // Metric categories are supplied by the platform and their display names can
    // change between accounts. Use the dialog's cross-category search instead of
    // relying on category labels such as “投放数据”.
    for (const label of promoteDataAnalysisExcludedIndicatorLabels) {
      await setPromoteDataAnalysisIndicatorBySearch(dialog, label, false);
    }
    for (const label of promoteDataAnalysisIndicatorLabels) {
      await setPromoteDataAnalysisIndicatorBySearch(dialog, label, true);
    }
    syncLogger.info("Selected Weixin Channels standard data analysis indicators", {
      indicators: [...promoteDataAnalysisIndicatorLabels],
    });

    const detailResponsePromise = waitForPromoteDataAnalysisResponseWithExpectedFields(
      page,
      (response) =>
        isPromoteDataAnalysisTableQuery(response.request()) &&
        doesPromoteDataAnalysisRequestMatchDateRange(response.request(), range),
      statisticResponseTimeoutMs,
    );
    const [detailResponse] = await Promise.all([
      detailResponsePromise,
      dialog.getByRole("button", { name: "确定", exact: true }).last().click({
        timeout: statisticResponseTimeoutMs,
      }),
    ]);
    syncLogger.info("Confirmed Weixin Channels standard data analysis detail fields", {
      targetDate: range.label,
    });
    if (!detailResponse.ok()) {
      throw new Error(
        `标准看板字段确认后的数据请求失败：HTTP ${detailResponse.status()} ${detailResponse.statusText()}`,
      );
    }
    const responseFailure = await detailResponse.finished();
    if (responseFailure) {
      throw new Error(`标准看板字段确认后的数据响应接收失败：${responseFailure.message}`);
    }
    assertPromoteDataAnalysisRequestFields(detailResponse.request());
    await assertStatisticResponseSucceeded(detailResponse);
    await assertPromoteDataAnalysisResponseHasRows(detailResponse, range.label);
    await dialog
      .waitFor({
        state: "hidden",
        timeout: statisticResponseTimeoutMs,
      })
      .catch(() => undefined);

    const detailCard = getPromoteDataAnalysisDetailCard(page);
    await getPromoteDataAnalysisLoading(page).waitFor({
      state: "detached",
      timeout: statisticResponseTimeoutMs,
    });
    await detailCard.waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    // The closed selector remains mounted inside the card and contains hidden
    // copies of every field label. Do not validate with getByText().first(), as
    // that can resolve to the hidden modal copy and block the download flow.
    await getPromoteDataAnalysisDownloadControl(page).waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });

    syncLogger.info("Weixin Channels standard data analysis detail fields configured", {
      dimensions: [...promoteDataAnalysisDimensionLabels],
      indicators: [...promoteDataAnalysisIndicatorLabels],
    });
  }

  async function setPromoteDataAnalysisDateRangeWithRetry(
    page: Page,
    range: ResolvedDateRange,
    signal: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= promoteDataAnalysisDateApplyMaxAttempts; attempt += 1) {
      try {
        await setPromoteDataAnalysisDateRange(page, range);
        return;
      } catch (error) {
        lastError = error;
        syncLogger.warn("Weixin Channels promote target date loading attempt failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
          maxAttempts: promoteDataAnalysisDateApplyMaxAttempts,
          targetDate: range.label,
        });
        if (signal.aborted || attempt === promoteDataAnalysisDateApplyMaxAttempts) {
          break;
        }
        await wait(1_000, signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function findPlayletStatisticDateRange(page: Page): Promise<{
    endInput: Locator;
    root: Locator;
    scope: string;
    startInput: Locator;
  }> {
    const singlePlayletBlock = page
      .locator(".block-title", {
        hasText: "单条剧集数据",
      })
      .locator("xpath=..");

    const candidates = [
      {
        root: singlePlayletBlock.locator(".weui-desktop-picker__date-range").first(),
        scope: "single-playlet-data-block",
      },
      {
        root: page.locator(".filter-wrapper .weui-desktop-picker__date-range").first(),
        scope: "filter-wrapper",
      },
      {
        root: page.locator(".weui-desktop-picker__date-range").first(),
        scope: "first-date-range",
      },
    ];

    for (const candidate of candidates) {
      const startInput = candidate.root.locator('input[placeholder="开始日期"]').first();
      const endInput = candidate.root.locator('input[placeholder="结束日期"]').first();
      const [startCount, endCount] = await Promise.all([startInput.count(), endInput.count()]);

      syncLogger.info("Checking Weixin Channels date range inputs", {
        endCount,
        scope: candidate.scope,
        startCount,
      });

      if (startCount === 0 || endCount === 0) {
        continue;
      }

      try {
        await Promise.all([
          startInput.waitFor({
            state: "visible",
            timeout: 15_000,
          }),
          endInput.waitFor({
            state: "visible",
            timeout: 15_000,
          }),
        ]);

        return {
          endInput,
          root: candidate.root,
          scope: candidate.scope,
          startInput,
        };
      } catch (error) {
        syncLogger.warn("Weixin Channels date range inputs found but not visible", {
          error: error instanceof Error ? error.message : String(error),
          scope: candidate.scope,
        });
      }
    }

    throw new Error("未找到视频号剧集统计开始日期和结束日期输入框");
  }

  async function setDateRangeInputsDirectly(
    dateRange: Locator,
    range: ResolvedDateRange,
  ): Promise<void> {
    const result = await dateRange.evaluate(async (root, value) => {
      type VueLike = {
        $children?: VueLike[];
        $emit?: (event: string, ...args: unknown[]) => void;
        $forceUpdate?: () => void;
        [key: string]: unknown;
      };
      type ElementWithVue = Element & {
        __vue__?: VueLike;
      };

      const inputs = [
        root.querySelector<HTMLInputElement>('input[placeholder="开始日期"]'),
        root.querySelector<HTMLInputElement>('input[placeholder="结束日期"]'),
      ];

      const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

      if (!valueDescriptor?.set) {
        throw new Error("Unable to resolve HTMLInputElement value setter");
      }

      const applyInputValue = (input: HTMLInputElement, dateValue: string) => {
        input.removeAttribute("readonly");
        input.setAttribute("value", dateValue);
        input.dataset.manualValue = dateValue;
        valueDescriptor.set?.call(input, dateValue);
      };

      const inputValues = [value.startDate, value.endDate];
      for (const [index, input] of inputs.entries()) {
        if (!input) {
          throw new Error("Date range input was not found");
        }

        applyInputValue(input, inputValues[index] ?? value.startDate);
      }

      const changedVuePaths: string[] = [];
      const isDateLikeString = (nextValue: unknown): nextValue is string =>
        typeof nextValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(nextValue);
      const maybeReplaceVueDates = (
        target: unknown,
        path: string,
        visited: WeakSet<object>,
        depth: number,
        scalarDate: string,
      ) => {
        if (!target || typeof target !== "object" || visited.has(target) || depth > 5) {
          return;
        }

        visited.add(target);

        if (Array.isArray(target)) {
          if (target.length >= 2 && target.some(isDateLikeString)) {
            target.splice(0, target.length, value.startDate, value.endDate);
            changedVuePaths.push(path);
            return;
          }

          target.forEach((item, index) => {
            maybeReplaceVueDates(item, `${path}[${index}]`, visited, depth + 1, scalarDate);
          });
          return;
        }

        for (const key of Object.keys(target)) {
          if (key.startsWith("_") || key.startsWith("$")) {
            continue;
          }

          const record = target as Record<string, unknown>;
          const current = record[key];
          const nextPath = path ? `${path}.${key}` : key;

          if (isDateLikeString(current)) {
            record[key] = scalarDate;
            changedVuePaths.push(nextPath);
            continue;
          }

          maybeReplaceVueDates(current, nextPath, visited, depth + 1, scalarDate);
        }
      };

      const vueRoots = new Set<VueLike>();
      root.querySelectorAll("*").forEach((element) => {
        const vue = (element as ElementWithVue).__vue__;

        if (vue) {
          vueRoots.add(vue);
        }
      });

      const rootVue = (root as ElementWithVue).__vue__;

      if (rootVue) {
        vueRoots.add(rootVue);
      }

      let vueIndex = 0;
      for (const vue of vueRoots) {
        const scalarDate = vueIndex === 0 ? value.startDate : value.endDate;
        maybeReplaceVueDates(vue, `vue[${vueIndex}]`, new WeakSet<object>(), 0, scalarDate);
        vue.$emit?.("input", [value.startDate, value.endDate]);
        vue.$emit?.("change", [value.startDate, value.endDate]);
        vue.$forceUpdate?.();
        vueIndex += 1;
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      for (const [index, input] of inputs.entries()) {
        if (!input) {
          continue;
        }

        const inputValue = inputValues[index] ?? value.startDate;
        applyInputValue(input, inputValue);
        input.focus();
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            composed: true,
            inputType: "insertReplacementText",
          }),
        );
        input.dispatchEvent(
          new Event("change", {
            bubbles: true,
            composed: true,
          }),
        );
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            composed: true,
            key: "Enter",
          }),
        );
        input.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            composed: true,
            key: "Enter",
          }),
        );
        input.blur();
        applyInputValue(input, inputValue);
      }

      root.dispatchEvent(
        new Event("change", {
          bubbles: true,
          composed: true,
        }),
      );

      return {
        changedVuePaths: changedVuePaths.slice(0, 20),
        endDate: inputs[1]?.value ?? "",
        startDate: inputs[0]?.value ?? "",
        vueRootCount: vueRoots.size,
      };
    }, range);

    syncLogger.info("Weixin Channels date range inputs updated directly", result);
  }

  async function waitForLoginPageCompleted(page: Page, signal: AbortSignal): Promise<void> {
    syncLogger.info("Waiting for Weixin Channels login page to leave QR login state");

    if (signal.aborted) throw new Error("Operation aborted");
    await page.waitForURL(
      (url) => !url.href.includes("/login.html") && !url.href.includes("/platform/login"),
      { timeout: 0 },
    );
  }

  async function waitForStatisticAuthData(
    page: Page,
    signal: AbortSignal,
  ): Promise<WeixinAuthData> {
    const deadline = Date.now() + 45_000;
    let fallbackAuthData: WeixinAuthData | undefined;

    while (!signal.aborted && Date.now() < deadline) {
      const authData = await fetchAuthData(page);

      if (authData.errCode === 0 && authData.data?.finderUser?.nickname) {
        fallbackAuthData = authData;
      }

      if (isStableFinderUser(authData)) {
        return authData;
      }

      await wait(statisticAuthPollIntervalMs, signal);
    }

    if (fallbackAuthData) {
      syncLogger.warn(
        "Using fallback Weixin Channels auth_data because stable finder user was not available",
      );
      return fallbackAuthData;
    }

    throw new Error("视频号账号信息等待已停止");
  }

  async function fetchAuthData(page: Page): Promise<WeixinAuthData> {
    return page.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          body: "{}",
          cache: "no-cache",
          credentials: "include",
          headers: {
            accept: "*/*",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "cache-control": "no-cache",
            "content-type": "application/json",
            pragma: "no-cache",
          },
          method: "POST",
          mode: "cors",
        });

        return (await response.json()) as WeixinAuthData;
      } catch (error) {
        return {
          errCode: -1,
          errMsg: error instanceof Error ? error.message : String(error),
        } satisfies WeixinAuthData;
      }
    }, authDataUrl);
  }

  function extractAccountInfo(authData: WeixinAuthData): {
    accountName: string;
    uniqId: string;
  } {
    const finderUser = authData.data?.finderUser;

    return {
      accountName: finderUser?.nickname ?? authData.data?.userAttr?.nickname ?? "视频号账号",
      uniqId: finderUser?.uniqId?.trim() ?? "",
    };
  }

  async function fetchPromoteAccountInfo(page: Page): Promise<{
    accountName: string;
    uniqId: string;
  }> {
    syncLogger.info("Requesting Weixin Channels promote account info");
    const result = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          body: "{}",
          cache: "no-cache",
          credentials: "include",
          headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            "cache-control": "no-cache",
            "content-type": "application/json",
            pragma: "no-cache",
            "promote-biz-id": "0",
          },
          method: "POST",
          mode: "cors",
        });
        const body = (await response.json().catch(() => undefined)) as unknown;

        return {
          body,
          error: "",
          status: response.status,
        };
      } catch (error) {
        return {
          body: undefined,
          error: error instanceof Error ? error.message : String(error),
          status: 0,
        };
      }
    }, promoteUserPrepareUrl);

    if (result.error) {
      throw new Error(`加热平台账号信息请求失败：${result.error}`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`加热平台账号信息请求失败：HTTP ${result.status}`);
    }
    if (!isRecord(result.body) || !isRecord(result.body.data)) {
      throw new Error("加热平台账号信息响应格式异常");
    }

    const accountId = result.body.data.accountId;
    if (typeof accountId !== "string" || !accountId.trim()) {
      throw new Error("加热平台账号信息响应中缺少 accountId");
    }

    const corporateUserInfo = result.body.data.corporateUserInfo;
    const corporateInfo = isRecord(corporateUserInfo) ? corporateUserInfo.corporateInfo : undefined;
    const accountNameCandidates = isRecord(corporateInfo)
      ? [corporateInfo.finderNickname, corporateInfo.nickname, corporateInfo.corporateName]
      : [];
    const accountName =
      accountNameCandidates
        .find(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        )
        ?.trim() ?? "加热平台账号";
    const uniqId = accountId.trim();

    syncLogger.info("Resolved Weixin Channels promote account from getUserPrepare", {
      accountId: uniqId,
      accountName,
    });

    return { accountName, uniqId };
  }

  async function signOutAccount(
    page: Page,
    options: StartWeixinChannelsSyncOptions,
    account: {
      accountName: string;
      uniqId?: string;
    },
    task: {
      mode: WeixinChannelsSyncMode;
      taskName: string;
      taskType: string;
    } = {
      mode: "assistant",
      taskName: playletExcelTaskName,
      taskType: playletExcelTaskType,
    },
  ): Promise<void> {
    syncLogger.info("Clearing Weixin Channels login state", account);
    await clearLoginState(page);
    options.sendEvent({
      accountName: account.accountName,
      message: `已退出登录：${account.accountName}`,
      mode: task.mode,
      taskName: task.taskName,
      taskType: task.taskType,
      type: "signed-out",
      uniqId: account.uniqId,
    });
  }

  function isStableFinderUser(authData: WeixinAuthData): boolean {
    const finderUser = authData.data?.finderUser;
    const nickname = finderUser?.nickname?.trim();
    const uniqId = finderUser?.uniqId?.trim();

    return Boolean(authData.errCode === 0 && nickname && uniqId && !/^用户\d+$/.test(nickname));
  }

  async function downloadStatisticFile(page: Page, targetDate: string): Promise<Download> {
    const download = await clickAndMaybeDownload(
      page,
      () => page.getByText("下载数据").click({ timeout: 120_000 }),
      "assistant statistic download control",
      targetDate,
    );

    if (download) {
      return download;
    }

    throw new Error("点击助手页面下载数据后没有捕获到浏览器下载事件");
  }

  async function downloadPromoteStatisticFile(page: Page, targetDate: string): Promise<Download> {
    const download = await clickAndMaybeDownload(
      page,
      () => getPromoteDownloadControl(page).click({ timeout: 120_000 }),
      "promote statistic download control",
      targetDate,
    );

    if (download) {
      return download;
    }

    throw new Error("点击加热平台数据下载按钮后没有捕获到浏览器下载事件");
  }

  async function downloadPromoteDataAnalysisFile(
    page: Page,
    targetDate: string,
    range: ResolvedDateRange,
  ): Promise<Download> {
    const downloadControl = getPromoteDataAnalysisDownloadControl(page);
    await downloadControl.waitFor({
      state: "visible",
      timeout: statisticResponseTimeoutMs,
    });
    await downloadControl.scrollIntoViewIfNeeded({
      timeout: statisticResponseTimeoutMs,
    });
    syncLogger.info("Weixin Channels standard data detail download control is ready", {
      selector: 'a[title="下载"]',
    });

    const targetResponsePromise = waitForPromoteDataAnalysisResponseWithExpectedFields(
      page,
      (response) =>
        isPromoteDataAnalysisDownloadQuery(response.request()) &&
        doesPromoteDataAnalysisRequestMatchDateRange(response.request(), range),
      downloadEventTimeoutMs,
    );
    const [download, targetResponse] = await Promise.all([
      clickAndMaybeDownload(
        page,
        () => downloadControl.click({ timeout: 120_000 }),
        "standard data analysis download control",
        targetDate,
      ),
      targetResponsePromise,
    ]);

    if (!targetResponse.ok()) {
      throw new Error(
        `标准看板下载数据请求失败：HTTP ${targetResponse.status()} ${targetResponse.statusText()}`,
      );
    }
    const responseFailure = await targetResponse.finished();
    if (responseFailure) {
      throw new Error(`标准看板下载数据响应接收失败：${responseFailure.message}`);
    }
    assertPromoteDataAnalysisRequestFields(targetResponse.request());
    await assertStatisticResponseSucceeded(targetResponse);
    await assertPromoteDataAnalysisResponseHasRows(targetResponse, targetDate);

    if (download) {
      return download;
    }

    throw new Error("点击加热平台标准看板下载按钮后没有捕获到浏览器下载事件");
  }

  async function clickAndMaybeDownload(
    page: Page,
    click: () => Promise<void>,
    label: string,
    targetDate: string,
  ): Promise<Download | undefined> {
    syncLogger.info(`Clicking ${label} and listening for download event`);

    const downloadPromise = page
      .waitForEvent("download", {
        timeout: downloadEventTimeoutMs,
      })
      .catch(() => undefined);

    await click();

    const download = await downloadPromise;

    if (!download) {
      syncLogger.info(`No browser download event captured from ${label}`);
      return undefined;
    }

    const failure = await download.failure();

    if (failure) {
      throw new Error(`视频号数据下载失败：${failure}`);
    }

    syncLogger.info("Browser download event received", {
      suggestedFilename: download.suggestedFilename(),
      targetDate,
      url: download.url(),
    });

    return download;
  }

  async function saveStatisticJson(
    body: Record<string, unknown>,
    options: {
      accountName: string;
      downloadDirectory: string;
      targetDate: string;
      uniqId: string;
    },
  ): Promise<{
    bytes: number;
    filePath: string;
    filename: string;
  }> {
    const preferredFilename = `助手_${sanitizeFilename(options.accountName)}_${sanitizeFilename(
      options.uniqId,
    )}_${sanitizeFilename(options.targetDate)}_剧集统计.json`;
    const directory = path.join(options.downloadDirectory, sanitizeFilename(options.accountName), sanitizeFilename(options.targetDate));
    await mkdir(directory, { recursive: true });
    const preferredFilePath = path.join(directory, preferredFilename);
    const filePath = await getAvailableDownloadFilePath(preferredFilePath);
    const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.partial`;
    const content = `${JSON.stringify(body, undefined, 2)}\n`;

    try {
      await writeFile(temporaryFilePath, content, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryFilePath, filePath);
    } catch (error) {
      await unlink(temporaryFilePath).catch(() => undefined);
      throw error;
    }

    const fileStats = await stat(filePath);
    return {
      bytes: fileStats.size,
      filePath,
      filename: path.basename(filePath),
    };
  }

  async function saveDownloadedFile(
    download: Download,
    options: {
      accountName: string;
      downloadDirectory: string;
      filenamePrefix?: string;
      targetDate: string;
      uniqId: string;
    },
  ): Promise<{
    bytes: number;
    filePath: string;
    filename: string;
    suggestedFilename: string;
  }> {
    const suggestedFilename = download.suggestedFilename();
    const safeSuggestedFilename = sanitizeFilename(suggestedFilename || "剧集数据统计.xlsx");
    const preferredFilename = `${options.filenamePrefix ? `${sanitizeFilename(options.filenamePrefix)}_` : ""}${sanitizeFilename(options.accountName)}_${sanitizeFilename(
      options.uniqId,
    )}_${sanitizeFilename(options.targetDate)}_${safeSuggestedFilename}`;
    const directory = path.join(options.downloadDirectory, sanitizeFilename(options.accountName), sanitizeFilename(options.targetDate));
    await mkdir(directory, { recursive: true });
    const preferredFilePath = path.join(directory, preferredFilename);
    const filePath = await getAvailableDownloadFilePath(preferredFilePath);
    const filename = path.basename(filePath);

    await saveDownloadStream(download, filePath);
    const fileStats = await stat(filePath);

    return {
      bytes: fileStats.size,
      filename,
      filePath,
      suggestedFilename,
    };
  }

  async function getAvailableDownloadFilePath(preferredFilePath: string): Promise<string> {
    const parsedPath = path.parse(preferredFilePath);

    for (let index = 0; index < 10_000; index += 1) {
      const candidatePath =
        index === 0
          ? preferredFilePath
          : path.join(parsedPath.dir, `${parsedPath.name} (${index})${parsedPath.ext}`);

      try {
        await stat(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return candidatePath;
        }
        throw error;
      }
    }

    throw new Error(`无法为下载文件生成可用名称：${preferredFilePath}`);
  }

  async function saveDownloadStream(download: Download, filePath: string): Promise<void> {
    const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.partial`;

    try {
      const downloadStream = await download.createReadStream();
      await pipeline(downloadStream, createWriteStream(temporaryFilePath, { flags: "wx" }));
      await rename(temporaryFilePath, filePath);
    } catch (error) {
      await unlink(temporaryFilePath).catch(() => undefined);
      throw error;
    }
  }

  async function importAssistantExcelFile(
    savedFile: {
      filePath: string;
      filename: string;
    },
    options: {
      sourceName: string;
      signal?: AbortSignal;
    },
  ) {
    const importClient = client;
    syncLogger.info("Resolving Daren Center source id for assistant Excel import", {
      sourceName: options.sourceName,
    });
    const sourceId = await importClient.getSourceId(options.sourceName, options.signal);
    syncLogger.info("Resolved Daren Center source id for assistant Excel import", {
      sourceId,
      sourceName: options.sourceName,
    });
    const fileBuffer = await readFile(savedFile.filePath);
    syncLogger.info("Read assistant Excel file for import", {
      bytes: fileBuffer.byteLength,
      filePath: savedFile.filePath,
    });

    const result = await importClient.importCopyrightData({
      signal: options.signal,
      file: new Blob([new Uint8Array(fileBuffer)], {
        type: contentTypeForFile(savedFile.filename),
      }),
      filename: savedFile.filename,
      sourceId,
    });

    return {
      result,
      sourceId,
    };
  }

  async function importPromoteStatisticFile(
    savedFile: {
      filePath: string;
      filename: string;
    },
    options: {
      accountName: string;
      uniqId: string;
      signal?: AbortSignal;
    },
  ) {
    const fileBuffer = await readFile(savedFile.filePath);
    syncLogger.info("Importing Weixin Channels promote file into Daren Center", {
      accountName: options.accountName,
      bytes: fileBuffer.byteLength,
      filePath: savedFile.filePath,
      filename: savedFile.filename,
      uniqId: options.uniqId,
    });

    const result = await client.importDramaHeatingActions({
      signal: options.signal,
      file: new Blob([new Uint8Array(fileBuffer)], {
        type: contentTypeForFile(savedFile.filename),
      }),
      filename: savedFile.filename,
    });

    syncLogger.info("Weixin Channels promote import completed", {
      accountName: options.accountName,
      body: result.body,
      filePath: savedFile.filePath,
      status: result.status,
      statusText: result.statusText,
      uniqId: options.uniqId,
    });

    return result;
  }

  async function importPromoteDataAnalysisFile(
    savedFile: {
      filePath: string;
      filename: string;
    },
    options: {
      accountName: string;
      uniqId: string;
      signal?: AbortSignal;
    },
  ) {
    syncLogger.info("Importing Weixin Channels standard data analysis CSV", {
      accountName: options.accountName,
      filePath: savedFile.filePath,
      filename: savedFile.filename,
      uniqId: options.uniqId,
    });

    return importPromoteStatisticFile(savedFile, options);
  }

  async function clearLoginState(page: Page): Promise<void> {
    await page.context().clearCookies();
    await page
      .evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      })
      .catch(() => undefined);
  }

  function sanitizeFilename(value: string): string {
    const withoutControlCharacters = Array.from(value, (character) =>
      character.charCodeAt(0) <= 31 ? "_" : character,
    ).join("");
    const sanitized = withoutControlCharacters
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80);

    return sanitized || "unknown";
  }

  function contentTypeForFile(filename: string): string {
    const extension = path.extname(filename).toLowerCase();

    if (extension === ".csv") {
      return "text/csv";
    }

    if (extension === ".xls") {
      return "application/vnd.ms-excel";
    }

    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Operation aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    dryRun: host.dryRun === true,
    getSettings: getWeixinChannelsSettings,
    saveSettings: saveWeixinChannelsSettings,
    start: startWeixinChannelsSync,
    stop: stopWeixinChannelsSync,
    runningModes: () => [...activeJobs.keys()],
    downloadDirectory: () => resolveWeixinChannelsDownloadRoot(getWeixinChannelsSettings()),
  };
}
