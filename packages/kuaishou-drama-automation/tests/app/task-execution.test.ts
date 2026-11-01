import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNextKuaishouDramaTaskApi as claimNextApi,
  reportKuaishouAccountTaskApi,
  KuaishouApiBusinessError,
} from "../../src/api/task.js";
import type { KuaishouDramaHttpClient } from "../../src/api/http-client.js";
import {
  executeKuaishouClaimedTask,
  flushPendingKuaishouReports,
  recoverKuaishouExecutions,
} from "../../src/app/task-execution.js";
import type { ClaimedKuaishouDramaTask } from "../../src/shared/types.js";
import { memoryExecutionStore } from "../helpers/execution-store.js";

function claimNextKuaishouDramaTaskApi(options: {
  apiBaseUrl: string;
  account: { accountId: string };
  workerId: string;
  executionStore: ReturnType<typeof memoryExecutionStore>;
  client: KuaishouDramaHttpClient;
}) {
  return claimNextApi({
    apiConfig: { baseUrl: options.apiBaseUrl },
    client: options.client,
    runtimeOptions: {
      kuaishouAccountId: options.account.accountId,
      workerId: options.workerId,
      executionStore: options.executionStore,
    },
  });
}

const apiBaseUrl = "http://backend.test";
const account = { id: 1, accountId: "ks-1", accountName: "快手账号" };
function backend() {
  let owner = "";
  let attemptCount = 2;
  let completed: boolean | undefined;
  let claimRequests = 0;
  const client: KuaishouDramaHttpClient = {
    async post(path, body) {
      const payload = body as Record<string, unknown>;
      if (path.endsWith("/page"))
        return {
          code: 0,
          data: {
            data: [{ id: 88, accountId: "ks-1", status: "READY", publishTitle: "过期列表剧名" }],
          },
        } as never; // A stale list must never confer execution permission.
      if (path.endsWith("/claim")) {
        claimRequests++;
        if (owner) return { code: -1, msg: "任务已被领取，状态已变更" } as never;
        owner = String(payload.workerId);
        attemptCount++;
        return {
          code: 0,
          data: {
            accountTaskId: 88,
            workerId: owner,
            attemptCount,
            accountId: "ks-1",
            publishTitle: "本轮发布剧名",
            payloadJson: {
              name: "原始剧名",
              episodeCount: 12,
              baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
              summary:
                "女主在事业与家庭的双重低谷中重新出发，凭借坚韧和智慧找回人生方向。她在一次次误解与挑战中守住初心，也逐渐揭开旧事背后的真相。面对亲情、友情和爱情的选择，她不再逃避，而是与伙伴并肩前行，最终完成自我成长并迎来新的生活。",
              producerName: "制作方",
              kuaishouPlaylet: {
                title: "本轮发布剧名",
                genderChannel: "不限",
                categories: ["脑洞"],
                plotTags: ["其他"],
                publishType: "广告",
              },
            },
          },
        } as never;
      }
      if (path.endsWith("/report")) {
        if (payload.workerId !== owner || payload.attemptCount !== attemptCount) {
          return { code: -1, msg: "领取者或轮次不匹配" } as never;
        }
        if (completed !== undefined && completed !== payload.success)
          return { code: -1, msg: "回写结果不一致" } as never;
        completed = Boolean(payload.success);
        return { code: 0, data: true } as never;
      }
      throw new Error(path);
    },
  };
  return {
    client,
    get claimRequests() {
      return claimRequests;
    },
    nextRound() {
      owner = "";
      completed = undefined;
    },
  };
}
async function claim(
  workerId = "machine-1-process-1",
  store = memoryExecutionStore(),
  server = backend(),
) {
  const task = await claimNextKuaishouDramaTaskApi({
    apiBaseUrl,
    account,
    workerId,
    executionStore: store,
    client: server.client,
  });
  assert.ok(task);
  return { task, store, server };
}
function failure(error: unknown) {
  return Promise.resolve({ stage: "OTHER" as const, message: String(error) });
}

