import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright";

const root = process.cwd();
const entry = path.join(root, "dist-electron/main.js");
const require = createRequire(import.meta.url);

test(
  "recreation monitor removes Excel UI and exposes global Feishu / platform sheet settings",
  { skip: !existsSync(entry), timeout: 60_000 },
  async () => {
    const cache = path.join(root, ".cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(path.join(cache, "feishu-smoke-"));
    const bootstrap = path.join(directory, "bootstrap.mjs");
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
    store.set('config.aiApiKeyCiphertext', '');
    store.set('config.aiBaseURL', 'https://ark.cn-beijing.volces.com/api/v3');
    store.set('config.aiModel', 'test-model');
    new Store({ name: 'baidu-netdisk-config' }).set('config.executablePath', ${JSON.stringify(directory + "/missing.exe")});
    await import(${JSON.stringify(pathToFileURL(entry).href)});
  `,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === "string" &&
          !["ELECTRON_RUN_AS_NODE", "PLAYWRIGHT_BROWSERS_PATH"].includes(pair[0]),
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
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1280, 900),
      );
      await page.evaluate(() => {
        location.hash = "/kuaishou-drama/recreation";
      });
      await page.getByRole("button", { name: "开始处理", exact: true }).waitFor();
      assert.equal(await page.getByRole("table").count(), 0);
      assert.equal(await page.getByRole("button", { name: /导入|导出|下载.*模板/ }).count(), 0);
      await page.getByRole("button", { name: "开始处理", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "App ID" }).waitFor();
      await page.screenshot({ path: path.join(cache, "kuaishou-feishu-monitor.png") });
      for (const route of ["/wechat-drama/recreation", "/tiktok-drama/netdisk"]) {
        await page.evaluate((route) => {
          location.hash = route;
        }, route);
        const start = page.getByRole("button", { name: "开始处理", exact: true });
        await start.waitFor();
        assert.equal(await start.count(), 1);
        assert.equal(await page.getByRole("table").count(), 0);
        assert.equal(await page.getByRole("button", { name: /导入|导出|下载.*模板/ }).count(), 0);
        await start.click();
        await page.getByRole("alert").filter({ hasText: "App ID" }).waitFor();
      }
      await page.evaluate(() => {
        location.hash = "/app/config";
      });
      await page.getByRole("region", { name: "飞书表格连接" }).waitFor();
      await page.getByLabel("App ID", { exact: true }).waitFor();
      await page.getByLabel("表格链接", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("快手二创工作表名称").count(), 0);
      const settings = await page.evaluate(() =>
        window.ipcRenderer.invoke("feishu:tables:settings"),
      );
      assert.equal(settings.appId, "");
      assert.equal(settings.tableUrl, "");
      assert.equal(settings.hasSecret, false);
      assert.equal(await page.getByRole("button", { name: "保存连接", exact: true }).count(), 0);
      await page.getByLabel("App ID", { exact: true }).fill("cli_smoketest");
      await page.getByLabel("App Secret", { exact: true }).fill("smoke-secret");
      await page
        .getByLabel("表格链接", { exact: true })
        .fill("https://example.feishu.cn/wiki/test");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>("#feishuAppSecret")?.placeholder === "••••••••",
      );
      const saved = await page.evaluate(() => window.ipcRenderer.invoke("feishu:tables:settings"));
      assert.equal(saved.appId, "cli_smoketest");
      assert.equal(saved.hasSecret, true);
      assert.equal(await page.getByLabel("App Secret", { exact: true }).inputValue(), "");
      await page.getByLabel("App ID", { exact: true }).fill("cli_discard");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await page.getByLabel("App ID", { exact: true }).inputValue(), "cli_smoketest");
      await page.evaluate(() => {
        location.hash = "/app/config";
      });
      await page
        .getByRole("region", { name: "飞书表格连接" })
        .screenshot({ path: path.join(cache, "feishu-global-config.png") });
      await page.evaluate(() => {
        location.hash = "/kuaishou-drama/config";
      });
      await page.getByLabel("二创工作表名称", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("二创工作表名称", { exact: true }).inputValue(),
        "快手二创",
      );
      await page.screenshot({ path: path.join(cache, "kuaishou-feishu-config.png") });
      for (const [route, label, sheet] of [
        ["/wechat-drama/config", "二创工作表名称", "微信二创"],
        ["/tiktok-drama/config", "转存工作表名称", "tiktok转存"],
      ]) {
        await page.evaluate((route) => {
          location.hash = route;
        }, route);
        const field = page.getByRole("textbox", { name: label, exact: true });
        await field.waitFor();
        assert.equal(await field.inputValue(), sheet);
        assert.equal(await page.getByRole("spinbutton", { name: "检查间隔", exact: true }).inputValue(), "30");
        await field.fill(sheet + "测试");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        const channel = route.includes("wechat")
          ? "wechat-drama:config:get"
          : "tiktok-drama:config:get";
        await page.waitForFunction(
          async ({ sheet, channel, key }) => {
            const saved = await window.ipcRenderer.invoke(channel);
            return saved.config[key] === sheet + "测试";
          },
          {
            sheet,
            channel,
            key: route.includes("wechat") ? "recreationSheetName" : "netdiskSheetName",
          },
        );
        const config = await page.evaluate(
          (channel) => window.ipcRenderer.invoke(channel),
          channel,
        );
        assert.equal(
          config.config[route.includes("wechat") ? "recreationSheetName" : "netdiskSheetName"],
          sheet + "测试",
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
