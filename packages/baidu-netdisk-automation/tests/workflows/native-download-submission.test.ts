import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { compileFunction, createContext, runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { submitNativeDownloadTask } from "../../src/workflows/download-baidu-folder.js";

test("submission survives disposed remote reads and a lost write result without duplicate downloads", async () => {
  for (const mode of ["stale-read", "lost-submit-result", "unknown-result"]) {
    const directory = await mkdtemp(path.join(tmpdir(), "baidu-native-submit-"));
    const task = {
      targetName: "第10集.mp4",
      savedPath: "/本剧/第10集.mp4",
      fsId: 10,
      size: 100,
      isDirectory: false,
      downloadRoot: directory,
    };
    let writes = 0,
      lostReads = 0,
      reads = 0,
      connections = 0;
    let accepted = false;
    const server = createServer((_request, response) => {
      const port = (server.address() as { port: number }).port;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify([
          {
            id: "core",
            type: "page",
            title: "BaiduNetdisk",
            url: "file:///core.asar/index.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}`,
          },
        ]),
      );
    });
    const sockets = new WebSocketServer({ server });
    const context = createContext({ setTimeout, clearTimeout });
    const app = {
      $downloader: {
        getDownloadTasks(callback: Function) {
          reads++;
          callback(
            0,
            0,
            {
              tasks: accepted
                ? [
                    {
                      id: "native10",
                      name: task.targetName,
                      server_path: task.savedPath,
                      local_path: path.join(directory, task.targetName),
                      size: 100,
                      finish_size: 10,
                      status: "downloading",
                    },
                  ]
                : [],
            },
            accepted ? 1 : 0,
          );
        },
        addDownloadTask(files: Array<{ server_path: string }>) {
          writes++;
          accepted = true;
          assert.equal(files[0].server_path, task.savedPath);
          if (mode === "lost-submit-result")
            throw new Error("submission response lost after acceptance");
          return 0;
        },
      },
    };
    sockets.on("connection", (socket) => {
      connections++;
      socket.on("message", async (raw) => {
        const message = JSON.parse(String(raw));
        try {
          const value =
            message.method === "Runtime.evaluate"
              ? await runInNewContext(message.params.expression, {
                  require: () => ({
                    app,
                    require: (name: string) => {
                      if (name === "electron") return { app };
                      if (name === "vm")
                        return {
                          compileFunction: (code: string, parameters: string[]) => {
                            if (accepted && (lostReads === 0 || mode === "unknown-result")) {
                              lostReads++;
                              throw new Error(
                                "Cannot get property 'tasks' on missing remote object 13710",
                              );
                            }
                            return compileFunction(code, parameters, { parsingContext: context });
                          },
                        };
                      throw new Error(name);
                    },
                  }),
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const result = await submitNativeDownloadTask(
        (server.address() as { port: number }).port,
        task,
      );
      assert.equal(writes, 1, "a failed read or lost response must never replay the write");
      assert.ok(connections >= 4, "reconnect for the safe read retry");
      if (mode === "unknown-result") {
        assert.equal(result.submitted, false);
        assert.match(result.error!, /下载提交结果尚未确认/);
        assert.equal(lostReads, 2, "read retries remain bounded");
        assert.equal(reads, 1, "a transport error is not an empty native task list");
      } else {
        assert.equal(result.submitted, true);
        assert.equal(lostReads, 1);
        assert.equal(reads, 2);
      }
    } finally {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
});
