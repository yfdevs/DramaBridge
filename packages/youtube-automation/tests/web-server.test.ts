import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { YoutubeWebServer, type Json } from "../src/index.js";
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}

test("Web access works without login, rejects cross-origin requests, and shares tasks/OAuth", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-web-test-"));
  const server = new YoutubeWebServer(),
    webPort = await port();
  const calls: { route: string; body?: Json }[] = [];
  await writeFile(
    path.join(directory, "youtube-web.html"),
    "<!doctype html><title>YouTube</title>",
  );
  try {
    const options: Parameters<YoutubeWebServer["start"]>[0] = {
      port: webPort,
      directory,
      status: () => ({ running: true }),
      request: async (route, body): Promise<Json> => {
        calls.push({ route, body });
        return route === "/api/oauth/start"
          ? { url: "https://accounts.google.com/o/oauth2/auth?state=test" }
          : route === "/api/tasks" && body === undefined
            ? { tasks: [], settings: { proxy: "private-proxy", paused: false } }
            : { id: "test-task" };
      },
    };
    await Promise.all([server.start(options), server.start(options)]);

    const url = `http://127.0.0.1:${webPort}`;
    assert.equal((await fetch(url)).status, 200);
    const status = await fetch(url + "/web-api/status");
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("set-cookie"), null);
    const request = (route: string, body?: Json, origin?: string) =>
      fetch(url + "/web-api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ route, body }),
      });
    assert.equal((await request("/api/tasks", {}, "http://evil.example")).status, 403);
    assert.equal((await request("/api/storage/cleanup", {})).status, 403);
    assert.equal((await request("/api/settings", { proxy: "http://evil.example" })).status, 403);
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        httpRequest(url + "/web-api/status", { headers: { host: "evil.example" } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
          .on("error", reject)
          .end();
      }),
      403,
    );
    assert.equal(
      (await request("/api/tasks", { resourceName: "Test", noUpload: true })).status,
      200,
    );
    assert.deepEqual(calls.at(-1), {
      route: "/api/tasks",
      body: { resourceName: "Test", noUpload: false },
    });
    const tasks = await (await request("/api/tasks")).json();
    assert.deepEqual(tasks.settings, { paused: false });
    const oauth = await (await request("/api/oauth/start", { accountId: "default" })).json();
    assert.equal(oauth.manual, true);
    await request("/api/oauth/complete", {
      callbackUrl: "http://127.0.0.1:1234/api/oauth/callback?state=test&code=test",
    });
    assert.equal(calls.at(-1)?.route, "/api/oauth/complete");
    await server.stop();
    assert.deepEqual(server.urls(), []);
    await assert.rejects(fetch(url));
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
