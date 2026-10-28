import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  taobaoEpisodeBatchPagePlan,
  taobaoEpisodeBatchRanges,
} from "../../src/shared/constants.js";

import {
  advanceTaobaoDropdownSearchState,
  isTaobaoDetachedFrameError,
  isTaobaoUploadReady,
  isTaobaoVerificationChallenge,
  isTaobaoVideoInputCandidate,
  publishSucceeded,
  normalizeTaobaoDropdownText,
  taobaoDropdownOptionIndex,
  scoreTaobaoContentTagMatch,
  summarizeTaobaoBatchItems,
  summarizeTaobaoUploadText,
  taobaoFatalUploadDialogReason,
  TAOBAO_DROPDOWN_END_SETTLE_MS,
  TAOBAO_DROPDOWN_SEARCH_TIMEOUT_MS,
  TAOBAO_MAX_FILES_PER_SELECTION,
  TAOBAO_PUBLISH_PRECLICK_MAX_MS,
  TAOBAO_PUBLISH_PRECLICK_MIN_MS,
} from "../../src/automation/episodes.js";

test("selects the complete Taobao task in one upload operation", () => {
  assert.equal(TAOBAO_MAX_FILES_PER_SELECTION, 100);
});

test("splits a Taobao task over 100 episodes into 100-episode publish batches", () => {
  assert.deepEqual(taobaoEpisodeBatchRanges(235), [
    { start: 1, end: 100 },
    { start: 101, end: 200 },
    { start: 201, end: 235 },
  ]);
});

test("uses one tab for up to 100 episodes", () => {
  assert.deepEqual(taobaoEpisodeBatchPagePlan(100), [{
    start: 1,
    end: 100,
    navigateToBatchPage: false,
  }]);
});

test("reuses the same task tab for episodes after 100", () => {
  assert.deepEqual(taobaoEpisodeBatchPagePlan(101), [
    {
      start: 1,
      end: 100,
      navigateToBatchPage: false,
    },
    {
      start: 101,
      end: 101,
      navigateToBatchPage: true,
    },
  ]);
});

test("an unrelated workspace or old success message cannot complete the current task", async () => {
  const before = "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish";
  const task = { isClosed: () => false, url: () => before, frames: () => [] } as unknown as Page;
  const home = {
    isClosed: () => false, opener: async () => null,
    url: () => "https://creator.guanghe.taobao.com/page/workspace/tb",
    frames: () => { throw new Error("must not inspect unrelated page controls"); },
  } as unknown as Page;
  Object.assign(task, { context: () => ({ pages: () => [home, task] }) });
  assert.equal(await publishSucceeded(task, before), false);
});

test("the current task's own workspace redirect is a publish success", async () => {
  const task = {
    isClosed: () => false,
    url: () => "https://creator.guanghe.taobao.com/page/workspace/tb",
  } as unknown as Page;
  Object.assign(task, { context: () => ({ pages: () => [task] }) });
  assert.equal(await publishSucceeded(task, "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish"), true);
});

test("never treats a partial 20-item Taobao queue as a complete larger task", () => {
  assert.equal(isTaobaoUploadReady({
    uploadEvidence: true,
    pending: false,
    buttonReady: true,
    matchedFileCount: 20,
    expectedFileCount: 78,
  }), false);
  assert.equal(isTaobaoUploadReady({
    uploadEvidence: true,
    pending: false,
    buttonReady: true,
    matchedFileCount: 78,
    expectedFileCount: 78,
  }), true);
});

test("paces the final Taobao publish action more slowly than normal form actions", () => {
  assert.equal(TAOBAO_PUBLISH_PRECLICK_MIN_MS, 3_000);
  assert.equal(TAOBAO_PUBLISH_PRECLICK_MAX_MS, 4_500);
});

test("recognizes Taobao batch items whose status is already uploaded", () => {
  assert.deepEqual(
    summarizeTaobaoBatchItems([
      { title: "烟火里的圆满 - 第1集.mp4", status: "已上传" },
      { title: "烟火里的圆满 - 第2集.mp4", status: "已上传" },
    ], [
      "D:\\episodes\\烟火里的圆满 - 第1集.mp4",
      "D:\\episodes\\烟火里的圆满 - 第2集.mp4",
    ]),
    {
      matchedFileCount: 2,
      completedFileCount: 2,
      terminalFileCount: 2,
      failedFileNames: [],
      failed: false,
      settled: true,
      complete: true,
    },
  );
});

