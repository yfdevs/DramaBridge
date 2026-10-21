import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { BrowserContext, Page } from "playwright";

import { IQIYI_DRAMA_LOGIN_URL } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { IqiyiDramaLoginState, IqiyiDramaRuntimeOptions } from "../shared/types.js";

export function iqiyiDramaLoginStateFromUrl(url: string | undefined): IqiyiDramaLoginState {
  if (!url || url === "about:blank") return "unknown";
  if (/showLogin=1|passport|\/login(?:[/?#]|$)/i.test(url)) return "login-required";
  return /^https:\/\/creator\.iqiyi\.com\/(?:comicPlay|miniPlay)(?:[/?#]|$)/i.test(url)
    ? "logged-in"
    : "unknown";
}

export async function launchIqiyiDramaBrowserContext(
  userDataDir: string,
  options: IqiyiDramaRuntimeOptions,
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
  log(options, "[iqiyi-drama] started browser with Playwright Chromium");
  return context;
}

export async function saveCredentialState(
  context: BrowserContext,
  options: IqiyiDramaRuntimeOptions,
) {
  if (!options.credentialStatePath) return;
  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
}

export async function waitForIqiyiLogin(
  page: Page,
  context: BrowserContext,
  options: IqiyiDramaRuntimeOptions,
) {
  if (iqiyiDramaLoginStateFromUrl(page.url()) === "logged-in") return true;
  log(options, "[iqiyi-drama] not logged in; task polling paused, waiting for manual login");
  await page.bringToFront().catch(() => undefined);
  if (iqiyiDramaLoginStateFromUrl(page.url()) !== "login-required") {
    await page.goto(IQIYI_DRAMA_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  await page.waitForURL(
    (url) => iqiyiDramaLoginStateFromUrl(url.href) === "logged-in",
    { timeout: 120 * 60 * 1000 },
  );
  await saveCredentialState(context, options).catch(() => undefined);
  log(options, "[iqiyi-drama] login completed");
  return true;
}
