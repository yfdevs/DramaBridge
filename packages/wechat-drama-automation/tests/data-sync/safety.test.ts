import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import type { BrowserContext } from "playwright";
import { DarenCenterClient } from "../../src/data-sync/client.js";
import { createWechatDataImportClient } from "../../src/data-sync/import-client.js";
import { createWechatDataSyncRuntime } from "../../src/data-sync/runtime.js";
import { resolveDataSyncBrowserExecutable } from "../../src/data-sync/browser.js";
import { assertCompleteStatistics } from "../../src/data-sync/validation.js";

test("dry run performs zero backend calls for all three workflows", async () => {
  let calls = 0;
  const backend = new DarenCenterClient(
    {
      baseUrl: "https://must-not-contact.invalid",
      username: "unused",
      password: "unused",
      timeoutMs: 10,
    },
    {
      fetch: async () => {
        calls++;
        throw new Error("Backend must not be called");
      },
    },
  );
  const client = createWechatDataImportClient(backend, true);
  assert.equal(await client.getSourceId("测试来源"), 0);
  const excel = await client.importCopyrightData({ file: new Blob(["excel"]), sourceId: 0 });
  const csv = await client.importDramaHeatingActions({ file: new Blob(["csv"]) });
  const json = await client.ingestWeChatDramaStatistics({
    list: [],
    totalCount: 0,
    statisticTime: "2026-11-16",
    wechatVideoAccountName: "测试",
  });
  for (const result of [excel, csv, json]) assert.equal(result.statusText, "DRY_RUN");
  assert.equal(calls, 0);
  assert.equal(backend.authenticated, false);
  assert.equal(createWechatDataImportClient(backend, false), backend);
});

test("custom date validation rejects missing, impossible, reversed and future dates before saving", () => {
  let saves = 0;
  const runtime = createWechatDataSyncRuntime({
    userDataDirectory: "test",
    profileRoot: "test",
    browsersPath: "test",
    dryRun: true,
    client: {} as DarenCenterClient,
    getSettings: () => ({}),
    saveSettings: () => {
      saves++;
    },
    logger: console,
  });
  for (const range of [
    undefined,
    { startDate: "2026-02-30", endDate: "2026-03-01" },
    { startDate: "2026-11-16", endDate: "2026-11-15" },
    { startDate: "2099-01-01", endDate: "2099-01-02" },
  ]) {
    assert.throws(
      () =>
        runtime.saveSettings({ assistantDatePreset: "custom", assistantCustomDateRange: range }),
      /自定义日期/,
    );
  }
  assert.equal(saves, 0);
  runtime.saveSettings({
    assistantDatePreset: "custom",
    assistantCustomDateRange: { startDate: "2024-02-29", endDate: "2024-03-01" },
  });
  assert.equal(saves, 1);
});

test("browser resolver uses the shared pinned binary even after Playwright has loaded", () => {
  const root = path.resolve(import.meta.dirname, "../../../../.cache/playwright-browsers");
  assert.ok(resolveDataSyncBrowserExecutable(root).startsWith(root));
  assert.throws(
    () => resolveDataSyncBrowserExecutable(path.join(root, "missing")),
    /找不到数据同步/,
  );
});

