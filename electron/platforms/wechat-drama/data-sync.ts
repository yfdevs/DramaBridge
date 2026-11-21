import { app, shell } from "electron";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  createWechatDataSyncRuntime,
  DarenCenterClient,
  type WeixinChannelsSettings,
  type WeixinChannelsSyncEvent,
  type WeixinChannelsSyncMode,
} from "@dramabridge/wechat-drama-automation";
import { createValidatedStore } from "../../core/config-store";
import { emitIpcEvent, trpcIpc } from "../../ipc";
import { playwrightBrowsersPath, selectDirectory } from "../shared";
import { createElectronPlatformLogger } from "../../platform-logger";

type Connection = {
  dataSyncDownloadDirectory: string;
  dataSyncDryRun: string;
  dataSyncApiBaseUrl: string;
  dataSyncAdminUsername: string;
  dataSyncAdminPassword: string;
  closeFailedTaskPages: string;
};
const defaults: WeixinChannelsSettings = {
  assistantDatePreset: "previous-day",
  assistantUseTestImportSource: false,
  promoteStandardDatePreset: "previous-day",
  promoteDatePreset: "previous-day",
};
const store = createValidatedStore<{
  settings: WeixinChannelsSettings;
  records: WeixinChannelsSyncEvent[];
}>({ name: "wechat-drama-data-sync", defaults: { settings: defaults, records: [] } });
let runtime: ReturnType<typeof createWechatDataSyncRuntime> | undefined;
let lastConnection = "";
let starting = false;
let lastEvent: WeixinChannelsSyncEvent | undefined;
const modes = ["assistant", "assistant-json", "promote-standard"] as const;
function defaultDownloadDirectory() {
  return path.join(app.getPath("downloads"), "微信视频号", "数据同步");
}
function publish(event: WeixinChannelsSyncEvent) {
  const stamped = { ...event, timestamp: event.timestamp ?? new Date().toISOString() };
  lastEvent = stamped;
  if (event.type === "imported" || event.type === "account-failed" || event.type === "error") {
    store.set("records", [stamped, ...store.get("records")].slice(0, 200));
  }
  emitIpcEvent("wechat-drama:data-sync:event", stamped);
}
function getRuntime(connection: Connection) {
  const key = JSON.stringify(connection);
  if (!runtime || key !== lastConnection) {
    if (runtime?.runningModes().length) throw new Error("请先停止数据同步任务，再应用新的后台配置");
    const dryRun = connection.dataSyncDryRun === "true";
    const baseUrl = connection.dataSyncApiBaseUrl.trim() || (dryRun ? "http://127.0.0.1" : "");
    if (!baseUrl) throw new Error("请先在配置管理中填写后台导入地址");
    if (!/^https?:$/.test(new URL(baseUrl).protocol))
      throw new Error("请在配置管理中填写有效的后台导入地址");
    if (!dryRun && (!connection.dataSyncAdminUsername.trim() || !connection.dataSyncAdminPassword))
      throw new Error("请先在配置管理中填写数据同步管理员账号和密码");
    process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
    const logger = createElectronPlatformLogger({
      platform: "wechat-drama",
      scope: "data-sync",
      logDir: path.join(app.getPath("userData"), "logs", "wechat-drama"),
    });
    runtime = createWechatDataSyncRuntime({
      defaultDownloadDirectory: defaultDownloadDirectory(),
      userDataDirectory: app.getPath("userData"),
      profileRoot: path.join(app.getPath("userData"), "browser-profiles", "data-sync"),
      browsersPath: playwrightBrowsersPath(),
      dryRun,
      closeFailedTaskPages: connection.closeFailedTaskPages === "true",
      client: new DarenCenterClient({
        baseUrl,
        username: connection.dataSyncAdminUsername.trim(),
        password: connection.dataSyncAdminPassword,
        timeoutMs: 120_000,
      }),
      getSettings: () => ({
        ...store.get("settings"),
        downloadDirectory: connection.dataSyncDownloadDirectory.trim() || undefined,
      }),
      saveSettings: (settings) => store.set("settings", settings),
      logger: {
        info: (message, details) => logger.info(message, details ? { details } : undefined),
        warn: (message, details) => logger.warn(message, details ? { details } : undefined),
        error: (message, details) => logger.error(message, details ? { details } : undefined),
      },
    });
    lastConnection = key;
  }
  return runtime;
}
export function registerWechatDataSyncHandlers(readConfig: () => Connection) {
  trpcIpc.handle("wechat-drama:data-sync:state", () => ({
    settings: {
      ...store.get("settings"),
      downloadDirectory: readConfig().dataSyncDownloadDirectory.trim() || undefined,
    },
    records: store.get("records"),
    runningModes: runtime?.runningModes() ?? [],
    dryRun: runtime?.runningModes().length
      ? runtime.dryRun
      : readConfig().dataSyncDryRun === "true",
    lastEvent,
  }));
  trpcIpc.handle("wechat-drama:config:select-data-sync-directory", (event, currentPath?: string) =>
    selectDirectory(event, {
      title: "选择数据保存目录",
      defaultPath: currentPath || readConfig().dataSyncDownloadDirectory || undefined,
      properties: ["openDirectory", "createDirectory"],
    }),
  );
  trpcIpc.handle("wechat-drama:data-sync:start", async (_event, mode: WeixinChannelsSyncMode) => {
    if (!modes.includes(mode as (typeof modes)[number])) throw new Error("不支持的数据同步任务");
    if (starting) throw new Error("正在启动任务，请稍候");
    starting = true;
    try {
      return getRuntime(readConfig()).start({ sendEvent: publish }, mode);
    } finally {
      starting = false;
    }
  });
  trpcIpc.handle(
    "wechat-drama:data-sync:stop",
    (_event, mode?: WeixinChannelsSyncMode) => runtime?.stop(mode) ?? { stopped: false },
  );
  trpcIpc.handle("wechat-drama:data-sync:settings", (_event, settings: WeixinChannelsSettings) => {
    if (runtime?.runningModes().length) throw new Error("请停止任务后再修改处理配置");
    // Normalize using the same runtime implementation, without requiring credentials.
    const validator = createWechatDataSyncRuntime({
      defaultDownloadDirectory: defaultDownloadDirectory(),
      userDataDirectory: app.getPath("userData"),
      profileRoot: "",
      browsersPath: "",
      client: {} as DarenCenterClient,
      getSettings: () => store.get("settings"),
      saveSettings: (value) => store.set("settings", value),
      logger: console,
    });
    return validator.saveSettings({ ...settings, downloadDirectory: undefined });
  });
  trpcIpc.handle("wechat-drama:data-sync:clear-records", () => {
    store.set("records", []);
  });
  trpcIpc.handle("wechat-drama:data-sync:open-directory", async () => {
    const directory = runtime?.runningModes().length
      ? runtime.downloadDirectory()
      : readConfig().dataSyncDownloadDirectory.trim() || defaultDownloadDirectory();
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
}
export async function stopWechatDataSync() {
  await runtime?.stop();
}

export function getWechatDataSyncLegacyDirectory() {
  return store.get("settings").downloadDirectory ?? "";
}
