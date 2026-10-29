import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright";

import {
  douyinDramaBrowserPageTitle,
  douyinDramaLoginStateFromUrl,
  waitForDouyinDramaEntryPageState,
} from "../../src/automation/browser-session.js";
import { DOUYIN_DRAMA_CREATE_URL, DOUYIN_DRAMA_LOGIN_URL } from "../../src/shared/constants.js";

const CREATE_PAGE_BODY = "上传漫剧 剧壳信息 基础信息 下一步";

test("builds a recognizable Douyin browser title from account name and id", () => {
  assert.equal(
    douyinDramaBrowserPageTitle({
      douyinAccountName: "抖音账号甲",
      douyinAccountId: "17732354154",
    }),
    "[抖音短剧] 抖音账号甲（17732354154）",
  );
  assert.equal(
    douyinDramaBrowserPageTitle({
      douyinAccountName: "17732354154",
      douyinAccountId: "17732354154",
    }),
    "[抖音短剧] 17732354154",
  );
});

test("falls back to the Douyin profile name when account metadata is unavailable", () => {
  assert.equal(
    douyinDramaBrowserPageTitle({ accountProfileName: "profile-a" }),
    "[抖音短剧] profile-a",
  );
});

function createPageProbe(states: Array<{ url: string; bodyText: string }>) {
  let index = 0;
  return {
    url: () => states[Math.min(index, states.length - 1)]!.url,
    locator: () => ({
      innerText: async () => states[Math.min(index, states.length - 1)]!.bodyText,
    }),
    waitForTimeout: async () => {
      index += 1;
    },
    title: async () => "短剧创作者中心",
  } as unknown as Page;
}

test("recognizes the Douyin login and authenticated page URLs", () => {
  assert.equal(douyinDramaLoginStateFromUrl(DOUYIN_DRAMA_LOGIN_URL), "login-required");
  assert.equal(douyinDramaLoginStateFromUrl(DOUYIN_DRAMA_CREATE_URL), "logged-in");
});

test("waits for a delayed redirect to the login page", async () => {
  const page = createPageProbe([
    { url: DOUYIN_DRAMA_CREATE_URL, bodyText: "" },
    { url: DOUYIN_DRAMA_LOGIN_URL, bodyText: "手机登录 密码登录" },
  ]);

  assert.equal(await waitForDouyinDramaEntryPageState(page, 1_000), "login-required");
});

test("reports logged in only after the create page content is ready", async () => {
  const page = createPageProbe([
    { url: DOUYIN_DRAMA_CREATE_URL, bodyText: "页面加载中" },
    { url: DOUYIN_DRAMA_CREATE_URL, bodyText: CREATE_PAGE_BODY },
  ]);

  assert.equal(await waitForDouyinDramaEntryPageState(page, 1_000), "logged-in");
});

test("recognizes the new clue association step as a ready create page", async () => {
  const page = createPageProbe([
    { url: DOUYIN_DRAMA_CREATE_URL, bodyText: "页面加载中" },
    {
      url: DOUYIN_DRAMA_CREATE_URL,
      bodyText: "关联线索 填写基本信息 上传视频 填写发布配置 提交完成 是否关联线索 是 否 下一步",
    },
  ]);
  assert.equal(await waitForDouyinDramaEntryPageState(page, 1_000), "logged-in");
});
