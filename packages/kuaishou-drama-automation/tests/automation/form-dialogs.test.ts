import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { confirmKuaishouBatchDialog } from "../../src/automation/batch-dialog.js";
import { selectYearByLabel } from "../../src/automation/form-controls.js";

let browser: Browser;
before(async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(
    new URL("../../../../.cache/playwright-browsers", import.meta.url),
  );
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});
after(async () => { await browser?.close(); });

test("batch confirmation waits for async closure without clicking the disappearing button twice", async () => {
  const page = await browser.newPage();
  try {
    for (const delay of [150, 700]) {
      await page.setContent(`<div role="dialog" aria-label="批量设置"><button onclick="window.clicks++; setTimeout(() => this.parentElement.style.display='none', ${delay})">确认</button></div>
        <script>window.clicks=0</script>`);
      const dialog = page.getByRole("dialog", { name: "批量设置" });
      await confirmKuaishouBatchDialog(page, dialog);
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    }
  } finally { await page.close(); }
});

test("a delayed price notice is handled while the batch request closes asynchronously", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="dialog" aria-label="批量设置" id="batch"><button onclick="window.clicks++; setTimeout(() => notice.style.display='block', 300)">确认</button></div>
      <div role="dialog" id="notice" style="display:none"><button onclick="notice.style.display='none'; setTimeout(() => batch.style.display='none', 150)">我已确认</button></div>
      <script>window.clicks=0</script>`);
    await confirmKuaishouBatchDialog(page, page.getByRole("dialog", { name: "批量设置" }));
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
  } finally { await page.close(); }
});

test("only an actual price warning permits a second batch confirmation", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="dialog" aria-label="批量设置" id="batch"><button onclick="window.clicks++; if(window.accepted) batch.style.display='none'; else notice.style.display='block'">确认</button></div>
      <div role="dialog" id="notice" style="display:none"><button onclick="window.accepted=true; notice.style.display='none'">我已确认</button></div>
      <script>window.clicks=0;window.accepted=false</script>`);
    await confirmKuaishouBatchDialog(page, page.getByRole("dialog", { name: "批量设置" }));
    assert.equal(await page.evaluate(() => (window as any).clicks), 2);
  } finally { await page.close(); }
});

test("a visible price notice is confirmed even when the batch panel has already closed", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div role="dialog" aria-label="批量设置" id="batch"><button onclick="batch.style.display='none';notice.style.display='block'">确认</button></div>
      <div role="dialog" id="notice" style="display:none"><button onclick="notice.style.display='none';window.accepted=true">我已确认</button></div>
      <script>window.accepted=false</script>`);
    await confirmKuaishouBatchDialog(page, page.getByRole("dialog", { name: "批量设置" }));
    assert.equal(await page.evaluate(() => (window as any).accepted), true);
  } finally { await page.close(); }
});

test("year selection reopens a hidden panel and resolves a changed popper association", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div class="ks-form-item"><label class="ks-form-item__label">制作年份</label>
      <input class="ks-input__inner" readonly aria-describedby="old-year" onclick="window.clicks++; if(window.clicks>1){this.setAttribute('aria-describedby','new-year');document.getElementById('new-year').style.display='block'}"></div>
      <div id="old-year" style="display:none"></div><div id="new-year" style="display:none"><table><tr><td onclick="document.querySelector('input').value='2026';document.getElementById('new-year').style.display='none'">2026</td></tr></table></div>
      <script>window.clicks=0</script>`);
    await selectYearByLabel(page, "制作年份", 2026);
    assert.equal(await page.locator("input").inputValue(), "2026");
    assert.equal(await page.evaluate(() => (window as any).clicks), 2);
    await selectYearByLabel(page, "制作年份", 2026);
    assert.equal(await page.evaluate(() => (window as any).clicks), 2);
  } finally { await page.close(); }
});
