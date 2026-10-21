import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";

import {
  hideTaobaoWebDriver,
  isTaobaoBatchPublishSuccessUrl,
  isTaobaoCreatorSuccessNavigation,
  isTaobaoTargetUrl,
  taobaoBrowserLaunchOptions,
  taobaoLoginStateFromPage,
  taobaoLoginStateFromUrl,
  testTaobaoBrowserExecutable,
  waitForTaobaoPage,
} from "../../src/automation/browser-session.js";

test("launches Taobao Chromium without the standard automation switches", () => {
  const launchOptions = taobaoBrowserLaunchOptions({
    config: { browser: { headless: false, slowMo: 50 } },
  });

  assert.deepEqual(launchOptions.args, ["--disable-blink-features=AutomationControlled"]);
  assert.deepEqual(launchOptions.ignoreDefaultArgs, ["--enable-automation"]);
  assert.ok("channel" in launchOptions);
  assert.equal(launchOptions.channel, "chrome");
  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.locale, "zh-CN");
  assert.equal(launchOptions.slowMo, 50);
  assert.equal(launchOptions.timezoneId, "Asia/Shanghai");
  assert.equal(launchOptions.viewport, null);
});

test("removes webdriver from the navigator prototype", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const navigatorPrototype = { webdriver: true };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: Object.create(navigatorPrototype),
  });

  try {
    hideTaobaoWebDriver();
    assert.equal(globalThis.navigator.webdriver, undefined);
    assert.equal("webdriver" in globalThis.navigator, false);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
});

test("reports a configured local browser path that cannot be launched", async () => {
  const result = await testTaobaoBrowserExecutable(
    "Z:\\missing-taobao-browser\\chrome.exe",
  );

  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("treats the Taobao workspace redirect as an explicit batch-publish success", () => {
  assert.equal(isTaobaoBatchPublishSuccessUrl(
    "https://creator.guanghe.taobao.com/page/workspace/tb",
  ), true);
  assert.equal(isTaobaoBatchPublishSuccessUrl(
    "https://creator.guanghe.taobao.com/page/workspace/tb/?from=publish",
  ), true);
  assert.equal(isTaobaoBatchPublishSuccessUrl(
    "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish",
  ), false);
  assert.equal(isTaobaoBatchPublishSuccessUrl(
    "https://evil.example/page/workspace/tb",
  ), false);
});

test("recognizes Taobao login, security verification and creator states", () => {
  assert.equal(taobaoLoginStateFromUrl("https://login.taobao.com/havanaone/login/login.htm"), "login-required");
  assert.equal(taobaoLoginStateFromUrl("https://aq.taobao.com/verify"), "verification-required");
  assert.equal(taobaoLoginStateFromUrl("https://creator.guanghe.taobao.com/page/unify/collect-create"), "logged-in");
  assert.equal(taobaoLoginStateFromUrl("not-a-url"), "unknown");
});

test("page verification and login signals override creator host URL", () => {
  const creatorUrl = "https://creator.guanghe.taobao.com/page/unify/collect-create";
  assert.equal(taobaoLoginStateFromPage(creatorUrl, "请完成安全验证 滑块验证"), "verification-required");
  assert.equal(taobaoLoginStateFromPage(creatorUrl, "登录淘宝 手机扫码登录"), "login-required");
  assert.equal(taobaoLoginStateFromPage(creatorUrl, "合集类型 短剧类型"), "logged-in");
});

test("recognizes both Taobao workflow target pages", () => {
  assert.equal(isTaobaoTargetUrl(
    "https://creator.guanghe.taobao.com/page/unify/collect-create?type=1",
    "collection",
  ), true);
  assert.equal(isTaobaoTargetUrl(
    "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish",
    "batch",
  ), true);
  assert.equal(isTaobaoTargetUrl("https://login.taobao.com/", "collection"), false);
  assert.equal(isTaobaoTargetUrl(
    "https://evil.example/?next=https://creator.guanghe.taobao.com/page/unify/collect-create",
    "collection",
  ), false);
});

test("only accepts safe creator-host navigation as a workflow success signal", () => {
  assert.equal(isTaobaoCreatorSuccessNavigation(
    "https://creator.guanghe.taobao.com/page/unify/collection",
    "collection",
  ), true);
  assert.equal(isTaobaoCreatorSuccessNavigation(
    "https://login.taobao.com/havanaone/login/login.htm",
    "collection",
  ), false);
  assert.equal(isTaobaoCreatorSuccessNavigation(
    "https://creator.guanghe.taobao.com/error",
    "collection",
  ), false);
  assert.equal(isTaobaoCreatorSuccessNavigation(
    "https://creator.guanghe.taobao.com/page/unify/collect-create?mode=1",
    "collection",
  ), false);
});

test("notifies once for a persistent verification page and resumes when it clears", async () => {
  let bodyReads = 0;
  let notifications = 0;
  let bringToFrontCalls = 0;
  const visibleLocator = {
    filter: () => visibleLocator,
    first: () => visibleLocator,
    isVisible: async () => true,
  };
  const page = {
    isClosed: () => false,
    url: () => "https://creator.guanghe.taobao.com/page/unify/collect-create?type=1",
    locator: () => ({
      innerText: async () => (++bodyReads <= 2
        ? "请完成安全验证 滑块验证"
        : "合集类型 短剧类型"),
    }),
    getByText: () => visibleLocator,
    getByRole: () => visibleLocator,
    waitForTimeout: async () => undefined,
    bringToFront: async () => { bringToFrontCalls += 1; },
  } as unknown as Page;

  await waitForTaobaoPage(page, "collection", {
    onHumanVerificationRequired: () => { notifications += 1; },
  });

  assert.equal(notifications, 1);
  assert.equal(bringToFrontCalls, 2);
});
