import type { Json } from "@dramabridge/youtube-automation";

export type YoutubeConfig = {
  pythonExecutable: string;
  proxy: string;
  paused: boolean;
  webPort: number;
};
export type YoutubeStatus = {
  running: boolean;
  starting: boolean;
  installing: boolean;
  startedAt?: number;
  installStage?: string;
  pid?: number;
  error?: string;
  logDir: string;
  webUrls?: string[];
};
export type YoutubeEnvironment = {
  python: string;
  executable?: string;
  compatible: boolean;
  ready: boolean;
  modules: Record<string, boolean>;
  ffmpeg: boolean;
  ffprobe: boolean;
};
export type YoutubeAccount = { id: string; name: string; authorized: boolean };
export type YoutubeTask = {
  id: string;
  status: string;
  payload: {
    resourceName: string;
    title?: string;
    privacy?: string;
    mode?: string;
    compress?: boolean;
    accountId?: string;
  };
  progress?: {
    percent?: number | null;
    speedText?: string;
    etaText?: string;
    etaScope?: "item";
    stage?: string;
    message?: string;
    elapsedSeconds?: number;
    processedSeconds?: number;
    durationSeconds?: number;
    episodeIndex?: number;
    episodeCount?: number;
    completedItems?: number;
    totalItems?: number;
    lastAdvanceSeconds?: number;
    frame?: number;
    fps?: number;
  } | null;
  timings?: {
    active?: { stage: string; startedAt: string } | null;
    stages?: Record<string, { elapsedSeconds: number; runs: number; lastOutcome?: string }>;
  };
  error?: string | null;
  logs?: string;
  result?: Json;
  created: string;
  updated: string;
};
export type YoutubeConfigResult = {
  config: YoutubeConfig;
  path: string;
  dataDirectory: string;
  credentialsImported: boolean;
};
export type YoutubeOauth = { status: string; message?: string };

export const isYoutubeWeb = document.documentElement.dataset.youtubeWeb === "true";
async function webRequest<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(route, {
    credentials: "same-origin",
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Web 请求失败");
  return value as T;
}
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (isYoutubeWeb) {
    if (channel === "youtube-drama:service:status") return webRequest<T>("/web-api/status");
    if (channel === "youtube-drama:api:request") {
      const route = args[0] as string;
      const popup = route === "/api/oauth/start" ? window.open("about:blank", "_blank") : null;
      if (popup) popup.opener = null;
      return webRequest<T>("/web-api/request", { route, body: args[1] })
        .then((result) => {
          if (route === "/api/oauth/start") {
            const url = new URL(String((result as { url?: string }).url ?? ""));
            if (url.protocol !== "https:" || url.hostname !== "accounts.google.com")
              throw new Error("Google 授权地址无效");
            if (popup) popup.location.href = url.href;
          }
          return result;
        })
        .catch((error) => {
          popup?.close();
          throw error;
        });
    }
    return Promise.reject(new Error("请在桌面端配置此项"));
  }
  if (!window.ipcRenderer)
    return Promise.reject(new Error("请在 DramaBridge 桌面应用中使用 YouTube"));
  return window.ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

export const youtubeService = {
  openTestUsers: () => invoke<void>("youtube-drama:oauth:open-test-users"),
  openWeb: (url?: string) => invoke<void>("youtube-drama:web:open", url),
  status: () => invoke<YoutubeStatus>("youtube-drama:service:status"),
  start: () => invoke<YoutubeStatus>("youtube-drama:service:start"),
  stop: () => invoke<YoutubeStatus>("youtube-drama:service:stop"),
  config: () => invoke<YoutubeConfigResult>("youtube-drama:config:get"),
  saveConfig: (config: Partial<YoutubeConfig>) =>
    invoke<YoutubeConfigResult>("youtube-drama:config:save", config),
  selectPython: () => invoke<string | null>("youtube-drama:config:select-python"),
  importCredentials: () => invoke<{ imported: boolean } | null>("youtube-drama:credentials:import"),
  checkEnvironment: () => invoke<YoutubeEnvironment>("youtube-drama:environment:check"),
  install: () => invoke<{ started: boolean }>("youtube-drama:environment:install"),
  request: <T = Json>(route: string, body?: Json) =>
    invoke<T>("youtube-drama:api:request", route, body),
};
