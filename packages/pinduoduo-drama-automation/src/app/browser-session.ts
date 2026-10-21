import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { PINDUODUO_LOGIN_EXPIRED_URL, PINDUODUO_MCN_ORIGIN } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { PinduoduoDramaLoginState, PinduoduoDramaRuntimeOptions } from "../shared/types.js";

function pinduoduoBrowserLaunchOptions(options: PinduoduoDramaRuntimeOptions) {
  return {
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
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

export async function launchPinduoduoBrowserContext(
  userDataDir: string,
  options: PinduoduoDramaRuntimeOptions,
): Promise<BrowserContext> {
  const launchOptions = pinduoduoBrowserLaunchOptions(options);

  try {
    const context = await launchPlatformBrowserContext(userDataDir, {
      ...launchOptions,
      ...(options.config?.browser?.executablePath
        ? { executablePath: options.config.browser.executablePath }
        : { channel: "chrome" as const }),
    });
    log(
      options,
      "info",
      "runtime",
      options.config?.browser?.executablePath
        ? "started browser with configured executable"
        : "started browser with Google Chrome channel",
    );
    return context;
  } catch (error) {
    log(options, "error", "runtime", "failed to start browser", {
      error,
    });
    throw Object.assign(
      new Error(
        options.config?.browser?.executablePath
          ? "无法启动配置的浏览器，请检查可执行文件路径和浏览器安装。"
          : "拼多多短剧需要本机安装 Google Chrome，请安装或修复 Chrome 后重启服务。",
      ),
      { cause: error },
    );
  }
}

export async function testPinduoduoBrowserExecutable(
  executablePath: string,
): Promise<{ ok: boolean; message: string }> {
  const trimmedPath = executablePath.trim();
  let browser;
  try {
    browser = await chromium.launch(
      trimmedPath ? { executablePath: trimmedPath, headless: true } : { channel: "chrome", headless: true },
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

export function pinduoduoDramaLoginStateFromUrl(url: string | undefined): PinduoduoDramaLoginState {
  if (!url || url === "about:blank") {
    return "unknown";
  }

  if (url.startsWith(PINDUODUO_LOGIN_EXPIRED_URL) || url.includes("/register")) {
    return "login-required";
  }

  if (url.startsWith(PINDUODUO_MCN_ORIGIN)) {
    return "logged-in";
  }

  return "unknown";
}

export async function saveCredentialState(
  context: BrowserContext,
  options: PinduoduoDramaRuntimeOptions,
): Promise<void> {
  if (!options.credentialStatePath) {
    return;
  }

  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
  log(options, "info", "runtime", "credential snapshot saved", {
    credentialStatePath: options.credentialStatePath,
  });
}
