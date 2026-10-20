import { chromium } from "playwright";

const USER_DATA_DIR = "D:/pinduoduo-drama/auth/accounts/default/chromium-profile";
const VIDEO = "D:/BaiduNetdiskDownload/货车被当免费拉货站，我收车/货车被当免费拉货站，我收车 - 第1集.mp4";
const DRAMA_TITLE = "货车被当免费拉货站，我收车";
const SHOT_DIR = "D:/WebDesign/CodeWorkspace/dramabridge/.cache";

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  channel: "chrome",
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  viewport: null,
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://mcn.pinduoduo.com/home/shortplayManage", {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});

console.log("waiting for login... (请在打开的窗口扫码登录，期间不要在其他地方登录该账号)");
const deadline = Date.now() + 5 * 60_000;
let userInfo = null;
while (Date.now() < deadline) {
  userInfo = await page
    .evaluate(async () => {
      const r = await fetch("https://mcn.pinduoduo.com/api/cafe/login/user_info", { credentials: "include" });
      return r.json().catch(() => null);
    })
    .catch(() => null);
  if (userInfo && userInfo.error_code !== 40001 && userInfo.success !== false) break;
  await page.waitForTimeout(2_000);
}
if (!userInfo || userInfo.error_code === 40001) {
  console.log("LOGIN TIMEOUT");
  await context.close();
  process.exit(1);
}
console.log("user_info:", JSON.stringify(userInfo).slice(0, 2000));

// Figure out the publish URL: try without uid, then with candidate uids from user_info.
const candidates = [undefined];
const seen = new Set();
const walk = (obj) => {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object") walk(v);
    else if (/uid|user_id|account_id/i.test(k) && (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) {
      if (!seen.has(String(v))) {
        seen.add(String(v));
        candidates.push(String(v));
      }
    }
  }
};
walk(userInfo.result ?? userInfo);
console.log("uid candidates:", JSON.stringify(candidates));

let publishReady = false;
for (const uid of candidates) {
  const url = uid ? `https://mcn.pinduoduo.com/home/creator/publish?uid=${uid}` : "https://mcn.pinduoduo.com/home/creator/publish";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const hasInput = await page.locator('input[data-testid="beast-core-upload-input"][accept*=".mp4"]').count();
  console.log(`publish try uid=${uid ?? "(none)"} -> url=${page.url()} videoInput=${hasInput}`);
  if (hasInput > 0) {
    publishReady = true;
    break;
  }
}
if (!publishReady) {
  console.log("NO PUBLISH PAGE REACHED");
  await page.screenshot({ path: `${SHOT_DIR}/pdd-publish-fail.png` });
  await context.close();
  process.exit(1);
}

// Enumerate inputs (video vs image).
const inputs = await page.evaluate(() =>
  [...document.querySelectorAll('input[data-testid="beast-core-upload-input"]')].map((el) => ({
    accept: el.getAttribute("accept"),
  })),
);
console.log("file inputs:", JSON.stringify(inputs));

// Upload one episode.
await page.locator('input[data-testid="beast-core-upload-input"][accept*=".mp4"]').setInputFiles([VIDEO]);
console.log("setInputFiles done");
await page.waitForTimeout(5_000);
await page.screenshot({ path: `${SHOT_DIR}/pdd-publish-2-uploading.png` });

const ok = await page
  .waitForFunction(() => !/上传中|处理中/.test(document.body.textContent ?? ""), undefined, {
    timeout: 10 * 60_000,
  })
  .then(() => true)
  .catch(() => false);
console.log("upload finished:", ok);
await page.screenshot({ path: `${SHOT_DIR}/pdd-publish-3-uploaded.png` });

// Click 添加至已有短剧.
const bindButton = page.locator("button", { hasText: "添加至已有短剧" }).first();
if ((await bindButton.count()) === 0) {
  console.log("NO BIND BUTTON");
  await context.close();
  process.exit(1);
}
await bindButton.click();
await page.waitForTimeout(3_000);
await page.screenshot({ path: `${SHOT_DIR}/pdd-publish-4-bind-dialog.png` });

const dumpOverlay = () =>
  page.evaluate(() => {
    const nodes = [...document.querySelectorAll("body > div")];
    const overlay = nodes.find((d) => /短剧|搜索/.test(d.textContent ?? "") && d !== document.body.firstElementChild);
    const dialog =
      document.querySelector('[role="dialog"], [class*="modal" i], [class*="drawer" i]') ?? overlay;
    return dialog ? dialog.outerHTML.slice(0, 8000) : "NO DIALOG FOUND";
  });
console.log("dialog html:", await dumpOverlay());

// Try search.
const searchInput = page.locator('[role="dialog"] input, [class*="modal" i] input').first();
if (await searchInput.count()) {
  await searchInput.fill(DRAMA_TITLE);
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: `${SHOT_DIR}/pdd-publish-5-bind-search.png` });
  console.log("dialog html after search:", await dumpOverlay());
} else {
  console.log("no search input found in dialog");
}

console.log("done (no publish clicked).");
await context.close();
