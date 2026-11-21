import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  clearPromoteDataAnalysisDimensions,
  setPromoteDataAnalysisOption,
} from "../../src/data-sync/options.ts";

const bundledBrowsers = fileURLToPath(
  new URL("../../../../.cache/playwright-browsers", import.meta.url),
);
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(bundledBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
}
const { chromium } = await import("playwright");

void test("standard dashboard dimension selection in Chromium", async (t) => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const scope = page.locator("body");
  const row =
    '<div class="inline-flex cursor-pointer"><input type="checkbox"><span>订单/计划</span></div>';

  await t.test("waits for delayed clear before selecting the first field", async () => {
    await page.setContent(`<button>清空</button>${row}`);
    await page.evaluate(() => {
      document.querySelector("input").checked = true;
      document.querySelector("button").onclick = () => {
        setTimeout(() => {
          document.querySelector("input").checked = false;
        }, 600);
      };
    });
    await clearPromoteDataAnalysisDimensions(scope);
    assert.equal(await page.locator("input").isChecked(), false);
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    assert.equal(await page.locator("input").isChecked(), true);
  });

  await t.test("recovers when the first input click is ignored", async () => {
    await page.setContent(row);
    await page.evaluate(() => {
      document.querySelector("input").onclick = (event) => event.preventDefault();
      document.querySelector("span").onclick = () => {
        document.querySelector("input").checked = true;
      };
    });
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    assert.equal(await page.locator("input").isChecked(), true);
  });

  await t.test("does not schedule a redundant clear on an already empty panel", async () => {
    await page.setContent(`<button>清空</button>${row}`);
    await page.evaluate(() => {
      window.clears = 0;
      document.querySelector("button").onclick = () => {
        window.clears++;
      };
    });
    await clearPromoteDataAnalysisDimensions(scope);
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    assert.equal(await page.evaluate(() => window.clears), 0);
    assert.equal(await page.locator("input").isChecked(), true);
  });

  await t.test("recovers from native input and wrapper both toggling selection", async () => {
    await page.setContent(row);
    await page.evaluate(() => {
      document.querySelector("div").onclick = () => {
        const input = document.querySelector("input");
        input.checked = !input.checked;
      };
    });
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    assert.equal(await page.locator("input").isChecked(), true);
  });

  await t.test("selects a hidden input through its custom label and stays idempotent", async () => {
    await page.setContent(row);
    await page.evaluate(() => {
      document.querySelector("input").style.display = "none";
      window.clicks = 0;
      document.querySelector("div").onclick = () => {
        window.clicks++;
        const input = document.querySelector("input");
        input.checked = !input.checked;
      };
    });
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    assert.equal(await page.evaluate(() => window.clicks), 1);
    await setPromoteDataAnalysisOption(scope, "订单/计划", false);
    assert.equal(await page.locator("input").isChecked(), false);
  });

  await t.test(
    "does not toggle twice when the platform renders selection asynchronously",
    async () => {
      await page.setContent(row);
      await page.evaluate(() => {
        document.querySelector("input").style.display = "none";
        window.clicks = 0;
        document.querySelector("div").onclick = () => {
          window.clicks++;
          setTimeout(() => {
            document.querySelector("input").checked = true;
          }, 800);
        };
      });
      await setPromoteDataAnalysisOption(scope, "订单/计划", true);
      assert.equal(await page.evaluate(() => window.clicks), 1);
    },
  );

  await t.test(
    "uses the visible exact field when names overlap and hidden copies exist",
    async () => {
      await page.setContent(`
      <div class="inline-flex cursor-pointer"><input type="checkbox"><span>短视频加热直播间素材</span></div>
      <div class="inline-flex cursor-pointer"><input id="target" type="checkbox"><span> 视 频 </span></div>
      <div class="inline-flex cursor-pointer" style="display:none"><input type="checkbox"><span>视频</span></div>`);
      await setPromoteDataAnalysisOption(scope, "视频", true);
      assert.equal(await page.locator("#target").isChecked(), true);
      assert.equal(await page.locator("input:checked").count(), 1);
    },
  );

  await t.test("supports ARIA controls and a replaced row", async () => {
    await page.setContent(
      '<div class="inline-flex cursor-pointer" role="checkbox" aria-checked="false"><span>订单/计划</span></div>',
    );
    await page.evaluate(() => {
      document.querySelector("div").onclick = () => {
        setTimeout(() => {
          document.querySelector("div").outerHTML =
            '<div class="inline-flex cursor-pointer" role="checkbox" aria-checked="true"><span>订单/计划</span></div>';
        }, 300);
      };
    });
    await setPromoteDataAnalysisOption(scope, "订单/计划", true);
    assert.equal(await page.getByRole("checkbox").getAttribute("aria-checked"), "true");
  });

  await t.test("reports a bounded failure when a custom control never changes", async () => {
    await page.setContent(
      '<div class="inline-flex cursor-pointer" role="checkbox" aria-checked="false"><span>订单/计划</span></div>',
    );
    await assert.rejects(
      setPromoteDataAnalysisOption(scope, "订单/计划", true),
      /未能选中.*已尝试 3 次/,
    );
    assert.equal(await page.getByRole("checkbox").getAttribute("aria-checked"), "false");
  });
});
