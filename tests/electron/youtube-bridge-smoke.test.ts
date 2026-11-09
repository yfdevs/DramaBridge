import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { _electron } from "playwright";

declare global {
  interface Window {
    ipcRenderer: import("electron").IpcRenderer;
  }
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

test("YouTube native pages and Python IPC run in built Electron", { timeout: 60000 }, async () => {
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache/youtube-smoke-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const webPort = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const bootstrap = path.join(directory, "bootstrap.mjs");
  await writeFile(
    bootstrap,
    `
    import { app } from 'electron'; import { mkdirSync } from 'node:fs';
    const directory = ${JSON.stringify(directory)};
    mkdirSync(directory + '/profile', {recursive:true}); app.setPath('userData', directory + '/profile'); app.setAppPath(${JSON.stringify(root)});
    app.on('browser-window-created', (_, window) => window.hide());
    const Store = (await import('electron-store')).default;
    const global = new Store({name:'global-app-config'});
    global.set('config.runDataRoot', directory+'/runs'); global.set('config.localMaterialRoot', directory+'/materials');
    new Store({name:'baidu-netdisk-config'}).set('config.executablePath', directory+'/missing.exe');
    new Store({name:'youtube-drama-config'}).set('config', {webPort:${webPort},pythonExecutable:${JSON.stringify(process.platform === "win32" ? "python" : "python3")}});
    await import(${JSON.stringify(pathToFileURL(path.join(root, "dist-electron/main.js")).href)});
  `,
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const electron = await _electron.launch({
    executablePath: require("electron"),
    args: [bootstrap],
    env: environment,
  });
  try {
    const page = await electron.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".app-workspace");
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000),
    );
    await page.evaluate(() => {
      location.hash = "/youtube-drama/config";
    });
    await page.getByRole("heading", { name: "YouTube 配置", exact: true }).waitFor();
    await page.getByLabel("YouTube 代理端口").fill("");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
    await page.getByLabel("YouTube 代理端口").fill("7890");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      async () =>
        (await window.ipcRenderer.invoke("youtube-drama:config:get")).config.proxy ===
        "http://127.0.0.1:7890",
    );
    await page.getByLabel("YouTube 代理端口").fill("65536");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "端口应为 1–65535" }).waitFor();
    await page.getByLabel("YouTube 代理端口").fill("7890");
    assert.equal(await page.getByText("数据目录", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "检查环境", exact: true }).click();
    await page.getByLabel("环境检查结果").waitFor();
    assert.equal(
      (await page.evaluate(() => window.ipcRenderer.invoke("youtube-drama:service:status")))
        .running,
      false,
      "checking environment must not start the worker",
    );
    await page.screenshot({ path: path.join(root, ".cache/youtube-configuration.png") });
    await page.evaluate(() => {
      location.hash = "/youtube-drama/service";
    });
    await page.getByRole("heading", { name: "YouTube 工作台", exact: true }).waitFor();
    const status = await page.evaluate(() =>
      window.ipcRenderer.invoke("youtube-drama:service:start"),
    );
    assert.equal(status.running, true);
    assert.ok(status.webUrls.includes(`http://127.0.0.1:${webPort}`));
    const webPagePromise = electron.context().waitForEvent("page");
    await electron.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      void window.loadURL(url);
    }, status.webUrls[0]);
    const webPage = await webPagePromise;

    await webPage.getByRole("heading", { name: "任务队列", exact: true }).waitFor();
    assert.equal(await webPage.evaluate(() => typeof window.ipcRenderer), "undefined");
    await webPage.getByRole("link", { name: "账号管理", exact: true }).click();
    await webPage.getByLabel("新账号名称").fill("Web channel");
    await webPage.getByRole("button", { name: "添加账号", exact: true }).click();
    await webPage.getByRole("heading", { name: "Web channel", exact: true }).waitFor();
    assert.ok(
      (
        await page.evaluate(() =>
          window.ipcRenderer.invoke("youtube-drama:api:request", "/api/accounts"),
        )
      ).accounts.some((account: { name: string }) => account.name === "Web channel"),
    );
    await webPage.screenshot({ path: path.join(root, ".cache/youtube-web-accounts.png") });
    await webPage.close();
    const env = await page.evaluate(() =>
      window.ipcRenderer.invoke("youtube-drama:api:request", "/api/environment"),
    );
    assert.equal(typeof env.python, "string");
    assert.equal(typeof env.ffmpeg, "boolean");
    assert.equal(env.ffmpeg, true, "bundled FFmpeg must be available to Python");
    await page.waitForFunction(() => document.body.innerText.includes("服务运行中"));
    await page.getByRole("link", { name: "账号管理" }).click();
    await page.getByRole("heading", { name: "YouTube 账号管理", exact: true }).waitFor();
    await page.getByLabel("新账号名称").fill("Smoke channel");
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    await page.getByRole("heading", { name: "Smoke channel", exact: true }).waitFor();
    const accountRow = page
      .locator('section[aria-label="YouTube 账号列表"] > div')
      .filter({ has: page.getByRole("heading", { name: "Smoke channel", exact: true }) });
    await accountRow.getByRole("button", { name: "重命名", exact: true }).click();
    await page.getByLabel("修改账号名称").fill("Renamed channel");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByRole("heading", { name: "Renamed channel", exact: true }).waitFor();
    await page.screenshot({ path: path.join(root, ".cache/youtube-accounts.png") });
    const renamedRow = page
      .locator('section[aria-label="YouTube 账号列表"] > div')
      .filter({ has: page.getByRole("heading", { name: "Renamed channel", exact: true }) });
    await renamedRow.getByRole("button", { name: "删除", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "删除账号", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Renamed channel", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "添加任务", exact: true }).click();
    await page.getByRole("heading", { name: "添加 YouTube 任务", exact: true }).waitFor();
    await page.getByLabel("剧名", { exact: true }).fill("示例短剧");
    await page
      .getByLabel("百度网盘分享链接及提取码")
      .fill("https://pan.baidu.com/s/example 提取码 abcd");
    await page.getByRole("combobox", { name: "处理模式" }).click();
    await page.getByRole("option", { name: "逐集分离", exact: true }).click();
    await page.getByRole("button", { name: "上传信息", exact: false }).click();
    await page.getByLabel("上传标题", { exact: true }).fill("示例标题");
    assert.equal(await page.getByRole("switch").count(), 0);
    await page.getByLabel("标签", { exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    await page.screenshot({ path: path.join(root, ".cache/youtube-create-task.png") });
    await page.getByRole("link", { name: "任务列表", exact: true }).click();
    await page.getByRole("heading", { name: "任务队列", exact: true }).waitFor();
    assert.equal(await page.getByLabel("新账号名称").isVisible(), false);
    await page.screenshot({ path: path.join(root, ".cache/youtube-workspace.png") });
    await page.evaluate(() => window.ipcRenderer.invoke("youtube-drama:service:stop"));
    assert.equal(
      (await page.evaluate(() => window.ipcRenderer.invoke("youtube-drama:service:status")))
        .running,
      false,
    );
    await assert.rejects(fetch(`http://127.0.0.1:${webPort}`));
    assert.deepEqual(errors, []);
  } finally {
    await electron.close();
    await rm(directory, { recursive: true, force: true });
  }
});
