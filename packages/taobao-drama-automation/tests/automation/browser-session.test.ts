import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";

import {
  hideTaobaoWebDriver,
  isTaobaoBatchPublishSuccessUrl,
  isTaobaoCreatorSuccessNavigation,
  isTaobaoTargetUrl,
  taobaoBrowserLaunchOptions,
  taobaoLoginStateFromPage,
  taobaoLoginStateFromUrl,
  taobaoTaskPages,
  testTaobaoBrowserExecutable,
  waitForTaobaoPage,
} from "../../src/automation/browser-session.js";
import {
  TAOBAO_DRAMA_COLLECTION_CREATE_URL,
  TAOBAO_DRAMA_HOME_URL,
  TAOBAO_DRAMA_NAVIGATION_SETTLE_MS,
  TAOBAO_DRAMA_PAGE_READY_TIMEOUT_MS,
} from "../../src/shared/constants.js";

type PageState = {
  url: string;
  text: string;
  ready: boolean;
  closed: boolean;
  waits: number;
  navigations: Array<{ url: string; at: number }>;
  reloads: number;
};

function navigationPage(t: TestContext, input: {
  url?: string;
  ready?: boolean;
  text?: string;
  onGoto?: (state: PageState, url: string) => void;
  onWait?: (state: PageState) => void;
} = {}) {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const state: PageState = {
    url: input.url ?? "about:blank", text: input.text ?? "合集类型 短剧类型",
    ready: input.ready ?? true, closed: false, waits: 0, navigations: [], reloads: 0,
  };
  const marker = {
    filter: () => marker, first: () => marker,
    isVisible: async () => state.ready,
  };
  const page = {
    url: () => state.url,
    isClosed: () => state.closed,
    locator: () => ({ innerText: async () => state.text, evaluateAll: async () => false }),
    getByText: () => marker,
    getByRole: () => marker,
    goto: async (url: string, options: { waitUntil: string }) => {
      assert.equal(options.waitUntil, "commit");
      state.navigations.push({ url, at: now });
      if (input.onGoto) input.onGoto(state, url);
      else state.url = url;
    },
    reload: async () => { state.reloads += 1; },
    waitForTimeout: async (ms: number) => {
      now += ms;
      state.waits += 1;
      assert.ok(state.waits <= 300, "navigation wait must be bounded outside manual login");
      input.onWait?.(state);
    },
    bringToFront: async () => undefined,
  } as unknown as Page;
  return { page, state };
}

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

for (const host of ["creator.guanghe.taobao.com", "creator.tiancheng.taobao.com"]) {
  test(`recognizes login, workflow targets and success navigation on ${host}`, () => {
    const origin = `https://${host}`;
    const collectionUrl = `${origin}/page/unify/collect-create?type=1`;
    const batchUrl = `${origin}/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish`;
    const workspaceUrl = `${origin}/page/workspace/tb`;
    assert.equal(taobaoLoginStateFromUrl(collectionUrl), "logged-in");
    assert.equal(taobaoLoginStateFromPage(collectionUrl, "请完成安全验证"), "verification-required");
    assert.equal(taobaoLoginStateFromPage(collectionUrl, "手机扫码登录"), "login-required");
    assert.equal(isTaobaoTargetUrl(workspaceUrl, "home"), true);
    assert.equal(isTaobaoTargetUrl(collectionUrl, "collection"), true);
    assert.equal(isTaobaoTargetUrl(batchUrl, "batch"), true);
    assert.equal(isTaobaoCreatorSuccessNavigation(`${origin}/page/unify/collection`, "collection"), true);
    assert.equal(isTaobaoCreatorSuccessNavigation(collectionUrl, "collection"), false);
    assert.equal(isTaobaoCreatorSuccessNavigation(batchUrl, "batch"), false);
    assert.equal(isTaobaoCreatorSuccessNavigation(`${origin}/page/error`, "collection"), false);
    assert.equal(isTaobaoBatchPublishSuccessUrl(`${workspaceUrl}/?from=publish`), true);
    assert.equal(isTaobaoBatchPublishSuccessUrl(batchUrl), false);
  });
}

