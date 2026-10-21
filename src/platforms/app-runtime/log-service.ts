import type { AutomationLogEntry, AutomationLogLevel } from "@dramabridge/automation-logging";
import type { PlatformId } from "@/config/navigation";

export type PlatformLogEvent =
  | { type: "snapshot"; filePath: string | null; entries: AutomationLogEntry[] }
  | { type: "append"; filePath: string; entries: AutomationLogEntry[] }
  | { type: "reset"; filePath: string }
  | { type: "waiting"; message: string }
  | { type: "error"; message: string };

export type { AutomationLogEntry, AutomationLogLevel };

export function subscribeToPlatformLogs(
  platform: PlatformId,
  handlers: {
    onData: (event: PlatformLogEvent) => void;
    onError: (message: string) => void;
  },
) {
  if (!window.platformLogs) {
    handlers.onError("实时日志仅在 Electron 应用内可用。");
    return () => undefined;
  }
  return window.platformLogs.subscribe(platform, {
    onData: (event) => handlers.onData(event as PlatformLogEvent),
    onError: (error) => handlers.onError(error.message),
  });
}

export function clearPlatformLog(platform: PlatformId) {
  if (!window.platformLogs) {
    throw new Error("实时日志仅在 Electron 应用内可用。");
  }
  return window.platformLogs.clear(platform);
}
