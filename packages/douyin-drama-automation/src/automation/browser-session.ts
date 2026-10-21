import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { DOUYIN_DRAMA_CREATE_URL, DOUYIN_DRAMA_LOGIN_URL } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { DouyinDramaLoginState, DouyinDramaRuntimeOptions } from "../shared/types.js";

const DOUYIN_DRAMA_CREATE_PAGE_READY_TEXTS = ["上传漫剧", "剧壳信息", "基础信息", "下一步"];

type DouyinDramaTitleWindow = Window & {
  __douyinDramaFixedTitle?: string;
  __douyinDramaFixedTitleInstalled?: boolean;
};

export function douyinDramaBrowserPageTitle(options: DouyinDramaRuntimeOptions) {
  const accountName = options.douyinAccountName?.trim();
  const accountId = options.douyinAccountId?.trim();
  const profileName = options.accountProfileName?.trim();
  const accountLabel = accountName && accountId && accountName !== accountId
    ? `${accountName}（${accountId}）`
    : accountName || accountId || profileName || "默认账号";
  return `[抖音短剧] ${accountLabel}`;
}

function installFixedDouyinDramaPageTitle(fixedTitle: string) {
  const pageWindow = window as DouyinDramaTitleWindow;
  pageWindow.__douyinDramaFixedTitle = fixedTitle;

  const applyTitle = () => {
    const title = pageWindow.__douyinDramaFixedTitle ?? fixedTitle;
    if (document.title !== title) document.title = title;
  };
  const watchTitle = () => {
    applyTitle();
    const titleElement = document.querySelector("title")
      ?? document.head?.appendChild(document.createElement("title"));
    if (!titleElement || titleElement.dataset.fixedDouyinDramaTitle === "true") return;
    titleElement.dataset.fixedDouyinDramaTitle = "true";
    new MutationObserver(applyTitle).observe(titleElement, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  };

  if (pageWindow.__douyinDramaFixedTitleInstalled) {
    applyTitle();
    return;
  }
  pageWindow.__douyinDramaFixedTitleInstalled = true;
  watchTitle();
  window.addEventListener("DOMContentLoaded", watchTitle);
  window.addEventListener("load", watchTitle);
  window.setInterval(applyTitle, 1_000);
}

async function installDouyinDramaBrowserPageTitles(
  context: BrowserContext,
  options: DouyinDramaRuntimeOptions,
) {
  const title = douyinDramaBrowserPageTitle(options);
  await context.addInitScript(installFixedDouyinDramaPageTitle, title);

  const applyToPage = (page: Page) => {
    void page.evaluate(installFixedDouyinDramaPageTitle, title).catch(() => undefined);
  };
  context.on("page", applyToPage);
  for (const page of context.pages()) applyToPage(page);
}

export function douyinDramaLoginStateFromUrl(url: string | undefined): DouyinDramaLoginState {
  if (!url || url === "about:blank") return "unknown";
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.shortdramas.com" && parsed.pathname === "/page/login") {
      return "login-required";
    }
    if (parsed.hostname === "www.shortdramas.com" && parsed.pathname.startsWith("/page/")) {
      return "logged-in";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

export async function launchDouyinDramaBrowserContext(
  userDataDir: string,
  options: DouyinDramaRuntimeOptions,
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
  await installDouyinDramaBrowserPageTitles(context, options);
  return context;
}

async function saveDouyinDramaCredentialState(
  context: BrowserContext,
  options: DouyinDramaRuntimeOptions,
) {
  if (!options.credentialStatePath) return;
  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
}

export async function openDouyinDramaCreatePage(page: Page) {
  await page.goto(DOUYIN_DRAMA_CREATE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
}

function isDouyinDramaCreatePageUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "www.shortdramas.com" &&
      parsed.pathname === "/page/copyright/short-play/motion-comic-manage-edit-page/"
    );
  } catch {
    return false;
  }
}

function compactPageText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function isDouyinDramaCreatePageReady(url: string, bodyText: string) {
  return (
    isDouyinDramaCreatePageUrl(url) &&
    DOUYIN_DRAMA_CREATE_PAGE_READY_TEXTS.every((text) => bodyText.includes(text))
  );
}

export async function waitForDouyinDramaEntryPageState(
  page: Page,
  timeoutMs = 60_000,
): Promise<"login-required" | "logged-in"> {
  const deadline = Date.now() + timeoutMs;
  let lastBodyText = "";
  while (Date.now() < deadline) {
    lastBodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const activeUrl = page.url();
    if (douyinDramaLoginStateFromUrl(activeUrl) === "login-required") {
      return "login-required";
    }
    if (isDouyinDramaCreatePageReady(activeUrl, lastBodyText)) {
      return "logged-in";
    }
    await page.waitForTimeout(500);
  }
  const title = await page.title().catch(() => "");
  throw new Error(
    `DOUYIN_DRAMA_ENTRY_PAGE_NOT_READY: url=${page.url()} ` +
      `title=${JSON.stringify(title)} body=${JSON.stringify(compactPageText(lastBodyText))}`,
  );
}

export async function waitForDouyinDramaCreatePageReady(page: Page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastBodyText = "";
  while (Date.now() < deadline) {
    lastBodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const activeUrl = page.url();
    if (douyinDramaLoginStateFromUrl(activeUrl) === "login-required") {
      throw new Error(`DOUYIN_DRAMA_LOGIN_REQUIRED: url=${activeUrl}`);
    }
    if (isDouyinDramaCreatePageReady(activeUrl, lastBodyText)) {
      return;
    }
    await page.waitForTimeout(500);
  }
  const title = await page.title().catch(() => "");
  throw new Error(
    `DOUYIN_DRAMA_CREATE_PAGE_NOT_READY: url=${page.url()} ` +
      `title=${JSON.stringify(title)} body=${JSON.stringify(compactPageText(lastBodyText))}`,
  );
}

export async function ensureDouyinDramaCreatePage(
  page: Page,
  options: DouyinDramaRuntimeOptions,
) {
  await openDouyinDramaCreatePage(page);
  await waitForDouyinDramaCreatePageReady(page);
  log(options, "[douyin-drama] 抖音上传漫剧页面已就绪，开始领取任务。", undefined, "browser");
}

export async function waitForDouyinDramaLogin(
  page: Page,
  context: BrowserContext,
  options: DouyinDramaRuntimeOptions,
) {
  const entryState = await waitForDouyinDramaEntryPageState(page);
  if (entryState === "logged-in") return false;
  log(options, "[douyin-drama] 抖音短剧创作者中心需要登录，请在浏览器中完成登录。", undefined, "browser");
  await page.bringToFront();
  if (!page.url().startsWith(DOUYIN_DRAMA_LOGIN_URL)) {
    await page.goto(DOUYIN_DRAMA_LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  const deadline = Date.now() + 120 * 60 * 1_000;
  while (Date.now() < deadline) {
    if (douyinDramaLoginStateFromUrl(page.url()) === "logged-in") {
      await saveDouyinDramaCredentialState(context, options).catch(() => undefined);
      log(options, "[douyin-drama] 抖音短剧创作者中心登录完成。", undefined, "browser");
      return true;
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error("DOUYIN_DRAMA_LOGIN_TIMEOUT");
}
