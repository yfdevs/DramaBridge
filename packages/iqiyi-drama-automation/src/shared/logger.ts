import { AsyncLocalStorage } from "node:async_hooks";
import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";

import type { IqiyiDramaRuntimeOptions } from "./types.js";

type LogFields = AutomationLogFields;
type LogContext = {
  accountTaskId?: number;
  iqiyiAccountId?: string;
  iqiyiAccountName?: string;
};

const contextStorage = new AsyncLocalStorage<LogContext>();
let defaultOptions: IqiyiDramaRuntimeOptions = {};

function loggerFor(
  options: IqiyiDramaRuntimeOptions,
  scope: string,
  context = contextStorage.getStore() ?? {},
) {
  return createAutomationLogger({
    platform: "iqiyi-drama",
    scope,
    context: {
      accountProfileName: options.accountProfileName,
      accountId: context.iqiyiAccountId ?? options.iqiyiAccountId,
      accountName: context.iqiyiAccountName ?? options.iqiyiAccountName,
      accountTaskId: context.accountTaskId,
    },
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: options.onLog
      ? (entry) => options.onLog?.(formatReadableLogEntry(entry))
      : undefined,
  });
}

function write(
  level: AutomationLogLevel,
  options: IqiyiDramaRuntimeOptions,
  message: string,
  fields?: LogFields,
) {
  loggerFor(options, "runtime")[level](message, fields);
}

export function configureIqiyiDramaLogger(options: IqiyiDramaRuntimeOptions) {
  defaultOptions = options;
}

export function cleanupOldLogFiles(options: IqiyiDramaRuntimeOptions = defaultOptions) {
  if (!options.logFilePath) return Promise.resolve();
  return cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

export function runWithLogContext<T>(context: LogContext, action: () => T): T {
  return contextStorage.run({ ...contextStorage.getStore(), ...context }, action);
}

export function log(options: IqiyiDramaRuntimeOptions, message: string, fields?: LogFields) {
  write("info", options, message, fields);
}

export function warn(options: IqiyiDramaRuntimeOptions, message: string, fields?: LogFields) {
  write("warn", options, message, fields);
}

export function errorLog(options: IqiyiDramaRuntimeOptions, message: string, fields?: LogFields) {
  write("error", options, message, fields);
}

export function logCallback(
  options: IqiyiDramaRuntimeOptions,
  scope: string,
  fields?: LogFields,
) {
  return loggerFor(options, scope).callback(scope, fields);
}
