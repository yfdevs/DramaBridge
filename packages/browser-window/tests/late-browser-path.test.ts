import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { launchPlatformBrowserContext } from "../src/index.js";

test("importing the shared browser helper defers Playwright until the platform sets its browser root", async () => {
  const runtimeRequire = createRequire(import.meta.url);
  assert.equal(runtimeRequire.cache[runtimeRequire.resolve("playwright")], undefined,
    "shared imports must not initialize the Playwright registry before platform startup");
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL("../../../.cache/playwright-browsers", import.meta.url));
  try {
    const context = await launchPlatformBrowserContext("", { headless: true, channel: "chromium" });
    try {
      const { chromium } = await import("playwright");
      assert.ok(chromium.executablePath().startsWith(process.env.PLAYWRIGHT_BROWSERS_PATH));
      const page = await context.newPage();
      await page.setContent("<title>late browser path</title>");
      assert.equal(await page.title(), "late browser path");
    } finally { await context.close(); }
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
  }
});
