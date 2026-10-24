import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import {
  baiduDramaBrowserPageTitle,
  waitForBaiduDramaCreatePageReady,
} from "../../src/automation/browser-session.js";
import { BAIDU_DRAMA_CREATE_URL } from "../../src/shared/constants.js";

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
