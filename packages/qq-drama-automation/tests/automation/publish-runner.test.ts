import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserContext, Page } from "playwright";
import type { ClaimedQqDramaTask } from "../../src/shared/types.js";

import { isQqFinishUploadTimeout, runQqDramaPublishTask, qqDramaAddPageRecoveryAction } from "../../src/automation/publish-runner.js";

test("recovers a stale QQ submission success page before the next task", () => {
  assert.equal(
    qqDramaAddPageRecoveryAction(
      "QQ漫剧创作者平台 漫剧提交成功 剧目已提交审核 剧目 ID：725961270905540608 继续添加 返回漫剧列表",
    ),
    "continue-adding",
  );
});

test("does not treat the normal add form as a stale success page", () => {
  assert.equal(
    qqDramaAddPageRecoveryAction("上传短剧 作品名称 审核通过后不支持修改 下一步"),
    undefined,
  );
});

test("requires the continue action before attempting success-page recovery", () => {
  assert.equal(
    qqDramaAddPageRecoveryAction("漫剧提交成功 剧目已提交审核 返回漫剧列表"),
    undefined,
  );
});

const finishUploadTimeout = new Error(
  'QQ_DRAMA_PAGE_MESSAGE: finish upload failed, caused by finishupload request: '
    + 'type:framework, code:102, msg:http client transport RoundTrip timeout: '
    + 'Post "http://11.142.10.239:80/finishupload": context deadline exceeded',
);

test("recognizes finishupload timeouts without retrying unrelated page errors", () => {
  assert.equal(isQqFinishUploadTimeout(finishUploadTimeout), true);
  assert.equal(isQqFinishUploadTimeout(new Error("QQ_DRAMA_PAGE_MESSAGE: 上传格式不支持")), false);
  assert.equal(isQqFinishUploadTimeout(new Error("QQ_DRAMA_PAGE_MESSAGE: finishupload: invalid file")), false);
  assert.equal(isQqFinishUploadTimeout(new Error("QQ_DRAMA_PAGE_MESSAGE: login timeout")), false);
  assert.equal(isQqFinishUploadTimeout(new Error("Timeout waiting for page")), false);
});

// Fail when the basic-info step first reads the payload, after message capture is installed.
function failingTaskFixture(errors: Error[]) {
  const events: string[] = [];
  let attempts = 0;
  const locator = {
    filter: () => locator,
    first: () => locator,
    count: async () => 1,
  };
  const page = {
    goto: async () => { events.push("open"); },
    reload: async () => { events.push("reload"); },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => "https://aishortdrama.qq.com/",
    locator: () => locator,
    evaluate: async () => { events.push("capture"); },
    addLocatorHandler: async () => { events.push("install"); },
    removeLocatorHandler: async () => { events.push("remove"); },
  } as unknown as Page;
  const context = {
    cookies: async () => [
      { name: "access_token", value: "test" },
      { name: "csrf_token", value: "test" },
    ],
  } as unknown as BrowserContext;
  const task = {
    accountTaskId: 1,
    get playlet() {
      events.push("basic-info");
      throw errors[attempts++] ?? new Error("unexpected extra attempt");
    },
  } as unknown as ClaimedQqDramaTask;
  return { page, context, task, events };
}

test("refreshes once, cleans up handlers, and restarts from basic info", async () => {
  const secondError = new Error("QQ_DRAMA_PAGE_MESSAGE: 第二次失败");
  const fixture = failingTaskFixture([finishUploadTimeout, secondError]);
  await assert.rejects(
    runQqDramaPublishTask(fixture.page, fixture.context, fixture.task, {}),
    (error) => error === secondError,
  );
  assert.deepEqual(fixture.events, [
    "open", "capture", "install", "basic-info", "remove", "reload",
    "open", "capture", "install", "basic-info", "remove",
  ]);
});

test("stops after the second finishupload timeout", async () => {
  const fixture = failingTaskFixture([finishUploadTimeout, finishUploadTimeout]);
  await assert.rejects(
    runQqDramaPublishTask(fixture.page, fixture.context, fixture.task, {}),
    (error) => error === finishUploadTimeout,
  );
  assert.equal(fixture.events.filter((event) => event === "reload").length, 1);
  assert.equal(fixture.events.filter((event) => event === "basic-info").length, 2);
});

test("does not refresh for unrelated errors", async () => {
  const error = new Error("QQ_DRAMA_PAGE_MESSAGE: 上传格式不支持");
  const fixture = failingTaskFixture([error]);
  await assert.rejects(
    runQqDramaPublishTask(fixture.page, fixture.context, fixture.task, {}),
    (actual) => actual === error,
  );
  assert.equal(fixture.events.includes("reload"), false);
  assert.equal(fixture.events.at(-1), "remove");
});
