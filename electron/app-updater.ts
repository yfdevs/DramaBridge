import { app, net, powerMonitor } from "electron";
import { CancellationError, CancellationToken } from "builder-util-runtime";
import Store from "electron-store";
import { createRequire } from "node:module";
import type { ProgressInfo, UpdateInfo } from "electron-updater";

import { createValidatedStore } from "./core/config-store";
import { emitIpcEvent, trpcIpc as ipcMain } from "./ipc";
import { logMain } from "./main-logger";

const require = createRequire(import.meta.url);
const { gt: isVersionGreater } = require("semver") as {
  gt: (candidate: string, current: string) => boolean;
};

const AUTOMATIC_UPDATE_START_DELAY_MS = 15_000;
const AUTOMATIC_UPDATE_INTERVAL_MS = 10 * 60_000;
const AUTOMATIC_UPDATE_RESUME_DELAY_MS = 5_000;
const UPDATE_SOURCE_PROBE_TIMEOUT_MS = 6_000;
const UPDATE_SOURCE_PROBE_CONCURRENCY = 3;
const UPDATE_SOURCE_FAILURE_COOLDOWN_MS = 30 * 60_000;
const UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 45_000;
const UPDATE_DOWNLOAD_MAX_SOURCE_ATTEMPTS = 3;
const AUTOMATIC_UPDATE_RETRY_DELAYS_MS = [2, 5, 15, 30].map((minutes) => minutes * 60_000);

