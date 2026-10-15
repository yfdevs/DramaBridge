import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";

import {
  qqDramaAuthCookieState,
  qqDramaAuthCookiesReady,
  waitForLoginIfNeeded,
} from "../../src/automation/browser-session.js";
import { QQ_DRAMA_ADD_URL, QQ_DRAMA_LOGIN_URL } from "../../src/shared/constants.js";

type SessionState = {
  refreshed: boolean;
  manuallyLoggedIn: boolean;
  url: string;
  reloads: number;
  loginNavigations: number;
};

function authCookies(ready: boolean, includeRefresh = true) {
  return [
    ...(ready
      ? [
          { name: "access_token", value: "access", domain: "aishortdrama.qq.com" },
          { name: "csrf_token", value: "csrf", domain: "aishortdrama.qq.com" },
        ]
      : []),
    ...(includeRefresh
      ? [{ name: "refresh_token", value: "refresh", domain: "aishortdrama.qq.com" }]
      : []),
  ];
}

function session(initiallyReady: boolean, refreshSucceeds: boolean) {
  const state: SessionState = {
    refreshed: false,
    manuallyLoggedIn: false,
    url: QQ_DRAMA_ADD_URL,
    reloads: 0,
    loginNavigations: 0,
  };
  const ready = () => initiallyReady || (refreshSucceeds && state.refreshed) || state.manuallyLoggedIn;
  const context = {
    cookies: async (urls?: string | string[]) => urls
      ? authCookies(ready()).filter((cookie) => cookie.name !== "refresh_token")
      : authCookies(ready()),
    storageState: async () => ({ cookies: [], origins: [] }),
  } as unknown as BrowserContext;
  const page = {
    url: () => state.url,
    reload: async () => {
      state.reloads += 1;
      state.refreshed = true;
    },
    bringToFront: async () => undefined,
    goto: async (url: string) => {
      state.url = url;
      if (url === QQ_DRAMA_LOGIN_URL) state.loginNavigations += 1;
    },
    waitForURL: async () => {
      state.manuallyLoggedIn = true;
      state.url = QQ_DRAMA_ADD_URL;
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  return { context, page, state };
}

test("recognizes a complete QQ auth cookie set", async () => {
  const { context } = session(true, false);
  const state = await qqDramaAuthCookieState(context);
  assert.deepEqual(state, { accessToken: true, csrfToken: true, refreshToken: true });
  assert.equal(qqDramaAuthCookiesReady(state), true);
});

test("refreshes an expired QQ session before allowing task polling", async () => {
  const current = session(false, true);
  assert.equal(await waitForLoginIfNeeded(current.page, current.context, {}), false);
  assert.equal(current.state.reloads, 1);
  assert.equal(current.state.loginNavigations, 0);
  assert.equal(qqDramaAuthCookiesReady(await qqDramaAuthCookieState(current.context)), true);
});

test("falls back to manual login when QQ cannot refresh its cookies", async () => {
  const current = session(false, false);
  assert.equal(await waitForLoginIfNeeded(current.page, current.context, {}), true);
  assert.equal(current.state.reloads, 1);
  assert.equal(current.state.loginNavigations, 1);
  assert.equal(qqDramaAuthCookiesReady(await qqDramaAuthCookieState(current.context)), true);
});
