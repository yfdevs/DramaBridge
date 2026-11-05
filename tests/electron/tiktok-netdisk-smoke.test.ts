import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright";

const require = createRequire(import.meta.url);
test(
  "Wechat and TikTok restore Feishu checkpoints, write links and show compact ring cards",
  { timeout: 60000 },
  async () => {
    const root = process.cwd(),
      cache = path.join(root, ".cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(path.join(cache, "feishu-platform-smoke-"));
    const bootstrap = path.join(directory, "bootstrap.mjs");
    await writeFile(
      bootstrap,
      `
    import { app, safeStorage } from 'electron';
    import { mkdirSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import Database from 'better-sqlite3';
    const directory = ${JSON.stringify(directory)};
    mkdirSync(directory + '/profile', { recursive: true });
    app.setPath('userData', directory + '/profile');
    app.on('browser-window-created', (_event, window) => window.hide());
    const Store = (await import('electron-store')).default;
    new Store({ name: 'global-app-config' }).set('config', {
      runDataRoot: directory + '/runs', localMaterialRoot: directory + '/materials', theme: 'light',
      aiApiKeyCiphertext: '', aiBaseURL: 'https://example.com', aiModel: 'test-model',
    });
    new Store({ name: 'baidu-netdisk-config' }).set('config.executablePath', directory + '/missing.exe');
    const feishu = new Store({ name: 'feishu-tables' });
    feishu.store = { appId: 'cli_smoketest', secretCiphertext: '', tableUrl: 'https://example.feishu.cn/wiki/test' };
    app.once('ready', () => feishu.set('secretCiphertext', safeStorage.encryptString('test-secret').toString('base64')));
    const db = new Database(directory + '/profile/automation.sqlite');
    db.exec('CREATE TABLE feishu_task_checkpoints (platform TEXT NOT NULL, source_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(platform, source_key))');
    const input = { originalTitle: '飞书转存测试', episodeCount: 80, shareText: 'https://pan.baidu.com/s/1test', versions: [] };
    for (const [platform, sheet] of [['wechat-drama', 'wechat'], ['tiktok-drama', 'tiktok']]) {
      const id = createHash('sha256').update(JSON.stringify(['book', sheet, input])).digest('hex');
      const task = { ...input, id, state: 'completed', results: [{ title: input.originalTitle, shareLayout: 'directory', shareUrl: 'https://pan.baidu.com/s/1result?pwd=1234' }], downloadCount: platform === 'wechat-drama' ? 48 : 80, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.prepare('INSERT INTO feishu_task_checkpoints VALUES (?, ?, ?)').run(platform, id, JSON.stringify(task));
    }
    db.close();
    const data = {
      wechat: [['剧名','集数','原百度链接','二创百度链接','备注'], [input.originalTitle, '80', input.shareText, '', '']],
      tiktok: [['剧名','集数','原百度链接','单层文件夹链接','备注'], [input.originalTitle, '80', input.shareText, '', '']],
    };
    globalThis.__feishuSmoke = { writes: [], reads: [] };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (request, init) => {
      const url = new URL(typeof request === 'string' ? request : request.url ?? request);
      if (!['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname)) return nativeFetch(request, init);
      const reply = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
      if (url.hostname === 'accounts.feishu.cn') return new Response(JSON.stringify({ code: 0, access_token: 'fake-token', expires_in: 3600 }));
      if (url.pathname.includes('get_node')) return reply({ node: { obj_type: 'sheet', obj_token: 'book' } });
      if (url.pathname.endsWith('/sheets/query')) return reply({ sheets: [['wechat', '微信二创'], ['tiktok', 'tiktok转存']].map(([sheet_id, title]) => ({ sheet_id, title, grid_properties: { row_count: 2, column_count: 5 } })) });
      if (url.pathname.endsWith('/styles_batch_update')) return reply({});
      if (url.pathname.endsWith('/values_batch_update')) {
        for (const range of JSON.parse(init.body).valueRanges) {
          const [sheet, cell] = range.range.split('!');
          const column = cell.charCodeAt(0) - 65;
          data[sheet][1][column] = range.values[0][0];
          globalThis.__feishuSmoke.writes.push({ sheet, column, value: range.values[0][0] });
        }
        return reply({});
      }
      if (url.pathname.includes('/values/')) {
        const sheet = decodeURIComponent(url.pathname.split('/').at(-1)).split('!')[0];
        globalThis.__feishuSmoke.reads.push(sheet);
        return reply({ valueRange: { values: data[sheet] } });
      }
      throw new Error('Unexpected Feishu request: ' + url.pathname);
    };
    await import(${JSON.stringify(pathToFileURL(path.join(root, "dist-electron/main.js")).href)});
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
      timeout: 15000,
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.waitForSelector(".app-workspace");
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1100, 760),
      );
      for (const [route, channel] of [
        ["/wechat-drama/recreation", "wechat-drama:recreation"],
        ["/tiktok-drama/netdisk", "tiktok-drama:netdisk"],
      ]) {
        await page.evaluate((route) => {
          location.hash = route;
        }, route);
        const start = page.getByRole("button", { name: "开始处理", exact: true });
        await start.waitFor();
        assert.ok((await start.boundingBox())!.height <= 28);
        await start.click();
        await page.waitForFunction(
          async (channel) =>
            (await window.ipcRenderer.invoke(channel + ":workspace")).completed === 1,
          channel,
        );
        const ring = page.getByRole("progressbar", { name: "飞书转存测试处理进度" });
        await ring.waitFor();
        assert.equal(await ring.getAttribute("aria-valuenow"), "100");
        assert.equal(await page.getByRole("table").count(), 0);
        assert.equal(await page.locator("main:visible details").count(), 0);
        assert.ok(
          (await page.getByRole("region", { name: "当前剧目进度" }).boundingBox())!.height < 140,
        );
        await page.screenshot({
          path: path.join(
            cache,
            channel.startsWith("wechat")
              ? "wechat-feishu-monitor.png"
              : "tiktok-feishu-monitor.png",
          ),
        });
      }
      await assert.rejects(
        page.evaluate(() => window.ipcRenderer.invoke("feishu:tables:save", {})),
        /停止各平台/,
      );
      const snapshot = await app.evaluate(() => (globalThis as any).__feishuSmoke);
      for (const sheet of ["wechat", "tiktok"]) {
        assert.ok(snapshot.reads.includes(sheet));
        assert.ok(
          snapshot.writes.some(
            (write: any) =>
              write.sheet === sheet &&
              write.column === 3 &&
              write.value === "https://pan.baidu.com/s/1result?pwd=1234",
          ),
        );
        const channel = sheet === "wechat" ? "wechat-drama:recreation" : "tiktok-drama:netdisk";
        const stopped = await page.evaluate(
          (channel) => window.ipcRenderer.invoke(channel + ":pause"),
          channel,
        );
        assert.equal(stopped.running, false);
        assert.equal(stopped.stopping, false);
      }
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
