import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import { KuaishouBrowserUnavailableError, KuaishouTaskPages } from "../../src/automation/task-pages.js";

class FakePage extends EventEmitter {
  closed = false;
  isClosed() { return this.closed; }
  async close() { this.closed = true; this.emit("close"); }
  asPage() { return this as unknown as Page; }
}

function fixture() {
  const initial = new FakePage();
  const replacements: FakePage[] = [];
  const initialized: Page[] = [];
  let connected = true;
  const context = Object.assign(new EventEmitter(), {
    browser: () => ({ isConnected: () => connected }),
    newPage: async () => {
      assert.ok(connected, "must not operate a disconnected browser");
      const page = new FakePage();
      replacements.push(page);
      return page.asPage();
    },
  });
  const pages = new KuaishouTaskPages(context as unknown as BrowserContext, initial.asPage(),
    async page => { initialized.push(page); }, () => {});
  return { pages, initial, replacements, initialized, context,
    disconnect: () => { connected = false; context.emit("close"); } };
}

test("a closed task tab is replaced while the browser and login window remain open", async () => {
  const f = fixture();
  await f.initial.close();
  try {
    const used = await f.pages.read(async page => page);
    assert.equal(used, f.replacements[0]!.asPage());
    assert.deepEqual(f.initialized, [used]);
    assert.equal(await f.pages.read(async page => page), used);
    assert.equal(f.replacements.length, 1);
  } finally { await f.pages.dispose(); }
  assert.equal(f.replacements[0]!.closed, true);
  assert.equal(f.context.listenerCount("close"), 0);
});

test("a stale target error during a read retries once in a fresh page", async () => {
  const f = fixture();
  let attempts = 0;
  try {
    assert.equal(await f.pages.read(async () => {
      if (++attempts === 1) throw new Error("QUERY_REQUEST_FAILED: Target page, context or browser has been closed");
      return "submitted";
    }), "submitted");
    assert.equal(attempts, 2);
    assert.equal(f.replacements.length, 1);
  } finally { await f.pages.dispose(); }
});

test("a crashed or closed task page during material preparation is replaced before upload", async () => {
  const f = fixture();
  f.initial.emit("crash");
  assert.equal(f.initial.isClosed(), false, "a crashed tab can still exist in the browser");
  try {
    assert.equal(await f.pages.readyQueryPage(), f.replacements[0]!.asPage());
    assert.equal(f.replacements.length, 1);
  } finally { await f.pages.dispose(); }
});

test("business errors do not reopen tabs and repeated target loss does not retry indefinitely", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.pages.read(async () => { throw new Error("登录失效"); }), /登录失效/);
    assert.equal(f.replacements.length, 0);
    let attempts = 0;
    await assert.rejects(f.pages.read(async () => { attempts++; throw new Error("Target closed"); }), /Target closed/);
    assert.equal(attempts, 2);
    assert.equal(f.replacements.length, 1);
  } finally { await f.pages.dispose(); }
});

test("a disconnected browser stops recovery and reports the connection problem", async () => {
  const f = fixture();
  f.disconnect();
  try {
    await assert.rejects(f.pages.read(async () => assert.fail("must not read")), KuaishouBrowserUnavailableError);
    await assert.rejects(f.pages.newUploadPage(), KuaishouBrowserUnavailableError);
    assert.equal(f.replacements.length, 0);
  } finally { await f.pages.dispose(); }
});
