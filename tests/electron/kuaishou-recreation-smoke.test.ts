import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { _electron } from "playwright";

const root = process.cwd();
const entry = path.join(root, "dist-electron/main.js");
const require = createRequire(import.meta.url);

test(
  "recreation desktop page saves template, imports Excel, renders persisted versions and copies links",
  {
    skip: !existsSync(entry),
    timeout: 60_000,
  },
  async () => {
    const cache = path.join(root, ".cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(path.join(cache, "recreation-smoke-"));
    const bootstrap = path.join(directory, "bootstrap.mjs");
    const file = path.join(directory, "template.xlsx");
    await writeFile(
      bootstrap,
      `
    import { app } from 'electron';
    import { mkdirSync } from 'node:fs';
    mkdirSync(${JSON.stringify(directory + "/profile")}, { recursive: true });
    app.setPath('userData', ${JSON.stringify(directory + "/profile")});
    app.on('browser-window-created', (_event, window) => window.hide());
    const Store = (await import('electron-store')).default;
    const store = new Store({ name: 'global-app-config' });
    store.set('config.runDataRoot', ${JSON.stringify(directory + "/runs")});
    store.set('config.localMaterialRoot', ${JSON.stringify(directory + "/materials")});
    store.set('config.theme', 'light');
    new Store({ name: 'baidu-netdisk-config' }).set('config.executablePath', ${JSON.stringify(directory + "/missing.exe")});
    await import(${JSON.stringify(pathToFileURL(entry).href)});
  `,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === "string" && !["ELECTRON_RUN_AS_NODE", "PLAYWRIGHT_BROWSERS_PATH"].includes(pair[0]),
      ),
    );
    const app = await _electron.launch({
      executablePath: require("electron"),
      args: [bootstrap],
      env,
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForSelector(".app-workspace");
      // Netdisk can load Playwright before any publishing service has started.
      await page.evaluate(() => window.ipcRenderer.invoke("baidu-netdisk:service:status"));
      const browserExecutable = await app.evaluate(() =>
        globalThis.require("playwright").chromium.executablePath(),
      );
      assert.ok(
        browserExecutable.startsWith(path.join(root, ".cache", "playwright-browsers") + path.sep),
        `Expected the shared browser cache, got ${browserExecutable}`,
      );
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1280, 900),
      );
      await page.evaluate(() => {
        location.hash = "/kuaishou-drama/recreation";
      });
      await page.getByRole("main", { name: "二创", exact: true }).waitFor();
      await app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, file);
      await page.getByRole("button", { name: "下载 Excel 模板" }).click();
      await page.getByText("Excel 模板已保存", { exact: true }).waitFor();
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(file);
      book.getWorksheet("二创任务")!.getRow(2).values = [
        "春日归人",
        101,
        "https://pan.baidu.com/s/1test?pwd=abcd",
        "星河归途",
        "长街来信",
      ];
      await book.xlsx.writeFile(file);
      await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
      await page.getByText("已导入 1 个任务", { exact: true }).waitFor();
      assert.ok((await page.getByRole("main").innerText()).includes("101 集 → 61 集"));
      const id = await app.evaluate(async (_electron, directory) => {
        const Database = globalThis.require("better-sqlite3");
        const database = new Database(directory + "/profile/automation.sqlite");
        const row = database.prepare("SELECT id, data FROM kuaishou_recreation_tasks").get();
        const task = JSON.parse(row.data);
        task.state = "completed";
        task.message = "所有版本已上传并生成分享链接";
        for (const result of task.results)
          Object.assign(result, {
            shareUrl: "https://pan.baidu.com/s/1mock",
            extractionCode: "abcd",
          });
        database
          .prepare("UPDATE kuaishou_recreation_tasks SET data = ? WHERE id = ?")
          .run(JSON.stringify(task), row.id);
        database.close();
        return row.id;
      }, directory);
      assert.ok(id);
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.getByRole("button", { name: "复制全部链接" }).waitFor();
      await page.getByRole("button", { name: "复制全部链接" }).click();
      await page.getByText("分享链接已复制", { exact: true }).waitFor();
      assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /星河归途-60%/);
      const taskRow = page
        .getByRole("row")
        .filter({ has: page.getByText("春日归人", { exact: true }) });
      assert.ok((await taskRow.boundingBox())!.height <= 48, "task stays on one compact row");
      assert.equal(await page.getByText("填写说明与目录规则", { exact: true }).count(), 0);
      assert.doesNotMatch(await page.getByRole("main").innerText(), /共 \d+ 个任务|已完成 \d+/);
      assert.doesNotMatch(await page.getByRole("main").innerText(), /队列已暂停|队列处理中|当前任务完成后暂停/);
      assert.equal(await page.getByRole("button", { name: "复制链接", exact: true }).count(), 0);
      await page.getByRole("button", { name: "查看春日归人的版本与分享链接" }).click();
      await page.getByRole("button", { name: "复制链接", exact: true }).first().waitFor();
      assert.equal(await page.getByRole("button", { name: "复制链接", exact: true }).count(), 3);
      await page.getByRole("button", { name: "复制链接", exact: true }).first().click();
      assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /春日归人-60%/);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "春日归人的更多操作" }).click();
      await page.getByRole("menuitem", { name: "删除记录" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: "搜索原剧名或版本名" }).fill("不存在的剧");
      await page.getByText("没有符合筛选条件的任务", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "搜索原剧名或版本名" }).fill("");
      await page.screenshot({ path: path.join(cache, "kuaishou-recreation-desktop.png") });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(900, 700),
      );
      await page.screenshot({ path: path.join(cache, "kuaishou-recreation-compact.png") });
      // An external IPC caller must update the page through the change event, without polling.
      await app.evaluate(async (_electron, directory) => {
        const Database = globalThis.require("better-sqlite3");
        const database = new Database(directory + "/profile/automation.sqlite");
        database.exec("UPDATE kuaishou_recreation_tasks SET data = json_set(data, '$.state', 'failed')");
        database.close();
      }, directory);
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.getByRole("button", { name: "重试", exact: true }).waitFor();
      await page.evaluate(id => window.ipcRenderer.invoke("kuaishou-drama:recreation:retry", id), id);
      await taskRow.getByText("待处理", { exact: true }).waitFor();
      await app.evaluate(async (_electron, directory) => {
        const Database = globalThis.require("better-sqlite3");
        const database = new Database(directory + "/profile/automation.sqlite");
        const template = JSON.parse(database.prepare("SELECT data FROM kuaishou_recreation_tasks LIMIT 1").get().data);
        const insert = database.prepare("INSERT INTO kuaishou_recreation_tasks (id, title_key, data) VALUES (?, ?, ?)");
        database.transaction(() => {
          for (let index = 0; index < 400; index++) {
            const title = `性能测试${index}`;
            insert.run(title, title, JSON.stringify({ ...template, id: title, originalTitle: title, state: "completed" }));
          }
        })();
        database.close();
      }, directory);
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await page.getByRole("navigation", { name: "任务分页" }).waitFor();
      assert.equal(await page.getByRole("row").count(), 51, "large queues render only 50 task rows");
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await page.getByRole("textbox", { name: "搜索原剧名或版本名" }).fill("性能测试399");
      await page.getByText("性能测试399", { exact: true }).waitFor();
      assert.equal(await page.getByRole("row").count(), 2);
      const reads = await page.evaluate(async () => {
        const original = window.ipcRenderer.invoke;
        let reads = 0;
        window.ipcRenderer.invoke = (async (channel: string, ...args: unknown[]) => {
          if (channel === "kuaishou-drama:recreation:workspace") reads++;
          return original(channel, ...args);
        }) as typeof original;
        try { await new Promise(resolve => setTimeout(resolve, 3200)); return reads; }
        finally { window.ipcRenderer.invoke = original; }
      });
      assert.equal(reads, 0, "idle recreation pages do not poll full task lists");
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
