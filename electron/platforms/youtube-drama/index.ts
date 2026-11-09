import { existsSync } from "node:fs";
import { app, shell, session } from "electron";
import Store from "electron-store";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  YoutubePythonRuntime,
  YoutubeWebServer,
  type Json,
  type YoutubeSettings,
} from "@dramabridge/youtube-automation";
import { trpcIpc as ipcMain } from "../../ipc";
import { resolveGlobalPlatformDirectories } from "../../global-app-config";
import { createElectronPlatformLogger } from "../../platform-logger";
import { dispatchInternalBaiduRequest } from "../../local-api";
import { selectDirectory } from "../shared";

type Config = YoutubeSettings & {
  pythonExecutable: string;
  webPort: number;
};
const defaults: Config = {
  pythonExecutable: "",
  proxy: "http://127.0.0.1:7897",
  paused: false,
  webPort: 18440,
};
const runtime = new YoutubePythonRuntime();
const web = new YoutubeWebServer();
let store: Store<{ config: Config }> | undefined;
const settingsStore = () => {
  if (!store) {
    store = new Store({ name: "youtube-drama-config", defaults: { config: defaults } });
    const existing = store.get("config");
    const { webAccessCode: _removed, ...clean } = existing as Config & { webAccessCode?: string };
    if (_removed !== undefined || !existing.webPort)
      store.set("config", { ...defaults, ...clean, webPort: existing.webPort || defaults.webPort });
  }
  return store;
};
const config = () => ({ ...defaults, ...settingsStore().get("config") });

function directories() {
  return resolveGlobalPlatformDirectories("youtube-drama", {
    runDataDir: path.join(app.getPath("userData"), ".drama-runs", "youtube-drama"),
    localMaterialRoot: "",
  });
}
function logDir() {
  return path.join(directories().runDataDir, "logs");
}
function logger() {
  return createElectronPlatformLogger({
    platform: "youtube-drama",
    logDir: logDir(),
    scope: "python",
  });
}

function validateConfig(value: Config): Config {
  if (value.pythonExecutable.includes("\0") || value.pythonExecutable.length > 4096)
    throw new Error("请选择有效的 Python 启动文件");
  if (value.proxy) {
    const proxy = new URL(value.proxy);
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      !proxy.hostname ||
      proxy.username ||
      proxy.password ||
      proxy.hash
    )
      throw new Error("YouTube 代理必须是有效的 HTTP(S) 地址");
  }
  if (!Number.isInteger(value.webPort) || value.webPort < 1 || value.webPort > 65535)
    throw new Error("Web 端口应为 1–65535");
  return {
    webPort: value.webPort,
    pythonExecutable: value.pythonExecutable.trim(),
    proxy: value.proxy.trim(),
    paused: Boolean(value.paused),
  };
}

