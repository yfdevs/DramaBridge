// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../../");
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(workspaceRoot, ".cache/playwright-browsers");

const [{ chromium }, { fillAndCreateTaobaoCollection }] = await Promise.all([
  import("playwright"),
  import("../../src/automation/collection.js"),
]);

const browserCacheDir = path.join(workspaceRoot, ".cache/playwright-browsers");
const cachedChromiumDirectory = (await readdir(browserCacheDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
  .sort((left, right) => Number(right.name.split("-")[1]) - Number(left.name.split("-")[1]))[0];
assert.ok(cachedChromiumDirectory, "未找到仓库共享的 Chromium 测试浏览器");

const browser = await chromium.launch({
  headless: true,
  executablePath: path.join(
    browserCacheDir,
    cachedChromiumDirectory.name,
    "chrome-win64/chrome.exe",
  ),
});

after(async () => {
  await browser.close();
});

test("fills a Fusion Next textbox without mistaking its label wrapper for the form item", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="next-form-item">
        <div class="next-form-item-label"><label>* 合集名称</label></div>
        <div class="next-form-item-control"><input id="collection-title"></div>
      </div>
    `);

    await assert.rejects(
      fillAndCreateTaobaoCollection(page, {
        title: "测试短剧",
        summary: "测试简介",
        episodeCount: 1,
        shortDramaType: "AI动漫短剧",
        shortDramaTags: ["3D漫"],
        audience: "男",
      }, "unused-cover.jpg", {}),
      /TAOBAO_DRAMA_FIELD_NOT_FOUND: labels=合集类型/u,
    );
    assert.equal(await page.locator("#collection-title").inputValue(), "测试短剧");
  } finally {
    await page.close();
  }
});
