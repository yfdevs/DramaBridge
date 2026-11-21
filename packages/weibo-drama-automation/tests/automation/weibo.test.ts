import assert from "node:assert/strict";
import test from "node:test";
import {
  isWeiboLoginPopup,
  prepareWeiboMainPage,
  resolveWeiboPublishAccount,
  requireWeiboPublishAccount,
  waitForLoginIfNeeded,
  weiboSessionReady,
} from "../../src/automation/browser-session.js";
import { classifyWeiboUploadError } from "../../src/automation/episode-upload.js";
import { claimedWeiboDramaTaskSchema } from "../../src/shared/types.js";
import { claimNextWeiboDramaTaskApi, reportWeiboDramaTaskSuccessApi } from "../../src/api/task.js";
import type { BrowserContext, Page } from "playwright";
import { waitForWeiboAction } from "../../src/automation/action-result.js";
import { fetchWeiboDramaAccounts } from "../../src/api/account-config.js";
import { withWeiboProgress } from "../../src/shared/progress.js";

test("long preparation emits a heartbeat and stops emitting when it finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entries: string[] = [];
  let finish!: () => void;
  const pending = withWeiboProgress(
    { onLog: (message) => entries.push(message) },
    "准备视频",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  t.mock.timers.tick(15_000);
  assert.ok(entries.some((message) => message.includes("仍在执行")));
  finish();
  await pending;
  const count = entries.length;
  t.mock.timers.tick(30_000);
  assert.equal(entries.length, count);
  assert.ok(entries.some((message) => message.includes("准备视频：完成")));
});

test("reuses the browser startup blank and closes only additional startup blanks", async () => {
  const closed: string[] = [];
  const page = (name: string, url: string) => ({
    isClosed: () => false,
    url: () => url,
    close: async () => {
      closed.push(name);
    },
  });
  const blank = page("main", "about:blank");
  const context = {
    pages: () => [
      blank,
      page("extra", "about:blank"),
      page("failed-task", "https://duanju.mcn.weibo.com/content/series/next?album_id=1"),
    ],
    newPage: async () => {
      throw new Error("unnecessary new tab");
    },
  } as unknown as BrowserContext;
  assert.equal(await prepareWeiboMainPage(context), blank);
  assert.deepEqual(closed, ["extra"]);
});

test("creates one main page when no startup blank exists, preserving restored pages", async () => {
  const main = {} as Page;
  let created = 0;
  const context = {
    pages: () => [],
    newPage: async () => {
      created++;
      return main;
    },
  } as unknown as BrowserContext;
  assert.equal(await prepareWeiboMainPage(context), main);
  assert.equal(created, 1);
});

test("Swagger permits an account without a display name; retain its UID as the label", async () => {
  const accounts = await fetchWeiboDramaAccounts(
    "http://backend",
    async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: "操作成功",
          data: {
            total: 2,
            data: [
              {
                id: 1,
                accountId: "uid-1",
                accountName: null,
                rpaProfileKey: "profile-1",
                status: "ON",
              },
              { id: 2, accountId: "uid-2", status: "OFF" },
            ],
          },
        }),
      ),
  );
  assert.deepEqual(
    accounts.map((account) => [account.accountId, account.accountName, account.rpaProfileKey]),
    [["uid-1", "uid-1", "profile-1"]],
  );
});

test("writes the verified Weibo collection ID and claim metadata to the documented report DTO", async () => {
  let actual: unknown;
  await reportWeiboDramaTaskSuccessApi({
    accountTaskId: 3,
    workerId: "worker",
    attemptCount: 2,
    externalId: "24121",
    platformDramaId: "24121",
    resultJson: { albumId: "24121" },
    client: {
      post: async <T>(path: string, body: unknown) => {
        assert.equal(path, "/dramaAiRpa/weibo/rpa/report");
        actual = JSON.parse(JSON.stringify(body));
        return { code: 0, data: true } as T;
      },
    },
  });
  assert.deepEqual(actual, {
    taskId: 3,
    success: true,
    workerId: "worker",
    attemptCount: 2,
    externalId: "24121",
    platformDramaId: "24121",
    resultJson: { albumId: "24121" },
  });
});

test("reports the actual invalid field instead of waiting for a missing submit request", async () => {
  const page = {
    locator: () => ({
      allInnerTexts: async () => [" 视频类型 *（请选择）", "内容声明 *（请选择）"],
    }),
  } as unknown as Page;
  await assert.rejects(
    waitForWeiboAction(page, async () => undefined, new Promise(() => undefined)),
    /视频类型.*内容声明/,
  );
});

const playlet = {
  title: "示例剧",
  summary: "示例简介",
  episodeCount: 59,
  collectionCategory: "AI动漫类",
  audienceType: "男频",
  subjectTypes: ["都市"],
  eraBackground: "现代",
  plotThemes: ["逆袭"],
  roleSettings: ["大男主"],
};

test("a backend login phone number resolves by unique publishing name without waiting for login again", async () => {
  const account = { uid: "8303299256", name: "甜心漫剧" };
  const page = {
    evaluate: async () => ({ authenticated: true, accounts: [account] }),
  } as unknown as Page;
  assert.deepEqual(resolveWeiboPublishAccount([account], "17732354154", "甜心漫剧"), account);
  assert.deepEqual(
    await requireWeiboPublishAccount(page, {
      weiboAccountId: "17732354154",
      weiboAccountName: "甜心漫剧",
    }),
    account,
  );
  // No context is accessed: the already authenticated page must return immediately.
  assert.equal(
    await waitForLoginIfNeeded(page, {} as never, {
      weiboAccountId: "17732354154",
      weiboAccountName: "甜心漫剧",
    }),
    false,
  );
});

