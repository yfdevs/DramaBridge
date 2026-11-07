import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { WebSocketServer } from "ws";
import { saveShareToOwnNetdisk } from "../../src/workflows/download-baidu-folder.js";

async function transferFixture(failure: "404" | "500" | "network" | "timeout", accepted: boolean) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const title = "重试测试剧";
  const sourcePath = "/原始素材/" + title;
  const sourceDirectory = { fs_id: 10, path: sourcePath, server_filename: title, isdir: 1 };
  const destinationDirectory = { ...sourceDirectory, fs_id: 20, path: "/" + title };
  const sourceFile = { fs_id: 11, path: sourcePath + "/" + title + "-第1集.mp4",
    server_filename: title + "-第1集.mp4", isdir: 0, size: 10, md5: "verified-content" };
  let transfers = 0;
  let verificationReads = 0;
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const fastTimeout = (callback: () => void, milliseconds: number) => {
    // Request deadlines are cancelled normally. Accelerate only workflow waits.
    const timer = setTimeout(() => {
      timers.delete(timer);
      clock += milliseconds;
      callback();
    }, milliseconds === 30_000 ? 60_000 : 0);
    timers.add(timer);
    return timer;
  };
  server.on("connection", socket => socket.on("message", async raw => {
    const message = JSON.parse(String(raw));
    try {
      const value = message.method === "Runtime.evaluate"
        ? await runInNewContext(message.params.expression, {
          __name: (value: unknown) => value,
          URL, URLSearchParams, AbortController, Date: Clock,
          setTimeout: fastTimeout, clearTimeout,
          location: { href: "https://pan.baidu.com/s/1retry" },
          document: { cookie: "", querySelectorAll: () => [] },
          localStorage: { getItem: () => "", setItem: () => undefined },
          console: { log: () => undefined },
          fetch: async (input: string, init: RequestInit = {}) => {
            const url = new URL(input, "https://pan.baidu.com");
            const json = (data: unknown) => ({ ok: true, json: async () => data });
            if (url.pathname === "/share/verify") return json({ errno: 0, randsk: "fixture" });
            if (url.pathname === "/s/1retry") return { ok: true,
              text: async () => `locals.mset(${JSON.stringify({ shareid: "123", share_uk: "456",
                bdstoken: "fixture", file_list: [sourceDirectory] })})` };
            if (url.pathname === "/share/list") return json({ errno: 0,
              list: url.searchParams.get("root") === "1" ? [sourceDirectory] : [sourceFile] });
            if (url.pathname === "/api/list") {
              if (url.searchParams.get("dir") === "/") return json({ errno: 0, list: [destinationDirectory] });
              if (transfers > 0) verificationReads++;
              return json({ errno: 0, list: accepted && transfers > 0
                ? [{ ...sourceFile, fs_id: 21, path: "/" + title + "/" + sourceFile.server_filename }] : [] });
            }
            if (url.pathname === "/share/transfer") {
              transfers++;
              assert.equal(init.method, "POST");
              assert.equal(new URLSearchParams(String(init.body)).get("path"), "/" + title);
              if (failure === "network") throw new Error("Failed to fetch");
              if (failure === "timeout") throw new Error("百度网盘接口请求超时（30 秒）");
              return { ok: false, status: Number(failure), redirected: false, url: url.href,
                headers: { get: () => "text/html" } };
            }
            throw new Error("unexpected endpoint: " + url.pathname);
          },
        }) : undefined;
      socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
    } catch (error) {
      socket.send(JSON.stringify({ id: message.id,
        result: { exceptionDetails: { exception: { description: String(error) } } } }));
    }
  }));
  try {
    const operation = saveShareToOwnNetdisk({ id: "share", type: "page", title,
      url: "https://pan.baidu.com/s/1retry", webSocketDebuggerUrl: `ws://127.0.0.1:${port}` },
    { name: title, link: "https://pan.baidu.com/s/1retry", pwd: "1234" }, { normalizedVideoEpisodeCount: 1 });
    if (accepted) {
      const result = await operation;
      assert.equal(result.remoteVideos.files.length, 1);
      assert.equal(transfers, 1, "a verified accepted write must never be replayed after a lost response");
    } else {
      await assert.rejects(operation, /已尝试3次.*目标目录仍未发现素材/);
      assert.equal(transfers, 3, "initial call plus two retries must total exactly three writes");
    }
    assert.ok(verificationReads > 0, "uncertain writes must invalidate cached absence and reread destination");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

for (const failure of ["404", "500", "network", "timeout"] as const) {
  test(`injected transfer bounds ${failure} failures to three writes`, () => transferFixture(failure, false));
  test(`injected transfer reconciles accepted ${failure} writes before retry`, () => transferFixture(failure, true));
}
