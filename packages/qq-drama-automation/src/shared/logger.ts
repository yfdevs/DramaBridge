import { AsyncLocalStorage } from "node:async_hooks";
import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";

import type { QqDramaRuntimeOptions } from "./types.js";

export type LogFieldValue = unknown;
export type LogFields = AutomationLogFields;
export type LogContext = {
  accountProfileName?: string;
  qqAccountId?: string;
  qqAccountName?: string;
  accountTaskId?: number;
};

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

const logContextStorage = new AsyncLocalStorage<LogContext>();
let defaultOptions: QqDramaRuntimeOptions = {};

export function configureQqDramaLogger(options: QqDramaRuntimeOptions) {
  defaultOptions = options;
}

function normalizedContext(options: QqDramaRuntimeOptions, context: LogContext) {
  return {
    accountProfileName: context.accountProfileName ?? options.accountProfileName,
    accountId: context.qqAccountId ?? options.qqAccountId,
    accountName: context.qqAccountName ?? options.qqAccountName,
    accountTaskId: context.accountTaskId,
  };
}

function loggerFor(
  options: QqDramaRuntimeOptions,
  scope: string,
  context = logContextStorage.getStore() ?? {},
) {
  return createAutomationLogger({
    platform: "qq-drama",
    scope,
    context: normalizedContext(options, context),
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: options.onLog
      ? (entry) => options.onLog?.(formatReadableLogEntry(entry))
      : undefined,
  });
}

export function cleanupOldLogFiles(options: QqDramaRuntimeOptions = defaultOptions) {
  if (!options.logFilePath) return Promise.resolve();
  return cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

function write(
  options: QqDramaRuntimeOptions,
  scope: string,
  level: AutomationLogLevel,
  message: string,
  fields?: LogFields,
) {
  loggerFor(options, scope)[level](message, fields);
}

export function runWithLogContext<T>(context: LogContext, action: () => T): T {
  return logContextStorage.run(
    { ...logContextStorage.getStore(), ...context },
    action,
  );
}

export function createLogger(scope: string): Logger {
  return {
    info: (message, fields) => write(defaultOptions, scope, "info", message, fields),
    warn: (message, fields) => write(defaultOptions, scope, "warn", message, fields),
    error: (message, fields) => write(defaultOptions, scope, "error", message, fields),
  };
}

export function log(options: QqDramaRuntimeOptions, message: string, fields?: LogFields) {
  write(options, "runtime", "info", message, fields);
}

export function warn(options: QqDramaRuntimeOptions, message: string, fields?: LogFields) {
  write(options, "runtime", "warn", message, fields);
}

export function errorLog(options: QqDramaRuntimeOptions, message: string, fields?: LogFields) {
  write(options, "runtime", "error", message, fields);
}

export function logCallback(
  options: QqDramaRuntimeOptions,
  scope: string,
  fields?: LogFields,
) {
  return loggerFor(options, scope).callback(scope, fields);
}
