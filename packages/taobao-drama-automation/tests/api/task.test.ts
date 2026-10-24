import assert from "node:assert/strict";
import test from "node:test";
import { memoryExecutionStore } from "../helpers/execution-store.js";
import type { TaobaoDramaHttpClient } from "../../src/api/http-client.js";
import {
  claimNextTaobaoDramaTaskApi,
  normalizeClaimedTaobaoDramaTask,
  reportTaobaoAccountTaskApi,
} from "../../src/api/task.js";

test("normalizes a claimed backend task for collection creation and video upload", () => {
  const task = normalizeClaimedTaobaoDramaTask({
    workerId: "worker-test", attemptCount: 3,
    accountTaskId: 88,
    accountId: "tb-1",
    originalTitle: "原始剧名",
    accountConfigJson: null,
    payloadJson: {
      name: "原始剧名",
      productionCost: {
        proofFiles: ["https://assets.example.test/cost-report.pdf"],
      },
      taobaoPlaylet: {
        title: "淘宝剧名",
        summary: "测试剧情简介",
        episodeCount: 12,
        baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
        shortDramaType: "AI动漫短剧",
        shortDramaTags: ["AI动漫解说漫", "逆袭"],
        audience: "男",
      },
    },
  }, {
    id: 88,
    accountId: "tb-1",
    accountName: "淘宝账号",
    status: "READY",
    originalTitle: "原始剧名",
  }, {
    id: 1,
    accountId: "tb-1",
    accountName: "淘宝账号",
  }, "execution-test");
  assert.equal(task.accountTaskId, 88);
  assert.equal(task.title, "淘宝剧名");
  assert.equal(task.episodeCount, 12);
  assert.deepEqual(task.shortDramaTags, ["AI动漫解说漫", "逆袭"]);
  assert.deepEqual(task.productionCostProofFiles, ["https://assets.example.test/cost-report.pdf"]);
});

test("lists and claims the next READY Taobao task through Taobao-prefixed endpoints", async () => {
  const calls: Array<{ path: string; payload: unknown }> = [];
  const client: TaobaoDramaHttpClient = {
    async post(path, payload) {
      calls.push({ path, payload });
      if (path.endsWith("/accountTask/page")) {
        return { code: 0, msg: "操作成功", data: { total: 1, data: [{
          id: 88,
          dramaId: 1688,
          accountId: "tb-1",
          accountName: "淘宝账号",
          status: "READY",
          originalTitle: "原始剧名",
        }] } } as never;
      }
      if (path.endsWith("/rpa/claim")) {
        return { code: 0, msg: "操作成功", data: {
          workerId: "worker-test", attemptCount: 3,
          accountTaskId: 88,
          accountId: "tb-1",
          rpaProfileKey: "profile-tb-1",
          originalTitle: "原始剧名",
          payloadJson: {
            name: "原始剧名",
            episodeCount: 12,
            baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
          },
        } } as never;
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };

  const task = await claimNextTaobaoDramaTaskApi({
    workerId: "worker-test", executionStore: memoryExecutionStore(),
    apiBaseUrl: "http://backend.test",
    account: { id: 1, accountId: "tb-1", accountName: "淘宝账号" },
    client,
  });

  assert.equal(task?.accountTaskId, 88);
  assert.deepEqual(calls.map((call) => call.path), [
    "/dramaAiRpa/taobao/accountTask/page",
    "/dramaAiRpa/taobao/rpa/claim",
  ]);
  assert.deepEqual(calls[1]?.payload, { accountTaskId: 88, workerId: "worker-test" });
});

test("reports all supported Taobao result fields", async () => {
  const calls: Array<{ path: string; payload: Record<string, unknown> }> = [];
  const client: TaobaoDramaHttpClient = {
    async post(path, payload) {
      calls.push({ path, payload: payload as Record<string, unknown> });
      return { code: 0, msg: "操作成功", data: true } as never;
    },
  };

  await reportTaobaoAccountTaskApi({
    apiBaseUrl: "http://backend.test",
    client,
    report: {
      taskId: 88, workerId: "worker-test", attemptCount: 3,
      success: true,
      externalId: "collection-1",
      platformDramaId: "drama-1",
      resultJson: { episodeCount: 12 },
    },
  });

  assert.equal(calls[0]?.path, "/dramaAiRpa/taobao/rpa/report");
  assert.equal(calls[0]?.payload.externalId, "collection-1");
  assert.equal(calls[0]?.payload.platformDramaId, "drama-1");
});

test("reports an invalid claimed Taobao task and safely leaves it out of the queue", async () => {
  const calls: Array<{ path: string; payload: Record<string, unknown> }> = [];
  const client: TaobaoDramaHttpClient = {
    async post(path, payload) {
      calls.push({ path, payload: payload as Record<string, unknown> });
      if (path.endsWith("/accountTask/page")) {
        return { code: 0, msg: "操作成功", data: { data: [{
          id: 91,
          accountId: "tb-1",
          accountName: "淘宝账号",
          status: "READY",
          originalTitle: "字段缺失任务",
        }] } } as never;
      }
      if (path.endsWith("/rpa/claim")) {
        return { code: 0, msg: "操作成功", data: {
          workerId: "worker-test", attemptCount: 4,
          accountTaskId: 91,
          accountId: "tb-1",
          originalTitle: "字段缺失任务",
          payloadJson: { name: "字段缺失任务" },
        } } as never;
      }
      return { code: 0, msg: "操作成功", data: true } as never;
    },
  };

  const store = memoryExecutionStore();
  await assert.rejects(claimNextTaobaoDramaTaskApi({
    workerId: "worker-test", executionStore: store,
    apiBaseUrl: "http://backend.test",
    account: { id: 1, accountId: "tb-1", accountName: "淘宝账号" }, client,
  }), /TAOBAO_DRAMA_CLAIMED_TASK_INVALID/);
  assert.equal(calls.some((call) => call.path.endsWith("/rpa/report")), false);
  const record = store.list("http://backend.test")[0]!;
  assert.equal(record.phase, "report-pending");
  assert.equal(record.report?.taskId, 91);
  assert.equal(record.report?.workerId, "worker-test");
  assert.equal(record.report?.attemptCount, 4);
  assert.equal(record.report?.success, false);
  assert.match(String(record.report?.errorMessage), /TAOBAO_DRAMA_CLAIMED_TASK_INVALID/u);
});
