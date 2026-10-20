import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
} from "@dramabridge/automation-logging";

import type { PinduoduoDramaRuntimeOptions } from "./types.js";

export type PinduoduoDramaLogLevel = "info" | "warn" | "error";
export type PinduoduoDramaLogFields = AutomationLogFields;

function loggerFor(
  options: PinduoduoDramaRuntimeOptions | undefined,
  scope: string,
) {
  return createAutomationLogger({
    platform: "pinduoduo-drama",
    scope,
    context: { accountProfileName: options?.accountProfileName },
    logFilePath: options?.logFilePath,
    retentionDays: options?.logRetentionDays,
    onEntry: options?.onLog
      ? (entry) => options.onLog?.(formatReadableLogEntry(entry))
      : undefined,
  });
}

export function log(
  options: PinduoduoDramaRuntimeOptions | undefined,
  level: PinduoduoDramaLogLevel,
  scope: string,
  message: string,
  fields?: PinduoduoDramaLogFields,
) {
  loggerFor(options, scope)[level](message, fields);
}

export function createLogger(scope: string, options?: PinduoduoDramaRuntimeOptions) {
  return {
    info: (message: string, fields?: PinduoduoDramaLogFields) =>
      log(options, "info", scope, message, fields),
    warn: (message: string, fields?: PinduoduoDramaLogFields) =>
      log(options, "warn", scope, message, fields),
    error: (message: string, fields?: PinduoduoDramaLogFields) =>
      log(options, "error", scope, message, fields),
  };
}

export async function cleanupOldLogFiles(options: PinduoduoDramaRuntimeOptions) {
  if (!options.logFilePath) return;
  await cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

export function logCallback(
  options: PinduoduoDramaRuntimeOptions,
  scope: string,
  fields?: PinduoduoDramaLogFields,
) {
  return loggerFor(options, scope).callback(scope, fields);
}
