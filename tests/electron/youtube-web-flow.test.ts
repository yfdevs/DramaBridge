import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { _electron } from "playwright";
import { YoutubeWebServer, type Json } from "../../packages/youtube-automation/src/index.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

test(
  "browser adds upload tasks and submits remote OAuth callback without Electron IPC",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(path.join(root, ".cache/youtube-web-flow-"));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const server = new YoutubeWebServer();
    const tasks: Json[] = [];
    let oauth: Json = { status: "idle", message: "" };
    let submitted = false;
    await server.start({
      port,

      directory: path.join(root, "dist"),
      status: () => ({ running: true, starting: false, installing: false, logDir: "" }),
      request: async (route, body): Promise<Json> => {
        if (route === "/api/accounts")
          return { accounts: [{ id: "default", name: "Web channel", authorized: true }] };
        if (route === "/api/environment")
          return {
            ready: true,
            compatible: true,
            python: "3.12",
            ffmpeg: true,
            ffprobe: true,
            modules: {},
          };
        if (route === "/api/oauth/status") return oauth;
        if (route === "/api/tasks" && body === undefined)
          return { tasks, settings: { paused: false } };
        if (route === "/api/tasks") {
          assert.equal((body as { noUpload: boolean }).noUpload, false);
          tasks.push({
            id: "1234-abcd",
            status: "queued",
            payload: body!,
            created: "",
            updated: "",
            logs: "",
          });
          return { id: "1234-abcd" };
        }
        if (route === "/api/oauth/start") {
          oauth = { status: "pending", message: "等待授权" };
          return { url: "https://accounts.google.com/o/oauth2/auth?state=browser-test" };
        }
        if (route === "/api/oauth/complete") {
          assert.equal(
            (body as { callbackUrl: string }).callbackUrl,
            "http://127.0.0.1:12345/api/oauth/callback?state=browser-test&code=test-code",
          );
          submitted = true;
          oauth = { status: "succeeded", message: "授权已保存" };
          return oauth;
        }
        throw new Error("Unexpected route: " + route);
      },
    });
    const bootstrap = path.join(directory, "bootstrap.mjs");
    await writeFile(
      bootstrap,
      `import { app, BrowserWindow } from 'electron'; app.setPath('userData',${JSON.stringify(path.join(directory, "profile"))}); app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}});void window.loadURL('http://127.0.0.1:${port}');});`,
    );
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    );
    const electron = await _electron
      .launch({
        executablePath: require("electron"),
        args: [bootstrap],
        env: environment,
      })
      .catch(async (error) => {
        await server.stop();
        await rm(directory, { recursive: true, force: true });
        throw error;
      });
    try {
      const page = await electron.firstWindow();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await electron
        .context()
        .route("https://accounts.google.com/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<h1>Test OAuth</h1>" }),
        );

      await page.getByRole("heading", { name: "任务队列", exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () => typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
        ),
        "undefined",
      );
      await page
        .getByRole("navigation", { name: "YouTube 页面" })
        .getByRole("link", { name: "添加任务", exact: true })
        .click();
      await page.getByLabel("剧名", { exact: true }).fill("Web 上传测试");
      await page
        .getByLabel("百度网盘分享链接及提取码")
        .fill("https://pan.baidu.com/s/test 提取码 abcd");
      await page.getByRole("combobox", { name: "处理模式", exact: true }).click();
      await page.getByRole("option", { name: "合并静音", exact: true }).click();
      await page.getByRole("switch", { name: "高画质压缩", exact: true }).click();
      await page.getByRole("button", { name: "加入队列", exact: true }).click();
      await page.getByRole("button", { name: "Web 上传测试", exact: true }).waitFor();
      assert.equal(tasks.length, 1);
      const payload = (tasks[0] as { payload: { mode: string; compress: boolean } }).payload;
      assert.equal(payload.mode, "mute");
      assert.equal(payload.compress, true);
      await page.getByText("合并静音 · 高画质压缩", { exact: true }).waitFor();
      await page.getByRole("link", { name: "账号管理", exact: true }).click();
      const popup = electron.context().waitForEvent("page", { timeout: 10000 });
      await page.getByRole("button", { name: "重新授权", exact: true }).click();
      await (await popup).getByRole("heading", { name: "Test OAuth", exact: true }).waitFor();
      await page
        .getByLabel("授权回调地址")
        .fill("http://127.0.0.1:12345/api/oauth/callback?state=browser-test&code=test-code");
      await page.getByRole("button", { name: "提交授权", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "授权已保存" }).first().waitFor();
      assert.equal(submitted, true);
      assert.deepEqual(errors, []);
    } finally {
      await electron.close();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
