import assert from "node:assert/strict";
import test from "node:test";
import { queryTaobaoCollectionDetail, parseTaobaoCollectionDetail } from "../../src/api/collection-detail.js";
import { applyTaobaoConfirmedSubmissions, createTaobaoCollectionUploadPlan, planTaobaoEpisodeUploadBatches } from "../../src/shared/collection-resume.js";
import { refreshTaobaoCollectionUploadPlan, restoreTaobaoConfirmedSubmissions } from "../../src/automation/collection-progress.js";
import { memoryExecutionStore } from "../helpers/execution-store.js";
import type { TaobaoExecutionRecord, TaobaoSubmitCheckpoint } from "../../src/shared/task-execution.js";

function detailModel(total = 127, existing = Array.from({ length: 100 }, (_, index) => index + 1)) {
  return {
    collectionInfo: { collectionId: 123, title: "补传测试剧", contentCount: existing.length, episodeCount: total, contentIds: existing.map((episode) => episode + 1000) },
    contentCards: existing.map((episode) => ({ baseInfo: { id: episode + 1000, collectionId: 123, title: `第${episode}集|剧情简介` },
      auditInfo: { status: 0 }, contentValidStatus: { contentValidStatus: 0, inValidReason: "内容安全审核中" } })),
  };
}
function contextFor(models: unknown[]) {
  const urls: string[] = [];
  let calls = 0;
  const context = { cookies: async () => [{ name: "_m_h5_tk", value: "live-test-token_1999999999999" }],
    request: { get: async (url: string) => {
      urls.push(url);
      const model = models[Math.min(calls++, models.length - 1)];
      return { ok: () => true, text: async () => `mtopjsonp1(${JSON.stringify({ ret: ["SUCCESS::调用成功"], data: { model } })})` };
    } } };
  return { context: context as never, urls };
}

test("requests detail v2 using the current login token and the real browser's request fields", async () => {
  const { context, urls } = contextFor([detailModel()]);
  const detail = await queryTaobaoCollectionDetail(context, "123");
  const url = new URL(urls[0]!);
  assert.equal(url.pathname, "/h5/mtop.taobao.gcm.collection.detail/2.0/");
  assert.deepEqual(JSON.parse(url.searchParams.get("data")!), { mode: "0", agentType: "", agentId: "", collectionId: "123" });
  assert.equal(detail.collectionInfo.collectionId, "123");
  assert.equal(detail.contentCards.length, 100);
  const plan = createTaobaoCollectionUploadPlan(detail, "补传测试剧", 127);
  assert.deepEqual(plan.missingEpisodeNumbers, Array.from({ length: 27 }, (_, index) => index + 101));
  // Pending/rejected review is still an existing video, never a missing upload.
  assert.equal(plan.uploadedEpisodeNumbers.length, 100);
});

test("empty collections omit contentCards; full collections produce no missing files", () => {
  const empty = detailModel(3, []);
  const parsedEmpty = parseTaobaoCollectionDetail({ model: { collectionInfo: empty.collectionInfo } }, "123");
  assert.deepEqual(createTaobaoCollectionUploadPlan(parsedEmpty, "补传测试剧", 3).missingEpisodeNumbers, [1, 2, 3]);
  const full = parseTaobaoCollectionDetail({ model: detailModel(127, Array.from({ length: 127 }, (_, index) => index + 1)) }, "123");
  assert.deepEqual(createTaobaoCollectionUploadPlan(full, "补传测试剧", 127).missingEpisodeNumbers, []);
});

test("sparse recovery preserves original episode numbers and batches only missing files", () => {
  const existing = Array.from({ length: 127 }, (_, index) => index + 1).filter((episode) => ![2, 51, 127].includes(episode));
  const plan = createTaobaoCollectionUploadPlan(parseTaobaoCollectionDetail({ model: detailModel(127, existing) }, "123"), "补传测试剧", 127);
  const sources = Array.from({ length: 127 }, (_, index) => ({ index: index + 1, file: `episode-${index + 1}.mp4` }));
  const batches = planTaobaoEpisodeUploadBatches(sources, plan.missingEpisodeNumbers);
  assert.deepEqual(batches, [[sources[1], sources[50], sources[126]]]);
  assert.deepEqual(planTaobaoEpisodeUploadBatches(sources, []), []);
  assert.throws(() => planTaobaoEpisodeUploadBatches(sources, [128]), /第 128 集本地文件/);
  assert.throws(() => planTaobaoEpisodeUploadBatches(sources, [2, 2]), /重复/);
  const more = Array.from({ length: 235 }, (_, index) => ({ index: index + 1 }));
  assert.deepEqual(planTaobaoEpisodeUploadBatches(more, more.slice(5).map((episode) => episode.index)).map((batch) =>
    [batch.length, batch[0]!.index, batch[batch.length - 1]!.index]), [[100, 6, 105], [100, 106, 205], [30, 206, 235]]);
});