test("rejects lookalike and unrecognized creator hosts", () => {
  for (const host of ["creator.tiancheng.taobao.com.evil.example", "creator.unknown.taobao.com"]) {
    const origin = `https://${host}`;
    assert.equal(taobaoLoginStateFromUrl(origin), "unknown");
    assert.equal(isTaobaoTargetUrl(`${origin}/page/unify/collect-create`, "collection"), false);
    assert.equal(isTaobaoCreatorSuccessNavigation(`${origin}/page/unify/collection`, "collection"), false);
    assert.equal(isTaobaoBatchPublishSuccessUrl(`${origin}/page/workspace/tb`), false);
  }
});

test("a redirect to Tiancheng waits for the collection form without navigating again", async (t) => {
  const { page, state } = navigationPage(t, {
    ready: false,
    onGoto(state, url) { state.url = url.replace("creator.guanghe.taobao.com", "creator.tiancheng.taobao.com"); },
    onWait(state) { if (state.waits === 8) state.ready = true; },
  });
  await waitForTaobaoPage(page, "collection", {});
  assert.equal(state.navigations.length, 1);
  assert.equal(state.waits, 8);
  assert.equal(state.reloads, 0);
});

test("an existing Tiancheng collection page with missing controls times out without navigation", async (t) => {
  const { page, state } = navigationPage(t, {
    url: "https://creator.tiancheng.taobao.com/page/unify/collect-create?type=1", ready: false,
  });
  await assert.rejects(waitForTaobaoPage(page, "collection", {}), /PAGE_READY_TIMEOUT/);
  assert.equal(state.navigations.length, 0);
  assert.equal(state.reloads, 0);
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
  assert.equal(bringToFrontCalls, 1);
});

test("opens a homepage without requiring a collection creation form", async (t) => {
  const { page, state } = navigationPage(t, { ready: false, text: "淘宝光合平台 内容管理" });
  await waitForTaobaoPage(page, "home", {});
  assert.deepEqual(state.navigations.map(item => item.url), [TAOBAO_DRAMA_HOME_URL]);
  assert.equal(state.reloads, 0);
});

test("keeps an already open creator homepage without navigating", async (t) => {
  const { page, state } = navigationPage(t, {
    url: "https://creator.guanghe.taobao.com/page/workspace/tb", text: "淘宝工作台",
  });
  await waitForTaobaoPage(page, "home", {});
  assert.equal(state.navigations.length, 0);
});

test("an aborted login redirect waits for login instead of reloading or navigating again", async (t) => {
  const { page, state } = navigationPage(t, {
    onGoto(state) {
      state.url = "https://login.taobao.com/havanaone/login/login.htm";
      state.text = "手机扫码登录";
      throw new Error("page.goto: net::ERR_ABORTED");
    },
    onWait(state) {
      if (state.waits === 3) {
        state.url = TAOBAO_DRAMA_COLLECTION_CREATE_URL;
        state.text = "合集类型 短剧类型";
      }
    },
  });
  await waitForTaobaoPage(page, "collection", {});
  assert.equal(state.navigations.length, 1);
  assert.equal(state.reloads, 0);
});

test("waits for a late navigation commit after ERR_ABORTED", async (t) => {
  const { page, state } = navigationPage(t, {
    onGoto() { throw new Error("page.goto: net::ERR_ABORTED"); },
    onWait(state) { if (state.waits === 2) state.url = TAOBAO_DRAMA_COLLECTION_CREATE_URL; },
  });
  await waitForTaobaoPage(page, "collection", {});
  assert.equal(state.navigations.length, 1);
});

test("does not treat a persistent ERR_ABORTED as success or retry forever", async (t) => {
  const { page, state } = navigationPage(t, {
    onGoto() { throw new Error("page.goto: net::ERR_ABORTED"); },
  });
  await assert.rejects(waitForTaobaoPage(page, "collection", {}), /PAGE_REDIRECT_LIMIT/);
  assert.equal(state.navigations.length, 2);
  assert.ok(state.navigations[1]!.at >= TAOBAO_DRAMA_NAVIGATION_SETTLE_MS);
  assert.equal(state.reloads, 0);
});

