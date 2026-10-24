import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { BAIDU_DRAMA_CREATE_URL, BAIDU_DRAMA_LOGIN_URL } from "../shared/constants.js";
import { log, warn } from "../shared/logger.js";
import type { BaiduDramaLoginState, BaiduDramaRuntimeOptions } from "../shared/types.js";

type BaiduDramaTitleWindow = Window & {
  __baiduDramaFixedTitle?: string;
  __baiduDramaFixedTitleInstalled?: boolean;
};

export function baiduDramaBrowserPageTitle(options: BaiduDramaRuntimeOptions) {
  const accountName = options.baiduAccountName?.trim();
  const accountId = options.baiduAccountId?.trim();
  const profileName = options.accountProfileName?.trim();
  const accountLabel = accountName && accountId && accountName !== accountId
    ? `${accountName}（${accountId}）`
    : accountName || accountId || profileName || "默认账号";
  return `[百度短剧] ${accountLabel}`;
}

function installFixedBaiduDramaPageTitle(fixedTitle: string) {
  const pageWindow = window as BaiduDramaTitleWindow;
  pageWindow.__baiduDramaFixedTitle = fixedTitle;

  const applyTitle = () => {
    const title = pageWindow.__baiduDramaFixedTitle ?? fixedTitle;
    if (document.title !== title) document.title = title;
  };
  const watchTitle = () => {
    applyTitle();
    const titleElement = document.querySelector("title")
      ?? document.head?.appendChild(document.createElement("title"));
    if (!titleElement || titleElement.dataset.fixedBaiduDramaTitle === "true") return;
    titleElement.dataset.fixedBaiduDramaTitle = "true";
    new MutationObserver(applyTitle).observe(titleElement, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  };

  if (pageWindow.__baiduDramaFixedTitleInstalled) {
    applyTitle();
    return;
  }
  pageWindow.__baiduDramaFixedTitleInstalled = true;
  watchTitle();
  window.addEventListener("DOMContentLoaded", watchTitle);
  window.addEventListener("load", watchTitle);
  window.setInterval(applyTitle, 1_000);
}

async function installBaiduDramaBrowserPageTitles(
  context: BrowserContext,
  options: BaiduDramaRuntimeOptions,
) {
  const title = baiduDramaBrowserPageTitle(options);
  await context.addInitScript(installFixedBaiduDramaPageTitle, title);

  const applyToPage = (page: Page) => {
    void page.evaluate(installFixedBaiduDramaPageTitle, title).catch(() => undefined);
  };
  context.on("page", applyToPage);
  for (const page of context.pages()) applyToPage(page);
}

export function baiduDramaLoginStateFromUrl(url: string | undefined): BaiduDramaLoginState {
  if (!url || url === "about:blank") return "unknown";
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/builder/theme/playletPlat/product")) return "login-required";
    if (parsed.hostname === "duanju.baidu.com") return "logged-in";
  } catch {
    return "unknown";
  }
  return "unknown";
}

export async function launchBaiduDramaBrowserContext(
  userDataDir: string,
  options: BaiduDramaRuntimeOptions,
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
  await installBaiduDramaBrowserPageTitles(context, options);
  return context;
}

export async function saveBaiduDramaCredentialState(
  context: BrowserContext,
  options: BaiduDramaRuntimeOptions,
) {
  if (!options.credentialStatePath) return;
  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
}

export async function openBaiduDramaCreatePage(page: Page) {
  await page.goto(BAIDU_DRAMA_CREATE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

function isBaiduDramaCreatePageUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "duanju.baidu.com" &&
      parsed.pathname === "/builder/rc/edit" &&
      parsed.searchParams.get("type") === "playlet"
    );
  } catch {
    return false;
  }
}

function compactPageText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function waitForBaiduDramaCreatePageReadyOnce(
  page: Page,
  timeoutMs: number,
) {
  const readyTexts = ["选择短剧类型", "非真人短剧", "下一步"];
  const deadline = Date.now() + timeoutMs;
  let lastBodyText = "";

  while (Date.now() < deadline) {
    lastBodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    if (
      isBaiduDramaCreatePageUrl(page.url()) &&
      readyTexts.every((text) => lastBodyText.includes(text))
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }

  const title = await page.title().catch(() => "");
  throw new Error(
    `BAIDU_DRAMA_CREATE_PAGE_NOT_READY: url=${page.url()} ` +
      `title=${JSON.stringify(title)} body=${JSON.stringify(compactPageText(lastBodyText))}`,
  );
}

export async function waitForBaiduDramaCreatePageReady(
  page: Page,
  timeoutMs = 60_000,
  options: BaiduDramaRuntimeOptions = {},
) {
  try {
    await waitForBaiduDramaCreatePageReadyOnce(page, timeoutMs);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("BAIDU_DRAMA_CREATE_PAGE_NOT_READY:") ||
      page.isClosed()
    ) throw error;

    warn(options, "[baidu-drama] 创建页未准备完成，刷新页面后重试一次。", { error }, "browser");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForBaiduDramaCreatePageReadyOnce(page, timeoutMs);
  }
}

export async function ensureBaiduDramaCreatePage(
  page: Page,
  options: BaiduDramaRuntimeOptions,
) {
  await openBaiduDramaCreatePage(page);
  await waitForBaiduDramaCreatePageReady(page, undefined, options);
  log(options, "[baidu-drama] 百度短剧创建页已就绪，开始领取任务。", undefined, "browser");
}

export async function waitForBaiduDramaLogin(
  page: Page,
  context: BrowserContext,
  options: BaiduDramaRuntimeOptions,
) {
  if (baiduDramaLoginStateFromUrl(page.url()) !== "login-required") return false;

  log(options, "[baidu-drama] 百度短剧平台需要登录，请在浏览器中完成登录。", undefined, "browser");
  await page.bringToFront();
  if (!page.url().startsWith(BAIDU_DRAMA_LOGIN_URL)) {
    await page.goto(BAIDU_DRAMA_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  const deadline = Date.now() + 120 * 60 * 1000;
  while (Date.now() < deadline) {
    if (baiduDramaLoginStateFromUrl(page.url()) === "logged-in") {
      await saveBaiduDramaCredentialState(context, options).catch(() => undefined);
      log(options, "[baidu-drama] 百度短剧平台登录完成。", undefined, "browser");
      return true;
    }
    const workbenchButton = page.getByText("去工作台", { exact: true }).first();
    if (await workbenchButton.isVisible().catch(() => false)) {
      await workbenchButton.click().catch(() => undefined);
      await page.waitForTimeout(1_000);
      await openBaiduDramaCreatePage(page).catch(() => undefined);
      continue;
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error("BAIDU_DRAMA_LOGIN_TIMEOUT");
}