const appUpdateSources = [
  {
    id: "accelerated",
    label: "down.mxw.xx.kg（默认）",
    description: "通过 down.mxw.xx.kg 获取 GitHub Release，国内网络通常更快。",
    url: "https://down.mxw.xx.kg/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "github",
    label: "GitHub 官方源",
    description: "直接连接 GitHub Release，适合可稳定访问 GitHub 的网络。",
    url: "https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "github-dpik-top",
    label: "github.dpik.top",
    description: "通过 github.dpik.top 加速获取 GitHub Release。",
    url: "https://github.dpik.top/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "gh-proxy-com",
    label: "gh-proxy.com",
    description: "通过 gh-proxy.com 加速获取 GitHub Release。",
    url: "https://gh-proxy.com/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "github-tbap-top",
    label: "github.tbap.top",
    description: "通过 github.tbap.top 加速获取 GitHub Release。",
    url: "https://github.tbap.top/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "memory-echoes",
    label: "github-proxy.memory-echoes.cn",
    description: "通过 github-proxy.memory-echoes.cn 加速获取 GitHub Release。",
    url: "https://github-proxy.memory-echoes.cn/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "gh-dpik-top",
    label: "gh.dpik.top",
    description: "通过 gh.dpik.top 加速获取 GitHub Release。",
    url: "https://gh.dpik.top/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "geekertao",
    label: "ghfile.geekertao.top",
    description: "通过 ghfile.geekertao.top 加速获取 GitHub Release。",
    url: "https://ghfile.geekertao.top/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
  {
    id: "ghproxy-net",
    label: "ghproxy.net",
    description: "通过 ghproxy.net 加速获取 GitHub Release。",
    url: "https://ghproxy.net/https://github.com/yfdevs/DramaBridge/releases/latest/download",
  },
] as const;

export type AppUpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type AppUpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type AppUpdateSourceId = (typeof appUpdateSources)[number]["id"];
export type AppUpdateSourceMode = "auto" | "manual";
export type AppUpdateSourceSelection = "auto" | AppUpdateSourceId;

export type AppUpdateSource = {
  id: AppUpdateSourceId;
  label: string;
  description: string;
  url: string;
};

export type AppUpdateStatus = {
  state: AppUpdateState;
  supported: boolean;
  enabled: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  progress?: AppUpdateProgress;
  error?: string;
  disabledReason?: string;
  sourceMode: AppUpdateSourceMode;
  source: AppUpdateSource;
  sources: AppUpdateSource[];
  lastCheckedAt?: string;
  nextCheckAt?: string;
  retryAttempt?: number;
  runningPlatformCount: number;
  updatedAt: string;
};

export type AppUpdateInstallOptions = {
  stopRunningServices?: boolean;
};

type AppUpdateSourceHealth = {
  averageLatencyMs?: number;
  averageBytesPerSecond?: number;
  successes: number;
  failures: number;
  cooldownUntil?: string;
};

type AppUpdateStore = {
  sourceId: AppUpdateSourceId;
  sourceMode: AppUpdateSourceMode;
  sourceHealth: Partial<Record<AppUpdateSourceId, AppUpdateSourceHealth>>;
};

type RegisterAppUpdaterHandlersOptions = {
  getRunningPlatformCount?: () => number;
  stopAllPlatformServices?: () => Promise<void>;
};

let configured = false;
let registered = false;
let latestUpdateInfo: UpdateInfo | null = null;
let downloadedUpdateInfo: UpdateInfo | null = null;
let downloadedUpdateProgress: AppUpdateProgress | undefined;
let status: AppUpdateStatus | null = null;
let getRunningPlatformCount: () => number = () => 0;
let stopAllPlatformServices: (() => Promise<void>) | null = null;
let autoUpdaterLoadError: string | null = null;
let autoUpdaterInstance:
  | typeof import("electron-updater").autoUpdater
  | null
  | undefined;
let store: Store<AppUpdateStore> | null = null;
let downloadCancellationToken: CancellationToken | null = null;
let downloadCancellationReason: "user" | "stall" | null = null;
let downloadLastProgressAt = 0;
let downloadPromise: Promise<AppUpdateStatus> | null = null;
let updateCheckPromise: Promise<AppUpdateStatus> | null = null;
let automaticUpdateTimer: NodeJS.Timeout | null = null;
let consecutiveAutomaticFailures = 0;
let autoDownloadSuppressedVersion: string | null = null;
let shuttingDown = false;

function getStore() {
  if (!store) {
    store = createValidatedStore<AppUpdateStore>({
      name: "app-update-config",
      defaults: {
        sourceId: "accelerated",
        sourceMode: "auto",
        sourceHealth: {},
      },
    });
  }

  return store;
}

function getSelectedUpdateSource(): AppUpdateSource {
  const sourceId = getStore().get("sourceId");
  return appUpdateSources.find((source) => source.id === sourceId) ?? appUpdateSources[0];
}

function getUpdateSourceMode(): AppUpdateSourceMode {
  return getStore().get("sourceMode") === "manual" ? "manual" : "auto";
}

function sourceHealth(sourceId: AppUpdateSourceId): AppUpdateSourceHealth {
  const saved = getStore().get("sourceHealth")[sourceId];
  return {
    averageLatencyMs: saved?.averageLatencyMs,
    averageBytesPerSecond: saved?.averageBytesPerSecond,
    successes: saved?.successes ?? 0,
    failures: saved?.failures ?? 0,
    cooldownUntil: saved?.cooldownUntil,
  };
}

function updateSourceHealth(
  sourceId: AppUpdateSourceId,
  changes: Partial<AppUpdateSourceHealth>,
) {
  const health = getStore().get("sourceHealth");
  getStore().set("sourceHealth", {
    ...health,
    [sourceId]: {
      ...sourceHealth(sourceId),
      ...changes,
    },
  });
}

function recordSourceSuccess(
  sourceId: AppUpdateSourceId,
  options: { latencyMs?: number; bytesPerSecond?: number } = {},
) {
  const current = sourceHealth(sourceId);
  const blend = (previous: number | undefined, latest: number | undefined) => {
    if (!latest || latest <= 0) return previous;
    return previous ? Math.round(previous * 0.7 + latest * 0.3) : Math.round(latest);
  };
  updateSourceHealth(sourceId, {
    averageLatencyMs: blend(current.averageLatencyMs, options.latencyMs),
    averageBytesPerSecond: blend(current.averageBytesPerSecond, options.bytesPerSecond),
    successes: current.successes + 1,
    cooldownUntil: undefined,
  });
}

function recordSourceFailure(sourceId: AppUpdateSourceId) {
  const current = sourceHealth(sourceId);
  updateSourceHealth(sourceId, {
    failures: current.failures + 1,
    cooldownUntil: new Date(Date.now() + UPDATE_SOURCE_FAILURE_COOLDOWN_MS).toISOString(),
  });
}

function getAutoUpdater() {
  if (autoUpdaterInstance !== undefined) {
    return autoUpdaterInstance;
  }

  try {
    const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
    autoUpdaterInstance = autoUpdater;
    autoUpdaterLoadError = null;
  } catch (error) {
    autoUpdaterInstance = null;
    autoUpdaterLoadError = readableError(error);
    logMain("error", "Failed to load auto-update module", error);
  }

  return autoUpdaterInstance;
}

type UpdateSourceProbeResult = {
  source: AppUpdateSource;
  latencyMs: number;
  fingerprint: string;
  version: string;
};

function parseUpdateMetadata(metadata: string) {
  if (metadata.length > 1024 * 1024) {
    throw new Error("更新元数据过大。");
  }
  const version = /^\s*version:\s*["']?([^\s"']+)/mu.exec(metadata)?.[1];
  const hashes = [...metadata.matchAll(/^\s*sha512:\s*["']?([^\s"']+)/gmu)]
    .map((match) => match[1])
    .filter((hash): hash is string => Boolean(hash));
  if (!version || hashes.length === 0) {
    throw new Error("更新元数据缺少版本号或 SHA512。");
  }
  return {
    version,
    fingerprint: `${version}|${[...new Set(hashes)].sort().join("|")}`,
  };
}

async function probeUpdateSource(source: AppUpdateSource): Promise<UpdateSourceProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_SOURCE_PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await net.fetch(`${source.url}/latest.yml`, {
      headers: { "cache-control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const metadata = parseUpdateMetadata(await response.text());
    return {
      source,
      latencyMs: Date.now() - startedAt,
      ...metadata,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeUpdateSources(sources: readonly AppUpdateSource[]) {
  const results: UpdateSourceProbeResult[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < sources.length) {
      const source = sources[cursor++];
      if (!source) continue;
      try {
        const result = await probeUpdateSource(source);
        recordSourceSuccess(source.id, { latencyMs: result.latencyMs });
        results.push(result);
      } catch (error) {
        recordSourceFailure(source.id);
        logMain("warn", "Failed to probe application update source", {
          sourceId: source.id,
          error: readableError(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(UPDATE_SOURCE_PROBE_CONCURRENCY, sources.length) },
      () => worker(),
    ),
  );
  return results;
}

function sourceProbeScore(result: UpdateSourceProbeResult) {
  const health = sourceHealth(result.source.id);
  const observedLatency = health.averageLatencyMs
    ? result.latencyMs * 0.7 + health.averageLatencyMs * 0.3
    : result.latencyMs;
  const reliabilityPenalty = 1 + health.failures / Math.max(health.successes + 1, 1) * 0.25;
  const throughputBonus = Math.min((health.averageBytesPerSecond ?? 0) / 1024 / 1024, 20) * 8;
  return observedLatency * reliabilityPenalty - throughputBonus;
}

function chooseBestUpdateSource(results: UpdateSourceProbeResult[]) {
  if (results.length === 0) return undefined;
  const official = results.find((result) => result.source.id === "github");
  const fingerprintCounts = new Map<string, number>();
  for (const result of results) {
    fingerprintCounts.set(
      result.fingerprint,
      (fingerprintCounts.get(result.fingerprint) ?? 0) + 1,
    );
  }
  const preferredFingerprint = official?.fingerprint
    ?? [...fingerprintCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const consistentResults = results.filter(
    (result) => result.fingerprint === preferredFingerprint,
  );
  const ranked = consistentResults.sort((left, right) => sourceProbeScore(left) - sourceProbeScore(right));
  const best = ranked[0];
  const current = ranked.find((result) => result.source.id === getSelectedUpdateSource().id);
  if (best && current && sourceProbeScore(current) <= sourceProbeScore(best) * 1.2) {
    return current;
  }
  return best;
}

function isSourceCoolingDown(source: AppUpdateSource) {
  const cooldownUntil = sourceHealth(source.id).cooldownUntil;
  return cooldownUntil ? Date.parse(cooldownUntil) > Date.now() : false;
}

async function selectAutomaticUpdateSource(excluded = new Set<AppUpdateSourceId>()) {
  const availableSources = appUpdateSources.filter(
    (source) => !excluded.has(source.id) && !isSourceCoolingDown(source),
  );
  const candidates = availableSources.length > 0
    ? availableSources
    : appUpdateSources.filter((source) => !excluded.has(source.id));
  const selected = chooseBestUpdateSource(await probeUpdateSources(candidates));
  if (!selected) {
    throw new Error("所有自动更新源当前均不可用。");
  }
  getStore().set("sourceId", selected.source.id);
  logMain("info", "Auto-selected application update source", {
    sourceId: selected.source.id,
    latencyMs: selected.latencyMs,
    version: selected.version,
  });
  return selected.source;
}

function clearAutomaticUpdateTimer() {
  if (automaticUpdateTimer) {
    clearTimeout(automaticUpdateTimer);
    automaticUpdateTimer = null;
  }
}

function scheduleAutomaticUpdate(delayMs: number) {
  clearAutomaticUpdateTimer();
  if (shuttingDown || readDisabledReason()) return;
  const nextCheckAt = new Date(Date.now() + delayMs).toISOString();
  setStatus({ nextCheckAt });
  automaticUpdateTimer = setTimeout(() => {
    automaticUpdateTimer = null;
    void checkForAppUpdate(true).catch((error) => {
      logMain("error", "Automatic application update check failed", error);
      scheduleAfterAutomaticFailure();
    });
  }, delayMs);
  automaticUpdateTimer.unref();
}

function scheduleAfterAutomaticFailure() {
  const index = Math.min(
    consecutiveAutomaticFailures,
    AUTOMATIC_UPDATE_RETRY_DELAYS_MS.length - 1,
  );
  const delay = AUTOMATIC_UPDATE_RETRY_DELAYS_MS[index] ?? AUTOMATIC_UPDATE_INTERVAL_MS;
  consecutiveAutomaticFailures += 1;
  scheduleAutomaticUpdate(delay);
}

export function registerAppUpdaterHandlers(options: RegisterAppUpdaterHandlersOptions = {}) {
  if (registered) {
    return;
  }

  registered = true;
  getRunningPlatformCount = options.getRunningPlatformCount ?? getRunningPlatformCount;
  stopAllPlatformServices = options.stopAllPlatformServices ?? stopAllPlatformServices;
  configureAutoUpdater();

  ipcMain.handle("app:update:status", () => getAppUpdateStatus());
  ipcMain.handle("app:update:check", () => checkForAppUpdate());
  ipcMain.handle("app:update:download", () => downloadAppUpdate());
  ipcMain.handle("app:update:download:cancel", () => cancelAppUpdateDownload());
  ipcMain.handle("app:update:install", (_event, options?: AppUpdateInstallOptions) =>
    installAppUpdate(options),
  );
  ipcMain.handle("app:update:source:set", (_event, selection: AppUpdateSourceSelection) =>
    setAppUpdateSource(selection),
  );

  powerMonitor.on("resume", () => {
    if (!["downloading", "downloaded", "installing"].includes(status?.state ?? "")) {
      scheduleAutomaticUpdate(AUTOMATIC_UPDATE_RESUME_DELAY_MS);
    }
  });
  app.once("before-quit", () => {
    shuttingDown = true;
    clearAutomaticUpdateTimer();
  });
  scheduleAutomaticUpdate(AUTOMATIC_UPDATE_START_DELAY_MS);
}

export function getAppUpdateStatus() {
  status = normalizeStatus(status ?? createStatus("idle"));
  return status;
}

async function checkForAppUpdate(automatic = false) {
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = performAppUpdateCheck(automatic).finally(() => {
    updateCheckPromise = null;
  });
  return updateCheckPromise;
}

async function performAppUpdateCheck(automatic: boolean) {
  const disabledReason = readDisabledReason();

  if (disabledReason) {
    return setStatus({
      state: "idle",
      progress: undefined,
      error: undefined,
      disabledReason,
      nextCheckAt: undefined,
    });
  }

  if (["downloading", "installing"].includes(status?.state ?? "")) {
    return getAppUpdateStatus();
  }

  if (!net.isOnline()) {
    const networkError = "当前网络不可用，联网后将自动重试更新。";
    setStatus({
      ...(downloadedUpdateInfo
        ? downloadedStatus(downloadedUpdateInfo)
        : { state: "error" as const, progress: undefined }),
      error: networkError,
      lastCheckedAt: new Date().toISOString(),
      nextCheckAt: undefined,
    });
    scheduleAfterAutomaticFailure();
    return getAppUpdateStatus();
  }

  latestUpdateInfo = null;
  setStatus({
    state: "checking",
    latestVersion: undefined,
    releaseName: undefined,
    releaseDate: undefined,
    releaseNotes: undefined,
    progress: undefined,
    error: undefined,
    nextCheckAt: undefined,
    retryAttempt: undefined,
  });

  const excludedSources = new Set<AppUpdateSourceId>();
  try {
    const autoUpdater = getAutoUpdater();

    if (!autoUpdater) {
      setStatus({ state: "idle", disabledReason: readDisabledReason() });
      return getAppUpdateStatus();
    }

    for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_SOURCE_ATTEMPTS; attempt += 1) {
      try {
        if (getUpdateSourceMode() === "auto") {
          await selectAutomaticUpdateSource(excludedSources);
        }
        applySelectedUpdateSource(autoUpdater);
        await autoUpdater.checkForUpdates();
        recordSourceSuccess(getSelectedUpdateSource().id);
        break;
      } catch (error) {
        const failedSource = getSelectedUpdateSource();
        recordSourceFailure(failedSource.id);
        excludedSources.add(failedSource.id);
        if (getUpdateSourceMode() === "manual" || attempt >= UPDATE_DOWNLOAD_MAX_SOURCE_ATTEMPTS) {
          throw error;
        }
        setStatus({ retryAttempt: attempt, error: `更新源 ${failedSource.label} 不可用，正在切换。` });
      }
    }

    consecutiveAutomaticFailures = 0;
    const checkedAt = new Date().toISOString();
    setStatus({ lastCheckedAt: checkedAt, retryAttempt: undefined });
    const availableUpdateInfo = latestUpdateInfo as UpdateInfo | null;
    if (downloadedUpdateInfo && !isNewerUpdate(availableUpdateInfo, downloadedUpdateInfo)) {
      latestUpdateInfo = downloadedUpdateInfo;
      setStatus({
        ...downloadedStatus(downloadedUpdateInfo),
        lastCheckedAt: checkedAt,
      });
      scheduleAutomaticUpdate(AUTOMATIC_UPDATE_INTERVAL_MS);
    } else if (
      availableUpdateInfo
      && status?.state === "available"
      && autoDownloadSuppressedVersion !== availableUpdateInfo.version
    ) {
      void downloadAppUpdate(true).catch((error) => {
        logMain("error", "Automatic application update download failed", error);
      });
    } else if (status?.state !== "downloaded") {
      scheduleAutomaticUpdate(AUTOMATIC_UPDATE_INTERVAL_MS);
    }
  } catch (error) {
    setStatus({
      ...(downloadedUpdateInfo
        ? downloadedStatus(downloadedUpdateInfo)
        : { state: "error" as const, progress: undefined }),
      error: downloadedUpdateInfo
        ? `检查新版本失败：${readableError(error)}`
        : readableError(error),
      lastCheckedAt: new Date().toISOString(),
      retryAttempt: undefined,
    });
    if (automatic || getUpdateSourceMode() === "auto") {
      scheduleAfterAutomaticFailure();
    } else {
      scheduleAutomaticUpdate(AUTOMATIC_UPDATE_INTERVAL_MS);
    }
  }

  return getAppUpdateStatus();
}

async function downloadAppUpdate(automatic = false) {
  if (downloadPromise) return downloadPromise;
  downloadPromise = performAppUpdateDownload(automatic).finally(() => {
    downloadPromise = null;
  });
  return downloadPromise;
}

async function performAppUpdateDownload(automatic: boolean) {
  const disabledReason = readDisabledReason();

  if (disabledReason) {
    throw new Error(disabledReason);
  }

  if (!latestUpdateInfo) {
    const message = "当前没有可下载的新版本，请先检查更新。";
    setStatus({ state: "error", error: message });
    throw new Error(message);
  }
  if (!automatic) autoDownloadSuppressedVersion = null;

  const excludedSources = new Set<AppUpdateSourceId>();
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_MAX_SOURCE_ATTEMPTS; attempt += 1) {
    if (!latestUpdateInfo) {
      const autoUpdater = getAutoUpdater();
      if (!autoUpdater) break;
      try {
        await selectAutomaticUpdateSource(excludedSources);
        applySelectedUpdateSource(autoUpdater);
        await autoUpdater.checkForUpdates();
        if (!latestUpdateInfo || status?.state !== "available") {
          throw new Error("备用更新源没有返回可下载的新版本。");
        }
      } catch (sourceError) {
        lastError = sourceError;
        const failedSource = getSelectedUpdateSource();
        recordSourceFailure(failedSource.id);
        excludedSources.add(failedSource.id);
        continue;
      }
    }
    const source = getSelectedUpdateSource();
    setStatus({
      state: "downloading",
      progress: undefined,
      error: undefined,
      retryAttempt: attempt > 1 ? attempt - 1 : undefined,
      nextCheckAt: undefined,
    });
    try {
      const result = await performAppUpdateDownloadAttempt();
      if (result === "cancelled") {
        autoDownloadSuppressedVersion = latestUpdateInfo?.version ?? null;
        scheduleAutomaticUpdate(AUTOMATIC_UPDATE_INTERVAL_MS);
        return getAppUpdateStatus();
      }
      recordSourceSuccess(source.id, {
        bytesPerSecond: status?.progress?.bytesPerSecond,
      });
      consecutiveAutomaticFailures = 0;
      return getAppUpdateStatus();
    } catch (error) {
      lastError = error;
      recordSourceFailure(source.id);
      excludedSources.add(source.id);
      if (getUpdateSourceMode() === "manual" || attempt >= UPDATE_DOWNLOAD_MAX_SOURCE_ATTEMPTS) {
        break;
      }

      setStatus({
        state: "checking",
        progress: undefined,
        retryAttempt: attempt,
        error: `从 ${source.label} 下载失败，正在切换备用更新源。`,
      });
      latestUpdateInfo = null;
    }
  }

  setStatus({
    ...(downloadedUpdateInfo
      ? downloadedStatus(downloadedUpdateInfo)
      : { state: "error" as const, progress: undefined }),
    error: `自动更新下载失败：${readableError(lastError)}`,
    retryAttempt: undefined,
  });
  scheduleAfterAutomaticFailure();
  if (!automatic) throw lastError;
  return getAppUpdateStatus();
}

async function performAppUpdateDownloadAttempt(): Promise<"completed" | "cancelled"> {
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) {
    throw new Error(readDisabledReason() ?? "更新模块不可用。");
  }

  const cancellationToken = new CancellationToken();
  downloadCancellationToken = cancellationToken;
  downloadCancellationReason = null;
  downloadLastProgressAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - downloadLastProgressAt >= UPDATE_DOWNLOAD_STALL_TIMEOUT_MS) {
      downloadCancellationReason = "stall";
      cancellationToken.cancel();
    }
  }, 5_000);
  watchdog.unref();

  try {
    await autoUpdater.downloadUpdate(cancellationToken);
    return "completed";
  } catch (error) {
    if (error instanceof CancellationError || cancellationToken.cancelled) {
      if (downloadCancellationReason === "user") return "cancelled";
      if (downloadCancellationReason === "stall") {
        if (error instanceof Error) error.message = "更新下载超过 45 秒没有进度。";
        throw error;
      }
    }
    throw error;
  } finally {
    clearInterval(watchdog);
    if (downloadCancellationToken === cancellationToken) {
      downloadCancellationToken = null;
      downloadCancellationReason = null;
    }
    cancellationToken.dispose();
  }
}

function cancelAppUpdateDownload() {
  if (status?.state !== "downloading" || !downloadCancellationToken) {
    throw new Error("当前没有正在下载的应用更新。");
  }

  downloadCancellationReason = "user";
  autoDownloadSuppressedVersion = latestUpdateInfo?.version ?? null;
  downloadCancellationToken.cancel();
  return setStatus({
    state: "available",
    progress: undefined,
    error: undefined,
    retryAttempt: undefined,
  });
}

async function installAppUpdate(options: AppUpdateInstallOptions = {}) {
  const disabledReason = readDisabledReason();

  if (disabledReason) {
    throw new Error(disabledReason);
  }

  if (status?.state !== "downloaded") {
    const message = "更新还没有下载完成，暂时不能安装。";
    setStatus({ error: message });
    throw new Error(message);
  }

  const runningPlatformCount = getRunningPlatformCount();
  if (runningPlatformCount > 0) {
    if (!options.stopRunningServices) {
      const message = `有 ${runningPlatformCount} 个平台服务正在运行。可以停止全部服务后重启安装。`;
      setStatus({ state: "downloaded", error: message });
      throw new Error(message);
    }

    if (!stopAllPlatformServices) {
      const message = "暂时无法自动停止平台服务，请手动停止后再重启安装。";
      setStatus({ state: "downloaded", error: message });
      throw new Error(message);
    }

    setStatus({ state: "downloaded", error: undefined });
    logMain("info", "Stopping all platform services before update installation", {
      runningPlatformCount,
    });

    try {
      await stopAllPlatformServices();
    } catch (error) {
      const message = `未能停止全部平台服务：${readableError(error)} 请稍后重试，或手动停止服务。`;
      setStatus({ state: "downloaded", error: message });
      throw Object.assign(new Error(message), { cause: error });
    }

    const remainingPlatformCount = getRunningPlatformCount();
    if (remainingPlatformCount > 0) {
      const message = `仍有 ${remainingPlatformCount} 个平台服务未停止，请稍后重试或手动停止。`;
      setStatus({ state: "downloaded", error: message });
      throw new Error(message);
    }
  }

  clearAutomaticUpdateTimer();
  setStatus({ state: "installing", error: undefined, nextCheckAt: undefined });
  const autoUpdater = getAutoUpdater();

  if (!autoUpdater) {
    throw new Error(readDisabledReason() ?? "更新模块不可用。");
  }

  autoUpdater.quitAndInstall(false, true);

  return getAppUpdateStatus();
}

function configureAutoUpdater() {
  if (configured) {
    return;
  }

  configured = true;
  const autoUpdater = getAutoUpdater();

  if (!autoUpdater) {
    setStatus({
      state: "idle",
      progress: undefined,
      error: undefined,
      disabledReason: readDisabledReason(),
    });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.fullChangelog = true;
  applySelectedUpdateSource(autoUpdater);

  autoUpdater.on("checking-for-update", () => {
    setStatus({ state: "checking", progress: undefined, error: undefined });
  });

  autoUpdater.on("update-available", (info) => {
    if (autoDownloadSuppressedVersion && autoDownloadSuppressedVersion !== info.version) {
      autoDownloadSuppressedVersion = null;
    }
    latestUpdateInfo = info;
    setStatus({
      ...statusFromUpdateInfo(info),
      state: "available",
      progress: undefined,
      error: undefined,
      retryAttempt: undefined,
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    latestUpdateInfo = null;
    autoDownloadSuppressedVersion = null;
    setStatus({
      ...statusFromUpdateInfo(info),
      state: "not-available",
      progress: undefined,
      error: undefined,
      retryAttempt: undefined,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    downloadLastProgressAt = Date.now();
    setStatus({
      state: "downloading",
      progress: statusFromProgress(progress),
      error: undefined,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedUpdateInfo = info;
    downloadedUpdateProgress = status?.progress;
    latestUpdateInfo = info;
    setStatus({
      ...downloadedStatus(info),
      error: undefined,
      retryAttempt: undefined,
    });
    scheduleAutomaticUpdate(AUTOMATIC_UPDATE_INTERVAL_MS);
  });

  autoUpdater.on("update-cancelled", (info) => {
    latestUpdateInfo = info;
    setStatus({
      ...statusFromUpdateInfo(info),
      state: "available",
      progress: undefined,
      error: undefined,
      retryAttempt: undefined,
    });
  });

  autoUpdater.on("error", (error) => {
    setStatus({
      state: "error",
      error: readableError(error),
    });
  });
}

function setAppUpdateSource(selection: AppUpdateSourceSelection) {
  if (
    ["checking", "downloading", "installing", "downloaded"].includes(status?.state ?? "")
  ) {
    throw new Error("当前更新任务进行中，暂时不能切换更新源。");
  }

  if (selection === "auto") {
    getStore().set("sourceMode", "auto");
  } else {
    const source = appUpdateSources.find((candidate) => candidate.id === selection);
    if (!source) {
      throw new Error("未知的应用更新源。");
    }
    getStore().set({
      sourceId: source.id,
      sourceMode: "manual",
    });
  }

  const autoUpdater = getAutoUpdater();
  if (autoUpdater) {
    applySelectedUpdateSource(autoUpdater);
  }

  latestUpdateInfo = null;
  autoDownloadSuppressedVersion = null;
  setStatus({
    state: "idle",
    latestVersion: undefined,
    releaseName: undefined,
    releaseDate: undefined,
    releaseNotes: undefined,
    progress: undefined,
    error: undefined,
  });
  scheduleAutomaticUpdate(AUTOMATIC_UPDATE_RESUME_DELAY_MS);
  return getAppUpdateStatus();
}

function applySelectedUpdateSource(
  autoUpdater: typeof import("electron-updater").autoUpdater,
) {
  const source = getSelectedUpdateSource();
  autoUpdater.setFeedURL({
    provider: "generic",
    url: source.url,
    channel: "latest",
  });
  logMain("info", "Application update source configured", {
    sourceId: source.id,
    url: source.url,
  });
}

function setStatus(nextStatus: Partial<AppUpdateStatus>) {
  status = normalizeStatus({
    ...(status ?? createStatus("idle")),
    ...nextStatus,
    updatedAt: new Date().toISOString(),
  });
  broadcastAppUpdateStatus(status);

  return status;
}

function normalizeStatus(nextStatus: AppUpdateStatus) {
  const disabledReason = readDisabledReason();
  const source = getSelectedUpdateSource();

  return {
    ...nextStatus,
    supported: process.platform === "win32",
    enabled: !disabledReason,
    currentVersion: app.getVersion(),
    disabledReason,
    sourceMode: getUpdateSourceMode(),
    source,
    sources: [...appUpdateSources],
    runningPlatformCount: getRunningPlatformCount(),
    updatedAt: nextStatus.updatedAt || new Date().toISOString(),
  };
}

function createStatus(state: AppUpdateState): AppUpdateStatus {
  return normalizeStatus({
    state,
    supported: process.platform === "win32",
    enabled: !readDisabledReason(),
    currentVersion: app.getVersion(),
    disabledReason: readDisabledReason(),
    sourceMode: getUpdateSourceMode(),
    source: getSelectedUpdateSource(),
    sources: [...appUpdateSources],
    runningPlatformCount: getRunningPlatformCount(),
    updatedAt: new Date().toISOString(),
  });
}

function statusFromUpdateInfo(info: UpdateInfo): Partial<AppUpdateStatus> {
  return {
    latestVersion: info.version,
    releaseName: info.releaseName ?? undefined,
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  };
}

function downloadedStatus(info: UpdateInfo): Partial<AppUpdateStatus> {
  return {
    ...statusFromUpdateInfo(info),
    state: "downloaded",
    progress: downloadedUpdateProgress,
    nextCheckAt: undefined,
  };
}

function isNewerUpdate(candidate: UpdateInfo | null, downloaded: UpdateInfo) {
  if (!candidate) return false;

  try {
    return isVersionGreater(candidate.version, downloaded.version);
  } catch (error) {
    logMain("warn", "Failed to compare application update versions", {
      candidateVersion: candidate.version,
      downloadedVersion: downloaded.version,
      error: readableError(error),
    });
    return candidate.version !== downloaded.version;
  }
}

function statusFromProgress(progress: ProgressInfo): AppUpdateProgress {
  return {
    percent: Math.round(progress.percent * 10) / 10,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  };
}

function normalizeReleaseNotes(releaseNotes: UpdateInfo["releaseNotes"]) {
  if (typeof releaseNotes === "string") {
    return releaseNotes.trim() || undefined;
  }

  if (Array.isArray(releaseNotes)) {
    const notes = releaseNotes
      .map((note) => [note.version, note.note].filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n\n");

    return notes.trim() || undefined;
  }

  return undefined;
}

function readDisabledReason() {
  if (process.platform !== "win32") {
    return "当前更新功能只启用 Windows 安装包。";
  }

  if (!app.isPackaged) {
    return "开发模式下不会连接 GitHub Releases 更新源。";
  }

  if (autoUpdaterLoadError) {
    return `更新模块加载失败：${autoUpdaterLoadError}`;
  }

  return undefined;
}

function readableError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function broadcastAppUpdateStatus(nextStatus: AppUpdateStatus) {
  emitIpcEvent("app:update:changed", nextStatus);
}
