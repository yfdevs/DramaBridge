import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { compileFunction, createContext, runInContext } from "node:vm";
import { clientUploadRequest } from "../../src/infrastructure/upload-request.js";

function fixture(respond: (attempt: number) => { status?: number; data?: unknown; body?: Buffer } | undefined, fileSystem: unknown = fs) {
  let attempts = 0;
  let aborted = 0;
  const writes: Buffer[] = [], expressions: string[] = [];
  const net = {
    request: () => {
      const attempt = ++attempts;
      const request = Object.assign(new EventEmitter(), {
        setHeader: () => undefined,
        write: (body: Buffer) => { writes.push(body); },
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
      require: (module: string) => module === "electron" ? electron : module === "crypto" ? crypto : module === "fs" ? fileSystem : {
        compileFunction: (code: string, parameters: string[]) => compileFunction(code, parameters, { parsingContext: mainContext }),
        runInThisContext: (expression: string) => runInContext(expression, mainContext),
      },
    }),
  });
  return {
    page: { evaluate: async <T>(expression: string): Promise<T> => { expressions.push(expression); return await runInContext(expression, context); } },
    writes, expressions,
    counts: () => ({ attempts, aborted, active: runInContext("globalThis.__dramaBridgeUploads?.size ?? 0", mainContext) }),
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
  // Wait until the paced request actually starts, then test active cancellation.
  while (counts().attempts === 0) await new Promise(resolve => setTimeout(resolve, 5));
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

test("file management identity verification does not block the next upload request", async () => {
  const { page, counts } = fixture(attempt => ({ data: attempt === 1 ? { errno: 132, request_id: "delete-132" } : { errno: 0, uploadid: "next-upload" } }));
  await assert.rejects(clientUploadRequest(page, "https://pan.baidu.com/api/filemanager?opera=delete", Buffer.from("filelist=[]")), /BAIDU_NETDISK_IDENTITY_VERIFICATION.*errno=132/);
  assert.equal(counts().attempts, 1, "a denied delete is not retried");
  const next = await clientUploadRequest(page, "https://pan.baidu.com/api/precreate", Buffer.from("path=next.mp4"));
  assert.equal(next.uploadid, "next-upload");
  assert.equal(counts().attempts, 2);
});

test("the client reads a local part without sending file bytes through CDP, validating content before upload", async () => {
  const directory = await fs.promises.mkdtemp(path.join(tmpdir(), "baidu-local-part-"));
  try {
    const local = path.join(directory, "video.mp4");
    const bytes = Buffer.alloc(32 * 1024, 123);
    await fs.promises.writeFile(local, bytes);
    const info = await fs.promises.stat(local);
    const part = { path: local, offset: 0, length: bytes.length, size: bytes.length, modifiedAtMs: info.mtimeMs, md5: crypto.createHash("md5").update(bytes).digest("hex"), boundary: "testBoundary" };
    const { page, writes, expressions, counts } = fixture(() => ({ data: { md5: part.md5 } }));
    const url = "https://c2.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&partseq=0";
    await clientUploadRequest(page, url, undefined, undefined, { filePart: part, traffic: "data" });
    assert.ok(writes[0].includes(bytes));
    assert.ok(expressions.every(expression => expression.length < bytes.length));
    assert.ok(expressions.every(expression => !expression.includes(bytes.toString("base64"))));
    await fs.promises.writeFile(local, Buffer.alloc(bytes.length, 7));
    await assert.rejects(clientUploadRequest(page, url, undefined, undefined, { filePart: part }), /发生变化/);
    assert.equal(counts().attempts, 1, "changed content never reaches the upload endpoint");
    await assert.rejects(clientUploadRequest(page, "https://example.com/rest/2.0/pcs/superfile2?method=upload", undefined, undefined, { filePart: part }), /无效.*本地上传分片/);
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
});

test("cancellation during a client-local read prevents a late HTTP submission and closes the file", async () => {
  const bytes = Buffer.from("local part");
  let release: () => void = () => undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let closed = false;
  const fileSystem = { promises: { open: async () => {
    await barrier;
    return {
      stat: async () => ({ isFile: () => true, size: bytes.length, mtimeMs: 10 }),
      read: async (buffer: Buffer) => { bytes.copy(buffer); return { bytesRead: bytes.length }; },
      close: async () => { closed = true; },
    };
  } } };
  const { page, counts } = fixture(() => ({ data: { errno: 0 } }), fileSystem);
  const controller = new AbortController();
  const pending = clientUploadRequest(page, "https://c2.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload", undefined, undefined, {
    signal: controller.signal, traffic: "data",
    filePart: { path: path.resolve("test.mp4"), offset: 0, length: bytes.length, size: bytes.length, modifiedAtMs: 10, md5: crypto.createHash("md5").update(bytes).digest("hex"), boundary: "testBoundary" },
  });
  const rejection = assert.rejects(pending, /用户停止/);
  while (!counts().active) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new Error("用户停止"));
  await rejection;
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
  assert.deepEqual(counts(), { attempts: 0, aborted: 0, active: 0 });
});

test("risk responses include errno and request id, pause further dispatch and never replay", async () => {
  const { page, counts } = fixture(() => ({ data: { errno: 8001, request_id: "risk-42" } }));
  await assert.rejects(clientUploadRequest(page, "https://pan.baidu.com/api/list?bdstoken=secret"), error => {
    assert.match(String(error), /BAIDU_NETDISK_RISK_CONTROL.*errno=8001.*request_id=risk-42/);
    assert.doesNotMatch(String(error), /secret/);
    return true;
  });
  await assert.rejects(clientUploadRequest(page, "https://pan.baidu.com/api/list"), /BAIDU_NETDISK_RISK_CONTROL/);
  assert.equal(counts().attempts, 1);
});
