import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LocalApiServer } from "../../electron/local-api/http-server";
import {
  ExternalDownloads,
  type ExternalDownloadTask,
  type ExternalDownloadTaskStore,
} from "../../electron/platforms/baidu-netdisk/external-downloads";
import {
  createExternalDownloadRoutes,
  postExternalDownloadCallback,
} from "../../electron/platforms/baidu-netdisk/external-download-routes";

const request = {
  requestId: "test-1",
  shareText: "https://pan.baidu.com/s/test?pwd=1234",
  resourceName: "测试短剧",
  episodeCount: 2,
  timeoutSeconds: 5,
};
const prefix = "/api/baidu-netdisk/downloads";
class MemoryTasks implements ExternalDownloadTaskStore {
  private tasks = new Map<string, ExternalDownloadTask>();
  list() {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }
  get(id: string) {
    const value = this.tasks.get(id);
    return value ? structuredClone(value) : undefined;
  }
  findRequest(id: string) {
    return this.list().find((task) => task.request.requestId === id);
  }
  save(task: ExternalDownloadTask) {
    this.tasks.set(task.taskId, structuredClone(task));
  }
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), "condition should settle");
}
async function fixture(manager: ExternalDownloads) {
  const port = await freePort();
  const server = new LocalApiServer(
    createExternalDownloadRoutes({
      manager: () => manager,
      status: async () => ({ ready: true }),
      start: async () => ({ ready: true }),
      control: async (_task, action) => ({ action }),
      progress: () => ({ percent: 50 }),
    }),
  );
  await server.configure({ enabled: true, port });
  const call = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    server,
    port,
    call,
    close: async () => {
      await server.close();
      manager.close();
    },
  };
}

