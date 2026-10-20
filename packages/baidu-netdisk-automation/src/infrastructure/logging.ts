import {
  createAutomationLogger,
  type AutomationLogFields,
  type AutomationLogger,
  type CreateAutomationLoggerOptions,
} from "@dramabridge/automation-logging";

import type { BaiduNetdiskRemoteVideoListing } from "../domain/types.js";
import { formatByteSize } from "./utils.js";

export type BaiduNetdiskAutomationLoggingOptions = Pick<
  CreateAutomationLoggerOptions,
  "console" | "logFilePath" | "onEntry" | "retentionDays"
>;

const defaultLoggerOptions: BaiduNetdiskAutomationLoggingOptions = {
  console: true,
};

let logger: AutomationLogger = createLogger(defaultLoggerOptions);

function createLogger(options: BaiduNetdiskAutomationLoggingOptions) {
  return createAutomationLogger({
    platform: "baidu-netdisk",
    scope: "netdisk",
    ...options,
  });
}

/** Configuration is injected by the Electron platform module at the runtime boundary. */
export function configureBaiduNetdiskAutomationLogging(
  options: BaiduNetdiskAutomationLoggingOptions,
) {
  logger = createLogger({ ...defaultLoggerOptions, ...options });
}

export function flushBaiduNetdiskAutomationLogs() {
  return logger.flush();
}

export const log = (message: string, fields?: AutomationLogFields) =>
  logger.info(message, fields);

export const warn = (message: string, fields?: AutomationLogFields) =>
  logger.warn(message, fields);

export const errorLog = (message: string, fields?: AutomationLogFields) =>
  logger.error(message, fields);

export function logRemoteVideoScanDetails(remoteVideos: BaiduNetdiskRemoteVideoListing) {
  const scannedDirs = remoteVideos.scannedDirs ?? [];
  if (scannedDirs.length <= 0) return;

  log("网盘目录扫描完成", {
    directoryCount: scannedDirs.length,
    videoCount: remoteVideos.allVideoFiles.length,
  });
  for (const dir of scannedDirs
    .slice()
    .sort((left, right) => (right.mp4Count ?? 0) - (left.mp4Count ?? 0) || left.path.localeCompare(right.path))) {
    log("网盘目录扫描详情", {
      path: dir.path,
      selected: dir.path === remoteVideos.rootPath,
      status: dir.errno === undefined ? "ok" : `errno=${dir.errno}`,
      itemCount: dir.count,
      fileCount: dir.fileCount ?? 0,
      videoCount: dir.mp4Count ?? 0,
      videoSize: formatByteSize(dir.mp4SizeBytes),
      hasMore: Boolean(dir.hasMore),
    });
  }
}
