import { execFile, spawn } from "node:child_process";
import { pathExists } from "@dramabridge/file-utils";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";

import { debugHost, requestTimeoutMs } from "../domain/constants.js";
import {
  CdpConnectionError,
  UnsupportedPlatformError,
  cdpConnectionError,
} from "../domain/errors.js";

export {
  configureBaiduNetdiskAutomationLogging,
  flushBaiduNetdiskAutomationLogs,
} from "../infrastructure/logging.js";
export * from "../domain/errors.js";

export const DEFAULT_BAIDU_NETDISK_CDP_PORT = 9337;

const baiduProcessNames = ["BaiduNetdisk", "BaiduNetdiskUnite"];

export type BaiduNetdiskCdpTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type BaiduNetdiskCdpStatus = {
  platform: "baidu-netdisk";
  isWindows: boolean;
  port: number;
  appRunning: boolean;
  cdpRunning: boolean;
  ready: boolean;
  executablePath?: string;
  targetCount: number;
  checkedAt: string;
  message: string;
};

export type BaiduNetdiskLaunchResult = {
  status: BaiduNetdiskCdpStatus;
  executablePath: string;
  restarted: boolean;
};

export type BaiduNetdiskCdpOptions = {
  port?: number;
  executablePath?: string;
};

export type StartBaiduNetdiskCdpOptions = BaiduNetdiskCdpOptions & {
  restart?: boolean;
  waitMs?: number;
};

async function pathKind(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) return "directory";
    if (fileStat.isFile()) return "file";
  } catch {
    return null;
  }

  return null;
}

async function getJson<T>(url: string, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getBaiduNetdiskCdpTargets(port = DEFAULT_BAIDU_NETDISK_CDP_PORT) {
  return getJson<BaiduNetdiskCdpTarget[]>(`http://${debugHost}:${port}/json/list`);
}

export async function isBaiduNetdiskCdpPort(port = DEFAULT_BAIDU_NETDISK_CDP_PORT) {
  try {
    const version = await getJson<{ "User-Agent"?: string }>(
      `http://${debugHost}:${port}/json/version`,
    );
    const targets = await getBaiduNetdiskCdpTargets(port);
    const userAgent = version["User-Agent"] ?? "";
    const hasBaiduTarget = targets.some((target) =>
      target.url.includes("BaiduNetdisk") ||
      target.url.includes("core.asar") ||
      target.url.includes("pan.baidu.com"),
    );

    return /baidunetdisk/i.test(userAgent) || hasBaiduTarget;
  } catch {
    return false;
  }
}

async function execText(file: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.toString().trim() || error.message));
        return;
      }

      resolve(stdout.toString());
    });
  });
}

