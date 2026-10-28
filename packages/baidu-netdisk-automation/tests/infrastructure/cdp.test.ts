import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CdpPage, withPage } from "../../src/infrastructure/cdp.js";
import { CdpTimeoutError } from "../../src/domain/errors.js";

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
