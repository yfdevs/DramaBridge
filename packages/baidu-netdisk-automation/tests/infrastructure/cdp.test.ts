import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CdpPage, withPage } from "../../src/infrastructure/cdp.js";
import { CdpTimeoutError } from "../../src/domain/errors.js";
import { createServer } from "node:http";
import { ensureBaiduCdpPort } from "../../src/infrastructure/cdp.js";
import { isBaiduNetdiskCdpPort } from "../../src/runtime/baidu-netdisk-runtime.js";

test("CDP identity survives transient probe failures without requiring a target list", async () => {
  let versions = 0;
  let lists = 0;
  let wrongService = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/json/version") {
      versions += 1;
      if (versions === 1) { response.writeHead(503); response.end("busy"); return; }
      response.end(JSON.stringify({ "User-Agent": wrongService ? "Chrome" : "baidunetdisk/8.9.7" }));
    } else {
      lists += 1;
      response.writeHead(503);
      response.end("busy");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await ensureBaiduCdpPort(port);
    assert.equal(versions, 2);
    assert.equal(lists, 0);
    assert.equal(await isBaiduNetdiskCdpPort(port), true);
    wrongService = true;
    await assert.rejects(ensureBaiduCdpPort(port), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /BAIDU_NETDISK_CLIENT_RESTART_REQUIRED/);
      assert.match(error.message, /顶部.*网盘.*启动并连接.*重启连接.*重试失败任务/);
      assert.equal((error as Error & { port: number }).port, port);
      assert.ok(error.cause, "retain the technical probe failure for diagnostics");
      return true;
    });
    assert.equal(await isBaiduNetdiskCdpPort(port), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("CDP timeouts preserve stage and duration, and a subsequent read can succeed", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const url = `ws://127.0.0.1:${address.port}`;
  let evaluations = 0;
  server.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.method === "Runtime.evaluate") {
      evaluations += 1;
      if (evaluations === 1) return;
    }
    socket.send(JSON.stringify({ id: message.id, result: { result: { value: "ok" } } }));
  }));
  const page = new CdpPage(url);
  try {
    await page.open();
    await assert.rejects(page.evaluate("pending", 10, "确认下载路径"), error => {
      assert.ok(error instanceof CdpTimeoutError);
      assert.equal(error.timeoutMs, 10);
      assert.equal(error.operation, "确认下载路径");
      assert.match(error.message, /Runtime.evaluate.*0.01 秒/);
      return true;
    });
    assert.equal(evaluations, 1); // Side effects are never retried by the transport.
    assert.equal(await page.evaluate("next", 1000), "ok");
    const original = new CdpTimeoutError({ message: "timeout", operation: "test", timeoutMs: 5 });
    await assert.rejects(withPage({ id: "test", type: "page", title: "", url: "", webSocketDebuggerUrl: url }, async () => { throw original; }), error => error === original);
  } finally {
    page.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("evaluations allow a slow client 60 seconds by default and retain explicit short probes", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const page = new CdpPage(`ws://127.0.0.1:${address.port}`);
  server.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    socket.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  try {
    await page.open();
    const budgets: number[] = [];
    page.send = async <T>(_method: string, _params = {}, timeoutMs = 15000): Promise<T> => {
      budgets.push(timeoutMs);
      return { result: { value: true } } as T;
    };
    await page.evaluate("default");
    await page.evaluate("probe", 4000);
    assert.deepEqual(budgets, [60_000, 4000]);
  } finally {
    page.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