test("unsafe detail never guesses episode numbers from count, list order, or maximum episode", () => {
  for (const mutate of [
    (model: ReturnType<typeof detailModel>) => { model.contentCards.pop(); },
    (model: ReturnType<typeof detailModel>) => { model.contentCards[0]!.baseInfo.title = "未标集数的预告片"; },
    (model: ReturnType<typeof detailModel>) => { model.contentCards[0]!.baseInfo.title = model.contentCards[1]!.baseInfo.title; },
    (model: ReturnType<typeof detailModel>) => { model.contentCards[0]!.baseInfo.title = "第128集|超过总集数"; },
    (model: ReturnType<typeof detailModel>) => { model.collectionInfo.contentIds[0] = 9999; },
    (model: ReturnType<typeof detailModel>) => { model.contentCards[0]!.baseInfo.collectionId = 999; },
    (model: ReturnType<typeof detailModel>) => { model.collectionInfo.episodeCount = 128; },
    (model: ReturnType<typeof detailModel>) => { model.collectionInfo.contentCount = 127; },
  ]) {
    const model = detailModel(); mutate(model);
    assert.throws(() => createTaobaoCollectionUploadPlan(parseTaobaoCollectionDetail({ model }, "123"), "补传测试剧", 127), /已停止上传/);
  }
  assert.throws(() => parseTaobaoCollectionDetail({ model: detailModel() }, "456"), /合集不一致/);
});

function savedExecution(checkpoints: TaobaoSubmitCheckpoint[]): TaobaoExecutionRecord {
  return { id: "old-task", apiBaseUrl: "http://backend.test", accountId: "tb-1", taskId: 1, workerId: "old-worker", attemptCount: 1,
    phase: "reported", checkpoints, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test("a page-confirmed submission completes without waiting for collection counters", async () => {
  const before = detailModel(3, [1, 2]);
  const plan = createTaobaoCollectionUploadPlan(parseTaobaoCollectionDetail({ model: before }, "123"), "补传测试剧", 3);
  const { context, urls } = contextFor([before]);
  const initial = await refreshTaobaoCollectionUploadPlan(context, plan);
  const after = applyTaobaoConfirmedSubmissions(initial, [3]);
  assert.deepEqual(after.missingEpisodeNumbers, []);
  assert.deepEqual(after.uploadedEpisodeNumbers, [1, 2]);
  assert.deepEqual(after.submittedEpisodeNumbers, [3]);
  assert.equal(urls.length, 1, "only the pre-upload read occurs; no post-publish polling");
});

test("restarting with stale remote counters reuses durable confirmed submissions and skips them", async () => {
  const plan = createTaobaoCollectionUploadPlan(parseTaobaoCollectionDetail({ model: detailModel() }, "123"), "补传测试剧", 127);
  const executionStore = memoryExecutionStore();
  const episodes = Array.from({ length: 27 }, (_, index) => index + 101);
  const checkpoint: TaobaoSubmitCheckpoint = { kind: "batch", state: "submitting", collectionId: "123", episodeNumbers: episodes };
  executionStore.save(savedExecution([checkpoint, { ...checkpoint, state: "confirmed" }]));
  const options = { apiConfig: { baseUrl: "http://backend.test" }, accountId: "tb-1", executionStore };
  const { context } = contextFor([detailModel()]);
  const restored = await refreshTaobaoCollectionUploadPlan(context, plan, options);
  assert.equal(restored.uploadedEpisodeNumbers.length, 100);
  assert.deepEqual(restored.missingEpisodeNumbers, []);
  assert.deepEqual(restored.submittedEpisodeNumbers, episodes);
  assert.deepEqual(restoreTaobaoConfirmedSubmissions(plan, { ...options, accountId: "another-account" }).missingEpisodeNumbers, episodes);
  assert.deepEqual(restoreTaobaoConfirmedSubmissions({ ...plan, collectionId: "another-collection" }, options).missingEpisodeNumbers, episodes);
});

test("an uncertain submit cannot be treated as either confirmed or safe to reupload", () => {
  const plan = createTaobaoCollectionUploadPlan(parseTaobaoCollectionDetail({ model: detailModel(3, [1, 2]) }, "123"), "补传测试剧", 3);
  const executionStore = memoryExecutionStore();
  executionStore.save(savedExecution([{ kind: "batch", state: "submitting", collectionId: "123", episodeNumbers: [3] }]));
  assert.throws(() => restoreTaobaoConfirmedSubmissions(plan, { executionStore, apiConfig: { baseUrl: "http://backend.test" }, accountId: "tb-1" }), /暂停自动补传/);
});
