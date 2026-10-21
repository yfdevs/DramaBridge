import TailFile from "@logdna/tail-file";
import type { AutomationLogEntry } from "@dramabridge/automation-logging";
import { mkdir, open, readdir, stat, truncate } from "node:fs/promises";
import path from "node:path";

export const platformLogIds = [
  "wechat-drama",
  "wechat-miniprogram-drama",
  "meituan-drama",
  "taobao-drama",
  "kuaishou-drama",
  "qq-drama",
  "tencent-huolong-drama",
  "iqiyi-drama",
  "baidu-drama",
  "douyin-drama",
  "tiktok-drama",
  "pinduoduo-drama",
] as const;

export type PlatformLogId = (typeof platformLogIds)[number];

export type PlatformLogEvent =
  | {
      type: "snapshot";
      filePath: string | null;
      entries: AutomationLogEntry[];
    }
  | { type: "append"; filePath: string; entries: AutomationLogEntry[] }
  | { type: "reset"; filePath: string }
  | { type: "waiting"; message: string }
  | { type: "error"; message: string };

type LogDirectoryResolver = (platform: PlatformLogId) => string;

const INITIAL_LINE_COUNT = 100;
const MAX_INITIAL_BYTES = 8 * 1024 * 1024;
const FILE_DISCOVERY_INTERVAL_MS = 2_000;
let resolveLogDirectory: LogDirectoryResolver | undefined;

export function configurePlatformLogViewer(resolver: LogDirectoryResolver) {
  resolveLogDirectory = resolver;
}

function logDirectory(platform: PlatformLogId) {
  if (!resolveLogDirectory) {
    throw new Error("实时日志服务尚未初始化。");
  }
  return resolveLogDirectory(platform);
}

function parseLogLine(line: string): AutomationLogEntry | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<AutomationLogEntry>;
    if (
      value.version !== 1 ||
      typeof value.pid !== "number" ||
      typeof value.time !== "string" ||
      !["debug", "info", "warn", "error"].includes(String(value.level)) ||
      typeof value.platform !== "string" ||
      typeof value.scope !== "string" ||
      typeof value.message !== "string"
    ) {
      return null;
    }
    return value as AutomationLogEntry;
  } catch {
    return null;
  }
}

async function latestLogFile(directory: string) {
  await mkdir(directory, { recursive: true });
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^app-\d{4}-\d{2}-\d{2}\.json$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => right.localeCompare(left));
  return candidates[0] ?? null;
}

async function readLastEntries(filePath: string, endPosition: number) {
  if (endPosition <= 0) return [];
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = endPosition;
    let newlineCount = 0;
    let byteCount = 0;
    while (position > 0 && newlineCount <= INITIAL_LINE_COUNT && byteCount < MAX_INITIAL_BYTES) {
      const length = Math.min(64 * 1024, position, MAX_INITIAL_BYTES - byteCount);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const complete = chunk.subarray(0, bytesRead);
      chunks.unshift(complete);
      byteCount += bytesRead;
      for (const byte of complete) {
        if (byte === 10) newlineCount += 1;
      }
    }
    return Buffer.concat(chunks)
      .toString("utf8")
      .split(/\r?\n/)
      .map(parseLogLine)
      .filter((entry): entry is AutomationLogEntry => entry !== null)
      .slice(-INITIAL_LINE_COUNT);
  } finally {
    await handle.close();
  }
}

export function subscribePlatformLogs(
  platform: PlatformLogId,
  emit: (event: PlatformLogEvent) => void,
) {
  let disposed = false;
  let currentFile: string | null = null;
  let tail: TailFile | null = null;
  let remainder = "";
  let switching = false;

  const stopTail = async () => {
    const activeTail = tail;
    tail = null;
    remainder = "";
    if (activeTail) {
      await activeTail.quit().catch(() => undefined);
    }
  };

  const startTail = async (filePath: string) => {
    const fileStats = await stat(filePath);
    const position = fileStats.size;
    const entries = await readLastEntries(filePath, position);
    if (disposed) return;

    await stopTail();
    currentFile = filePath;
    emit({ type: "snapshot", filePath, entries });

    const nextTail = new TailFile(filePath, {
      encoding: "utf8",
      pollFileIntervalMs: 350,
      pollFailureRetryMs: 300,
      maxPollFailures: 20,
      startPos: position,
    });
    tail = nextTail;
    nextTail.on("data", (chunk: string | Buffer) => {
      if (disposed || tail !== nextTail) return;
      const parts = `${remainder}${chunk.toString()}`.split(/\r?\n/);
      remainder = parts.pop() ?? "";
      const appended = parts
        .map(parseLogLine)
        .filter((entry): entry is AutomationLogEntry => entry !== null);
      if (appended.length > 0) emit({ type: "append", filePath, entries: appended });
    });
    nextTail.on("truncated", () => {
      remainder = "";
      emit({ type: "reset", filePath });
    });
    nextTail.on("tail_error", ({ meta }) => {
      emit({ type: "error", message: meta.actual?.message ?? "日志文件读取失败。" });
      if (tail === nextTail) tail = null;
      void nextTail.quit().catch(() => undefined);
    });
    nextTail.on("error", (error) => {
      emit({ type: "error", message: error.message });
      if (tail === nextTail) tail = null;
      void nextTail.quit().catch(() => undefined);
    });
    try {
      await nextTail.start();
    } catch (error) {
      if (tail === nextTail) tail = null;
      emit({
        type: "error",
        message: error instanceof Error ? error.message : "日志监听启动失败。",
      });
    }
  };

  const discover = async () => {
    if (disposed || switching) return;
    switching = true;
    try {
      const filePath = await latestLogFile(logDirectory(platform));
      if (!filePath) {
        if (currentFile !== null) await stopTail();
        currentFile = null;
        emit({ type: "waiting", message: "正在等待当前平台生成日志…" });
        return;
      }
      if (filePath !== currentFile || !tail) await startTail(filePath);
    } catch (error) {
      emit({
        type: "error",
        message: error instanceof Error ? error.message : "无法读取日志目录。",
      });
    } finally {
      switching = false;
    }
  };

  void discover();
  const timer = setInterval(() => void discover(), FILE_DISCOVERY_INTERVAL_MS);
  return () => {
    disposed = true;
    clearInterval(timer);
    void stopTail();
  };
}

export async function clearCurrentPlatformLog(platform: PlatformLogId) {
  const filePath = await latestLogFile(logDirectory(platform));
  if (!filePath) return { cleared: false as const, filePath: null };
  await truncate(filePath, 0);
  return { cleared: true as const, filePath };
}
