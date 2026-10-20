import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";

import type { BaiduDramaRuntimeOptions } from "./types.js";

export type BaiduDramaLogLevel = "info" | "warn" | "error";
export type BaiduDramaLogFields = AutomationLogFields;

function loggerFor(options: BaiduDramaRuntimeOptions, scope: string) {
  return createAutomationLogger({
    platform: "baidu-drama",
    scope,
    context: { accountProfileName: options.accountProfileName },
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: options.onLog
      ? (entry) => options.onLog?.(formatReadableLogEntry(entry))
      : undefined,
  });
}

export function writeBaiduDramaLog(
  options: BaiduDramaRuntimeOptions,
  level: BaiduDramaLogLevel,
  scope: string,
  message: string,
  fields?: BaiduDramaLogFields,
) {
  loggerFor(options, scope)[level as AutomationLogLevel](message, fields);
}

export function log(
  options: BaiduDramaRuntimeOptions,
  message: string,
  fields?: BaiduDramaLogFields,
  scope = "runtime",
) {
  writeBaiduDramaLog(options, "info", scope, message, fields);
}

export function warn(
  options: BaiduDramaRuntimeOptions,
  message: string,
  fields?: BaiduDramaLogFields,
  scope = "runtime",
) {
  writeBaiduDramaLog(options, "warn", scope, message, fields);
}

export function errorLog(
  options: BaiduDramaRuntimeOptions,
  message: string,
  fields?: BaiduDramaLogFields,
  scope = "runtime",
) {
  writeBaiduDramaLog(options, "error", scope, message, fields);
}

export async function flushBaiduDramaLogs(options: BaiduDramaRuntimeOptions) {
  await loggerFor(options, "runtime").flush();
}

export async function cleanupOldBaiduDramaLogFiles(options: BaiduDramaRuntimeOptions) {
  if (!options.logFilePath) return;
  await cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

export function logCallback(
  options: BaiduDramaRuntimeOptions,
  scope: string,
  fields?: BaiduDramaLogFields,
) {
  return loggerFor(options, scope).callback(scope, fields);
}