test("stops repeated redirects to a different creator page", async (t) => {
  const { page, state } = navigationPage(t, {
    onGoto(state) { state.url = TAOBAO_DRAMA_HOME_URL; },
  });
  await assert.rejects(waitForTaobaoPage(page, "collection", {}), /PAGE_REDIRECT_LIMIT/);
  assert.equal(state.navigations.length, 2);
  assert.ok(state.navigations[1]!.at >= TAOBAO_DRAMA_NAVIGATION_SETTLE_MS);
});

test("missing controls produce a timeout without periodic reloads", async (t) => {
  const { page, state } = navigationPage(t, { url: TAOBAO_DRAMA_COLLECTION_CREATE_URL, ready: false });
  await assert.rejects(waitForTaobaoPage(page, "collection", {}), /PAGE_READY_TIMEOUT/);
  assert.ok(state.waits * 1_000 >= TAOBAO_DRAMA_PAGE_READY_TIMEOUT_MS);
  assert.equal(state.navigations.length, 0);
  assert.equal(state.reloads, 0);
});

test("a subsequent batch explicitly clears the previous queue in the same tab", async (t) => {
  const { page, state } = navigationPage(t, {
    url: "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish",
  });
  await waitForTaobaoPage(page, "batch", {}, { fresh: true });
  assert.equal(state.navigations.length, 1);
  assert.equal(state.reloads, 0);
});

test("manual login may exceed the readiness timeout without navigation", async (t) => {
  const { page, state } = navigationPage(t, {
    url: "https://login.taobao.com/", text: "手机扫码登录",
    onWait(state) {
      if (state.waits === 120) {
        state.url = TAOBAO_DRAMA_COLLECTION_CREATE_URL;
        state.text = "合集类型 短剧类型";
      }
    },
  });
  await waitForTaobaoPage(page, "collection", {});
  assert.equal(state.waits, 120);
  assert.equal(state.navigations.length, 0);
  assert.equal(state.reloads, 0);
});

test("manual verification is notified once and is never refreshed", async (t) => {
  let notifications = 0;
  const { page, state } = navigationPage(t, {
    url: TAOBAO_DRAMA_COLLECTION_CREATE_URL, text: "请完成安全验证",
    onWait(state) { if (state.waits === 100) state.text = "合集类型 短剧类型"; },
  });
  await waitForTaobaoPage(page, "collection", { onHumanVerificationRequired() { notifications += 1; } });
  assert.equal(notifications, 1);
  assert.equal(state.navigations.length, 0);
  assert.equal(state.reloads, 0);
});

test("propagates network errors other than interrupted navigation", async (t) => {
  const { page, state } = navigationPage(t, {
    onGoto() { throw new Error("net::ERR_NAME_NOT_RESOLVED"); },
  });
  await assert.rejects(waitForTaobaoPage(page, "collection", {}), /ERR_NAME_NOT_RESOLVED/);
  assert.equal(state.navigations.length, 1);
});

test("closing a page during navigation stops the wait", async (t) => {
  const { page } = navigationPage(t, {
    onGoto(state) { state.closed = true; throw new Error("net::ERR_ABORTED"); },
  });
  await assert.rejects(waitForTaobaoPage(page, "collection", {}), /BROWSER_PAGE_CLOSED/);
});

test("task pages exclude the homepage and unrelated retained failure tabs", async () => {
  const task = { isClosed: () => false } as Page;
  const unrelated = { isClosed: () => false, opener: async () => null } as unknown as Page;
  const popup = { isClosed: () => false, opener: async () => task } as unknown as Page;
  const closed = { isClosed: () => true } as Page;
  Object.assign(task, { context: () => ({ pages: () => [unrelated, task, popup, closed] }) });
  assert.deepEqual(await taobaoTaskPages(task), [task, popup]);
});
