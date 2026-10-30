import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import { compileFunction, createContext, runInContext } from "node:vm";
import { clientUploadRequest } from "../../src/infrastructure/upload-request.js";

function fixture(respond: (attempt: number) => { status?: number; data?: unknown; body?: Buffer } | undefined) {
  let attempts = 0;
  let aborted = 0;
  const net = {
    request: () => {
      const attempt = ++attempts;
      const request = Object.assign(new EventEmitter(), {
        setHeader: () => undefined,
        write: () => undefined,
        abort: () => { aborted++; request.emit("close"); },
        end: () => queueMicrotask(() => {
          const result = respond(attempt);
          if (!result) return;
          // Baidu can close the request before delivering its successful response.
          request.emit("close");
          const response = Object.assign(new EventEmitter(), { statusCode: result.status ?? 200 });
          request.emit("response", response);
          const bytes = result.body ?? Buffer.from(JSON.stringify(result.data ?? { errno: 0 }));
          response.emit("data", bytes.subarray(0, 4));
          response.emit("data", bytes.subarray(4));
          response.emit("end");
          request.emit("close");
        }),
      });
      return request;
    },
  };
  const contents = { id: 1, getURL: () => "https://pan.baidu.com/disk/main", session: {} };
  const electron = { net, webContents: { getAllWebContents: () => [contents], fromId: () => contents } };
  const mainContext = createContext({ Buffer, URL, setTimeout, clearTimeout });
  const context = createContext({
    require: () => ({
      getCurrentWebContents: () => contents,
      require: (module: string) => module === "electron" ? electron : module === "crypto" ? crypto : {
        compileFunction: (code: string, parameters: string[]) => compileFunction(code, parameters, { parsingContext: mainContext }),
        runInThisContext: (expression: string) => runInContext(expression, mainContext),
      },
    }),
  });
  return {
    page: { evaluate: async <T>(expression: string): Promise<T> => await runInContext(expression, context) },
    counts: () => ({ attempts, aborted, active: runInContext("globalThis.__dramaBridgeUploads.size", mainContext) }),
  };
}

test("request close before response does not reject a successful response, and streams stay in main process", async () => {
  // The renderer context has no Buffer or timers; all request/stream work must use the main context.
  const { page, counts } = fixture(() => ({ data: { errno: 0, result: { bdstoken: "test-token" } } }));
  const result = await clientUploadRequest(page, "https://pan.baidu.com/api/gettemplatevariable");
  assert.equal((result.result as { bdstoken: string }).bdstoken, "test-token");
  assert.deepEqual(counts(), { attempts: 1, aborted: 0, active: 0 });
});

test("content checksum streams bytes in the main process and rejects truncated or oversized content", async () => {
  const bytes = Buffer.from("cloud video bytes");
  const { page } = fixture(() => ({ body: bytes }));
  const result = await clientUploadRequest(page, "https://d.pcs.baidu.com/content", undefined, undefined, {
    responseType: "checksum", expectedSize: bytes.length, retryable: false,
  });
  assert.equal(result.md5, crypto.createHash("md5").update(bytes).digest("hex"));
  assert.equal(result.size, bytes.length);
  for (const expectedSize of [bytes.length - 1, bytes.length + 1])
    await assert.rejects(clientUploadRequest(page, "https://d.pcs.baidu.com/content", undefined, undefined, {
      responseType: "checksum", expectedSize, retryable: false,
    }), /长度/);
});

test("timed-out reads abort the request and retry without leaking client handles", async () => {
  const { page, counts } = fixture(attempt => attempt === 1 ? undefined : { data: { errno: 0, list: [] } });
  const messages: string[] = [];
  const result = await clientUploadRequest(page, "https://pan.baidu.com/api/list?bdstoken=secret", undefined, undefined, {
    timeoutMs: 20, onRetry: message => messages.push(message),
  });
  assert.ok(Array.isArray(result.list) && result.list.length === 0);
  assert.deepEqual(counts(), { attempts: 2, aborted: 1, active: 0 });
  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes("secret"));
});

test("transient upload block failures retry the same request", async () => {
  const { page, counts } = fixture(attempt => attempt === 1 ? { status: 503 } : { data: { md5: "verified" } });
  const result = await clientUploadRequest(page, "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2", Buffer.from("block"), undefined, {
    retryable: true, label: "上传 第1集 分片 1/2",
  });
  assert.equal(result.md5, "verified");
  assert.equal(counts().attempts, 2);
});

test("mutating requests and business errors do not automatically retry", async () => {
  const timed = fixture(() => undefined);
  await assert.rejects(clientUploadRequest(timed.page, "https://pan.baidu.com/share/set", Buffer.from("form"), undefined, {
    timeoutMs: 20,
  }), /share\/set失败（尝试 1 次）.*超时/);
  assert.deepEqual(timed.counts(), { attempts: 1, aborted: 1, active: 0 });
  const failed = fixture(() => ({ data: { errno: -6, errmsg: "登录已失效" } }));
  await assert.rejects(clientUploadRequest(failed.page, "https://pan.baidu.com/api/list"), /登录已失效/);
  assert.equal(failed.counts().attempts, 1);
});

test("stopping a task aborts its active client request immediately", async () => {
  const { page, counts } = fixture(() => undefined);
  const controller = new AbortController();
  const pending = clientUploadRequest(page, "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2", Buffer.from("block"), undefined, {
    signal: controller.signal, timeoutMs: 600_000, retryable: true,
  });
  controller.abort(new Error("用户停止任务"));
  await assert.rejects(pending, /用户停止任务/);
  assert.deepEqual(counts(), { attempts: 1, aborted: 1, active: 0 });
});

test("repeated timeouts stop after three attempts and omit sensitive URL parameters", async () => {
  const { page, counts } = fixture(() => undefined);
  await assert.rejects(
    clientUploadRequest(page, "https://pan.baidu.com/api/list?bdstoken=secret", undefined, undefined, { timeoutMs: 20 }),
    error => error instanceof Error && /尝试 3 次/.test(error.message) && !error.message.includes("secret"),
  );
  assert.deepEqual(counts(), { attempts: 3, aborted: 3, active: 0 });
});
