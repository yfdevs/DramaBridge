import { app, shell } from "electron";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAutomationLogger,
  formatDateKey,
  type AutomationLogFields,
  type AutomationLogLevel,
} from "@dramabridge/automation-logging";

type MainLogLevel = Exclude<AutomationLogLevel, "debug"> | "debug";

let processLoggingRegistered = false;
const rendererConsoleDedupWindowMs = 30_000;
const rendererConsoleMessages = new Map<string, {
  lastLoggedAt: number;
  suppressedCount: number;
}>();

export function getMainLogDir() {
  return path.join(getUserDataPath(), "logs");
}

export function getMainLogFilePath() {
  const logDir = getMainLogDir();
  mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `app-${formatDateKey()}.json`);
}

export async function openMainLogDir() {
  const logDir = getMainLogDir();
  mkdirSync(logDir, { recursive: true });
  const errorMessage = await shell.openPath(logDir);
  if (errorMessage) throw new Error(errorMessage);
  return logDir;
}

export function logMain(
  level: MainLogLevel,
  message: string,
  detail?: unknown,
  scope = "system",
) {
  try {
    const logger = createAutomationLogger({
      platform: "app",
      scope,
      logFilePath: getMainLogFilePath(),
      retentionDays: 7,
    });
    logger[level](message, detailFields(detail));
  } catch {
    // Logging must never break application startup.
  }
}

export function registerMainProcessLogging() {
  if (processLoggingRegistered) return;
  processLoggingRegistered = true;

  process.on("uncaughtException", (error) => {
    logMain("error", "Uncaught main-process exception", { error });
  });

  process.on("unhandledRejection", (reason) => {
    logMain("error", "Unhandled main-process rejection", { error: reason });
  });

  app.on("web-contents-created", (_event, webContents) => {
    webContents.on("did-fail-load", (_loadEvent, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logMain("error", "Renderer page load failed", {
        errorCode,
        errorDescription,
        url: validatedURL,
        isMainFrame,
      });
    });

    webContents.on("preload-error", (_preloadEvent, preloadPath, error) => {
      logMain("error", "Renderer preload failed", { path: preloadPath, error });
    });

    webContents.on("render-process-gone", (_goneEvent, details) => {
      logMain("error", "Renderer process exited", details);
    });

    webContents.on("console-message", (_consoleEvent, level, message, line, sourceId) => {
      if (level < 2 || shouldIgnoreRendererConsoleMessage(message)) return;
      const compactMessage = compactRendererConsoleMessage(message);
      const compactSource = compactRendererConsoleSource(sourceId);
      const suppressedCount = registerRendererConsoleMessage([
        level,
        compactMessage,
        compactSource,
        line,
      ].join("|"));
      if (suppressedCount === undefined) return;
      const isWarning = level === 2 || /^warning\b/i.test(compactMessage);
      logMain(isWarning ? "warn" : "error", isWarning
        ? "Renderer console warning"
        : "Renderer console error", {
        consoleLevel: level,
        message: compactMessage,
        line,
        source: compactSource,
        ...(suppressedCount ? { suppressedDuplicates: suppressedCount } : {}),
      }, "renderer");
    });
  });

  app.on("child-process-gone", (_event, details) => {
    logMain("error", "Child process exited", details);
  });

  app.on("will-quit", () => {
    logMain("info", "Application is quitting");
  });
}

function shouldIgnoreRendererConsoleMessage(message: string) {
  return !app.isPackaged
    && message.includes("Electron Security Warning (Insecure Content-Security-Policy)");
}

function compactRendererConsoleMessage(message: string) {
  const singleLine = message.replace(/\s+/g, " ").trim();
  const withoutReactStack = /^warning\b/i.test(singleLine)
    ? singleLine.replace(/%s/g, "").replace(/\s+at\s+[A-Z][\s\S]*$/, "")
    : singleLine;
  return withoutReactStack.slice(0, 1_000);
}

function compactRendererConsoleSource(sourceId: string) {
  try {
    const sourceUrl = new URL(sourceId);
    if (sourceUrl.origin === "null") return sourceId.slice(0, 500);
    if (sourceUrl.hostname === "localhost" || sourceUrl.hostname === "127.0.0.1") {
      return sourceUrl.pathname;
    }
    return `${sourceUrl.origin}${sourceUrl.pathname}`;
  } catch {
    return sourceId.slice(0, 500);
  }
}

function registerRendererConsoleMessage(fingerprint: string) {
  const now = Date.now();
  const previous = rendererConsoleMessages.get(fingerprint);
  if (previous && now - previous.lastLoggedAt < rendererConsoleDedupWindowMs) {
    previous.suppressedCount += 1;
    return undefined;
  }
  const suppressedCount = previous?.suppressedCount ?? 0;
  rendererConsoleMessages.set(fingerprint, {
    lastLoggedAt: now,
    suppressedCount: 0,
  });
  if (rendererConsoleMessages.size > 200) {
    const oldestKey = rendererConsoleMessages.keys().next().value;
    if (oldestKey) rendererConsoleMessages.delete(oldestKey);
  }
  return suppressedCount;
}

function detailFields(detail: unknown): AutomationLogFields | undefined {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) return { error: detail };
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return detail as AutomationLogFields;
  }
  return { detail };
}

function getUserDataPath() {
  try {
    return app.getPath("userData");
  } catch {
    const appDataPath = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appDataPath, "DramaBridge");
  }
}
