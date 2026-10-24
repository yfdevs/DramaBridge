import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  TAOBAO_DRAMA_BATCH_PUBLISH_URL,
  TAOBAO_DRAMA_COLLECTION_CREATE_URL,
  TAOBAO_DRAMA_HOME_URL,
  TAOBAO_DRAMA_MAX_PAGE_NAVIGATIONS,
  TAOBAO_DRAMA_NAVIGATION_SETTLE_MS,
  TAOBAO_DRAMA_PAGE_READY_TIMEOUT_MS,
} from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { TaobaoDramaLoginState, TaobaoDramaRuntimeOptions } from "../shared/types.js";

const loginHosts = ["login.taobao.com", "passport.taobao.com", "aq.taobao.com", "sec.taobao.com"];
// Taobao may redirect the same creator workflow between these two hosts.
const creatorHosts = new Set(["creator.guanghe.taobao.com", "creator.tiancheng.taobao.com"]);
type TaobaoPageTarget = "home" | "collection" | "batch";

export function hideTaobaoWebDriver() {
  const navigatorPrototype = Object.getPrototypeOf(navigator) as Record<string, unknown> | null;
  if (!navigatorPrototype) return;

  try {
    if (Reflect.deleteProperty(navigatorPrototype, "webdriver")) return;
    throw new Error("webdriver descriptor is not configurable");
  } catch {
    try {
      Object.defineProperty(navigatorPrototype, "webdriver", {
        configurable: true,
        get: () => undefined,
      });
    } catch {
      // Some custom browser builds expose a non-configurable descriptor. In that
      // case the Chromium launch flag below remains the primary protection.
    }
  }
}

async function installTaobaoStealth(context: BrowserContext) {
  await context.addInitScript(hideTaobaoWebDriver);

  // A persistent profile can restore an already-loaded tab. Init scripts cover
  // subsequent documents and iframes; this also patches those restored tabs.
  await Promise.all(context.pages().map((page) =>
    page.evaluate(hideTaobaoWebDriver).catch(() => undefined)
  ));
}

export function taobaoBrowserLaunchOptions(options: TaobaoDramaRuntimeOptions) {
  const executablePath = options.config?.browser?.executablePath?.trim();
  return {
    ...(executablePath
      ? { executablePath }
      : { channel: "chrome" as const }),
    args: ["--disable-blink-features=AutomationControlled"],
    extraHTTPHeaders: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
    headless: options.config?.browser?.headless ?? false,
    ignoreDefaultArgs: ["--enable-automation"],
    locale: "zh-CN",
    slowMo: options.config?.browser?.slowMo ?? 0,
    timezoneId: "Asia/Shanghai",
    viewport: null,
  } satisfies Parameters<typeof launchPlatformBrowserContext>[1];
}

export function taobaoLoginStateFromUrl(url?: string): TaobaoDramaLoginState {
  if (!url) return "unknown";
  try {
    const parsed = new URL(url);
    if (creatorHosts.has(parsed.hostname)) return "logged-in";
    if (parsed.hostname === "login.taobao.com" || parsed.hostname === "passport.taobao.com") {
      return "login-required";
    }
    if (loginHosts.includes(parsed.hostname)) return "verification-required";
  } catch {
    return "unknown";
  }
  return "unknown";
}

export function taobaoLoginStateFromPage(
  url: string | undefined,
  pageText: string,
): TaobaoDramaLoginState {
  const normalized = pageText.replace(/\s+/g, " ");
  if (/安全验证|身份验证|滑块验证|请完成验证|验证码|账号(?:存在)?风险|扫码验证/.test(normalized)) {
    return "verification-required";
  }
  if (/登录淘宝|手机扫码登录|密码登录|短信登录/.test(normalized)) {
    return "login-required";
  }
  return taobaoLoginStateFromUrl(url);
}

export function isTaobaoTargetUrl(url: string, target: TaobaoPageTarget) {
  try {
    const parsed = new URL(url);
    if (!creatorHosts.has(parsed.hostname)) return false;
    if (target === "home") {
      return parsed.pathname.startsWith("/page/") &&
        !/(?:^|\/)(?:error|login|verify|exception)(?:\/|$)/i.test(parsed.pathname);
    }
    return target === "collection"
      ? parsed.pathname === "/page/unify/collect-create"
      : parsed.pathname === "/page/unify/creation-tool/batch-publish";
  } catch {
    return false;
  }
}