test("waits for every Taobao item to settle before handling failed uploads", () => {
  assert.deepEqual(
    summarizeTaobaoBatchItems([
      { title: "测试剧 - 第1集.mp4", status: "上传失败" },
      { title: "测试剧 - 第2集.mp4", status: "上传中" },
      { title: "测试剧 - 第3集.mp4", status: "已上传" },
    ], [
      "D:\\episodes\\测试剧 - 第1集.mp4",
      "D:\\episodes\\测试剧 - 第2集.mp4",
      "D:\\episodes\\测试剧 - 第3集.mp4",
    ]),
    {
      matchedFileCount: 3,
      completedFileCount: 1,
      terminalFileCount: 2,
      failedFileNames: ["测试剧 - 第1集.mp4"],
      failed: true,
      settled: false,
      complete: false,
    },
  );

  assert.equal(summarizeTaobaoBatchItems([
    { title: "测试剧 - 第1集.mp4", status: "上传失败" },
    { title: "测试剧 - 第2集.mp4", status: "上传成功" },
    { title: "测试剧 - 第3集.mp4", status: "已上传" },
  ], [
    "D:\\episodes\\测试剧 - 第1集.mp4",
    "D:\\episodes\\测试剧 - 第2集.mp4",
    "D:\\episodes\\测试剧 - 第3集.mp4",
  ]).settled, true);
});

test("extracts the rejection reason from Taobao upload failure dialogs", () => {
  assert.match(
    taobaoFatalUploadDialogReason([
      "上传失败 上传视频的宽高是720x1280不符合要求，视频宽高均要大于1080 我知道了",
    ]) ?? "",
    /720x1280/,
  );
  assert.equal(taobaoFatalUploadDialogReason(["正在上传 42%"]), undefined);
});

test("matches Taobao content tags case-insensitively with an approximate fallback", () => {
  assert.equal(scoreTaobaoContentTagMatch("# ai 短剧", "AI短剧"), 1);
  assert.ok(scoreTaobaoContentTagMatch("# 都市情感AI仿真人短剧", "都市") >= 0.45);
  assert.ok(scoreTaobaoContentTagMatch("# AI仿真人短剧", "AI短剧") >= 0.45);
  assert.ok(scoreTaobaoContentTagMatch("# 农村美食", "AI短剧") < 0.45);
});

test("recognizes detached Taobao upload frames for safe reacquisition", () => {
  assert.equal(isTaobaoDetachedFrameError(new Error("locator.waitFor: Frame was detached")), true);
  assert.equal(isTaobaoDetachedFrameError(new Error("frame has been detached")), true);
  assert.equal(isTaobaoDetachedFrameError(new Error("Execution context was destroyed")), true);
  assert.equal(isTaobaoDetachedFrameError(new Error("locator.waitFor: Timeout 30000ms exceeded")), false);
});

test("resumes after Taobao reports that a persistent captcha widget passed", () => {
  assert.equal(isTaobaoVerificationChallenge({
    visibleControlCount: 1,
    text: "验证通过",
  }), false);
  assert.equal(isTaobaoVerificationChallenge({
    visibleControlCount: 1,
    text: "请按住滑块，拖动到最右边 验证通过后继续",
  }), true);
  assert.equal(isTaobaoVerificationChallenge({
    visibleControlCount: 1,
    activeControlCount: 0,
    text: "",
  }), false);
  assert.equal(isTaobaoVerificationChallenge({
    visibleControlCount: 1,
    activeControlCount: 1,
    text: "",
  }), true);
  assert.equal(isTaobaoVerificationChallenge({
    visibleControlCount: 1,
    activeControlCount: 1,
    text: "请按住滑块，拖动到最右边 验证通过后继续 验证通过",
  }), false);
});

test("normalizes collection option whitespace before matching", () => {
  assert.equal(
    normalizeTaobaoDropdownText("   十八年归零，离婚后我靠辣酱翻身 "),
    "十八年归零，离婚后我靠辣酱翻身",
  );
  assert.equal(normalizeTaobaoDropdownText("第 12 集"), "第12集");
});

