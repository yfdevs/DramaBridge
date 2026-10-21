import { app } from "electron";
import { trpcIpc as ipcMain } from "../../ipc";
import Store from "electron-store";
import { createValidatedStore } from "../../core/config-store";
import { registerTaskAnalyticsHandler } from "../shared/task-analytics";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { formatDateKey } from "@dramabridge/automation-logging";
import {
  assertGlobalDirectoriesConfigured,
  resolveGlobalPlatformDirectories,
} from "../../global-app-config";
import {
  directoryDefaultPath,
  normalizePlatformRunDataDir,
  openExistingPath,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from "../shared";

type TiktokDramaCenterRuntimeStatus = {
  platform: "tiktok-drama";
  running: boolean;
  loginState: "login-required" | "logged-in" | "unknown";
  activeUrl?: string;
  userDataDir: string;
};

type TiktokDramaCenterRuntime = {
  getStatus: () => TiktokDramaCenterRuntimeStatus;
  stop: () => Promise<void>;
};

export type TiktokDramaCenterConfig = {
  headless: string;
  localEpisodeVideoRoot: string;
  operationDelaySeconds: string;
  runDataDir: string;
};

export type TiktokDramaCenterServiceStatus = TiktokDramaCenterRuntimeStatus & {
  pid: number | null;
};

type TiktokDramaCenterConfigResult = {
  config: TiktokDramaCenterConfig;
  path: string;
  restartRequired: boolean;
};

type TiktokDramaCenterStore = {
  config: Partial<TiktokDramaCenterConfig> & Record<string, string | undefined>;
};

const defaultTiktokDramaCenterConfig: TiktokDramaCenterConfig = {
  headless: "false",
  localEpisodeVideoRoot: "",
  operationDelaySeconds: "0.02",
  runDataDir: ".drama-runs/tiktok-drama",
};

const runtimeController = new RuntimeController<TiktokDramaCenterRuntime>();
let store: Store<TiktokDramaCenterStore> | null = null;

export function getTiktokDramaCenterBrowserInstanceCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getTiktokDramaCenterRunningPlatformCount() {
  return runtimeController.current?.getStatus().running ? 1 : 0;
}

export function getTiktokDramaCenterPlatformRuntimeSummary() {
  const runtimeStatus = runtimeController.current?.getStatus();
  const running = Boolean(runtimeStatus?.running);

  return {
    platform: "tiktok-drama" as const,
    running,
    startedAt: runtimeController.startedAt,
    browserInstanceCount: running ? 1 : 0,
    browserInstances: running
      ? [{
          id: "default",
          label: "TikTok",
          loginState: runtimeStatus?.loginState ?? "unknown",
          activeUrl: runtimeStatus?.activeUrl,
        }]
      : [],
    logDir: tiktokDramaCenterLogDir(),
  };
}

export function openTiktokDramaCenterLogDir() {
  const logDir = tiktokDramaCenterLogDir();
  mkdirSync(logDir, { recursive: true });
  return openExistingPath(logDir);
}

function getStore() {
  if (!store) {
    store = createValidatedStore<TiktokDramaCenterStore>({
      name: "tiktok-drama-config",
      defaults: {
        config: defaultTiktokDramaCenterConfig,
      },
    });
  }

  return store;
}

function normalizeConfig(
  config: Partial<TiktokDramaCenterConfig> & Record<string, string | undefined>,
): TiktokDramaCenterConfig {
  return {
    headless: config.headless ?? defaultTiktokDramaCenterConfig.headless,
    localEpisodeVideoRoot:
      config.localEpisodeVideoRoot ?? defaultTiktokDramaCenterConfig.localEpisodeVideoRoot,
    operationDelaySeconds:
      config.operationDelaySeconds ?? defaultTiktokDramaCenterConfig.operationDelaySeconds,
    runDataDir:
      !config.runDataDir || config.runDataDir === ".drama-runs"
        ? defaultTiktokDramaCenterConfig.runDataDir
        : config.runDataDir,
  };
}

function readConfig(): TiktokDramaCenterConfig {
  const config = normalizeConfig(getStore().get("config"));
  const directories = resolveGlobalPlatformDirectories("tiktok-drama", {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  });
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  };
}

function writeConfig(config: TiktokDramaCenterConfig) {
  getStore().set("config", config);
}

function configPath() {
  return getStore().path;
}

function tiktokDramaCenterRunDataDir(config = readConfig()) {
  return resolveFromAppRoot(config.runDataDir);
}