export function isTaobaoCreatorSuccessNavigation(
  url: string,
  target: "collection" | "batch",
) {
  try {
    const parsed = new URL(url);
    return creatorHosts.has(parsed.hostname) &&
      !/(?:^|\/)(?:error|login|verify|exception)(?:\/|$)/i.test(parsed.pathname) &&
      !isTaobaoTargetUrl(url, target);
  } catch {
    return false;
  }
}

export function isTaobaoBatchPublishSuccessUrl(url: string) {
  try {
    const parsed = new URL(url);
    return creatorHosts.has(parsed.hostname) &&
      parsed.pathname.replace(/\/+$/, "") === "/page/workspace/tb";
  } catch {
    return false;
  }
}

async function targetReady(page: Page, target: TaobaoPageTarget) {
  if (target === "home") {
    return Boolean((await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "")).trim());
  }
  const marker = page
    .getByText(target === "collection" ? /合集类型|短剧类型/ : /上传视频|上传文件|添加视频/)
    .filter({ visible: true })
    .first();
  const action = page
    .getByRole("button", { name: target === "collection" ? /创建合集|创建/ : /批量发布/ })
    .filter({ visible: true })
    .first();
  const markerReady = await marker.isVisible().catch(() => false) || (target === "batch" && await page
    .locator("input[type='file']:not([disabled])")
    .evaluateAll((inputs) => inputs.some((element) => {
      const input = element as HTMLInputElement;
      const context = input.parentElement?.parentElement?.textContent ?? "";
      return /video|mp4/i.test(input.accept) || /上传视频|添加视频|上传剧集/.test(context);
    }))
    .catch(() => false));
  if (target === "batch") return markerReady;
  return markerReady && await action.isVisible().catch(() => false);
}

async function currentLoginState(page: Page) {
  const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  return taobaoLoginStateFromPage(page.url(), text);
}

export async function launchTaobaoBrowserContext(
  userDataDir: string,
  options: TaobaoDramaRuntimeOptions,
) {
  const executablePath = options.config?.browser?.executablePath?.trim();
  try {
    const context = await launchPlatformBrowserContext(
      userDataDir,
      taobaoBrowserLaunchOptions(options),
    );
    await installTaobaoStealth(context);
    log(
      options,
      executablePath
        ? "[taobao-drama] 已使用配置的本地浏览器启动"
        : "[taobao-drama] 已使用系统 Chrome 启动",
    );
    return context;
  } catch (error) {
    throw Object.assign(
      new Error(
        executablePath
          ? "无法启动配置的浏览器，请检查可执行文件路径和浏览器安装。"
          : "淘宝短剧需要本机安装 Google Chrome，请安装或修复 Chrome 后重启服务。",
      ),
      { cause: error },
    );
  }
}