test("waits for a stable true end while a virtual collection list loads more options", () => {
  let state = advanceTaobaoDropdownSearchState({}, {
    atEnd: true,
    moved: false,
    loading: false,
    signature: "1000:300:合集1",
  }, 1_000, 2_000);
  assert.equal(state.shouldStop, false);

  state = advanceTaobaoDropdownSearchState(state.state, {
    atEnd: true,
    moved: false,
    loading: true,
    signature: "1000:300:合集1",
  }, 2_000, 2_000);
  assert.equal(state.shouldStop, false);

  state = advanceTaobaoDropdownSearchState(state.state, {
    atEnd: false,
    moved: true,
    loading: false,
    signature: "1800:300:合集8\u0001合集9",
  }, 3_000, 2_000);
  assert.equal(state.shouldStop, false);
  assert.equal(state.state.stableAtEndSince, undefined);

  state = advanceTaobaoDropdownSearchState(state.state, {
    atEnd: true,
    moved: false,
    loading: false,
    signature: "1800:300:合集8\u0001合集9",
  }, 4_000, 2_000);
  assert.equal(state.shouldStop, false);

  state = advanceTaobaoDropdownSearchState(state.state, {
    atEnd: true,
    moved: false,
    loading: false,
    signature: "1800:300:合集8\u0001合集9",
  }, 6_000, 2_000);
  assert.equal(state.shouldStop, true);
});

test("finds a collection from one batch of dropdown option texts", () => {
  assert.equal(taobaoDropdownOptionIndex([
    "合集一",
    " 你不就是带个孩子吗 ",
    "合集三",
  ], "你不就是带个孩子吗"), 1);
  assert.equal(taobaoDropdownOptionIndex(["合集一", "合集二"], "目标合集"), -1);
});

test("gives collection virtual scrolling enough time without waiting forever", () => {
  assert.equal(TAOBAO_DROPDOWN_END_SETTLE_MS, 12_000);
  assert.equal(TAOBAO_DROPDOWN_SEARCH_TIMEOUT_MS, 120_000);
});

test("summarizes Taobao upload progress from visible page text", () => {
  assert.deepEqual(
    summarizeTaobaoUploadText("第1集.mp4 正在上传 42% 第2集.mp4 排队中", [
      "D:\\episodes\\第1集.mp4",
      "D:\\episodes\\第2集.mp4",
    ]),
    { matchedFileCount: 2, completedFileCount: 0, pending: true, failed: false, complete: false, progressText: "42%" },
  );
  assert.deepEqual(
    summarizeTaobaoUploadText("第1集.mp4 上传完成 第2集.mp4 上传完成 100%", [
      "D:\\episodes\\第1集.mp4",
      "D:\\episodes\\第2集.mp4",
    ]),
    { matchedFileCount: 2, completedFileCount: 2, pending: false, failed: false, complete: true, progressText: "100%" },
  );
  assert.equal(summarizeTaobaoUploadText("10 / 10", []).complete, true);
  assert.equal(summarizeTaobaoUploadText("上传失败，请重新上传", []).failed, true);
  assert.equal(summarizeTaobaoUploadText(
    "第1集.mp4 100% 第2集.mp4 等待上传",
    ["第1集.mp4", "第2集.mp4"],
  ).complete, false);
  assert.equal(summarizeTaobaoUploadText(
    "第1集.mp4 上传完成 第2集.mp4 等待上传 总进度 1 / 1",
    ["第1集.mp4", "第2集.mp4"],
  ).complete, false);
  assert.equal(summarizeTaobaoUploadText(
    "第1集.mp4 上传完成 第2集.mp4 转码失败",
    ["第1集.mp4", "第2集.mp4"],
  ).failed, true);
});

test("distinguishes the episode video input from the collection image uploader", () => {
  assert.equal(isTaobaoVideoInputCandidate({
    accept: "image/jpeg,image/png",
    multiple: true,
    nearby: "上传封面图片",
  }), false);
  assert.equal(isTaobaoVideoInputCandidate({
    accept: "video/mp4",
    multiple: true,
    nearby: "选择文件",
  }), true);
  assert.equal(isTaobaoVideoInputCandidate({
    accept: "",
    multiple: true,
    nearby: "批量上传剧集",
  }), true);
});