function tiktokDramaCenterUserDataDir() {
  return path.join(tiktokDramaCenterRunDataDir(), "auth", "chromium-profile");
}

function tiktokDramaCenterCredentialStatePath() {
  return path.join(tiktokDramaCenterRunDataDir(), "auth", "storage-state.json");
}

function tiktokDramaCenterSchemeFile() {
  return path.join(tiktokDramaCenterRunDataDir(), "scheme.local.json");
}

function tiktokDramaCenterTempDir() {
  return path.join(tiktokDramaCenterRunDataDir(), "tmp");
}

function tiktokDramaCenterLogDir() {
  return path.join(tiktokDramaCenterRunDataDir(), "logs");
}

function tiktokDramaCenterLogFile() {
  return path.join(tiktokDramaCenterLogDir(), `app-${formatDateKey()}.json`);
}

async function defaultStoppedStatus(): Promise<TiktokDramaCenterServiceStatus> {
  return {
    platform: "tiktok-drama",
    running: false,
    loginState: "unknown",
    userDataDir: tiktokDramaCenterUserDataDir(),
    pid: null,
  };
}

async function status(): Promise<TiktokDramaCenterServiceStatus> {
  const runtime = runtimeController.current;
  if (!runtime) return defaultStoppedStatus();

  const runtimeStatus = runtime.getStatus();
  if (!runtimeStatus.running) {
    await runtimeController.stop();
    return defaultStoppedStatus();
  }

  return {
    ...runtimeStatus,
    pid: process.pid,
  };
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();

  const config = readConfig();
  const operationDelayMs = Math.max(0, Number.parseFloat(config.operationDelaySeconds) || 0) * 1000;
  const { startTiktokDramaCenterRuntime } = await import("@dramabridge/tiktok-drama-automation");
  return startTiktokDramaCenterRuntime({
    userDataDir: tiktokDramaCenterUserDataDir(),
    credentialStatePath: tiktokDramaCenterCredentialStatePath(),
    config: {
      logFile: tiktokDramaCenterLogFile(),
      schemeFile: tiktokDramaCenterSchemeFile(),
      tempDir: tiktokDramaCenterTempDir(),
      videoDir: config.localEpisodeVideoRoot,
      browser: {
        headless: config.headless === "true",
        slowMo: operationDelayMs,
      },
    },
  });
}

export function registerTiktokDramaCenterPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: "tiktok-drama",
    unsupportedReason: "TikTok 任务日志接口尚未接入",
  });
  ipcMain.handle("tiktok-drama:config:get", () => ({
    config: readConfig(),
    path: configPath(),
    restartRequired: false,
  }));

  ipcMain.handle(
    "tiktok-drama:config:save",
    (_event, config: TiktokDramaCenterConfig): TiktokDramaCenterConfigResult => {
      const nextConfig = normalizeConfig(config);
      writeConfig(nextConfig);
      return {
        config: nextConfig,
        path: configPath(),
        restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
      };
    },
  );

  ipcMain.handle(
    "tiktok-drama:config:select-local-episode-video-root",
    async (event, currentPath?: string) => {
      return selectDirectory(event, {
        title: "选择 TikTok 剧集视频根目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("videos")),
        properties: ["openDirectory", "createDirectory"],
      });
    },
  );

  ipcMain.handle(
    "tiktok-drama:config:select-run-data-dir",
    async (event, currentPath?: string) => {
      const selectedPath = await selectDirectory(event, {
        title: "选择 TikTok 运行数据目录",
        defaultPath: directoryDefaultPath(currentPath, app.getPath("documents")),
        properties: ["openDirectory", "createDirectory"],
      });

      return normalizePlatformRunDataDir(selectedPath, "tiktok-drama");
    },
  );

  ipcMain.handle("tiktok-drama:service:status", () => status());

  ipcMain.handle("tiktok-drama:service:start", async () => {
    assertGlobalDirectoriesConfigured();
    const runtime = runtimeController.current;
    if (runtime && !runtime.getStatus().running) {
      await runtimeController.stop();
    }

    await runtimeController.start(startRuntime);
    return status();
  });

  ipcMain.handle("tiktok-drama:service:stop", async () => {
    await runtimeController.stop();
    return status();
  });
}

export function stopTiktokDramaCenterPlatformRuntime() {
  runtimeController.stopInBackground();
}

export function stopTiktokDramaCenterPlatformService() {
  return runtimeController.stop();
}
