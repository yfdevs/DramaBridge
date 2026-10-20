import path from "node:path";
import {
  createAutomationLogger,
  formatDateKey,
  type AutomationLogFields,
} from "@dramabridge/automation-logging";

export function createElectronPlatformLogger(options: {
  platform: string;
  logDir: string;
  scope?: string;
  context?: AutomationLogFields;
  retentionDays?: number;
}) {
  return createAutomationLogger({
    platform: options.platform,
    scope: options.scope ?? "runtime",
    context: options.context,
    logFilePath: path.join(options.logDir, `app-${formatDateKey()}.log`),
    retentionDays: options.retentionDays ?? 3,
  });
}
