import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  createAutomationLogger,
  formatDateKey,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";

import { getWechatMiniProgramRuntimeSettings } from "./runtime-settings.js";
import { integerSetting } from "./settings-value.js";

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LogContext {
  videoAccountId?: string;
  videoAccountName?: string;
  accountTaskId?: number;
}

export type LogFieldValue = unknown;
export type LogFields = AutomationLogFields;

const logContextStorage = new AsyncLocalStorage<LogContext>();

function logFilePath() {
  const configured = getWechatMiniProgramRuntimeSettings().runDataDir || ".drama-runs/wechat-miniprogram-drama";
  const runDataDir = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  return path.join(runDataDir, "logs", `app-${formatDateKey()}.json`);
}

function contextFields(context = logContextStorage.getStore() ?? {}) {
  return {
    accountId: context.videoAccountId,
    accountName: context.videoAccountName,
    accountTaskId: context.accountTaskId,
  };
}

function loggerFor(scope: string) {
  const settings = getWechatMiniProgramRuntimeSettings();
  return createAutomationLogger({
    platform: "wechat-miniprogram-drama",
    scope,
    context: contextFields(),
    logFilePath: logFilePath(),
    retentionDays: Math.max(1, integerSetting(settings.logRetentionDays, 3)),
  });
}

function write(
  scope: string,
  level: AutomationLogLevel,
  message: string,
  fields?: LogFields,
) {
  loggerFor(scope)[level](message, fields);
}

export function runWithLogContext<T>(context: LogContext, action: () => T): T {
  const nextContext = { ...logContextStorage.getStore() };
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) Object.assign(nextContext, { [key]: value });
  }
  return logContextStorage.run(nextContext, action);
}

export function createLogger(scope: string): Logger {
  return {
    info: (message, fields) => write(scope, "info", message, fields),
    warn: (message, fields) => write(scope, "warn", message, fields),
    error: (message, fields) => write(scope, "error", message, fields),
  };
}
