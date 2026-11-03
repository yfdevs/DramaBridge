import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import {
  assertNoBaiduFormError,
  confirmBaiduDramaTypeChangeIfPresent,
  selectDropdownOption,
  selectFormItem,
  uploadCoverSlot,
} from "../../src/automation/form-controls.js";

test("retries Baidu form-error inspection when navigation destroys the document context", async () => {
  let scans = 0;
  let loadWaits = 0;
  const page = {
    isClosed: () => false,
    locator: () => ({
      allTextContents: async () => {
        scans += 1;
        if (scans === 1) {
          throw new Error("locator.allTextContents: Execution context was destroyed, most likely because of a navigation");
        }
        return [];
      },
    }),
    waitForLoadState: async () => {
      loadWaits += 1;
    },
    waitForTimeout: async () => undefined,
  } as unknown as import("playwright").Page;

  await assertNoBaiduFormError(page, "提交短剧审核");

  assert.equal(loadWaits, 1);
  assert.equal(scans, 3);
});

test("confirms a delayed Baidu drama-type change dialog before continuing", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button class="type-card" type="button">非真人短剧</button>
      <div class="cheetah-modal-wrap" style="display: none" role="dialog">
        <div class="cheetah-modal-content">
          <p>变更短剧类型后需重新填写短剧信息，是否确认变更？</p>
          <button type="button">取消</button>
          <button class="confirm" type="button">确定</button>
        </div>
      </div>
      <script>
        const dialog = document.querySelector('.cheetah-modal-wrap');
        document.querySelector('.type-card').addEventListener('click', () => {
          setTimeout(() => { dialog.style.display = 'block'; }, 50);
        });
        document.querySelector('.confirm').addEventListener('click', () => {
          dialog.style.display = 'none';
        });
      </script>
    `);

    await page.getByText("非真人短剧", { exact: true }).click();
    assert.equal(await confirmBaiduDramaTypeChangeIfPresent(page, 1_000), true);
    assert.equal(await page.locator(".cheetah-modal-wrap").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("selects both Baidu categories promptly when neither has a selected item yet", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1_000);
    await page.setContent(`
      <div class="cheetah-form-item">
        <label>剧情分类</label>
        <div class="cheetah-select">
          <div class="cheetah-select-selector"><input role="combobox" aria-expanded="false" readonly></div>
        </div>
      </div>
      <div class="cheetah-form-item">
        <label>二级分类</label>
        <div class="cheetah-select">
          <div class="cheetah-select-selector"><input role="combobox" aria-expanded="false" readonly></div>
        </div>
      </div>
      <div class="cheetah-select-dropdown" style="display: none">
        <div class="cheetah-select-item-option">男频</div>
      </div>
      <div class="cheetah-select-dropdown" style="display: none">
        <div class="cheetah-select-item-option">奇幻</div>
      </div>
      <script>
        const selectors = document.querySelectorAll('.cheetah-select-selector');
        const dropdowns = document.querySelectorAll('.cheetah-select-dropdown');
        selectors.forEach((selector, index) => {
          const input = selector.querySelector('input');
          const dropdown = dropdowns[index];
          selector.addEventListener('click', () => {
            input.setAttribute('aria-expanded', 'true');
            dropdown.style.display = 'block';
          });
          dropdown.querySelector('.cheetah-select-item-option').addEventListener('click', (event) => {
            const selected = document.createElement('span');
            selected.className = 'cheetah-select-selection-item';
            selected.textContent = event.currentTarget.textContent;
            selected.title = selected.textContent;
            selector.append(selected);
            input.setAttribute('aria-expanded', 'false');
            dropdown.style.display = 'none';
          });
        });
      </script>
    `);

    const startedAt = Date.now();
    await selectFormItem(page, "剧情分类", "男频");
    await selectDropdownOption(page, page.locator('[role="combobox"]').nth(1), "奇幻");

    assert.deepEqual(await page.locator(".cheetah-select-selection-item").allTextContents(), ["男频", "奇幻"]);
    assert.ok(Date.now() - startedAt < 3_000, "empty category selections should not wait for missing DOM nodes");
  } finally {
    await browser.close();
  }
});

test("opens a Baidu category select through its visible selector instead of the hidden combobox", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1_000);
    await page.setContent(`
      <div class="cheetah-form-item">
        <label>剧情分类</label>
        <div class="cheetah-select">
          <div class="cheetah-select-selector">
            <input
              role="combobox"
              aria-expanded="false"
              readonly
              value=""
              style="width: 0; height: 0; opacity: 0; pointer-events: none"
            >
            <span class="cheetah-select-selection-item" title="男频">男频</span>
          </div>
        </div>
      </div>
      <div class="cheetah-select-dropdown" style="display: none">
        <div class="cheetah-select-item-option">女频</div>
      </div>
      <script>
        const input = document.querySelector('[role="combobox"]');
        const selector = document.querySelector('.cheetah-select-selector');
        const selected = document.querySelector('.cheetah-select-selection-item');
        const dropdown = document.querySelector('.cheetah-select-dropdown');
        selector.addEventListener('click', () => {
          input.setAttribute('aria-expanded', 'true');
          dropdown.style.display = 'block';
        });
        dropdown.querySelector('.cheetah-select-item-option').addEventListener('click', () => {
          selected.textContent = '女频';
          selected.title = '女频';
          input.setAttribute('aria-expanded', 'false');
          dropdown.style.display = 'none';
        });
      </script>
    `);

    await selectFormItem(page, "剧情分类", "女频");

    assert.equal(await page.locator(".cheetah-select-selection-item").textContent(), "女频");
  } finally {
    await browser.close();
  }
});

test("accepts a Baidu cover upload when the component clears the file input immediately", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baidu-cover-input-"));
  const coverFile = path.join(root, "cover.jpg");
  await writeFile(coverFile, Buffer.from("test cover"));
  const browser = await chromium.launch({ channel: "chromium", headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button class="coverUploaderView" type="button">16:9</button>
      <div class="cheetah-modal-wrap" role="dialog" style="display: none">
        <div class="cheetah-tabs-tab cheetah-tabs-tab-active" role="tab" aria-selected="true">
          本地图片
        </div>
        <div class="local-image-panel">
          <input type="file" accept="image/jpeg,image/png">
          <span class="upload-count">0张上传成功</span>
          <button class="confirm" type="button" disabled>确认</button>
        </div>
      </div>
      <script>
        const slot = document.querySelector('.coverUploaderView');
        const dialog = document.querySelector('.cheetah-modal-wrap');
        const input = dialog.querySelector('input[type="file"]');
        const count = dialog.querySelector('.upload-count');
        const confirm = dialog.querySelector('.confirm');
        slot.addEventListener('click', () => {
          dialog.style.display = 'block';
        });
        input.addEventListener('change', () => {
          input.value = '';
          setTimeout(() => {
            count.textContent = '1张上传成功';
            confirm.disabled = false;
          }, 10);
        });
        confirm.addEventListener('click', () => {
          dialog.style.display = 'none';
          slot.innerHTML = '<div class="bjh-image-box"><div class="cover-uploader-view-image"><div role="image" style="background-image: url(https://example.com/cover.jpg)"></div></div></div>';
        });
      </script>
    `);

    const slot = page.locator(".coverUploaderView");
    const receipt = await uploadCoverSlot(page, slot, coverFile, { maxAttempts: 1 });

    assert.equal(receipt.file, coverFile);
    assert.equal(await page.locator(".upload-count").textContent(), "1张上传成功");
    assert.equal(await page.locator('.bjh-image-box [role="image"]').count(), 1);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scrolls a rendered Baidu dropdown option into its clipped list before clicking", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`
      <div class="cheetah-select">
        <div class="cheetah-select-selector"><input role="combobox" readonly aria-expanded="false"></div>
      </div>
      <div class="cheetah-select-dropdown" style="display:none">
        <div class="rc-virtual-list-holder" style="height:100px;overflow:auto">
          <div style="height:900px"></div>
          <div class="cheetah-select-item-option" style="height:32px">奇幻</div>
        </div>
      </div>
      <script>
        const input = document.querySelector('input');
        const dropdown = document.querySelector('.cheetah-select-dropdown');
        document.querySelector('.cheetah-select-selector').onclick = () => {
          dropdown.style.display = 'block';
          input.setAttribute('aria-expanded', 'true');
        };
        document.querySelector('.cheetah-select-item-option').onclick = () => {
          input.value = '奇幻';
          dropdown.style.display = 'none';
          input.setAttribute('aria-expanded', 'false');
        };
      </script>
    `);
    await selectDropdownOption(page, page.getByRole("combobox"), "奇幻");
    assert.equal(await page.getByRole("combobox").inputValue(), "奇幻");
  } finally {
    await browser.close();
  }
});