async function getRunningBaiduProcesses() {
  if (process.platform !== "win32") return [];

  const command = [
    "$names = @('BaiduNetdisk','BaiduNetdiskUnite');",
    "Get-Process -Name $names -ErrorAction SilentlyContinue |",
    "Select-Object -ExpandProperty ProcessName -Unique",
  ].join(" ");

  const output = await execText("powershell.exe", ["-NoProfile", "-Command", command]).catch(
    () => "",
  );

  return output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function defaultEngineExecutableCandidates() {
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const homeDir = os.homedir();
  const candidates = [
    appData
      ? path.join(appData, "baidu", "BaiduNetdisk", "module", "BrowserEngine", "BaiduNetdiskUnite.exe")
      : undefined,
    localAppData
      ? path.join(localAppData, "baidu", "BaiduNetdisk", "module", "BrowserEngine", "BaiduNetdiskUnite.exe")
      : undefined,
    path.join(homeDir, "AppData", "Roaming", "baidu", "BaiduNetdisk", "module", "BrowserEngine", "BaiduNetdiskUnite.exe"),
    "C:\\Program Files\\BaiduNetdisk\\BaiduNetdisk.exe",
    "C:\\Program Files (x86)\\BaiduNetdisk\\BaiduNetdisk.exe",
  ].filter((item): item is string => Boolean(item));

  return [...new Set(candidates)];
}

export async function findBaiduNetdiskExecutable(explicitPath?: string) {
  const explicit = explicitPath?.trim();

  if (explicit) {
    const explicitKind = await pathKind(explicit);

    if (explicitKind === "file") {
      return explicit;
    }

    if (explicitKind === "directory") {
      const directoryCandidates = [
        path.join(explicit, "module", "BrowserEngine", "BaiduNetdiskUnite.exe"),
        path.join(explicit, "BaiduNetdiskUnite.exe"),
        path.join(explicit, "BaiduNetdisk.exe"),
      ];

      for (const candidate of directoryCandidates) {
        if (await pathExists(candidate)) return candidate;
      }

      throw new Error(`百度网盘安装目录中没有找到启动文件：${explicit}`);
    }

    throw new Error(`百度网盘安装目录或启动文件不存在：${explicit}`);
  }

  for (const candidate of defaultEngineExecutableCandidates()) {
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error("没有找到百度网盘启动文件，请检查是否已安装百度网盘。");
}

async function stopBaiduNetdiskProcesses() {
  const runningProcesses = await getRunningBaiduProcesses();
  if (runningProcesses.length === 0) return;

  for (const name of baiduProcessNames) {
    await execText("taskkill.exe", ["/IM", `${name}.exe`, "/T", "/F"]).catch(() => "");
  }
}

async function waitForCdpStatus(
  options: Required<Pick<BaiduNetdiskCdpOptions, "port">> & Pick<BaiduNetdiskCdpOptions, "executablePath">,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastStatus = await checkBaiduNetdiskCdpStatus(options);

  while (!lastStatus.ready && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    lastStatus = await checkBaiduNetdiskCdpStatus(options);
  }

  return lastStatus;
}

async function checkBaiduNetdiskCdpStatusPromise(
  options: BaiduNetdiskCdpOptions = {},
): Promise<BaiduNetdiskCdpStatus> {
  const port = options.port ?? DEFAULT_BAIDU_NETDISK_CDP_PORT;
  const isWindows = process.platform === "win32";
  const checkedAt = new Date().toISOString();

  if (!isWindows) {
    return {
      platform: "baidu-netdisk",
      isWindows,
      port,
      appRunning: false,
      cdpRunning: false,
      ready: false,
      targetCount: 0,
      checkedAt,
      message: "百度网盘 CDP 自动化当前只支持 Windows。",
    };
  }

  const [processes, executablePath] = await Promise.all([
    getRunningBaiduProcesses(),
    findBaiduNetdiskExecutable(options.executablePath).catch(() => undefined),
  ]);
  const targets = await getBaiduNetdiskCdpTargets(port).catch(() => []);
  const cdpRunning = targets.length > 0 && (await isBaiduNetdiskCdpPort(port));
  const appRunning = cdpRunning || processes.length > 0;
  const ready = appRunning && cdpRunning;

  return {
    platform: "baidu-netdisk",
    isWindows,
    port,
    appRunning,
    cdpRunning,
    ready,
    executablePath,
    targetCount: targets.length,
    checkedAt,
    message: ready
      ? `百度网盘 CDP 已连接，端口 ${port}。`
      : appRunning
        ? `百度网盘已启动，但端口 ${port} 未开启 CDP。`
        : "百度网盘未启动。",
  };
}

export function checkBaiduNetdiskCdpStatusEffect(
  options: BaiduNetdiskCdpOptions = {},
): Effect.Effect<BaiduNetdiskCdpStatus> {
  return Effect.promise(() => checkBaiduNetdiskCdpStatusPromise(options));
}

export function checkBaiduNetdiskCdpStatus(options: BaiduNetdiskCdpOptions = {}) {
  return Effect.runPromise(checkBaiduNetdiskCdpStatusEffect(options));
}

async function startBaiduNetdiskCdpPromise(
  options: StartBaiduNetdiskCdpOptions = {},
): Promise<BaiduNetdiskLaunchResult> {
  const port = options.port ?? DEFAULT_BAIDU_NETDISK_CDP_PORT;
  const waitMs = options.waitMs ?? 12000;

  if (process.platform !== "win32") {
    throw new Error("百度网盘 CDP 启动当前只支持 Windows。");
  }

  const currentStatus = await checkBaiduNetdiskCdpStatus({ ...options, port });
  if (currentStatus.ready && !options.restart) {
    return {
      status: currentStatus,
      executablePath: currentStatus.executablePath ?? "",
      restarted: false,
    };
  }

  if (currentStatus.appRunning && !currentStatus.ready && !options.restart) {
    throw new Error(
      "百度网盘已启动，但不是 CDP 模式。请显式点击“重启为 CDP 模式”，该操作会先关闭当前百度网盘客户端再重新打开。",
    );
  }

  const executablePath = await findBaiduNetdiskExecutable(options.executablePath);
  const shouldRestart = Boolean(options.restart);

  if (shouldRestart) {
    await stopBaiduNetdiskProcesses();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const child = spawn(executablePath, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(executablePath),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const status = await waitForCdpStatus({ port, executablePath }, waitMs);

  if (!status.ready) {
    throw new Error(status.message);
  }

  return {
    status,
    executablePath,
    restarted: shouldRestart,
  };
}

export function startBaiduNetdiskCdpEffect(
  options: StartBaiduNetdiskCdpOptions = {},
): Effect.Effect<BaiduNetdiskLaunchResult, CdpConnectionError | UnsupportedPlatformError> {
  if (process.platform !== "win32") {
    return Effect.fail(new UnsupportedPlatformError({
      message: "百度网盘 CDP 启动当前只支持 Windows。",
      platform: process.platform,
    }));
  }

  return Effect.tryPromise({
    try: () => startBaiduNetdiskCdpPromise(options),
    catch: (error) => cdpConnectionError(error, options.port ?? DEFAULT_BAIDU_NETDISK_CDP_PORT),
  });
}

export function startBaiduNetdiskCdp(options: StartBaiduNetdiskCdpOptions = {}) {
  return Effect.runPromise(startBaiduNetdiskCdpEffect(options));
}
