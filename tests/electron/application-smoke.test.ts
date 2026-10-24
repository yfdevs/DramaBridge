import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { _electron } from "playwright";

declare global {
  interface Window { ipcRenderer: import("electron").IpcRenderer }
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const mainEntry = path.join(root, "dist-electron/main.js");
const require = createRequire(import.meta.url);
const platforms = [
  "wechat-drama", "wechat-miniprogram-drama", "meituan-drama", "taobao-drama",
  "kuaishou-drama", "qq-drama", "tencent-huolong-drama", "iqiyi-drama",
  "baidu-drama", "douyin-drama", "tiktok-drama", "pinduoduo-drama",
];

test("built Electron app supports platform IPC, settings, database and smooth corners", {
  skip: !existsSync(mainEntry),
  timeout: 180_000,
}, async () => {
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "electron-app-smoke-"));
  const bootstrap = path.join(directory, "bootstrap.mjs");
  // Seed configuration through electron-store in a temporary user profile.
  // An explicitly missing Baidu executable prevents its startup probe from
  // launching or restarting the user's actual Netdisk client.
  await writeFile(bootstrap, `
    import { app } from 'electron';
    import { mkdirSync } from 'node:fs';
    const directory = ${JSON.stringify(directory)};
    mkdirSync(directory + '/profile', { recursive: true });
    app.setPath('userData', directory + '/profile');
    app.on('browser-window-created', (_event, window) => window.hide());
    const Store = (await import('electron-store')).default;
    const config = new Store({ name: 'global-app-config' });
    config.set('config.runDataRoot', directory + '/runs');
    config.set('config.localMaterialRoot', directory + '/materials');
    config.set('config.theme', 'light');
    config.set('config.aiModel', '');
    new Store({ name: 'baidu-netdisk-config' }).set('config.executablePath', directory + '/missing.exe');
    await import(${JSON.stringify(pathToFileURL(mainEntry).href)});
  `);
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
  ));
  let electron = await _electron.launch({
    executablePath: require("electron"), args: [bootstrap], env: environment,
    timeout: 30_000,
  });
  try {
    const page = await electron.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".app-workspace");
    await electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 900);
    });
    const versions = await electron.evaluate(() => process.versions);
    assert.ok(Number(versions.chrome!.split(".")[0]) >= 139);
    assert.equal(await page.evaluate(() => CSS.supports("corner-shape", "squircle")), true);

    for (const platform of platforms) {
      const result = await page.evaluate(async (platform) => ({
        runtime: await window.ipcRenderer.invoke("app:platform:runtime", platform),
        config: await window.ipcRenderer.invoke(`${platform}:config:get`),
        status: await window.ipcRenderer.invoke(`${platform}:service:status`),
      }), platform);
      assert.ok(result.runtime, `${platform} runtime IPC`);
      assert.ok(result.config, `${platform} configuration IPC`);
      assert.ok(result.status, `${platform} service IPC`);
      for (const route of ["service", "config", "statistics", "logs"]) {
        await page.evaluate(async (hash) => {
          location.hash = hash;
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }, `/${platform}/${route}`);
        await page.waitForFunction(() => Boolean(document.querySelector(".app-workspace")?.textContent?.trim()));
        assert.ok(await page.locator(".app-workspace").innerText(), `${platform}/${route} renders`);
      }
    }
    for (const route of ["wechat-drama/accounts", "wechat-drama/publish", "pinduoduo-drama/records", "app/config", "app/updates"]) {
      await page.evaluate(async (hash) => {
        location.hash = hash;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, `/${route}`);
      await page.waitForFunction(() => Boolean(document.querySelector(".app-workspace")?.textContent?.trim()));
      assert.ok(await page.locator(".app-workspace").innerText(), `${route} renders`);
    }
    await page.evaluate(() => { location.hash = "/pinduoduo-drama/logs"; });
    const levelSelector = page.getByRole("combobox", { name: "日志级别" });
    await levelSelector.click();
    await page.getByRole("listbox").waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(cache, "electron-corners-menu.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "hidden" });

    if (await electron.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())) {
      const key = await page.evaluate(async () => {
        const current = await window.ipcRenderer.invoke("app:config:get");
        await window.ipcRenderer.invoke("app:config:save", { ...current.config, aiApiKey: "electron-upgrade-smoke-key" });
        return (await window.ipcRenderer.invoke("app:config:get")).config.aiApiKey;
      });
      assert.equal(key, "electron-upgrade-smoke-key");
    }

    await page.evaluate(() => { location.hash = "/app/config"; });
    const localOcrSwitch = page.getByRole("switch", { name: "优先使用本机识别" });
    await localOcrSwitch.waitFor();
    assert.equal((await page.evaluate(() => window.ipcRenderer.invoke("app:config:get"))).config.ownershipLocalOcrEnabled, false);
    await page.getByRole("button", { name: "测试是否可用" }).click();
    await page.waitForFunction(() => /本机识别可用|本机识别暂不可用|这台电脑不支持本机识别/.test(document.body.innerText));
    await page.getByRole("button", { name: "测试是否可用" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(cache, "electron-local-ocr-settings.png") });
    await localOcrSwitch.click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(async () => (await window.ipcRenderer.invoke("app:config:get")).config.ownershipLocalOcrEnabled === true);

    const savedTheme = await page.evaluate(async () => {
      const current = await window.ipcRenderer.invoke("app:config:get");
      await window.ipcRenderer.invoke("app:config:save", { ...current.config, theme: "dark" });
      return window.ipcRenderer.invoke("app:theme:get");
    });
    assert.equal(savedTheme, "dark");
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.screenshot({ path: path.join(cache, "electron-corners-dark.png") });
    await page.evaluate(async () => {
      const current = await window.ipcRenderer.invoke("app:config:get");
      await window.ipcRenderer.invoke("app:config:save", { ...current.config, theme: "light" });
    });
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await page.screenshot({ path: path.join(cache, "electron-corners-light.png") });

    const corners = await page.locator('[data-slot="button"]').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { shape: style.getPropertyValue("corner-shape"), radius: style.borderTopLeftRadius };
    });
    assert.ok(["squircle", "superellipse(2)"].includes(corners.shape));
    assert.ok(Number.parseFloat(corners.radius) > 0);
    const round = await page.locator(".rounded-full").first().evaluate((element) => ({
      shape: getComputedStyle(element).getPropertyValue("corner-shape"),
      radius: getComputedStyle(element).borderTopLeftRadius,
    }));
    assert.ok(["round", "superellipse(1)"].includes(round.shape));
    assert.ok(Number.parseFloat(round.radius) > 0);

    const integrity = await electron.evaluate(({ app }) => {
      const Database = globalThis.require("better-sqlite3");
      const path = globalThis.require("node:path");
      const database = new Database(path.join(app.getPath("userData"), "automation.sqlite"));
      try {
        const tables = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
        database.exec("CREATE TABLE upgrade_smoke (value TEXT NOT NULL UNIQUE)");
        database.transaction(() => {
          database.prepare("INSERT INTO upgrade_smoke VALUES (?)").run("first");
          database.prepare("INSERT INTO upgrade_smoke VALUES (?)").run("second");
        })();
        try {
          database.transaction(() => {
            database.prepare("INSERT INTO upgrade_smoke VALUES (?)").run("third");
            database.prepare("INSERT INTO upgrade_smoke VALUES (?)").run("first");
          })();
        } catch { /* A uniqueness failure must roll back the whole transaction. */ }
        const rows = database.prepare("SELECT value FROM upgrade_smoke ORDER BY value").all();
        const check = database.pragma("integrity_check", { simple: true });
        database.exec("DROP TABLE upgrade_smoke");
        return { tables, rows, check };
      } finally { database.close(); }
    });
    assert.ok(integrity.tables > 0);
    assert.deepEqual(integrity.rows, [{ value: "first" }, { value: "second" }]);
    assert.equal(integrity.check, "ok");
    assert.deepEqual(errors, []);

    {
      const probe = createServer();
      await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
      const apiPort = (probe.address() as { port: number }).port;
      await new Promise<void>(resolve => probe.close(() => resolve()));
      const initialApi = await page.evaluate(() => window.ipcRenderer.invoke("app:config:external-api:get"));
      assert.equal(initialApi.config.enabled, false);
      assert.equal(initialApi.status.running, false);
      await page.evaluate(() => { location.hash = "/app/config"; });
      const apiSwitch = page.getByRole("switch", { name: "开启接口服务" });
      await apiSwitch.waitFor();
      await page.locator("#port").fill(String(apiPort));
      await apiSwitch.click();
      await page.waitForFunction(() => document.body.innerText.includes("运行中 · http://127.0.0.1:"));
      const api = await page.evaluate(() => window.ipcRenderer.invoke("app:config:external-api:get"));
      assert.equal(api.config.enabled, true);
      assert.equal(api.config.port, String(apiPort));
      assert.deepEqual(Object.keys(api.config).sort(), ["enabled", "port"]);
      assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status, 200);
      const persistedTaskId = await electron.evaluate(({ app }) => {
        const Database = globalThis.require("better-sqlite3");
        const path = globalThis.require("node:path");
        const database = new Database(path.join(app.getPath("userData"), "automation.sqlite"));
        const now = new Date().toISOString();
        const task = { taskId: "smoke-external-persistence", attempt: 1,
          request: { requestId: "smoke-persistence", shareText: "https://pan.baidu.com/s/test?pwd=1234",
            resourceName: "回归测试", episodeCount: 1, timeoutSeconds: 60 },
          fingerprint: "smoke", status: "queued", createdAt: now, updatedAt: now,
          deadlineAt: new Date(Date.now() + 60_000).toISOString() };
        try {
          database.prepare("INSERT INTO baidu_netdisk_external_tasks VALUES (?, ?, ?, ?)")
            .run(task.taskId, task.request.requestId, now, JSON.stringify(task));
          return task.taskId;
        } finally { database.close(); }
      });
      assert.equal((await (await fetch(`http://127.0.0.1:${apiPort}/api/baidu-netdisk/downloads/${persistedTaskId}`)).json()).data.status, "queued");
      await page.getByRole("button", { name: "复制接口地址" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(cache, "electron-local-api-settings.png") });

      // Saving ordinary global settings must preserve the independently saved API settings.
      await page.evaluate(async () => {
        const current = await window.ipcRenderer.invoke("app:config:get");
        await window.ipcRenderer.invoke("app:config:save", { ...current.config, theme: "light" });
      });
      assert.equal((await page.evaluate(() => window.ipcRenderer.invoke("app:config:external-api:get"))).config.enabled, true);
      assert.deepEqual(errors, []);
      await electron.close();
      await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/api/health`));
      electron = await _electron.launch({ executablePath: require("electron"), args: [bootstrap], env: environment, timeout: 30_000 });
      const restartedPage = await electron.firstWindow();
      await restartedPage.waitForSelector(".app-workspace");
      assert.equal((await restartedPage.evaluate(() => window.ipcRenderer.invoke("app:config:get"))).config.ownershipLocalOcrEnabled, true);
      const restoredApi = await restartedPage.evaluate(() => window.ipcRenderer.invoke("app:config:external-api:get"));
      assert.equal(restoredApi.config.enabled, true);
      assert.equal(restoredApi.status.running, true);
      assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status, 200);
      const recoveredTask = await (await fetch(`http://127.0.0.1:${apiPort}/api/baidu-netdisk/downloads/${persistedTaskId}`)).json();
      assert.equal(recoveredTask.data.status, "interrupted");
      const stoppedApi = await restartedPage.evaluate(async config => window.ipcRenderer.invoke(
        "app:config:external-api:save", { ...config, enabled: false }), restoredApi.config);
      assert.equal(stoppedApi.status.running, false);
      await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/api/health`));
    }
  } finally {
    await electron.close();
    assert.equal(path.dirname(directory), cache);
    assert.ok(path.basename(directory).startsWith("electron-app-smoke-"));
    await rm(directory, { recursive: true, force: true });
  }
});
