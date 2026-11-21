import assert from "node:assert/strict";
import test from "node:test";
import { claimBaiduDramaTaskByIdApi, claimNextBaiduDramaTaskApi, reportBaiduDramaTaskSuccessApi, reportBaiduDramaTaskErrorApi } from "../../src/api/task.js";
import type { BaiduDramaHttpClient } from "../../src/api/http-client.js";

const playlet = { title: "测试剧", summary: "简介", episodeCount: 1, audienceType: "男频", secondaryCategory: "都市", updateStatus: "已完结", director: { name: "导演" }, producers: ["制片"], screenwriters: ["编剧"], actors: [{ name: "甲", roleName: "甲" }, { name: "乙", roleName: "乙" }], productionCost: { amountWan: 1 }, productionOrganization: "制作公司" };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<{path: string; body: any}> = [];
  const client = { post: async (path: string, body: any) => {
    calls.push({ path, body });
    if (path.endsWith("/claim")) return { code: 0, data: { accountTaskId: 2192, workerId: body.workerId, attemptCount: 3, originalTitle: "测试剧", payloadJson: playlet, ...overrides } };
    if (path.endsWith("/page")) return { code: 0, data: { data: [{ id: 2192, accountId: "a", status: "READY" }] } };
    return { code: 0, data: true };
  } } as BaiduDramaHttpClient;
  return { client, calls };
}
test("claim carries worker identity and both report paths preserve the returned generation", async () => {
  const f = fixture();
  const task = await claimBaiduDramaTaskByIdApi({ client: f.client, accountTaskId: 2192, runtimeOptions: { workerId: "baidu-machine-process" } });
  assert.equal(task?.workerId, "baidu-machine-process"); assert.equal(task?.attemptCount, 3);
  await reportBaiduDramaTaskSuccessApi({ client: f.client, accountTaskId: 2192, workerId: task!.workerId, attemptCount: task!.attemptCount });
  await reportBaiduDramaTaskErrorApi({ client: f.client, accountTaskId: 2192, workerId: task!.workerId, attemptCount: task!.attemptCount, failStage: "OTHER", errorMessage: "failed" });
  for (const {body} of f.calls.slice(1)) { assert.equal(body.workerId, task!.workerId); assert.equal(body.attemptCount, 3); }
});
test("missing or oversized worker identity never sends a claim", async () => {
  const f = fixture();
  for (const workerId of [undefined, "", "x".repeat(129)]) await assert.rejects(claimBaiduDramaTaskByIdApi({ client: f.client, accountTaskId: 2192, workerId }));
  assert.equal(f.calls.length, 0);
});
test("foreign owners and invalid generations never reach publishing or report another owner's task", async () => {
  for (const overrides of [{ workerId: "other" }, { attemptCount: 0 }, { workerId: undefined }]) {
    const f = fixture(overrides);
    await assert.rejects(claimBaiduDramaTaskByIdApi({ client: f.client, accountTaskId: 2192, workerId: "self" }));
    assert.equal(f.calls.length, 1);
  }
});
test("claim failures surface as failures rather than an empty queue", async () => {
  const f = fixture({ workerId: "other" });
  await assert.rejects(claimNextBaiduDramaTaskApi({ client: f.client, runtimeOptions: { baiduAccountId: "a", workerId: "self" } }), /WORKER_MISMATCH/);
});
test("invalid upload payload reports failure with the claimed ownership", async () => {
  const f = fixture({ payloadJson: {} });
  await assert.rejects(claimBaiduDramaTaskByIdApi({ client: f.client, accountTaskId: 2192, workerId: "self" }));
  assert.equal(f.calls[1].body.workerId, "self"); assert.equal(f.calls[1].body.attemptCount, 3);
});
