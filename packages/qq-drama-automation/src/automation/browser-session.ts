import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { QQ_DRAMA_ADD_URL, QQ_DRAMA_LOGIN_URL } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { QqDramaLoginState, QqDramaRuntimeOptions } from "../shared/types.js";

export function qqDramaLoginStateFromUrl(url: string | undefined): QqDramaLoginState {
  if (!url || url === "about:blank") return "unknown";
  return /(?:#|\/)\/?login(?:\?|$|&|\/)/i.test(url) || url.includes("#/login")
    ? "login-required"
    : "logged-in";
}

export type QqDramaAuthCookieState = {
  accessToken: boolean;
  csrfToken: boolean;
  refreshToken: boolean;
};

export async function qqDramaAuthCookieState(
  context: BrowserContext,
): Promise<QqDramaAuthCookieState> {
  const [cookies, allCookies] = await Promise.all([
    context.cookies(QQ_DRAMA_ADD_URL),
    context.cookies(),
  ]);
  const names = new Set(
    cookies.filter((cookie) => cookie.value.trim()).map((cookie) => cookie.name),
  );
  const refreshToken = allCookies.some((cookie) =>
    cookie.name === "refresh_token" &&
    cookie.value.trim() &&
    /(?:^|\.)aishortdrama\.qq\.com$/i.test(cookie.domain)
  );
  return {
    accessToken: names.has("access_token"),
    csrfToken: names.has("csrf_token"),
    refreshToken,
  };
}

export function qqDramaAuthCookiesReady(state: QqDramaAuthCookieState) {
  return state.accessToken && state.csrfToken;
}

async function waitForAuthCookies(
  page: Page,
  context: BrowserContext,
  timeoutMs: number,
) {
  const pollIntervalMs = 250;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await qqDramaAuthCookieState(context);
    if (qqDramaAuthCookiesReady(state)) return state;
    if (attempt + 1 < attempts) await page.waitForTimeout(pollIntervalMs);
  }
  return qqDramaAuthCookieState(context);
}

function qqDramaBrowserLaunchOptions(options: QqDramaRuntimeOptions) {
  return {
    args: ["--disable-blink-features=AutomationControlled"],
    extraHTTPHeaders: {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    headless: options.config?.browser?.headless ?? false,
    ignoreDefaultArgs: ["--enable-automation"],
    locale: "zh-CN",
    slowMo: options.config?.browser?.slowMo ?? 0,
    timezoneId: "Asia/Shanghai",
    viewport: null,
  } satisfies Parameters<typeof launchPlatformBrowserContext>[1];
}

export async function launchQqDramaBrowserContext(
  userDataDir: string,
  options: QqDramaRuntimeOptions,
) {
  const launchOptions = qqDramaBrowserLaunchOptions(options);
  const context = await launchPlatformBrowserContext(userDataDir, launchOptions);
  log(options, "[qq-drama] started browser with Playwright Chromium");
  return context;
}

export async function saveCredentialState(context: BrowserContext, options: QqDramaRuntimeOptions) {
  if (!options.credentialStatePath) return;

  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
  log(options, `[qq-drama] credential snapshot saved: ${options.credentialStatePath}`);
}

export async function waitForLoginIfNeeded(
  page: Page,
  context: BrowserContext,
  options: QqDramaRuntimeOptions,
): Promise<boolean> {
  let state = await qqDramaAuthCookieState(context);
  if (
    qqDramaLoginStateFromUrl(page.url()) !== "login-required" &&
    qqDramaAuthCookiesReady(state)
  ) {
    return false;
  }

  if (qqDramaLoginStateFromUrl(page.url()) !== "login-required") {
    log(options, "[qq-drama] login cookies are incomplete; refreshing platform session", state);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    state = await waitForAuthCookies(page, context, 15_000);
    if (qqDramaAuthCookiesReady(state)) {
      await saveCredentialState(context, options).catch(() => undefined);
      log(options, "[qq-drama] login cookies refreshed");
      return false;
    }
  }

  log(options, "[qq-drama] login required, waiting for manual login", state);
  await page.bringToFront().catch(() => undefined);
  if (!page.url().includes("#/login")) {
    await page.goto(QQ_DRAMA_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  await page.waitForURL((url) => qqDramaLoginStateFromUrl(url.href) !== "login-required", {
    timeout: 120 * 60 * 1000,
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined);
  state = await waitForAuthCookies(page, context, 60_000);
  if (!qqDramaAuthCookiesReady(state)) {
    throw new Error(
      "QQ_DRAMA_LOGIN_COOKIES_NOT_READY: 登录页面已跳转，但 access_token/csrf_token 仍未就绪。",
    );
  }
  await saveCredentialState(context, options).catch(() => undefined);
  log(options, "[qq-drama] login completed");
  return true;
}
