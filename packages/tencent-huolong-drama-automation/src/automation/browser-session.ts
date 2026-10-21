import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { TENCENT_HUOLONG_DRAMA_LOGIN_URL } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { TencentHuolongLoginState, TencentHuolongRuntimeOptions } from "../shared/types.js";

export function tencentHuolongLoginStateFromUrl(url?: string): TencentHuolongLoginState {
  if (!url || url === "about:blank") return "unknown";
  return url.startsWith(TENCENT_HUOLONG_DRAMA_LOGIN_URL) && !url.includes("/kairos/")
    ? "login-required"
    : "logged-in";
}

export async function launchTencentHuolongBrowserContext(
  userDataDir: string,
  options: TencentHuolongRuntimeOptions,
) {
  const context = await launchPlatformBrowserContext(userDataDir, {
    args: ["--disable-blink-features=AutomationControlled"],
    extraHTTPHeaders: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
    headless: options.config?.browser?.headless ?? false,
    ignoreDefaultArgs: ["--enable-automation"],
    locale: "zh-CN",
    slowMo: options.config?.browser?.slowMo ?? 0,
    timezoneId: "Asia/Shanghai",
    viewport: null,
  });
  log(options, "[tencent-huolong-drama] Playwright Chromium 已启动");
  return context;
}

export async function saveCredentialState(context: BrowserContext, options: TencentHuolongRuntimeOptions) {
  if (!options.credentialStatePath) return;
  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
}

export async function waitForLoginIfNeeded(
  page: Page,
  context: BrowserContext,
  options: TencentHuolongRuntimeOptions,
) {
  if (tencentHuolongLoginStateFromUrl(page.url()) !== "login-required") return false;
  log(options, "[tencent-huolong-drama] 等待用户登录腾讯视频创作平台");
  await page.bringToFront().catch(() => undefined);
  if (page.url() !== TENCENT_HUOLONG_DRAMA_LOGIN_URL) {
    await page.goto(TENCENT_HUOLONG_DRAMA_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  await page.waitForURL((url) => url.pathname.startsWith("/kairos/"), { timeout: 120 * 60_000 });
  await saveCredentialState(context, options).catch(() => undefined);
  return true;
}