test("publishing identity never falls back to a different or ambiguous account", async () => {
  const accounts = [
    { uid: "uid-1", name: "同名" },
    { uid: "uid-2", name: "同名" },
  ];
  assert.equal(resolveWeiboPublishAccount(accounts, "phone", "同名"), undefined);
  assert.equal(resolveWeiboPublishAccount(accounts, "phone", "其他账号"), undefined);
  assert.equal(resolveWeiboPublishAccount(accounts, "uid-2", "同名")?.uid, "uid-2");
  const page = { evaluate: async () => ({ authenticated: true, accounts }) } as unknown as Page;
  await assert.rejects(
    waitForLoginIfNeeded(page, {} as never, { weiboAccountId: "phone", weiboAccountName: "同名" }),
    /ACCOUNT_MISMATCH/,
  );
});

test("recognizes only the independent Weibo passport popup", () => {
  assert.equal(isWeiboLoginPopup("https://passport.weibo.com/sso/signin?disp=popup"), true);
  assert.equal(isWeiboLoginPopup("https://duanju.mcn.weibo.com/content/series/publish"), false);
  assert.equal(isWeiboLoginPopup("https://passport.weibo.com.example.com/sso/signin"), false);
});

test("a rendered form or a successful response for another publishing account is not logged in", async () => {
  const originalFetch = globalThis.fetch;
  const page = {
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;
  try {
    for (const [body, expected] of [
      [{ status: 401 }, false],
      [{ status: 0, data: { pub_uids: [] } }, false],
      [{ status: 0, data: { pub_uids: [{ uid: "other" }] } }, false],
      [{ status: 0, data: { pub_uids: [{ uid: "account-1" }] } }, true],
    ] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify(body));
      assert.equal(await weiboSessionReady(page, "account-1"), expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validates real option limits, requires episode five, and does not require QQ contracts", () => {
  const task = { accountTaskId: 1, originalTitle: "原剧", playlet };
  assert.equal(claimedWeiboDramaTaskSchema.safeParse(task).success, true);
  for (const invalid of [
    { episodeCount: 4 },
    { subjectTypes: ["都市", "爱情", "科幻"] },
    { plotThemes: ["未知主题"] },
    { roleSettings: ["大男主", "大男主"] },
  ]) {
    assert.equal(
      claimedWeiboDramaTaskSchema.safeParse({ ...task, playlet: { ...playlet, ...invalid } })
        .success,
      false,
    );
  }
});

test("classifies actual 720p rejection for repair and permanent failures for user action", () => {
  assert.equal(
    classifyWeiboUploadError("视频清晰度不符合要求（当前720p），要求≥1080p"),
    "resolution",
  );
  assert.equal(classifyWeiboUploadError("网络请求超时"), "retry");
  assert.equal(classifyWeiboUploadError("视频编码不支持"), "manual");
});

test("claims only this account's READY tasks and maps the shared backend payload", async () => {
  const requests: Array<{ path: string; payload: unknown }> = [];
  const client = {
    post: async <T>(path: string, payload: unknown): Promise<T> => {
      requests.push({ path, payload });
      if (path.endsWith("/page"))
        return {
          code: 0,
          data: {
            data: [
              { id: 1, accountId: "other", status: "READY" },
              { id: 2, accountId: "account-1", status: "READY", originalTitle: "原剧" },
            ],
          },
        } as T;
      return {
        code: 0,
        data: {
          accountTaskId: 2,
          originalTitle: "原剧",
          accountId: "account-1",
          workerId: "worker-1",
          attemptCount: 4,
          payloadJson: JSON.stringify({
            name: playlet.title,
            summary: playlet.summary,
            episodeCount: 59,
            weiboPlaylet: {
              ...playlet,
              title: undefined,
              summary: undefined,
              episodeCount: undefined,
            },
          }),
        },
      } as T;
    },
  };
  const task = await claimNextWeiboDramaTaskApi({
    client,
    runtimeOptions: { weiboAccountId: "account-1" },
  });
  assert.equal(task?.playlet.title, "示例剧");
  assert.equal(task?.playlet.episodeCount, 59);
  assert.equal(task?.workerId, "worker-1");
  assert.equal(task?.attemptCount, 4);
  assert.deepEqual(
    requests.map((item) => item.path),
    ["/dramaAiRpa/weibo/accountTask/page", "/dramaAiRpa/weibo/rpa/claim"],
  );
  assert.deepEqual(requests[1].payload, { accountTaskId: 2 });
});

test("does not accept a false backend success-report result", async () => {
  await assert.rejects(
    reportWeiboDramaTaskSuccessApi({
      accountTaskId: 1,
      client: { post: async <T>() => ({ code: 0, data: false }) as T },
    }),
    /REPORT_FAILED/,
  );
});

test("a backend business error is reported rather than treated as an empty task queue", async () => {
  await assert.rejects(
    claimNextWeiboDramaTaskApi({
      runtimeOptions: { weiboAccountId: "uid-1" },
      client: { post: async <T>() => ({ code: 500, msg: "系统异常" }) as T },
    }),
    /ACCOUNT_TASK_PAGE_FAILED: code=500 message=系统异常/,
  );
});
