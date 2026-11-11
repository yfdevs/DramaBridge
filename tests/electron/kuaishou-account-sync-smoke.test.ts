import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright";

test("account sync page selects multiple sources and reports missing Feishu settings", { timeout: 60_000 }, async () => {
  const root = process.cwd();
  await mkdir(path.join(root, ".cache"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".cache", "kuaishou-sync-smoke-"));
  const bootstrap = path.join(directory, "bootstrap.mjs");
  await writeFile(bootstrap, `import { app } from 'electron';
    app.setPath('userData', ${JSON.stringify(directory)});
    app.on('browser-window-created', (_event, window) => window.hide());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, ...args) => String(url).includes('/kuaishou/accountConfig/page')
      ? new Response(JSON.stringify({code:0,data:{total:2,data:[{id:1,accountId:'source-one',accountName:'来源账号一',status:'ON'},{id:2,accountId:'source-two',accountName:'来源账号二',status:'ON'}]}}),{headers:{'Content-Type':'application/json'}})
      : originalFetch(url,...args);
    await import(${JSON.stringify(pathToFileURL(path.join(root, "dist-electron/main.js")).href)});`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "ELECTRON_RUN_AS_NODE")) as Record<string, string>;
  const application = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron"), args: [bootstrap], env });
  try {
    const page = await application.firstWindow();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.waitForSelector(".app-workspace");
    await page.evaluate(() => {
      location.hash = "/kuaishou-drama/account-sync";
    });
    const start = page.getByRole("button", { name: "开始同步", exact: true });
    await start.waitFor(); assert.equal(await start.isDisabled(), true);
    await page.getByText("来源账号一", { exact: true }).click();
    assert.equal(await start.isEnabled(), true);
    const workspace = page.locator(".account-sync-workspace");
    await workspace.getByRole("checkbox", { name: "选择账号 来源账号二", exact: true }).check();
    assert.equal(await workspace.getByRole("checkbox", { name: "选择账号 来源账号一", exact: true }).isChecked(), true);
    assert.equal(await workspace.getByRole("checkbox", { name: "选择账号 来源账号二", exact: true }).isChecked(), true);
    assert.equal(await start.isEnabled(), true);
    await workspace.getByRole("button", { name: "取消选择", exact: true }).click();
    assert.equal(await start.isDisabled(), true);
    await workspace.getByRole("checkbox", { name: "全选当前结果中的启用账号", exact: true }).check();
    assert.equal(await workspace.getByRole("checkbox", { name: "选择账号 来源账号一", exact: true }).isChecked(), true);
    assert.equal(await workspace.getByRole("checkbox", { name: "选择账号 来源账号二", exact: true }).isChecked(), true);
    await start.click();
    await page.getByRole("alert").filter({ hasText: "App ID" }).last().waitFor();
    for (const [width,height,name] of [[1280,900,"desktop"],[800,720,"compact"]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0],size[1]), [width,height]);
      await page.screenshot({ path: path.join(root, `.cache/kuaishou-account-sync-${name}.png`) });
    }
    await application.evaluate(({ nativeTheme, BrowserWindow }) => {
      nativeTheme.themeSource = "dark";
      BrowserWindow.getAllWindows()[0]!.setSize(1280,900);
    });
    await page.evaluate(async () => {
      const result = await window.ipcRenderer.invoke("app:config:get");
      await window.ipcRenderer.invoke("app:config:save", { ...result.config, theme: "dark" });
    });
    await page.locator("html.dark").waitFor();
    await page.screenshot({ path: path.join(root, ".cache/kuaishou-account-sync-dark.png") });
    assert.deepEqual(errors, []);
  } finally { await application.close(); }
});
