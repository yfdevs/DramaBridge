import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { resolveFromRoot } from "../shared/config.js";
import { minutesToMs } from "../shared/settings-value.js";
import type { Config, TaskRunOptions } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const authLogger = createLogger("auth");

export async function launchContext(playletConfig: Config): Promise<BrowserContext> {
  const userDataDir = resolveFromRoot(playletConfig.browser?.userDataDir ?? ".auth/weixin-video-channel");
  await mkdir(userDataDir, { recursive: true });

  return chromium.launchPersistentContext(userDataDir, {
    headless: playletConfig.browser?.headless ?? false,
    slowMo: playletConfig.browser?.slowMo ?? 20,
    viewport: null,
    acceptDownloads: true,
  });
}

export async function saveStorageState(context: BrowserContext, stateFile: string): Promise<void> {
  const statePath = resolveFromRoot(stateFile);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(await context.storageState(), null, 2), "utf8");
}

function isLoginUrl(url: string): boolean {
  return url.includes("login");
}

export async function waitForLoginIfNeeded(
  page: Page,
  accountLabel?: string,
  loginPageTitle?: string,
  onLoginRequired?: () => void | Promise<void>,
): Promise<boolean> {
  if (!isLoginUrl(page.url())) {
    const loginState = await Promise.race([
      page.waitForURL((url) => isLoginUrl(url.href), { timeout: 8000 }).then(() => "login" as const),
      page.locator("wujie-app").first().waitFor({ state: "attached", timeout: 8000 }).then(() => "logged-in" as const),
    ]).catch(() => "unknown" as const);
    if (loginState !== "login") return false;
  }

  if (loginPageTitle) {
    await page.evaluate((title) => {
      document.title = title;
    }, loginPageTitle).catch(() => undefined);
  }

  await onLoginRequired?.();

  const label = accountLabel ? ` ${accountLabel}` : "";
  authLogger.info("请使用微信扫码并确认登录", { accountName: label.trim() || undefined });
  await page.waitForURL((url) => !isLoginUrl(url.href), { timeout: minutesToMs(10) });
  await page.waitForLoadState("domcontentloaded");
  authLogger.info("登录成功", { accountName: label.trim() || undefined });
  return true;
}

async function pauseForManualInspection(message: string): Promise<void> {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${message} Press Enter to close the browser...`);
  rl.close();
}

export async function maybePauseForInspection(runOptions: TaskRunOptions, playletConfig: Config, failed: boolean): Promise<void> {
  if (!runOptions.interactive) return;
  if (playletConfig.browser?.keepOpenAfterRun || (failed && (playletConfig.browser?.keepOpenOnError ?? true))) {
    await pauseForManualInspection(
      failed ? "[debug] Error happened. Browser is kept open for inspection." : "[debug] Run finished.",
    );
  }
}
