import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import { WebSocketServer } from "ws";
import { saveShareToOwnNetdisk } from "../../src/workflows/download-baidu-folder.js";

test("real injected transfer script uses fresh share metadata and rejects -9 before any cloud write", async () => {
  for (const rootState of ["valid", "missing", "empty"]) {
    const failRoot = rootState === "missing";
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const title = "周丽君-被断销路，我建冷库破局";
    const real = "/原始素材/" + title;
    const virtual = "/sharelink1099807332123-176267936097208/" + title;
    const root = { fs_id: 10, path: real, server_filename: title, isdir: 1, size: 0 };
    const fresh = { shareid: "123", share_uk: "456", bdstoken: "fresh-token", file_list: [root] };
    const calls: string[] = [];
    let writes = 0;
    server.on("connection", (socket) => {
      socket.on("message", async (raw) => {
        const message = JSON.parse(String(raw));
        try {
          const value =
            message.method === "Runtime.evaluate"
              ? await runInNewContext(message.params.expression, {
                  URL,
                  URLSearchParams,
                  AbortController,
                  setTimeout,
                  clearTimeout,
                  location: { href: "https://pan.baidu.com/s/1fresh" },
                  document: { cookie: "", querySelectorAll: () => [] },
                  localStorage: { getItem: () => "", setItem: () => undefined },
                  // Deliberately stale metadata matches the requested title. It must
                  // not take precedence over HTML fetched from the verified link.
                  yunData: {
                    shareid: "old",
                    share_uk: "old",
                    bdstoken: "old",
                    file_list: [{ ...root, path: virtual }],
                  },
                  console: { log: () => undefined },
                  fetch: async (input: string, init: RequestInit) => {
                    const url = new URL(input, "https://pan.baidu.com");
                    calls.push(url.pathname);
                    if (url.pathname === "/share/verify")
                      return { ok: true, json: async () => ({ errno: 0, randsk: "fixture" }) };
                    if (init.method === "POST") {
                      writes++;
                      throw new Error("unexpected cloud write");
                    }
                    if (url.pathname === "/s/1fresh")
                      return {
                        ok: true,
                        text: async () => `locals.mset(${JSON.stringify(fresh)})`,
                      };
                    if (url.pathname === "/share/list") {
                      assert.equal(url.searchParams.get("shareid"), "123");
                      assert.equal(url.searchParams.get("uk"), "456");
                      assert.equal(url.searchParams.get("bdstoken"), "fresh-token");
                      if (url.searchParams.get("root") === "1") {
                        assert.equal(url.searchParams.has("dir"), false);
                        return {
                          ok: true,
                          json: async () =>
                            failRoot
                              ? { errno: -9, request_id: "987" }
                              : { errno: 0, list: rootState === "empty" ? [] : [root] },
                        };
                      }
                      assert.equal(url.searchParams.get("root"), "0");
                      assert.equal(url.searchParams.get("dir"), real);
                      return {
                        ok: true,
                        json: async () => ({
                          errno: 0,
                          list: [
                            {
                              fs_id: 11,
                              path: real + "/第1集.mp4",
                              server_filename: "第1集.mp4",
                              isdir: 0,
                              size: 10,
                            },
                          ],
                        }),
                      };
                    }
                    if (url.pathname === "/api/list")
                      throw new Error("confirmed correct source before transfer");
                    throw new Error("unexpected endpoint: " + url.pathname);
                  },
                })
              : undefined;
          socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
        } catch (error) {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { exceptionDetails: { exception: { description: String(error) } } },
            }),
          );
        }
      });
    });
    try {
      await assert.rejects(
        saveShareToOwnNetdisk(
          {
            id: "share",
            type: "page",
            title,
            url: "https://pan.baidu.com/s/1fresh",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
          },
          { name: title, link: "https://pan.baidu.com/s/1fresh", pwd: "1234" },
        ),
        failRoot
          ? /errno=-9.*request_id=987/
          : rootState === "empty"
            ? /没有解析到可转存文件元数据/
            : /confirmed correct source before transfer/,
      );
      assert.equal(writes, 0);
      assert.equal(
        calls.filter((endpoint) => endpoint === "/share/list").length,
        rootState === "valid" ? 2 : 1,
      );
      assert.equal(calls.includes("/api/list"), rootState === "valid");
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
