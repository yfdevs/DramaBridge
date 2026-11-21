import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BrowserContext, Page } from "playwright";
import {
  baiduDramaBrowserPageTitle,
  waitForBaiduDramaCreatePageReady,
  openBaiduDramaCreatePage,
  waitForBaiduDramaLogin,
  prepareBaiduDramaTaskPolling,
} from "../../src/automation/browser-session.js";
import { BAIDU_DRAMA_CREATE_URL, BAIDU_DRAMA_LOGIN_URL } from "../../src/shared/constants.js";

test("builds a recognizable Baidu browser title from account name and id", () => {
  assert.equal(
    baiduDramaBrowserPageTitle({
      baiduAccountName: "百度账号甲",
      baiduAccountId: "baidu-1001",
    }),
    "[百度短剧] 百度账号甲（baidu-1001）",
  );
});

test("falls back to the profile name when account metadata is unavailable", () => {
  assert.equal(
    baiduDramaBrowserPageTitle({ accountProfileName: "profile-a" }),
    "[百度短剧] profile-a",
  );
});

function createPage(t: TestContext, input: {
  text?: string;
  onReload?: () => void;
  onWait?: () => void;
} = {}) {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const state = { text: input.text ?? "", closed: false, reloads: 0, reloadTimes: [] as number[] };
  const page = {
    url: () => BAIDU_DRAMA_CREATE_URL,
    title: async () => "[百度短剧] 测试账号",
    isClosed: () => state.closed,
    locator: () => ({ innerText: async () => state.text }),
    waitForTimeout: async (ms: number) => { now += ms; input.onWait?.(); },
    reload: async (options: unknown) => {
      assert.deepEqual(options, { waitUntil: "domcontentloaded", timeout: 60_000 });
      state.reloads += 1;
      state.reloadTimes.push(now);
      input.onReload?.();
    },
  } as unknown as Page;
  return { page, state, now: () => now };
}

test("a ready Baidu creation page is not refreshed", async (t) => {
  const { page, state } = createPage(t, { text: "选择短剧类型 非真人短剧 下一步" });
  await waitForBaiduDramaCreatePageReady(page);
  assert.equal(state.reloads, 0);
});

test("an unready Baidu creation page refreshes once and resumes after becoming ready", async (t) => {
  const logs: string[] = [];
  const { page, state } = createPage(t, {
    onReload() { state.text = "选择短剧类型 非真人短剧 下一步"; },
  });
  await waitForBaiduDramaCreatePageReady(page, undefined, { onLog: (line) => logs.push(line) });
  assert.deepEqual(state.reloadTimes, [60_000]);
  assert.equal(state.reloads, 1);
  assert.equal(logs.filter((line) => line.includes("刷新页面后重试一次")).length, 1);
});

test("the retry gets a full readiness timeout and never refreshes a second time", async (t) => {
  const { page, state, now } = createPage(t, {
    onReload() { state.text = "刷新后仍在加载"; },
  });
  await assert.rejects(waitForBaiduDramaCreatePageReady(page), (error: Error) => {
    assert.match(error.message, /^BAIDU_DRAMA_CREATE_PAGE_NOT_READY:/);
    assert.match(error.message, /body="刷新后仍在加载"/);
    return true;
  });
  assert.equal(state.reloads, 1);
  assert.equal(now(), 120_000);
});

test("a closed Baidu creation page is not refreshed", async (t) => {
  const { page, state } = createPage(t, { onWait() { state.closed = true; } });
  await assert.rejects(waitForBaiduDramaCreatePageReady(page, 500), /BAIDU_DRAMA_CREATE_PAGE_NOT_READY/);
  assert.equal(state.reloads, 0);
});

test("unrelated page errors are propagated without a refresh", async (t) => {
  const failure = new Error("browser context closed");
  const { page, state } = createPage(t, { onWait() { throw failure; } });
  await assert.rejects(waitForBaiduDramaCreatePageReady(page), (error) => error === failure);
  assert.equal(state.reloads, 0);
});

