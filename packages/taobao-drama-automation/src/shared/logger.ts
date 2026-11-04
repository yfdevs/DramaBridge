import { AsyncLocalStorage } from "node:async_hooks";
import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";
import type { TaobaoDramaRuntimeOptions } from "./types.js";

type LogContext = { taskId?: string; title?: string };
const contextStorage = new AsyncLocalStorage<LogContext>();

function loggerFor(options: TaobaoDramaRuntimeOptions, scope: string) {
  const context = contextStorage.getStore() ?? {};
  return createAutomationLogger({
    platform: "taobao-drama",
    scope,
    context: context.taskId || context.title
      ? { taskId: context.taskId, title: context.title }
      : undefined,
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: (entry) => {
      options.onLog?.(formatReadableLogEntry(entry));
      if (context.taskId && entry.level === "info" && !/等待|仍在|暂无|探测|heartbeat|waiting/i.test(entry.message)) {
        options.taskWatchdog?.progress(Number(context.taskId), JSON.stringify([entry.scope, entry.message, entry.details]));
      }
    },
  });
}

export function cleanupOldLogFiles(options: TaobaoDramaRuntimeOptions) {
  if (!options.logFilePath) return Promise.resolve();
  return cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

function write(
  options: TaobaoDramaRuntimeOptions,
  level: AutomationLogLevel,
  message: string,
  fields?: AutomationLogFields,
) {
  loggerFor(options, "runtime")[level](message, fields);
}

export function runWithLogContext<T>(context: LogContext, action: () => T): T {
  return contextStorage.run({ ...contextStorage.getStore(), ...context }, action);
}

export function log(options: TaobaoDramaRuntimeOptions, message: string, fields?: AutomationLogFields) {
  write(options, "info", message, fields);
}

export function errorLog(options: TaobaoDramaRuntimeOptions, message: string, fields?: AutomationLogFields) {
  write(options, "error", message, fields);
}