export async function testTaobaoBrowserExecutable(
  executablePath: string,
): Promise<{ ok: boolean; message: string }> {
  const trimmedPath = executablePath.trim();
  let browser;
  try {
    browser = await chromium.launch(
      trimmedPath
        ? { executablePath: trimmedPath, headless: true }
        : { channel: "chrome", headless: true },
    );
    return {
      ok: true,
      message: trimmedPath
        ? "浏览器路径可用，Playwright 已成功启动。"
        : "未填写自定义路径，系统 Chrome 可用。",
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function saveTaobaoCredentialState(
  context: BrowserContext,
  options: TaobaoDramaRuntimeOptions,
) {
  if (!options.credentialStatePath) return;
  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
}

export async function waitForTaobaoPage(
  page: Page,
  target: TaobaoPageTarget,
  options: TaobaoDramaRuntimeOptions,
  navigation: { fresh?: boolean } = {},
) {
  const targetUrl = target === "home" ? TAOBAO_DRAMA_HOME_URL : target === "collection"
    ? TAOBAO_DRAMA_COLLECTION_CREATE_URL
    : TAOBAO_DRAMA_BATCH_PUBLISH_URL;
  const label = target === "home" ? "淘宝主页" : target === "collection" ? "创建合集页" : "批量发布页";
  let freshNavigationNeeded = navigation.fresh === true;
  let navigationCount = 0;
  let readyDeadline = Date.now() + TAOBAO_DRAMA_PAGE_READY_TIMEOUT_MS;
  let observedUrl = page.url();
  let urlStableSince = Date.now();
  let loginLogged = false;
  let verificationNotified = false;
  while (!page.isClosed()) {
    if (page.url() !== observedUrl) {
      observedUrl = page.url();
      urlStableSince = Date.now();
    }
    const state = await currentLoginState(page);
    if (state === "login-required" || state === "verification-required") {
      if (!loginLogged) {
        log(
          options,
          state === "verification-required"
            ? "[taobao-drama] 等待用户完成淘宝安全校验"
            : "[taobao-drama] 等待用户登录淘宝光合平台",
        );
        loginLogged = true;
      }
      if (state === "verification-required" && !verificationNotified) {
        verificationNotified = true;
        await page.bringToFront().catch(() => undefined);
        await options.onHumanVerificationRequired?.({ pages: [page.url()] });
      }
      // Login and manual verification must never be interrupted by navigation
      // or consume the form-readiness timeout.
      readyDeadline = Date.now() + TAOBAO_DRAMA_PAGE_READY_TIMEOUT_MS;
      urlStableSince = Date.now();
      await page.waitForTimeout(1_000);
      continue;
    }

    verificationNotified = false;

    if (!freshNavigationNeeded && isTaobaoTargetUrl(page.url(), target) && await targetReady(page, target)) {
      log(options, `[taobao-drama] ${label}已就绪`);
      return;
    }
    if (Date.now() >= readyDeadline) {
      throw new Error(`TAOBAO_DRAMA_PAGE_READY_TIMEOUT: ${label}未就绪，已停止自动跳转，请检查登录、页面权限或网络。url=${page.url()}`);
    }
    if (freshNavigationNeeded || !isTaobaoTargetUrl(page.url(), target)) {
      // Give platform redirects time to settle. Reissuing goto on every poll
      // cancels login redirects and can itself cause net::ERR_ABORTED.
      if (navigationCount === 0 || Date.now() - urlStableSince >= TAOBAO_DRAMA_NAVIGATION_SETTLE_MS) {
        if (navigationCount >= TAOBAO_DRAMA_MAX_PAGE_NAVIGATIONS) {
          throw new Error(`TAOBAO_DRAMA_PAGE_REDIRECT_LIMIT: ${label}反复跳转，已停止自动跳转，请检查登录或页面权限。url=${page.url()}`);
        }
        navigationCount += 1;
        const urlBeforeNavigation = page.url();
        try {
          await page.goto(targetUrl, { waitUntil: "commit", timeout: 60_000 });
          freshNavigationNeeded = false;
        } catch (error) {
          if (page.isClosed()) throw Object.assign(new Error("TAOBAO_DRAMA_BROWSER_PAGE_CLOSED"), { cause: error });
          const message = error instanceof Error ? error.message : String(error);
          if (!/net::ERR_ABORTED|navigation.*interrupted by another navigation/i.test(message)) throw error;
          if (page.url() !== urlBeforeNavigation) freshNavigationNeeded = false;
          // An interrupted navigation is not success. Continue checking the
          // resulting URL, login state and controls within the bounded wait.
          log(options, `[taobao-drama] ${label}导航被中断，等待页面跳转完成`, { activeUrl: page.url() });
        }
        observedUrl = page.url();
        urlStableSince = Date.now();
        continue;
      }
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("TAOBAO_DRAMA_BROWSER_PAGE_CLOSED");
}

/** Only the current task and its popups may supply controls or success signals. */
export async function taobaoTaskPages(page: Page) {
  const related: Page[] = page.isClosed() ? [] : [page];
  for (const candidate of page.context().pages()) {
    if (candidate === page || candidate.isClosed()) continue;
    if (await candidate.opener().catch(() => null) === page) related.push(candidate);
  }
  return related;
}