test("Express API accepts unauthenticated local requests and validates /api prefix and JSON without downloading", async () => {
  let downloads = 0;
  const manager = new ExternalDownloads(new MemoryTasks(), async () => {
    downloads++;
  });
  const api = await fixture(manager);
  try {
    assert.equal((await api.call("/api/health")).status, 200);
    assert.equal(
      (await api.call("/api/health", undefined, { Origin: "https://example.test" })).status,
      403,
    );
    assert.equal((await api.call("/health")).status, 404);
    assert.equal((await api.call(prefix, {}, { "Content-Type": "text/plain" })).status, 415);
    const malformed = await fetch(`http://127.0.0.1:${api.port}${prefix}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_JSON");
    assert.equal((await api.call(prefix, { payload: "a".repeat(70_000) })).status, 413);
    assert.equal((await api.call(prefix, { ...request, resourceName: "../other" })).status, 400);
    assert.equal((await api.call(prefix, { ...request, callbackUrl: "invalid" })).status, 400);
    assert.equal((await api.call(prefix, { ...request, timeoutSeconds: 0 })).status, 400);
    assert.equal((await api.call(prefix, { ...request, shareText: "https://pan.baidu.com/s/test" })).status, 400);
    assert.equal(downloads, 0);
  } finally {
    await api.close();
  }
});

test("submits once, delivers a JSON callback, and reuses identical requestIds", async () => {
  let downloads = 0;
  const events: Record<string, unknown>[] = [];
  const callback = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    assert.equal(req.headers["x-dramabridge-signature"], undefined);
    assert.equal(req.headers.authorization, undefined);
    events.push(JSON.parse(body));
    res.writeHead(200).end();
  });
  const callbackPort = await listen(callback);
  const store = new MemoryTasks();
  const manager = new ExternalDownloads(
    store,
    async () => {
      downloads++;
      return { localPath: "D:\\materials\\测试短剧" };
    },
    postExternalDownloadCallback,
    5,
  );
  const api = await fixture(manager);
  try {
    const body = { ...request, callbackUrl: `http://127.0.0.1:${callbackPort}/done` };
    const response = await api.call(prefix, body);
    assert.equal(response.status, 202);
    const taskId = (await response.json()).data.taskId;
    await until(() => store.get(taskId)?.callback?.status === "delivered");
    const duplicate = await api.call(prefix, body);
    assert.equal((await duplicate.json()).data.taskId, taskId);
    assert.equal(downloads, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "download.completed");
    assert.equal(events[0]!.requestId, request.requestId);
    assert.equal((await api.call(prefix, { ...body, episodeCount: 3 })).status, 409);
    assert.equal((await api.call(`${prefix}/${taskId}`)).status, 200);
  } finally {
    await api.close();
    await close(callback);
  }
});

test("per-call timeout returns HTTP 504, aborts work and cannot become success after late completion", async () => {
  let complete!: () => void;
  let signal: AbortSignal | undefined;
  const store = new MemoryTasks();
  const events: string[] = [];
  const manager = new ExternalDownloads(
    store,
    async (_request, value) => {
      signal = value;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return { done: true };
    },
    async (task) => {
      events.push(task.status);
    },
  );
  const api = await fixture(manager);
  try {
    const response = await api.call(`${prefix}?wait=true`, {
      ...request,
      timeoutSeconds: 0.05,
      callbackUrl: "http://127.0.0.1:1234/done",
    });
    assert.equal(response.status, 504);
    const task = (await response.json()).data;
    assert.equal(task.status, "timed_out");
    assert.equal(task.error.code, "DOWNLOAD_TIMEOUT");
    assert.equal(signal?.aborted, true);
    complete();
    await delay(20);
    assert.equal(store.get(task.taskId)?.status, "timed_out");
    assert.deepEqual(events, ["timed_out"]);
  } finally {
    await api.close();
  }
});

test("timeout includes queue time and never starts an expired queued task", async () => {
  let complete!: () => void;
  const started: string[] = [];
  const manager = new ExternalDownloads(new MemoryTasks(), async (value) => {
    started.push(value.requestId);
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  const api = await fixture(manager);
  try {
    await api.call(prefix, request);
    const response = await api.call(`${prefix}?wait=true`, {
      ...request,
      requestId: "second",
      timeoutSeconds: 0.03,
    });
    assert.equal(response.status, 504);
    complete();
    await delay(10);
    assert.deepEqual(started, ["test-1"]);
  } finally {
    await api.close();
  }
});

test("callback failures retry delivery three times without redownloading or changing download success", async () => {
  let downloads = 0;
  let deliveries = 0;
  const store = new MemoryTasks();
  const manager = new ExternalDownloads(
    store,
    async () => {
      downloads++;
      return { ok: true };
    },
    async () => {
      deliveries++;
      throw new Error("callback offline");
    },
    5,
  );
  try {
    const { task } = manager.submit({ ...request, callbackUrl: "http://127.0.0.1:1234/done" });
    await until(() => store.get(task.taskId)?.callback?.status === "failed");
    assert.equal(deliveries, 3);
    assert.equal(downloads, 1);
    assert.equal(manager.get(task.taskId).status, "completed");
  } finally {
    manager.close();
  }
});

test("restart marks unfinished work interrupted and retains completed jobs and idempotency", async () => {
  const store = new MemoryTasks();
  const first = new ExternalDownloads(store, async () => new Promise(() => {}));
  const { task } = first.submit(request);
  first.close();
  let restartedDownloads = 0;
  const restarted = new ExternalDownloads(store, async () => {
    restartedDownloads++;
    return { ok: true };
  });
  try {
    assert.equal(restarted.submit(request).created, false);
    assert.equal(restarted.get(task.taskId).status, "interrupted");
    restarted.retry(task.taskId);
    await until(() => restarted.get(task.taskId).status === "completed");
    assert.equal(restartedDownloads, 1);
    assert.equal(restarted.submit(request).task.status, "completed");
  } finally {
    restarted.close();
  }
});

test("explicit retry gets a new callback event identity and cannot be deduplicated as the previous failure", async () => {
  let downloads = 0;
  const events: string[] = [];
  const store = new MemoryTasks();
  const manager = new ExternalDownloads(store, async () => {
    if (++downloads === 1) throw new Error("first attempt failed");
    return { ok: true };
  }, async task => { events.push(`${task.taskId}:${task.attempt}:${task.status}`); });
  try {
    const { task } = manager.submit({ ...request, callbackUrl: "http://127.0.0.1:1234/done" });
    await until(() => store.get(task.taskId)?.callback?.status === "delivered");
    manager.retry(task.taskId);
    await until(() => events.length === 2);
    assert.deepEqual(events, [`${task.taskId}:1:failed`, `${task.taskId}:2:completed`]);
  } finally { manager.close(); }
});

test("switching off closes HTTP waiters but existing download continues and can be queried after reenabling", async () => {
  let complete!: () => void;
  const store = new MemoryTasks();
  const manager = new ExternalDownloads(
    store,
    async () =>
      new Promise((resolve) => {
        complete = () => resolve({ ok: true });
      }),
  );
  const api = await fixture(manager);
  try {
    const waiting = api.call(`${prefix}?wait=true`, request);
    await until(() => Boolean(complete));
    await api.server.close();
    assert.equal((await waiting).status, 503);
    assert.equal(api.server.status().running, false);
    complete();
    await until(() => store.list()[0]?.status === "completed");
    await api.server.configure({ enabled: true, port: api.port });
    const response = await api.call(`${prefix}/${store.list()[0]!.taskId}`);
    assert.equal((await response.json()).data.status, "completed");
  } finally {
    await api.close();
  }
});

test("a port conflict preserves the running server and port changes take effect immediately", async () => {
  const manager = new ExternalDownloads(new MemoryTasks(), async () => {});
  const api = await fixture(manager);
  const occupied = createServer();
  const occupiedPort = await listen(occupied);
  try {
    await assert.rejects(
      api.server.configure({ enabled: true, port: occupiedPort }),
      /端口.*已被占用/u,
    );
    assert.equal((await api.call("/api/health")).status, 200);
    const newPort = await freePort();
    await api.server.configure({ enabled: true, port: newPort });
    await assert.rejects(api.call("/api/health"));
    assert.equal((await fetch(`http://127.0.0.1:${newPort}/api/health`)).status, 200);
  } finally {
    await api.close();
    await close(occupied);
  }
});
