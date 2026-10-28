import assert from "node:assert/strict";
import test from "node:test";
import { compileFunction, createContext, runInContext, runInNewContext } from "node:vm";
import { baiduShareWindowExpression, selectOpenedBaiduShareTarget } from "../../src/infrastructure/share-window.js";
import type { CdpTarget } from "../../src/domain/types.js";

test("opens and reuses only an owned share window while preserving the client's pages and session", () => {
  const loaded: string[] = [];
  const sharedSession = {};
  let created = 0;
  const windows: Array<{
    id: number; isDestroyed: () => boolean;
    webContents: { id: number; getLastWebPreferences: () => { additionalArguments?: string[] } };
    loadURL: (url: string) => Promise<void>;
  }> = [{ id: 1, isDestroyed: () => false, webContents: { id: 1, getLastWebPreferences: () => ({}) }, loadURL: async () => { throw new Error("must not navigate the client's homepage"); } }];
  class Window {
    static getAllWindows = () => windows;
    id = ++created + 1;
    webContents: typeof windows[number]["webContents"];
    isDestroyed = () => false;
    loadURL = async (url: string) => { loaded.push(url); };
    constructor(options: { webPreferences: { session: unknown; additionalArguments: string[]; backgroundThrottling: boolean } }) {
      assert.equal(options.webPreferences.session, sharedSession);
      assert.equal(options.webPreferences.backgroundThrottling, false);
      // Current Baidu releases discard these options when reading them back.
      this.webContents = { id: this.id, getLastWebPreferences: () => ({}) };
      windows.push(this);
    }
  }
  const mainContext = createContext({});
  const remote = { require: () => ({
    runInThisContext: (source: string) => runInContext(source, mainContext),
    compileFunction: (source: string, parameters: string[]) => compileFunction(source, parameters, { parsingContext: mainContext }),
  }), BrowserWindow: Window, webContents: { getAllWebContents: () => [
    { getURL: () => "https://pan.baidu.com/aipan/search", session: {} },
    { getURL: () => "https://pan.baidu.com/s/1previous", session: sharedSession },
  ] } };
  const context = { URL, require: () => remote };
  runInNewContext(baiduShareWindowExpression("https://pan.baidu.com/s/1first?pwd=1234"), context);
  runInNewContext(baiduShareWindowExpression("https://pan.baidu.com/s/1second?pwd=5678"), context);
  assert.equal(created, 1);
  assert.deepEqual(loaded, ["https://pan.baidu.com/s/1first?pwd=1234", "https://pan.baidu.com/s/1second?pwd=5678"]);
});

test("older clients can reuse a unique share target without the Electron target mapping API", () => {
  const target = (id: string, url: string): CdpTarget => ({ id, url, type: "page", title: "", webSocketDebuggerUrl: `ws://localhost/${id}` });
  const existing = target("owned", "https://pan.baidu.com/s/1example");
  const ai = target("ai", "https://pan.baidu.com/aipan/search");
  assert.equal(selectOpenedBaiduShareTarget([existing, ai], [existing, ai], undefined, "example"), existing);
  assert.equal(selectOpenedBaiduShareTarget([target("other", "https://pan.baidu.com/s/1example-extra")], [], undefined, "example"), undefined);
  assert.equal(selectOpenedBaiduShareTarget([existing, target("ambiguous", existing.url)], [], undefined, "example"), undefined);
});
