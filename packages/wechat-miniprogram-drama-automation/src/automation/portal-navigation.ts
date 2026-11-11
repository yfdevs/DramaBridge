import type { Page } from "playwright";
import { playletUrl } from "./constants.js";

function tokenFromUrl(value: string): string | null {
  try {
    return new URL(value).searchParams.get("token");
  } catch {
    return null;
  }
}

async function resolveSessionToken(page: Page): Promise<string> {
  const currentToken = tokenFromUrl(page.url());
  if (currentToken) return currentToken;

  await page.goto(playletUrl, { waitUntil: "domcontentloaded" });
  const redirectedToken = tokenFromUrl(page.url());
  if (redirectedToken) return redirectedToken;

  const tokenLink = page.locator('a[href*="token="]').first();
  const href = await tokenLink.getAttribute("href").catch(() => null);
  const linkedToken = href ? tokenFromUrl(new URL(href, page.url()).href) : null;
  if (linkedToken) return linkedToken;

  throw new Error("[login-required] 微信小程序后台登录状态无效，请重新扫码登录");
}

export async function gotoMiniProgramPage(page: Page, pathname: string): Promise<void> {
  const token = await resolveSessionToken(page);
  const url = new URL(pathname, "https://mp.weixin.qq.com");
  url.searchParams.set("simple", "1");
  url.searchParams.set("token", token);
  url.searchParams.set("lang", "zh_CN");
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
}
