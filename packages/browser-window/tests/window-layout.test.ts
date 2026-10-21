import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { type BrowserContext, type Page } from "playwright";
import { launchPlatformBrowserContext } from "../src/index.js";

async function windowBounds(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  try {
    return await session.send("Browser.getWindowForTarget");
  } finally {
    await session.detach();
  }
}

test("resets native window bounds on launch, profile reopen and popup creation", async () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const profile = await mkdtemp(path.join(temporaryRoot, "dramabridge-window-test-"));
  let context: BrowserContext | undefined;
  try {
    const options = {
      headless: false,
      viewport: null,
      args: ["--window-size=900,600", "--window-position=200,150", "--start-maximized"],
    };
    context = await launchPlatformBrowserContext(profile, options);
    let page = context.pages()[0]!;
    const expected = await page.evaluate(() => {
      const screen = window.screen as Screen & { availLeft: number; availTop: number };
      return {
        left: screen.availLeft,
        top: screen.availTop,
        width: Math.round(screen.availWidth * 2 / 3),
        height: Math.round(screen.availHeight * 2 / 3),
        windowState: "normal",
      };
    });
    assert.deepEqual((await windowBounds(context, page)).bounds, expected);

    // Simulate the user resizing/maximizing the window before closing it.
    const session = await context.newCDPSession(page);
    const { windowId } = await windowBounds(context, page);
    await session.send("Browser.setWindowBounds", {
      windowId, bounds: { windowState: "maximized" },
    });
    await session.detach();
    await context.close();
    context = await launchPlatformBrowserContext(profile, { headless: false, viewport: null });
    page = context.pages()[0]!;
    assert.deepEqual((await windowBounds(context, page)).bounds, expected);

    const popupReady = context.waitForEvent("page");
    await page.evaluate(() => { window.open("about:blank", "layout-test", "width=400,height=400"); });
    const popup = await popupReady;
    assert.notEqual((await windowBounds(context, popup)).windowId, (await windowBounds(context, page)).windowId);
    // The page event handler runs asynchronously for windows opened by a site.
    let actual = (await windowBounds(context, popup)).bounds;
    for (let attempt = 0; attempt < 50 && !isDeepStrictEqual(actual, expected); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      actual = (await windowBounds(context, popup)).bounds;
    }
    assert.deepEqual(actual, expected);
  } finally {
    await context?.close();
    // Delete only the temporary profile created by this test.
    assert.equal(path.dirname(profile), temporaryRoot);
    assert.ok(path.basename(profile).startsWith("dramabridge-window-test-"));
    await rm(profile, { recursive: true, force: true });
  }
});

test("keeps headless browser launches available", async () => {
  const context = await launchPlatformBrowserContext("", { headless: true, channel: "chromium" });
  try {
    const page = context.pages()[0]!;
    await page.setContent("<title>headless check</title>");
    assert.equal(await page.title(), "headless check");
  } finally {
    await context.close();
  }
});
