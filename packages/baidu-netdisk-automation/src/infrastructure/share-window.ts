import { getTargets, withPage } from "./cdp.js";
import { sleep } from "./utils.js";
import type { CdpTarget } from "../domain/types.js";

export function baiduShareWindowExpression(link: string) {
  return `(() => {
    const remote = require('@electron/remote');
    const vm = remote.require('vm');
    const marker = '--dramabridge-baidu-share-page';
    // Some Baidu releases discard additionalArguments. Keep ownership and a
    // strong window reference in the main process, shared by all core views.
    let window = vm.runInThisContext('globalThis.__dramabridgeBaiduShareWindow');
    try { if (window?.isDestroyed()) window = undefined; } catch { window = undefined; }
    if (!window) {
      const candidates = remote.webContents.getAllWebContents().filter(contents => {
        try {
          const url = new URL(contents.getURL());
          return url.hostname === 'pan.baidu.com';
        } catch { return false; }
      });
      const source = candidates.find(contents => {
        const pathname = new URL(contents.getURL()).pathname;
        return pathname.startsWith('/s/') || pathname.startsWith('/share/');
      }) || candidates[0];
      const preferences = { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, additionalArguments: [marker] };
      if (source) preferences.session = source.session;
      window = new remote.BrowserWindow({ show: false, width: 1100, height: 800, title: 'DramaBridge 百度网盘分享', webPreferences: preferences });
      vm.compileFunction('globalThis.__dramabridgeBaiduShareWindow = window;', ['window'])(window);
    }
    // ERR_ABORTED is normal when /s/ redirects to the extraction form. The
    // caller tracks this window's real target and verifies the resulting page.
    window.loadURL(${JSON.stringify(link)}).catch(() => undefined);
    return { windowId: window.id, webContentsId: window.webContents.id };
  })()`;
}

export function selectOpenedBaiduShareTarget(targets: CdpTarget[], before: CdpTarget[], mappedId: string | undefined, expectedId: string) {
  const exact = targets.find(target => target.id === mappedId);
  if (exact) return exact;
  const matching = targets.filter(target => {
    try {
      const url = new URL(target.url);
      const id = url.pathname.startsWith("/s/") ? url.pathname.split("/").pop()?.replace(/^1/, "") : url.searchParams.get("surl");
      return url.hostname === "pan.baidu.com" && id === expectedId;
    } catch { return false; }
  });
  const created = matching.filter(target => !before.some(previous => previous.id === target.id));
  if (created.length === 1) return created[0];
  return matching.length === 1 ? matching[0] : undefined;
}

export async function openDedicatedBaiduShareWindow(port: number, link: string): Promise<CdpTarget> {
  const before = await getTargets(port);
  const core = before.find(target => target.webSocketDebuggerUrl && target.url.includes("core.asar")
    && !/#\/(?:bubble_menu|sestonMenu|workspace)/.test(target.url));
  if (!core) throw new Error("百度网盘 CDP 核心页面不可用，无法打开独立分享页。");
  const opened = await withPage(core, page => page.evaluate<{ windowId: number; webContentsId: number }>(
    baiduShareWindowExpression(link),
  ));
  const expected = new URL(link).pathname.split("/").pop()?.replace(/^1/, "") ?? "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = (await getTargets(port)).filter(target => target.webSocketDebuggerUrl);
    const targetId = await withPage(core, page => page.evaluate<string | undefined>(`(() => {
      const remote = require('@electron/remote');
      if (typeof remote.webContents.fromDevToolsTargetId !== 'function') return undefined;
      return ${JSON.stringify(targets.map(target => target.id))}.find(id => {
        try { return remote.webContents.fromDevToolsTargetId(id)?.id === ${JSON.stringify(opened.webContentsId)}; }
        catch { return false; }
      });
    })()`)).catch(() => undefined);
    const exact = selectOpenedBaiduShareTarget(targets, before, targetId, expected);
    if (exact) return exact;
    await sleep(250);
  }
  throw new Error(`没有找到独立分享页的 CDP target：windowId=${opened.windowId}`);
}
