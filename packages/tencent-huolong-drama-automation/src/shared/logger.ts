import { AsyncLocalStorage } from "node:async_hooks";
import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";
import type { TencentHuolongRuntimeOptions } from "./types.js";

type LogContext = { accountId?: string; accountName?: string; accountTaskId?: number };
const contextStorage = new AsyncLocalStorage<LogContext>();
let defaultOptions: TencentHuolongRuntimeOptions = {};

export function configureTencentHuolongLogger(options: TencentHuolongRuntimeOptions) {
  defaultOptions = options;
}

function loggerFor(options: TencentHuolongRuntimeOptions, scope: string) {
  const context = contextStorage.getStore() ?? {};
  return createAutomationLogger({
    platform: "tencent-huolong-drama",
    scope,
    context: {
      accountId: context.accountId ?? options.accountId,
      accountName: context.accountName ?? options.accountName,
      accountTaskId: context.accountTaskId,
    },
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: options.onLog ? (entry) => options.onLog?.(formatReadableLogEntry(entry)) : undefined,
  });
}

export function cleanupOldLogFiles(options: TencentHuolongRuntimeOptions = defaultOptions) {
  if (!options.logFilePath) return Promise.resolve();
  return cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

function write(options: TencentHuolongRuntimeOptions, level: AutomationLogLevel, message: string, fields?: AutomationLogFields) {
  loggerFor(options, "runtime")[level](message, fields);
}

export function runWithLogContext<T>(context: LogContext, action: () => T): T {
  return contextStorage.run({ ...contextStorage.getStore(), ...context }, action);
}

export function log(options: TencentHuolongRuntimeOptions, message: string, fields?: AutomationLogFields) {
  write(options, "info", message, fields);
}

export function warn(options: TencentHuolongRuntimeOptions, message: string, fields?: AutomationLogFields) {
  write(options, "warn", message, fields);
}

export function errorLog(options: TencentHuolongRuntimeOptions, message: string, fields?: AutomationLogFields) {
  write(options, "error", message, fields);
}
