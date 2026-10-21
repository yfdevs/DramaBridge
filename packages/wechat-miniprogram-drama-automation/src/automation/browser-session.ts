import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { resolveFromRoot } from "../shared/config.js";
import { minutesToMs } from "../shared/settings-value.js";
import type { Config, TaskRunOptions } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";
import { loginQrCodeSelector } from "./constants.js";

const authLogger = createLogger("auth");

export async function launchContext(playletConfig: Config): Promise<BrowserContext> {
  const userDataDir = resolveFromRoot(playletConfig.browser?.userDataDir ?? ".auth/weixin-miniprogram");
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

export function isWechatMiniProgramLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.href.includes("login")
      || parsed.pathname.includes("loginpage");
  } catch {
    return url.includes("login");
  }
}

const authenticatedPageSelector = [
  'a[href*="token="]',
  'a[href*="/wxamp/"]',
  ".weui-desktop-layout",
  'input[placeholder="搜索文件名"]',
  'button:has-text("选择文件")',
].join(", ");

export async function waitForLoginIfNeeded(
  page: Page,
  accountLabel?: string,
  loginPageTitle?: string,
  onLoginRequired?: () => void | Promise<void>,
): Promise<boolean> {
  const loginQrCode = page.locator(loginQrCodeSelector).first();
  const authenticatedPage = page.locator(authenticatedPageSelector).first();
  const loginPageVisible = isWechatMiniProgramLoginUrl(page.url())
    || await loginQrCode.isVisible().catch(() => false);

  if (!loginPageVisible) {
    const loginState = await Promise.race([
      page.waitForURL((url) => isWechatMiniProgramLoginUrl(url.href), { timeout: 8000 }).then(() => "login" as const),
      loginQrCode
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => "login" as const),
      authenticatedPage
        .waitFor({ state: "attached", timeout: 8000 })
        .then(() => "logged-in" as const),
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
  await Promise.race([
    page.waitForURL((url) => !isWechatMiniProgramLoginUrl(url.href), { timeout: minutesToMs(10) }),
    loginQrCode.waitFor({ state: "hidden", timeout: minutesToMs(10) }),
    authenticatedPage.waitFor({ state: "attached", timeout: minutesToMs(10) }),
  ]);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
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