function options() {
  const current = validateConfig(config());
  const require = createRequire(import.meta.url);
  const ffmpeg = require("ffmpeg-static") as string;
  const ffprobe =
    process.platform === "darwin" && process.arch === "arm64"
      ? path.join(
          path.dirname(require.resolve("@ffprobe-installer/darwin-arm64/package.json")),
          "ffprobe",
        )
      : (require("ffprobe-static") as { path: string }).path;
  return {
    sourceDirectory: app.isPackaged
      ? path.join(process.resourcesPath, "youtube-automation")
      : path.join(app.getAppPath(), "packages", "youtube-automation", "python"),
    workingDirectory: directories().runDataDir,
    pythonExecutable: current.pythonExecutable,
    mediaDirectories: [
      path.dirname(ffmpeg.replace("app.asar", "app.asar.unpacked")),
      path.dirname(ffprobe.replace("app.asar", "app.asar.unpacked")),
    ],
    settings: { proxy: current.proxy, paused: current.paused },
    download: async (url: string, signal: AbortSignal) => {
      const direct = session.fromPartition("youtube-drama-python-download-direct");
      if (current.proxy) {
        const proxy = session.fromPartition("youtube-drama-python-download-proxy");
        await proxy.setProxy({ proxyRules: current.proxy });
        try {
          const response = await proxy.fetch(url, { signal });
          if (response.ok) return response;
          await response.body?.cancel();
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      await direct.setProxy({ mode: "direct" });
      return direct.fetch(url, { signal });
    },
    onExit: () => {
      void web.stop();
    },
    netdisk: async (request: { path: string; body: Json }) => {
      const result = await dispatchInternalBaiduRequest({
        method: request.body === null ? "GET" : "POST",
        url: new URL("http://127.0.0.1/api" + request.path),
        body: request.body,
        signal: AbortSignal.timeout(40_000),
      });
      return result.data as Json;
    },
    saveSettings: (settings: Partial<YoutubeSettings>) =>
      settingsStore().set("config", validateConfig({ ...config(), ...settings })),
    log: (line: string) =>
      logger().info(line.replace(/(https?:\/\/\S*oauth\S*)\?\S+/gi, "$1?[redacted]")),
  };
}

export const stopYoutubeRuntime = () => {
  void web.stop();
  runtime.dispose();
};
export const stopYoutubeService = async () => {
  await web.stop();
  await runtime.stop();
};
export const youtubeRunningCount = () => (runtime.status().running ? 1 : 0);
export const youtubeRuntimeSummary = () => ({
  platform: "youtube-drama",
  ...runtime.status(),
  logDir: logDir(),
  webUrls: web.urls(),
});
export const openYoutubeLogs = () => shell.openPath(logDir());

export function registerYoutubeHandlers() {
  const configurationResult = () => ({
    config: config(),
    path: settingsStore().path,
    dataDirectory: directories().runDataDir,
    credentialsImported: existsSync(
      path.join(directories().runDataDir, "data", "credentials", "client_secret.json"),
    ),
  });
  ipcMain.handle("youtube-drama:config:get", configurationResult);
  ipcMain.handle("youtube-drama:environment:check", () => runtime.inspectEnvironment(options()));
  ipcMain.handle("youtube-drama:config:save", (_event, value: Partial<Config>) => {
    if (runtime.status().running || runtime.status().starting || runtime.status().installing)
      throw new Error("请先停止 YouTube 服务，再修改配置");
    const next = validateConfig({
      ...config(),
      pythonExecutable:
        typeof value.pythonExecutable === "string"
          ? value.pythonExecutable
          : config().pythonExecutable,
      proxy: typeof value.proxy === "string" ? value.proxy : config().proxy,
      webPort: typeof value.webPort === "number" ? value.webPort : config().webPort,
    });
    settingsStore().set("config", next);
    return configurationResult();
  });
  ipcMain.handle("youtube-drama:config:select-python", async (event) =>
    selectDirectory(event, { title: "选择 Python 3.12 启动文件", properties: ["openFile"] }),
  );
  ipcMain.handle("youtube-drama:credentials:import", async (event) => {
    if (runtime.status().running)
      throw new Error("请先停止 YouTube 服务，再更换 Google 客户端凭据");
    const file = await selectDirectory(event, {
      title: "选择 Google 桌面应用 client_secret.json",
      properties: ["openFile"],
      filters: [{ name: "Google OAuth JSON", extensions: ["json"] }],
    });
    if (!file) return null;
    const raw = await readFile(file, "utf8");
    if (Buffer.byteLength(raw) > 65536) throw new Error("Google 客户端凭据文件过大");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
      installed?: {
        client_id?: string;
        client_secret?: string;
        auth_uri?: string;
        token_uri?: string;
      };
    };
    const client = parsed.installed;
    if (
      !client?.client_id ||
      !client.client_secret ||
      client.auth_uri !== "https://accounts.google.com/o/oauth2/auth" ||
      ![
        "https://oauth2.googleapis.com/token",
        "https://accounts.google.com/o/oauth2/token",
      ].includes(client.token_uri ?? "")
    )
      throw new Error("需要 Google 桌面应用的 OAuth 客户端凭据，不是网页应用或令牌文件");
    const directory = path.join(directories().runDataDir, "data", "credentials");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "client_secret.json"), JSON.stringify(parsed), {
      mode: 0o600,
    });
    return { imported: true };
  });
  ipcMain.handle("youtube-drama:oauth:open-test-users", async () => {
    const url = new URL("https://console.cloud.google.com/auth/audience");
    try {
      const raw = await readFile(
        path.join(directories().runDataDir, "data", "credentials", "client_secret.json"),
        "utf8",
      );
      const credentials = JSON.parse(raw) as { installed?: { project_id?: unknown } };
      const project = credentials.installed?.project_id;
      if (typeof project === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(project))
        url.searchParams.set("project", project);
    } catch {
      /* Google Cloud can select the project when credentials are unavailable. */
    }
    await shell.openExternal(url.href);
  });
  ipcMain.handle("youtube-drama:web:open", async (_event, url?: string) => {
    const target = url ?? web.urls()[0];
    if (!target || !web.urls().includes(target)) throw new Error("请先启动 YouTube 服务");
    await shell.openExternal(target);
  });
  ipcMain.handle("youtube-drama:service:status", () => youtubeRuntimeSummary());
  ipcMain.handle("youtube-drama:service:start", async () => {
    await runtime.start(options());
    try {
      const current = config();
      await web.start({
        port: current.webPort,
        directory: path.join(app.getAppPath(), "dist"),
        status: () => ({ ...runtime.status(), logDir: "" }),
        request: (route, body) => runtime.request(route, body),
      });
    } catch (error) {
      await runtime.stop();
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        const portError = new Error("Web 端口已被占用，请修改端口后重试");
        Object.assign(portError, { cause: error });
        throw portError;
      }
      throw error;
    }
    return youtubeRuntimeSummary();
  });
  ipcMain.handle("youtube-drama:service:stop", async () => {
    await stopYoutubeService();
    return youtubeRuntimeSummary();
  });
  ipcMain.handle("youtube-drama:environment:install", () => {
    if (runtime.status().running || runtime.status().starting || runtime.status().installing)
      throw new Error("请先停止服务，并等待当前操作完成");
    void runtime
      .installDependencies(options())
      .catch((error) => logger().error("Python 环境准备失败", { error }));
    return { started: true };
  });
  ipcMain.handle("youtube-drama:api:request", async (_event, route: string, body?: Json) => {
    if (typeof route !== "string") throw new Error("无效的 YouTube 请求");
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body)) > 65536)
      throw new Error("请求不能超过 64 KiB");
    const result = await runtime.request(route, body);
    if (route === "/api/oauth/start") {
      const url = new URL(String((result as { url?: string }).url ?? ""));
      if (
        url.protocol !== "https:" ||
        url.hostname !== "accounts.google.com" ||
        url.username ||
        url.password
      )
        throw new Error("Google 授权地址无效");
      await shell.openExternal(url.href);
    }
    return result;
  });
}