test("a failed refresh is propagated without another attempt", async (t) => {
  const failure = new Error("net::ERR_CONNECTION_RESET");
  const { page, state } = createPage(t, { onReload() { throw failure; } });
  await assert.rejects(waitForBaiduDramaCreatePageReady(page), (error) => error === failure);
  assert.equal(state.reloads, 1);
});

test("a navigation timeout keeps the login page available for more than a minute", async (t) => {
  let now = 0, url = BAIDU_DRAMA_LOGIN_URL;
  t.mock.method(Date, "now", () => now);
  const page = {
    goto: async () => { throw Object.assign(new Error("navigation timed out"), { name: "TimeoutError" }); },
    isClosed: () => false,
    url: () => url,
    bringToFront: async () => undefined,
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async (ms: number) => { now += ms; if (now >= 180_000) url = BAIDU_DRAMA_CREATE_URL; },
  } as unknown as Page;
  await openBaiduDramaCreatePage(page);
  assert.equal(await waitForBaiduDramaLogin(page, {} as BrowserContext, {}), true);
  assert.equal(now, 180_000);
});

test("a delayed redirect to login gets the manual login budget instead of the readiness budget", async (t) => {
  let url = BAIDU_DRAMA_CREATE_URL;
  const { page, state, now } = createPage(t, {
    onWait() {
      if (now() < 180_000) url = BAIDU_DRAMA_LOGIN_URL;
      else { url = BAIDU_DRAMA_CREATE_URL; state.text = "选择短剧类型 非真人短剧 下一步"; }
    },
  });
  Object.assign(page, {
    url: () => url,
    context: () => ({}),
    bringToFront: async () => undefined,
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    goto: async () => undefined,
  });
  await waitForBaiduDramaCreatePageReady(page);
  assert.ok(now() >= 180_000);
  assert.equal(state.reloads, 0);
});

test("navigation failures other than timeouts are still reported", async () => {
  const failure = new Error("net::ERR_CONNECTION_RESET");
  const page = { goto: async () => { throw failure; }, isClosed: () => false } as unknown as Page;
  await assert.rejects(openBaiduDramaCreatePage(page), error => error === failure);
});

test("a temporary unknown redirect is allowed to settle without navigating back to login", async (t) => {
  let url = 'https://passport.baidu.com/redirect';
  const {page, state} = createPage(t, {
    onWait() { url = BAIDU_DRAMA_CREATE_URL; state.text = '选择短剧类型 非真人短剧 下一步'; },
  });
  Object.assign(page, {url:()=>url, context:()=>{throw new Error('must not restart login');}});
  await waitForBaiduDramaCreatePageReady(page);
  assert.equal(state.reloads, 0);
});

test("task polling starts after login without depending on idle creation-page text", async () => {
  let navigations = 0;
  const logs: string[] = [];
  const page = {
    goto: async () => {navigations++;},
    url: () => BAIDU_DRAMA_CREATE_URL,
    locator: () => {throw new Error('idle form readiness must not block task polling');},
  } as unknown as Page;
  await prepareBaiduDramaTaskPolling(page, {} as BrowserContext, {onLog:line=>logs.push(line)});
  assert.equal(navigations, 1);
  assert.ok(logs.some(line=>line.includes('开始领取任务')));
});

test("login waits through an unknown callback URL without forcing another navigation", async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', ()=>now);
  const page = {
    url:()=>now ? BAIDU_DRAMA_CREATE_URL : 'https://passport.baidu.com/redirect',
    bringToFront:async()=>{},
    goto:async()=>{throw new Error('must not interrupt login callback');},
    getByText:()=>({first:()=>({isVisible:async()=>false})}),
    waitForTimeout:async(ms:number)=>{now+=ms;},
  } as unknown as Page;
  assert.equal(await waitForBaiduDramaLogin(page, {} as BrowserContext, {}), true);
});