test("assistant tasks share one lock and stopping during browser launch closes the late context", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wechat-sync-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release!: (context: BrowserContext) => void;
  let launched!: () => void;
  const launching = new Promise<void>((resolve) => {
    launched = resolve;
  });
  let closed = 0;
  const runtime = createWechatDataSyncRuntime({
    userDataDirectory: directory,
    profileRoot: directory,
    browsersPath: directory,
    dryRun: true,
    client: {} as DarenCenterClient,
    getSettings: () => ({}),
    saveSettings: () => {},
    logger: console,
    launchContext: async () => {
      launched();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const events: string[] = [];
  assert.equal(runtime.start({ sendEvent: (e) => events.push(e.type) }, "assistant").started, true);
  assert.equal(runtime.start({ sendEvent: () => {} }, "assistant-json").started, false);
  await launching;
  const stopped = runtime.stop("assistant");
  release({
    close: async () => {
      closed++;
    },
  } as unknown as BrowserContext);
  await stopped;
  assert.equal(closed, 1);
  assert.deepEqual(runtime.runningModes(), []);
  assert.ok(!events.includes("error"));
});

test("failed task browser is retained for inspection and cleaned up on shutdown", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wechat-sync-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let closed = 0;
  let finished!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const context = {
    close: async () => {
      closed++;
    },
    clearCookies: async () => {},
    once: () => {},
    pages: () => [
      {
        context: () => context,
        evaluate: async () => {},
        goto: async () => {
          throw new Error("synthetic navigation failure");
        },
      },
    ],
  };
  const runtime = createWechatDataSyncRuntime({
    userDataDirectory: directory,
    profileRoot: directory,
    browsersPath: directory,
    dryRun: true,
    client: {} as DarenCenterClient,
    getSettings: () => ({}),
    saveSettings: () => {},
    logger: console,
    launchContext: async () => context as unknown as BrowserContext,
  });
  runtime.start(
    {
      sendEvent: (e) => {
        if (e.type === "stopped") finished();
      },
    },
    "assistant",
  );
  await stopped;
  assert.equal(closed, 0);
  await runtime.stop();
  assert.equal(closed, 1);
});

test("concurrent unauthorized requests share one token refresh", async () => {
  let logins = 0;
  const backend = new DarenCenterClient(
    {
      baseUrl: "https://fixture.invalid",
      username: "fixture",
      password: "fixture",
      timeoutMs: 1000,
    },
    {
      fetch: async (url, options) => {
        if (String(url).includes("/auth/login")) {
          logins++;
          return Response.json({
            data: { tokenValue: logins === 1 ? "old" : "new", tokenName: "Authorization" },
          });
        }
        const token = new Headers(options?.headers).get("Authorization");
        return Response.json(
          { data: { ok: token === "new" } },
          { status: token === "new" ? 200 : 401 },
        );
      },
    },
  );
  await backend.login();
  const results = await Promise.all(Array.from({ length: 20 }, () => backend.getCurrentUser()));
  assert.equal(results.length, 20);
  assert.equal(logins, 2);
});

test("cancelled backend request releases the caller without retrying a write", async () => {
  let writes = 0;
  const controller = new AbortController();
  const backend = new DarenCenterClient(
    {
      baseUrl: "https://fixture.invalid",
      username: "fixture",
      password: "fixture",
      timeoutMs: 1000,
    },
    {
      fetch: async (url, options) => {
        if (String(url).includes("/auth/login"))
          return Response.json({ data: { tokenValue: "token" } });
        writes++;
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
          controller.abort();
        });
      },
    },
  );
  await assert.rejects(
    backend.importCopyrightData({
      file: new Blob(["fixture"]),
      sourceId: 1,
      signal: controller.signal,
    }),
    /cancelled/,
  );
  assert.equal(writes, 1);
});

test("changed totals and truncated or duplicated responses fail completeness validation", () => {
  assert.doesNotThrow(() => assertCompleteStatistics(292, 292, 292));
  assert.doesNotThrow(() => assertCompleteStatistics(0, 0, 0));
  for (const counts of [
    [292, 292, 300],
    [291, 292, 291],
    [293, 292, 292],
    [1, -1, 1],
  ]) {
    assert.throws(() => assertCompleteStatistics(counts[0], counts[1], counts[2]), /不完整/);
  }
});

test("HTTP 200 HTML or empty responses cannot be reported as successful imports", async () => {
  for (const text of [
    "<html>gateway error</html>",
    "",
    JSON.stringify({ message: "failure" }),
    JSON.stringify({ data: null, message: "failed" }),
  ]) {
    let calls = 0;
    const backend = new DarenCenterClient(
      {
        baseUrl: "https://fixture.invalid",
        username: "fixture",
        password: "fixture",
        timeoutMs: 1000,
      },
      {
        fetch: async () => {
          calls++;
          return new Response(text);
        },
      },
    );
    await assert.rejects(
      backend.ingestWeChatDramaStatistics({
        list: [],
        totalCount: 0,
        statisticTime: "2026-11-16",
        wechatVideoAccountName: "fixture",
      }),
      /无法确认/,
    );
    assert.equal(calls, 1, "writes must not be retried after an ambiguous response");
  }
});
