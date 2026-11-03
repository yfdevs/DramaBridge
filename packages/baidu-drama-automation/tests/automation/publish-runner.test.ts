import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

import {
  configureBaiduDistribution,
  collectShortDramaCertificationFiles,
  submitBaiduDramaForReview,
} from "../../src/automation/publish-runner.js";

const reviewTestTiming = {
  settleMs: 100,
  resultTimeoutMs: 800,
  captchaTimeoutMs: 500,
  pollIntervalMs: 20,
};

test("Baidu review submission waits for a real management-page result", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://duanju.baidu.com/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<button type="button" aria-label="提交审核">提交审核</button>
        <script>
          document.querySelector('button').addEventListener('click', () => {
            setTimeout(() => history.pushState({}, '', '/builder/rc/playletPlat/home'), 50);
          });
        </script>`,
    }));
    await page.goto("https://duanju.baidu.com/builder/rc/edit?sub_type=create_playlet_videos");
    assert.equal(await page.getByRole("button", { name: "提交审核" }).count(), 1, await page.content());

    await submitBaiduDramaForReview(page, {}, reviewTestTiming);

    assert.match(page.url(), /playletPlat\/home$/);
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});

test("Baidu review submission stays pending while security verification is visible", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://duanju.baidu.com/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<button type="button" aria-label="提交审核">提交审核</button>
        <div class="passMod_dialog-container" style="display: none">
          <p>百度安全验证</p><button type="button" class="solve">人工完成验证</button>
        </div>
        <script>
          const captcha = document.querySelector('.passMod_dialog-container');
          document.querySelector('[aria-label="提交审核"]').addEventListener('click', () => {
            captcha.style.display = 'block';
          });
          document.querySelector('.solve').addEventListener('click', () => {
            captcha.style.display = 'none';
            history.pushState({}, '', '/builder/rc/playletPlat/home');
          });
        </script>`,
    }));
    await page.goto("https://duanju.baidu.com/builder/rc/edit?sub_type=create_playlet_videos");

    let finished = false;
    const submission = submitBaiduDramaForReview(page, {}, reviewTestTiming).finally(() => {
      finished = true;
    });
    await page.locator(".passMod_dialog-container").waitFor({ state: "visible" });
    await page.waitForTimeout(120);
    assert.equal(finished, false);
    await page.locator(".solve").click();
    await submission;

    assert.match(page.url(), /playletPlat\/home$/);
  } finally {
    await browser.close();
  }
});

test("Baidu review submission does not report success when the page never leaves the upload step", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://duanju.baidu.com/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<button type="button" aria-label="提交审核">提交审核</button>',
    }));
    await page.goto("https://duanju.baidu.com/builder/rc/edit?sub_type=create_playlet_videos");

    await assert.rejects(
      submitBaiduDramaForReview(page, {}, { ...reviewTestTiming, resultTimeoutMs: 150 }),
      /BAIDU_DRAMA_SUBMIT_NOT_CONFIRMED/,
    );
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});

test("Baidu review submission reports a verification timeout instead of success", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://duanju.baidu.com/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<button type="button" aria-label="提交审核">提交审核</button>
        <div class="passMod_dialog-container" style="display: none">百度安全验证</div>
        <script>
          document.querySelector('button').addEventListener('click', () => {
            document.querySelector('.passMod_dialog-container').style.display = 'block';
          });
        </script>`,
    }));
    await page.goto("https://duanju.baidu.com/builder/rc/edit?sub_type=create_playlet_videos");

    await assert.rejects(
      submitBaiduDramaForReview(page, {}, { ...reviewTestTiming, captchaTimeoutMs: 150 }),
      /BAIDU_DRAMA_CAPTCHA_MANUAL_VERIFICATION_TIMEOUT/,
    );
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});

test("uploads every Baidu contract file to short drama certification", () => {
  const files = collectShortDramaCertificationFiles({
    qualification: { proofFiles: [] },
    copyright: {
      productionProofFiles: ["contract.pdf"],
      licenseProofFiles: ["authorization.pdf"],
    },
    productionCost: { proofFiles: ["cost-report.pdf"] },
    commitmentFiles: ["commitment.pdf"],
  });

  assert.deepEqual(files, [
    "contract.pdf",
    "authorization.pdf",
    "cost-report.pdf",
    "commitment.pdf",
  ]);
});

test("keeps all files per type and removes duplicate references", () => {
  const files = collectShortDramaCertificationFiles({
    qualification: { proofFiles: ["qualification.pdf"] },
    copyright: {
      productionProofFiles: ["contract-a.pdf", "contract-b.pdf"],
      licenseProofFiles: ["authorization.pdf"],
    },
    productionCost: { proofFiles: ["cost-report.pdf"] },
    commitmentFiles: ["commitment.pdf", "contract-a.pdf"],
  });

  assert.deepEqual(files, [
    "qualification.pdf",
    "contract-a.pdf",
    "contract-b.pdf",
    "authorization.pdf",
    "cost-report.pdf",
    "commitment.pdf",
  ]);
});

for (const material of ["", "下载链接：https://example.com/material"]) {
  test(`Baidu distribution waits for the delayed material field (${material || "optional empty"})`, async () => {
    const browser = await chromium.launch({ channel: "chromium", headless: true });
    try {
      const page = await browser.newPage();
      await configureBaiduDistribution(page, { supportDistribution: false });
      await page.setContent(`<label><input type="checkbox" id="canSplit"><span>支持分销</span></label>
        <script>document.querySelector('input').onchange = () => setTimeout(() => {
          const field = document.createElement('textarea'); field.id = 'commissionMaterial';
          document.body.append(field);
        }, 200);</script>`);
      await configureBaiduDistribution(page, { supportDistribution: true, distributionMaterial: material });
      assert.equal(await page.locator('#canSplit').isChecked(), true);
      assert.equal(await page.locator('#commissionMaterial').inputValue(), material);
    } finally { await browser.close(); }
  });
}
