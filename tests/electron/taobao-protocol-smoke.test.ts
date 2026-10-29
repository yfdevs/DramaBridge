import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import test from "node:test";
import { _electron } from "playwright";

declare global {
  interface Window { ipcRenderer: import("electron").IpcRenderer }
}

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const mainEntry = path.join(root, "dist-electron/main.js");

test("built Taobao service renders persistent attention records, verifies manual release and recovers reports without a browser", {
  skip: !existsSync(mainEntry), timeout: 90_000,
}, async () => {
  let remoteState = "UPLOADING";
  let accountData: Array<{ id: number; accountId: string; accountName: string; status: string }> = [];
  const reports: unknown[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const url = request.url!;
    paths.push(url);
    let result: unknown;
    if (url.endsWith("/accountConfig/page")) {
      const data = body.status ? accountData.filter((account) => account.status === body.status) : accountData;
      result = { code: 0, data: { total: data.length, data } };
    }
    else if (url.endsWith("/accountTask/page")) result = { code: 0, data: { total: 1, data: [{ id: 88, accountId: "tb-test", status: remoteState }] } };
    else if (url.endsWith("/rpa/report")) { reports.push(body); result = { code: 0, data: true }; }
    else { response.writeHead(404); response.end(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "taobao-protocol-smoke-"));
  const bootstrap = path.join(directory, "bootstrap.mjs");
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
    config.set('config.aiModel', '');
    new Store({ name: 'baidu-netdisk-config' }).set('config.executablePath', directory + '/missing.exe');
    new Store({ name: 'taobao-drama-config' }).set('config.apiBaseUrl', ${JSON.stringify(apiBaseUrl)});
    await import(${JSON.stringify(pathToFileURL(mainEntry).href)});
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
  ));
  const electron = await _electron.launch({ executablePath: require("electron"), args: [bootstrap], env, timeout: 30_000 });
  try {
    const page = await electron.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".app-workspace");
    await page.evaluate(() => window.ipcRenderer.invoke("taobao-drama:service:status"));
    await electron.evaluate(({ app }, apiBaseUrl) => {
      const Database = globalThis.require("better-sqlite3");
      const path = globalThis.require("node:path");
      const db = new Database(path.join(app.getPath("userData"), "automation.sqlite"));
      try {
        const now = new Date().toISOString();
        for (const [id, taskId, phase] of [["review", 88, "review-required"], ["pending", 89, "report-pending"]] as const) {
          const record = { id, apiBaseUrl, accountId: "tb-test", taskId, workerId: "old-process", attemptCount: 3,
            phase, originalTitle: phase === "review-required" ? "提交结果待核实的剧" : "已经上传等待补报的剧", checkpoints: [],
            report: phase === "report-pending" ? { taskId, workerId: "old-process", attemptCount: 3, success: true, resultJson: { original: "saved" } } : undefined,
            errorMessage: phase === "review-required" ? "提交后等待超时，请在淘宝确认结果" : "网络超时，结果已保存，不会重新上传",
            createdAt: now, updatedAt: now };
          db.prepare("INSERT INTO taobao_drama_executions VALUES (?, ?, ?, ?, ?, ?)")
            .run(id, apiBaseUrl, record.accountId, taskId, phase, JSON.stringify(record));
        }
      } finally { db.close(); }
    }, apiBaseUrl);
    await page.evaluate(() => { location.hash = "/taobao-drama/service"; });
    const attention = page.getByRole("region", { name: "待处理任务" });
    await attention.getByText("提交结果待核实的剧", { exact: false }).waitFor();
    await attention.getByText("已经上传等待补报的剧", { exact: false }).waitFor();
    const recheck = page.getByRole("button", { name: "已在后台处理，重新检查" });
    assert.equal(await recheck.count(), 1);
    await recheck.click();
    await page.getByText("后台任务仍在上传中或状态无法确认。", { exact: false }).waitFor();
    assert.equal((await page.evaluate(() => window.ipcRenderer.invoke("taobao-drama:service:status"))).executions.length, 2);
    await page.screenshot({ path: path.join(cache, "taobao-task-attention.png") });
    remoteState = "FAILED";
    await recheck.click();
    await attention.getByText("提交结果待核实的剧", { exact: false }).waitFor({ state: "hidden" });
    const startError = await page.evaluate(async () => {
      try { await window.ipcRenderer.invoke("taobao-drama:service:start"); return ""; }
      catch (error) { return String(error); }
    });
    assert.match(startError, /TAOBAO_DRAMA_ENABLED_ACCOUNT_NOT_FOUND/);
    assert.deepEqual(reports, [{ taskId: 89, workerId: "old-process", attemptCount: 3, success: true, resultJson: { original: "saved" } }]);
    assert.equal(paths.some((url) => url.endsWith("/claim")), false);
    assert.deepEqual((await page.evaluate(() => window.ipcRenderer.invoke("taobao-drama:service:status"))).executions, []);
    accountData = [
      { id: 1, accountId: "tb-one", accountName: "淘宝一号", status: "ON" },
      { id: 2, accountId: "tb-two", accountName: "淘宝二号", status: "ON" },
      { id: 3, accountId: "tb-off", accountName: "停用账号", status: "OFF" },
    ];
    const selection = page.getByRole("region", { name: "淘宝账号选择" });
    await selection.getByRole("button", { name: "刷新账号" }).click();
    const firstAccount = selection.getByRole("checkbox", { name: /淘宝一号/ });
    await firstAccount.waitFor();
    assert.equal(await selection.getByRole("checkbox").count(), 3);
    assert.equal(await selection.getByRole("checkbox", { name: /停用账号/ }).isDisabled(), true);
    const start = page.getByRole("button", { name: "启动服务", exact: true });
    assert.equal(await start.isDisabled(), true);
    await firstAccount.check();
    assert.equal(await start.isEnabled(), true);
    assert.equal(await selection.getByRole("checkbox", { name: /淘宝二号/ }).isChecked(), false);
    await selection.getByText("已选择", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(cache, "taobao-account-selection.png") });
    await selection.getByRole("button", { name: "全选", exact: true }).click();
    assert.equal(await selection.getByRole("checkbox", { name: /淘宝二号/ }).isChecked(), true);
    await selection.getByRole("button", { name: "清空", exact: true }).click();
    assert.equal(await start.isDisabled(), true);
    const emptySelectionError = await page.evaluate(async () => {
      try { await window.ipcRenderer.invoke("taobao-drama:service:start", []); return ""; }
      catch (error) { return String(error); }
    });
    assert.match(emptySelectionError, /至少选择/);
    // An invalid executable stops before any real browser/login can open.
    // Starting only the second account must never even prepare the first profile.
    await selection.getByRole("checkbox", { name: /淘宝二号/ }).check();
    const runDataDir = await page.evaluate(async (missingBrowser) => {
      const result = await window.ipcRenderer.invoke("taobao-drama:config:get");
      await window.ipcRenderer.invoke("taobao-drama:config:save", {
        ...result.config, browserExecutablePath: missingBrowser, headless: "true",
      });
      return result.config.runDataDir as string;
    }, path.join(directory, "missing-browser.exe"));
    await start.click();
    await page.getByText("无法启动配置的浏览器", { exact: false }).waitFor();
    const refreshed = await page.evaluate(() => window.ipcRenderer.invoke("taobao-drama:accounts:list"));
    assert.deepEqual(refreshed.selectedAccountIds, ["tb-two"]);
    assert.equal(existsSync(path.join(runDataDir, "auth/accounts/tb-two")), true);
    assert.equal(existsSync(path.join(runDataDir, "auth/accounts/tb-one")), false);
    assert.deepEqual(errors, []);
  } finally {
    await electron.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(path.dirname(directory), cache);
    assert.ok(path.basename(directory).startsWith("taobao-protocol-smoke-"));
    await rm(directory, { recursive: true, force: true });
  }
});
