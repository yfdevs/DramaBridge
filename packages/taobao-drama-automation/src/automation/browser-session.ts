import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  TAOBAO_DRAMA_BATCH_PUBLISH_URL,
  TAOBAO_DRAMA_COLLECTION_CREATE_URL,
  TAOBAO_DRAMA_PAGE_READY_RELOAD_MS,
} from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { TaobaoDramaLoginState, TaobaoDramaRuntimeOptions } from "../shared/types.js";

const loginHosts = ["login.taobao.com", "passport.taobao.com", "aq.taobao.com", "sec.taobao.com"];

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
  } satisfies Parameters<typeof chromium.launchPersistentContext>[1];
}

export function taobaoLoginStateFromUrl(url?: string): TaobaoDramaLoginState {
  if (!url) return "unknown";
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "creator.guanghe.taobao.com") return "logged-in";
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

export function isTaobaoTargetUrl(url: string, target: "collection" | "batch") {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "creator.guanghe.taobao.com") return false;
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
    return parsed.hostname === "creator.guanghe.taobao.com" &&
      !/(?:^|\/)(?:error|login|verify|exception)(?:\/|$)/i.test(parsed.pathname) &&
      !isTaobaoTargetUrl(url, target);
  } catch {
    return false;
  }
}

export function isTaobaoBatchPublishSuccessUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "creator.guanghe.taobao.com" &&
      parsed.pathname.replace(/\/+$/, "") === "/page/workspace/tb";
  } catch {
    return false;
  }
}

async function targetReady(page: Page, target: "collection" | "batch") {
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
    const context = await chromium.launchPersistentContext(
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
  target: "collection" | "batch",
  options: TaobaoDramaRuntimeOptions,
) {
  const targetUrl = target === "collection"
    ? TAOBAO_DRAMA_COLLECTION_CREATE_URL
    : TAOBAO_DRAMA_BATCH_PUBLISH_URL;
  if (!isTaobaoTargetUrl(page.url(), target)) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  let loginLogged = false;
  let verificationNotified = false;
  let lastReadyReloadAt = Date.now();
  while (!page.isClosed()) {
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
        await page.bringToFront().catch(() => undefined);
      }
      await page.waitForTimeout(1_000);
      continue;
    }

    verificationNotified = false;

    if (!isTaobaoTargetUrl(page.url(), target)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      loginLogged = false;
      lastReadyReloadAt = Date.now();
      continue;
    }
    if (await targetReady(page, target)) {
      log(options, `[taobao-drama] ${target === "collection" ? "创建合集" : "批量发布"}页面已就绪`);
      return;
    }
    if (Date.now() - lastReadyReloadAt >= TAOBAO_DRAMA_PAGE_READY_RELOAD_MS) {
      log(
        options,
        `[taobao-drama] ${target === "collection" ? "创建合集" : "批量发布"}页面长时间未出现操作控件，刷新后重试`,
      );
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      lastReadyReloadAt = Date.now();
      continue;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("TAOBAO_DRAMA_BROWSER_PAGE_CLOSED");
}
