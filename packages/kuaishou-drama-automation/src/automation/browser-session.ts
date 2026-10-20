import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  cleanupAutomationLogFiles,
  createAutomationLogger,
  formatReadableLogEntry,
} from "@dramabridge/automation-logging";
import type { BrowserContext, Page } from "playwright";
import type {
  KuaishouDramaLoginState,
  KuaishouDramaRuntimeOptions,
} from "../shared/types.js";

export function log(options: KuaishouDramaRuntimeOptions, message: string) {
  runtimeLogger(options).callback()(message);
}

export function loginStateFromUrl(url: string | undefined): KuaishouDramaLoginState {
  if (!url || url === "about:blank") return "unknown";
  return url.includes("login") ? "login-required" : "logged-in";
}

function runtimeLogger(options: KuaishouDramaRuntimeOptions) {
  return createAutomationLogger({
    platform: "kuaishou-drama",
    scope: "runtime",
    context: {
      accountProfileName: options.accountProfileName,
      accountId: options.kuaishouAccountId,
      accountName: options.kuaishouAccountName,
    },
    logFilePath: options.logFilePath,
    retentionDays: options.logRetentionDays,
    onEntry: options.onLog
      ? (entry) => options.onLog?.(formatReadableLogEntry(entry))
      : undefined,
  });
}

export async function cleanupOldLogFiles(options: KuaishouDramaRuntimeOptions) {
  if (!options.logFilePath) return;
  await cleanupAutomationLogFiles(options.logFilePath, options.logRetentionDays ?? 3);
}

export async function saveCredentialState(
  context: BrowserContext,
  options: KuaishouDramaRuntimeOptions,
) {
  if (!options.credentialStatePath) {
    return;
  }

  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
  log(options, `[kuaishou-drama] credential snapshot saved: ${options.credentialStatePath}`);
}

export async function waitForLoginIfNeeded(
  page: Page,
  options: KuaishouDramaRuntimeOptions,
): Promise<boolean> {
  if (loginStateFromUrl(page.url()) !== "login-required") {
    return false;
  }

  log(options, "[kuaishou-drama] login required, waiting for manual login");
  await page.waitForURL((url) => loginStateFromUrl(url.href) !== "login-required", {
    timeout: 10 * 60 * 1000,
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined);
  log(options, "[kuaishou-drama] login completed");
  return true;
}
