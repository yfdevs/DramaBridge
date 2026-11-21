import { launchPlatformBrowserContext } from "@dramabridge/browser-window";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { WEIBO_DRAMA_ADD_URL } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { WeiboDramaRuntimeOptions } from "../shared/types.js";

export function isWeiboLoginPopup(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "passport.weibo.com" && parsed.pathname.startsWith("/sso/");
  } catch {
    return false;
  }
}

export async function launchWeiboDramaBrowserContext(
  userDataDir: string,
  options: WeiboDramaRuntimeOptions,
) {
  return launchPlatformBrowserContext(userDataDir, {
    headless: options.config?.browser?.headless ?? false,
    slowMo: options.config?.browser?.slowMo ?? 0,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: null,
  });
}

export async function prepareWeiboMainPage(context: BrowserContext) {
  const startupBlanks = context
    .pages()
    .filter((page) => !page.isClosed() && page.url() === "about:blank");
  const main = startupBlanks.shift() ?? (await context.newPage());
  // Only startup blanks are disposable. Keep restored task/failure pages intact.
  await Promise.allSettled(startupBlanks.map((page) => page.close()));
  return main;
}

export async function saveCredentialState(
  context: BrowserContext,
  options: WeiboDramaRuntimeOptions,
) {
  if (!options.credentialStatePath) return;
  await mkdir(dirname(options.credentialStatePath), { recursive: true });
  await context.storageState({ path: options.credentialStatePath });
}

export type WeiboPublishAccount = { uid: string; name: string };

// Backend accountId may be a login phone number. Only the platform response
// supplies publishing UIDs; a unique configured name can bridge these identities.
export function resolveWeiboPublishAccount(
  accounts: WeiboPublishAccount[],
  backendAccountId?: string,
  accountName?: string,
) {
  const exactUid = accounts.find((account) => account.uid === backendAccountId?.trim());
  if (exactUid) return exactUid;
  const matches = accounts.filter((account) => account.name === accountName?.trim());
  if (accountName?.trim() && matches.length === 1) return matches[0];
  if (!backendAccountId && !accountName && accounts.length === 1) return accounts[0];
  return undefined;
}

export async function readWeiboSession(page: Page) {
  return page.evaluate(async () => {
    try {
      const token = typeof localStorage === "undefined" ? null : localStorage.getItem("token");
      const response = await fetch("https://api-duanju.weibo.com/creator/album/editInfoV2", {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      const accounts: Array<{ uid: string; name: string }> =
        result.status === 0 && Array.isArray(result.data?.pub_uids)
          ? result.data.pub_uids.map((account: { uid: string | number; name?: string }) => ({
              uid: String(account.uid),
              name: String(account.name ?? "").trim(),
            }))
          : [];
      return {
        authenticated: result.status === 0,
        accounts,
        error: result.status === 0 ? undefined : String(result.msg ?? "微博登录态未就绪"),
      };
    } catch (error) {
      return {
        authenticated: false,
        accounts: [] as Array<{ uid: string; name: string }>,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export async function weiboSessionReady(
  page: Page,
  expectedAccountId?: string,
  accountName?: string,
) {
  const session = await readWeiboSession(page);
  return (
    session.authenticated &&
    Boolean(resolveWeiboPublishAccount(session.accounts, expectedAccountId, accountName))
  );
}

export async function requireWeiboPublishAccount(page: Page, options: WeiboDramaRuntimeOptions) {
  const session = await readWeiboSession(page);
  if (!session.authenticated)
    throw new Error(`WEIBO_DRAMA_LOGIN_REQUIRED: ${session.error ?? "请完成微博登录"}`);
  const account = resolveWeiboPublishAccount(
    session.accounts,
    options.weiboAccountId,
    options.weiboAccountName,
  );
  if (!account)
    throw new Error(
      `WEIBO_DRAMA_ACCOUNT_MISMATCH: 已登录，但无法唯一匹配后台账号“${options.weiboAccountName || options.weiboAccountId || "未配置"}”；当前可发布账号：${session.accounts.map((item) => `${item.name}(${item.uid})`).join("、") || "无"}，请检查后台账号名称或填写微博UID`,
    );
  return account;
}

export async function waitForLoginIfNeeded(
  page: Page,
  context: BrowserContext,
  options: WeiboDramaRuntimeOptions,
) {
  const checkSession = async () => {
    const session = await readWeiboSession(page);
    if (!session.authenticated) return false;
    const account =
      resolveWeiboPublishAccount(
        session.accounts,
        options.weiboAccountId,
        options.weiboAccountName,
      ) ?? (await requireWeiboPublishAccount(page, options));
    log(options, "[weibo-drama] 登录已确认", {
      backendAccountId: options.weiboAccountId,
      publishUid: account.uid,
      publishAccountName: account.name,
    });
    return true;
  };
  if (await checkSession()) return false;
  log(options, "[weibo-drama] 请在独立微博登录窗口完成登录，等待主页面刷新并验证发布账号");
  const deadline = Date.now() + 120 * 60_000;
  let lastReload = Date.now();
  while (Date.now() < deadline && !page.isClosed()) {
    const popup = context.pages().find((candidate) => isWeiboLoginPopup(candidate.url()));
    if (popup) await popup.bringToFront().catch(() => undefined);
    // Polling the read-only endpoint does not itself invoke the site's popup code.
    if (!popup && Date.now() - lastReload > 15_000) {
      await page.goto(WEIBO_DRAMA_ADD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      lastReload = Date.now();
    }
    if (await checkSession()) {
      await saveCredentialState(context, options);
      return true;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error("WEIBO_DRAMA_LOGIN_TIMEOUT: 未完成微博登录，或登录账号没有所选发布账号权限");
}