test("two workers race on the same stale candidate; only the successful claimant may publish", async () => {
  const server = backend();
  const stores = [memoryExecutionStore(), memoryExecutionStore()];
  const tasks = await Promise.all(
    stores.map((executionStore, index) =>
      claimNextKuaishouDramaTaskApi({
        apiBaseUrl,
        account,
        workerId: `computer-${index}`,
        executionStore,
        client: server.client,
      }),
    ),
  );
  assert.equal(tasks.filter(Boolean).length, 1);
  let uploads = 0;
  for (const [index, task] of tasks.entries()) {
    if (!task) continue;
    assert.equal(task.task.title, "本轮发布剧名");
    assert.equal(task.task.episodeCount, 12);
    assert.equal(task.attemptCount, 3);
    await executeKuaishouClaimedTask({
      store: stores[index]!,
      task,
      publish: async () => {
        uploads++;
      },
      failure,
      resultJson: () => ({}),
    });
    await flushPendingKuaishouReports({
      store: stores[index]!,
      apiBaseUrl,
      accountId: account.accountId,
      client: server.client,
    });
    assert.equal(stores[index]!.get(task.executionId)?.phase, "reported");
  }
  assert.equal(uploads, 1);
});

test("strict claim credentials: missing, invalid and mismatched identities never authorize publishing", async () => {
  for (const replacement of [
    { workerId: undefined },
    { attemptCount: undefined },
    { attemptCount: 0 },
    { attemptCount: 1.5 },
    { attemptCount: true },
    { attemptCount: "3" },
    { workerId: "another-worker" },
    { accountTaskId: 99 },
  ]) {
    const server = backend();
    const store = memoryExecutionStore();
    const client: KuaishouDramaHttpClient = {
      async post(path, body) {
        const response = await server.client.post<any>(path, body);
        return (
          path.endsWith("/claim")
            ? { ...response, data: { ...response.data, ...replacement } }
            : response
        ) as never;
      },
    };
    await assert.rejects(
      claimNextKuaishouDramaTaskApi({
        apiBaseUrl,
        account,
        workerId: "worker",
        executionStore: store,
        client,
      }),
    );
    assert.equal(store.list(apiBaseUrl)[0]?.phase, "review-required");
    assert.equal(
      await claimNextKuaishouDramaTaskApi({
        apiBaseUrl,
        account,
        workerId: "worker",
        executionStore: store,
        client,
      }),
      null,
    );
    assert.equal(server.claimRequests, 1);
  }
});

test("lost claim response persists uncertainty before sending and never claims or uploads that task again", async () => {
  const server = backend();
  const store = memoryExecutionStore();
  const client: KuaishouDramaHttpClient = {
    async post(path, body) {
      if (path.endsWith("/claim")) assert.equal(store.list(apiBaseUrl)[0]?.phase, "claiming");
      const response = await server.client.post(path, body);
      if (path.endsWith("/claim")) throw new Error("Request timed out.");
      return response as never;
    },
  };
  await assert.rejects(
    claimNextKuaishouDramaTaskApi({
      apiBaseUrl,
      account,
      workerId: "old-worker",
      executionStore: store,
      client,
    }),
    /timed out/,
  );
  recoverKuaishouExecutions(store, apiBaseUrl, account.accountId);
  assert.equal(
    await claimNextKuaishouDramaTaskApi({
      apiBaseUrl,
      account,
      workerId: "new-worker",
      executionStore: store,
      client,
    }),
    null,
  );
  assert.equal(server.claimRequests, 1);
  assert.match(store.list(apiBaseUrl)[0]!.errorMessage!, /领取结果待核实/);
});

test("a non-conflict business rejection surfaces instead of silently consuming further candidates", async () => {
  const server = backend();
  const client: KuaishouDramaHttpClient = {
    async post(path, body) {
      if (path.endsWith("/claim")) return { code: -1, msg: "workerId 参数无效" } as never;
      return server.client.post(path, body);
    },
  };
  await assert.rejects(
    claimNextKuaishouDramaTaskApi({
      apiBaseUrl,
      account,
      workerId: "worker",
      executionStore: memoryExecutionStore(),
      client,
    }),
    /workerId 参数无效/,
  );
});

