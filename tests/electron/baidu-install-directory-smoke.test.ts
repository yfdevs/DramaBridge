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
  "Baidu setup accepts the install folder and rejects invalid edits without replacing the saved folder",
  {
    skip: !existsSync(entry),
    timeout: 60_000,
  },
  async () => {
    const cache = path.join(root, ".cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(path.join(cache, "baidu-folder-smoke-"));
    const installation = path.join(directory, "百度网盘", "BaiduNetdisk");
    await mkdir(path.join(installation, "module", "BrowserEngine"), { recursive: true });
    await writeFile(
      path.join(installation, "module", "BrowserEngine", "BaiduNetdiskUnite.exe"),
      "test fixture, do not launch",
    );
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
    const netdisk = new Store({ name: 'baidu-netdisk-config' });
    netdisk.set('config.executablePath', ${JSON.stringify(directory + "/missing.exe")});
    netdisk.set('config.debugPort', '65531');
    await import(${JSON.stringify(pathToFileURL(entry).href)});
  `,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === "string" && pair[0] !== "ELECTRON_RUN_AS_NODE",
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
      await page.getByRole("button", { name: /打开百度网盘 CDP 控制/ }).click();
      const field = page.getByRole("textbox", { name: "百度网盘安装目录" });
      await field.waitFor();
      await app.evaluate(({ dialog }, installation) => {
        dialog.showOpenDialog = async (_window, options) => {
          if (!options.properties?.includes("openDirectory"))
            throw new Error("Expected an installation folder picker");
          return { canceled: false, filePaths: [installation] };
        };
      }, installation);
      await page.getByRole("button", { name: "选择百度网盘安装目录" }).click();
      await page.getByText("安装目录已保存，启动文件将自动识别。", { exact: true }).waitFor();
      assert.equal(await field.inputValue(), installation);
      const config = await page.evaluate(() =>
        window.ipcRenderer.invoke("baidu-netdisk:config:get"),
      );
      assert.equal(config.config.executablePath, installation);
      await field.fill(path.join(directory, "不存在"));
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.getByText(/百度网盘安装目录或启动文件不存在/).waitFor();
      const after = await page.evaluate(() =>
        window.ipcRenderer.invoke("baidu-netdisk:config:get"),
      );
      assert.equal(after.config.executablePath, installation);
      await field.fill(`"${installation}"`);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.getByText("安装目录已保存，启动文件将自动识别。", { exact: true }).waitFor();
      assert.equal(await field.inputValue(), installation);
      await page.screenshot({ path: path.join(cache, "baidu-install-directory.png") });
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
