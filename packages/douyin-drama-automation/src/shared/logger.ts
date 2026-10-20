import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";

import type { DouyinDramaRuntimeOptions } from "./types.js";

export type DouyinDramaLogLevel = "info" | "warn" | "error";
export type DouyinDramaLogFields = AutomationLogFields;

function loggerFor(options: DouyinDramaRuntimeOptions, scope: string) {
  return createAutomationLogger({
    platform: "douyin-drama",
    scope,
    context: { accountProfileName: options.accountProfileName },
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: options.onLog
      ? (entry) => options.onLog?.(formatReadableLogEntry(entry))
      : undefined,
  });
}

export function writeDouyinDramaLog(
  options: DouyinDramaRuntimeOptions,
  level: DouyinDramaLogLevel,
  scope: string,
  message: string,
  fields?: DouyinDramaLogFields,
) {
  loggerFor(options, scope)[level as AutomationLogLevel](message, fields);
}

export function log(
  options: DouyinDramaRuntimeOptions,
  message: string,
  fields?: DouyinDramaLogFields,
  scope = "runtime",
) {
  writeDouyinDramaLog(options, "info", scope, message, fields);
}

export function warn(
  options: DouyinDramaRuntimeOptions,
  message: string,
  fields?: DouyinDramaLogFields,
  scope = "runtime",
) {
  writeDouyinDramaLog(options, "warn", scope, message, fields);
}

export function errorLog(
  options: DouyinDramaRuntimeOptions,
  message: string,
  fields?: DouyinDramaLogFields,
  scope = "runtime",
) {
  writeDouyinDramaLog(options, "error", scope, message, fields);
}

export async function flushDouyinDramaLogs(options: DouyinDramaRuntimeOptions) {
  await loggerFor(options, "runtime").flush();
}

export async function cleanupOldDouyinDramaLogFiles(options: DouyinDramaRuntimeOptions) {
  if (!options.logFilePath) return;
  await cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

export function logCallback(
  options: DouyinDramaRuntimeOptions,
  scope: string,
  fields?: DouyinDramaLogFields,
) {
  return loggerFor(options, scope).callback(scope, fields);
}