test("successful publishing with a lost report acknowledgement replays the identical old report after restart", async () => {
  const { task, store, server } = await claim();
  let uploads = 0;
  await executeKuaishouClaimedTask({
    store,
    task,
    publish: async (checkpoint) => {
      uploads++;
      checkpoint({ variant: "ad-unlock", state: "submitting" });
      checkpoint({ variant: "ad-unlock", state: "confirmed" });
    },
    failure,
    resultJson: () => ({ external: "saved-result" }),
  });
  const savedReport = structuredClone(store.get(task.executionId)!.report!);
  let rejectedAsUploadFailure = 0;
  const client: KuaishouDramaHttpClient = {
    async post(path, body) {
      assert.deepEqual(JSON.parse(JSON.stringify(body)), JSON.parse(JSON.stringify(savedReport)));
      if (!(body as { success: boolean }).success) rejectedAsUploadFailure++;
      await server.client.post(path, body); // Backend received it; acknowledgement was lost.
      throw new Error("Request timed out.");
    },
  };
  await flushPendingKuaishouReports({ store, apiBaseUrl, accountId: account.accountId, client });
  assert.equal(store.get(task.executionId)?.phase, "report-pending");
  recoverKuaishouExecutions(store, apiBaseUrl, account.accountId);
  assert.equal(
    await claimNextKuaishouDramaTaskApi({
      apiBaseUrl,
      account,
      workerId: "new-process",
      executionStore: store,
      client: server.client,
    }),
    null,
  );
  await flushPendingKuaishouReports({
    store,
    apiBaseUrl,
    accountId: account.accountId,
    client: server.client,
  });
  assert.equal(store.get(task.executionId)?.phase, "reported");
  assert.deepEqual(store.get(task.executionId)?.report, savedReport);
  assert.equal(uploads, 1);
  assert.equal(rejectedAsUploadFailure, 0);
});

test("ownership rejection stops automatic retries, and old-round callbacks cannot overwrite a new claim", async () => {
  const { task, store, server } = await claim();
  await executeKuaishouClaimedTask({
    store,
    task,
    publish: async () => {},
    failure,
    resultJson: () => ({}),
  });
  server.nextRound();
  const nextClaim = (
    await server.client.post<any>("/claim", { accountTaskId: 88, workerId: "new-worker" })
  ).data;
  assert.equal(nextClaim.attemptCount, 4);
  let requests = 0;
  const client: KuaishouDramaHttpClient = {
    async post(path, body) {
      requests++;
      return server.client.post(path, body);
    },
  };
  await flushPendingKuaishouReports({ store, apiBaseUrl, accountId: account.accountId, client });
  await flushPendingKuaishouReports({ store, apiBaseUrl, accountId: account.accountId, client });
  assert.equal(requests, 1);
  assert.equal(store.get(task.executionId)?.phase, "report-blocked");
  assert.equal(store.get(task.executionId)?.report?.attemptCount, 3);
  await assert.rejects(
    reportKuaishouAccountTaskApi({
      apiConfig: { baseUrl: apiBaseUrl },
      report: store.get(task.executionId)!.report!,
      client: server.client,
    }),
    KuaishouApiBusinessError,
  );
});

test("submit uncertainty and partial multi-version success require review and never create a failure report", async () => {
  for (const partial of [false, true]) {
    const { task, store } = await claim();
    const outcome = await executeKuaishouClaimedTask({
      store,
      task,
      publish: async (checkpoint) => {
        checkpoint({ variant: "ad-unlock", state: "submitting" });
        if (partial) checkpoint({ variant: "ad-unlock", state: "confirmed" });
        throw new Error(partial ? "第二批填写失败" : "提交后等待超时");
      },
      failure,
      resultJson: () => ({}),
    });
    assert.equal(outcome.record.phase, "review-required");
    assert.equal(outcome.record.report, undefined);
  }
});

test("pre-submit failures preserve the actual claim credentials and non-empty failure reason", async () => {
  const { task, store, server } = await claim();
  const outcome = await executeKuaishouClaimedTask({
    store,
    task,
    publish: async () => {
      throw new Error("视频下载失败");
    },
    failure,
    resultJson: () => ({}),
  });
  assert.equal(outcome.record.report?.success, false);
  assert.equal(outcome.record.report?.workerId, task.workerId);
  assert.equal(outcome.record.report?.attemptCount, task.attemptCount);
  assert.match(outcome.record.report!.errorMessage!, /视频下载失败/);
  await flushPendingKuaishouReports({
    store,
    apiBaseUrl,
    accountId: account.accountId,
    client: server.client,
  });
  assert.equal(store.get(task.executionId)?.phase, "reported");
});

test("interrupted execution needs review after restart and cannot be published a second time", async () => {
  const { task, store } = await claim();
  recoverKuaishouExecutions(store, apiBaseUrl, account.accountId);
  let uploads = 0;
  await assert.rejects(
    executeKuaishouClaimedTask({
      store,
      task: task as ClaimedKuaishouDramaTask,
      publish: async () => {
        uploads++;
      },
      failure,
      resultJson: () => ({}),
    }),
    /禁止上传/,
  );
  assert.equal(uploads, 0);
  assert.equal(store.get(task.executionId)?.phase, "review-required");
});
