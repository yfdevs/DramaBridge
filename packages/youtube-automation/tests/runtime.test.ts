import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { allowedYoutubeRequest, YoutubePythonRuntime, type YoutubeSettings } from "../src/index.js";

test("request routes reject external URLs and path traversal", () => {
  for (const route of [
    "https://example.com/api/tasks",
    "/api/tasks/../../storage",
    "/api/service/stop",
    "/api/storage/cleanup",
    "/api/tasks?x=1",
  ]) {
    assert.equal(allowedYoutubeRequest(route, true), false);
    assert.equal(allowedYoutubeRequest(route, false), false);
  }
  assert.equal(allowedYoutubeRequest("/api/tasks/0123-abcd/pause", true), true);
});

test(
  "actual Python bridge owns lifecycle and uses parent Netdisk/config callbacks",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dramabridge-youtube-test-"));
    const runtime = new YoutubePythonRuntime();
    const calls: string[] = [],
      settings: Partial<YoutubeSettings>[] = [],
      logs: string[] = [];
    const options = {
      sourceDirectory: fileURLToPath(new URL("../python", import.meta.url)),
      workingDirectory: directory,
      pythonExecutable: process.platform === "win32" ? "python" : "python3",
      mediaDirectories: [],
      settings: { proxy: "", paused: true },
      netdisk: async ({ path: route }: { path: string }) => {
        calls.push(route);
        return { ready: true };
      },
      saveSettings: (value: Partial<YoutubeSettings>) => {
        settings.push(value);
      },
      log: (line: string) => logs.push(line),
    };
    try {
      const inspection = (await runtime.inspectEnvironment(options)) as { python: string };
      assert.equal(typeof inspection.python, "string");
      assert.equal(runtime.status().running, false);
      await runtime.start(options);
      assert.equal(runtime.status().running, true, logs.join("\n"));
      const initial = await runtime.request<{ tasks: unknown[]; settings: YoutubeSettings }>(
        "/api/tasks",
      );
      assert.deepEqual(initial.tasks, []);
      assert.equal(initial.settings.proxy, "");
      await runtime.request("/api/status");
      assert.deepEqual(calls, ["/baidu-netdisk/status"]);
      await runtime.request("/api/settings", { proxy: "http://127.0.0.1:7890", paused: true });
      assert.equal(settings.at(-1)?.proxy, "http://127.0.0.1:7890");
      const account = await runtime.request<{ id: string }>("/api/accounts", {
        name: "Test channel",
      });
      assert.match(account.id, /^[a-f0-9]{32}$/);
      const environment = await runtime.request<{ python: string; ready: boolean }>(
        "/api/environment",
      );
      assert.equal(typeof environment.ready, "boolean");
      if (!environment.ready)
        await assert.rejects(
          runtime.request("/api/tasks", {
            resourceName: "test",
            shareText: "https://pan.baidu.com/s/test",
            noUpload: true,
          }),
          /环境尚未就绪/,
        );
      await assert.rejects(runtime.request("/api/storage/cleanup", {}));
      await runtime.stop();
      assert.equal(runtime.status().running, false);
      await runtime.start(options);
      const accounts = await runtime.request<{ accounts: { id: string }[] }>("/api/accounts");
      assert.ok(accounts.accounts.some((item) => item.id === account.id));
      assert.equal(
        (await runtime.request<{ settings: YoutubeSettings }>("/api/tasks")).settings.proxy,
        "",
        "configuration must come from Electron, not Python SQLite",
      );
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
