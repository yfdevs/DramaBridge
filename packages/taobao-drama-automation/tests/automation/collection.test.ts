// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { TAOBAO_DRAMA_FIXED_FIELDS } from "../../src/shared/constants.js";
import { taobaoEpisodeBatchPagePlan } from "../../src/shared/constants.js";
import { waitForTaobaoPage } from "../../src/automation/browser-session.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../../");
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(workspaceRoot, ".cache/playwright-browsers");

const [{ chromium }, { fillAndCreateTaobaoCollection, isTaobaoCollectionCreateSuccessSignal, selectTaobaoDramaCollectionTags, shouldRetryTaobaoCollectionCreate, uploadTaobaoCollectionCover, uploadTaobaoCostConfigMaterial }] = await Promise.all([
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

test("keeps one homepage and one task tab through creation and all 235-episode batches", async () => {
  const context = await browser.newContext();
  const documentPaths: string[] = [];
  try {
    await context.route("https://creator.guanghe.taobao.com/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      documentPaths.push(pathname);
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: pathname.endsWith("collect-create")
        ? '<p>合集类型</p><button>创建合集</button>'
        : pathname.endsWith("batch-publish")
          ? '<p>上传视频</p><input type="file" accept="video/mp4"><textarea id="queue"></textarea>'
          : '<p>淘宝光合平台 合集管理</p>',
      });
    });
    const home = await context.newPage();
    await waitForTaobaoPage(home, "home", {});
    const homeUrl = home.url();
    const task = await context.newPage();
    await waitForTaobaoPage(task, "collection", {});
    await waitForTaobaoPage(task, "batch", {});
    for (const range of taobaoEpisodeBatchPagePlan(235)) {
      if (range.navigateToBatchPage) await waitForTaobaoPage(task, "batch", {}, { fresh: true });
      assert.equal(await task.locator("#queue").inputValue(), "", "previous upload queue must be cleared");
      await task.locator("#queue").fill(`${range.start}-${range.end}`);
      assert.equal(context.pages().length, 2);
      assert.equal(home.url(), homeUrl);
    }
    assert.deepEqual(documentPaths, [
      "/page/unify/collection", "/page/unify/collect-create",
      "/page/unify/creation-tool/batch-publish",
      "/page/unify/creation-tool/batch-publish",
      "/page/unify/creation-tool/batch-publish",
    ]);
  } finally { await context.close(); }
});

test("lets a client login redirect finish without repeated navigation", async () => {
  const context = await browser.newContext();
  let createRequests = 0;
  let loginRequests = 0;
  try {
    await context.route("https://creator.guanghe.taobao.com/**", async (route) => {
      createRequests += 1;
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: createRequests === 1
        ? '<script>location.replace("https://login.taobao.com/login.htm")</script>'
        : '<p>合集类型</p><button>创建合集</button>',
      });
    });
    await context.route("https://login.taobao.com/**", async (route) => {
      loginRequests += 1;
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: '<p>手机扫码登录</p>' });
    });
    const page = await context.newPage();
    const waiting = waitForTaobaoPage(page, "collection", {});
    const completed = assert.doesNotReject(waiting);
    await page.getByText("手机扫码登录").waitFor();
    assert.equal(loginRequests, 1);
    await page.goto("https://creator.guanghe.taobao.com/page/unify/collect-create");
    await completed;
    assert.equal(createRequests, 2);
    assert.equal(loginRequests, 1);
    assert.equal(context.pages().length, 1);
  } finally { await context.close(); }
});

test("accepts creator-domain redirects for home, collection and batch pages", { timeout: 20_000 }, async () => {
  const context = await browser.newContext();
  const redirectedPaths: string[] = [];
  try {
    await context.route("**/*", (route) => route.abort());
    await context.route("https://creator.guanghe.taobao.com/**", async (route) => {
      const url = new URL(route.request().url());
      redirectedPaths.push(url.pathname);
      url.hostname = "creator.tiancheng.taobao.com";
      await route.fulfill({ contentType: "text/html; charset=utf-8", body:
        `<script>location.replace(${JSON.stringify(url.href)})</script>`,
      });
    });
    await context.route("https://creator.tiancheng.taobao.com/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: pathname.endsWith("collect-create")
        ? '<p>合集类型</p><button>创建合集</button>'
        : pathname.endsWith("batch-publish")
          ? '<p>上传视频</p><input type="file" accept="video/mp4">'
          : '<p>淘宝工作台</p>',
      });
    });
    const page = await context.newPage();
    for (const target of ["home", "collection", "batch"] as const) {
      await waitForTaobaoPage(page, target, {});
      assert.equal(new URL(page.url()).hostname, "creator.tiancheng.taobao.com");
    }
    await waitForTaobaoPage(page, "batch", {}, { fresh: true });
    assert.deepEqual(redirectedPaths, [
      "/page/unify/collection", "/page/unify/collect-create",
      "/page/unify/creation-tool/batch-publish", "/page/unify/creation-tool/batch-publish",
    ]);
  } finally { await context.close(); }
});

test("uses Yang Aiping for Taobao collection people fields", () => {
  assert.equal(TAOBAO_DRAMA_FIXED_FIELDS.producerName, "杨爱平");
  assert.equal(TAOBAO_DRAMA_FIXED_FIELDS.directorName, "杨爱平");
  assert.equal(TAOBAO_DRAMA_FIXED_FIELDS.scriptwriterName, "杨爱平");
  assert.equal(TAOBAO_DRAMA_FIXED_FIELDS.mainActors, "杨爱平");
  assert.equal(TAOBAO_DRAMA_FIXED_FIELDS.productionCompany, "明星说（北京）科技有限公司");
});

test("recognizes a missing collection-create button after the settle period", () => {
  assert.equal(isTaobaoCollectionCreateSuccessSignal({
    navigated: false,
    successMessageVisible: false,
    createButtonVisible: false,
    settlePeriodComplete: true,
  }), true);
  assert.equal(isTaobaoCollectionCreateSuccessSignal({
    navigated: false,
    successMessageVisible: false,
    createButtonVisible: false,
    settlePeriodComplete: false,
  }), false);
  assert.equal(isTaobaoCollectionCreateSuccessSignal({
    navigated: false,
    successMessageVisible: false,
    createButtonVisible: true,
    settlePeriodComplete: true,
  }), false);
});

test("retries collection creation only once when the button remains usable", () => {
  const retryable = {
    success: false,
    alreadyRetried: false,
    settlePeriodComplete: true,
    createButtonVisible: true,
    createButtonEnabled: true,
  };
  assert.equal(shouldRetryTaobaoCollectionCreate(retryable), true);
  assert.equal(shouldRetryTaobaoCollectionCreate({ ...retryable, alreadyRetried: true }), false);
  assert.equal(shouldRetryTaobaoCollectionCreate({ ...retryable, createButtonEnabled: false }), false);
  assert.equal(shouldRetryTaobaoCollectionCreate({ ...retryable, settlePeriodComplete: false }), false);
});

test("fills a Fusion Next textbox without mistaking its label wrapper for the form item", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="next-form-item">
        <div class="next-form-item-label">
          <label for="collection-title" required>
            <span>合集名称<span class="sub-label--test">最低内容要求2字以上</span></span>
          </label>
        </div>
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
      }, "unused-cover.jpg", "unused-cost.png", {}),
      /TAOBAO_DRAMA_FIELD_NOT_FOUND: labels=合集类型/u,
    );
    assert.equal(await page.locator("#collection-title").inputValue(), "测试短剧");
  } finally {
    await page.close();
  }
});

test("selects hashed-class Taobao dialog tags and confirms the dialog", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="next-form-item">
        <div class="next-form-item-label"><label>* 短剧标签</label></div>
        <div id="tag-control" class="next-form-item-control"><button id="open-tags">选择</button></div>
      </div>
      <div id="tag-dialog" class="next-dialog" style="display:none">
        <div class="next-dialog-body next-dialog-body-no-footer">
          <div class="dialog-content--JWBAZGEV">
            <div class="dialog-group--HcUEaeJM">
              <div class="dialog-group-title--GMghXWn5">短剧内容类型</div>
              <div class="dialog-tags--cfPFid8I">
                <div class="dialog-tag--oTkYljha"><span class="dialog-tag-label--rFX9pBVn">AI动漫解说漫</span></div>
                <div class="dialog-tag--oTkYljha"><span class="dialog-tag-label--rFX9pBVn">3D漫</span></div>
              </div>
            </div>
            <div class="dialog-group--HcUEaeJM">
              <div class="dialog-group-title--GMghXWn5">核心情节</div>
              <div class="dialog-tags--cfPFid8I">
                <div class="dialog-tag--oTkYljha"><span class="dialog-tag-label--rFX9pBVn">逆袭</span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="dialog-footer--g6YvQEOY"><button class="dialog-confirm-btn--nqH0_iMG">确认</button></div>
      </div>
      <script>
        const dialog = document.querySelector('#tag-dialog');
        const selected = new Set();
        document.querySelector('#open-tags').addEventListener('click', () => {
          setTimeout(() => dialog.style.display = 'block', 700);
        });
        document.querySelectorAll('[class*="dialog-tag--"]').forEach((tag) => tag.addEventListener('click', () => {
          selected.add(tag.textContent.trim());
          tag.classList.add('selected');
        }));
        document.querySelector('[class*="dialog-confirm-btn"]').addEventListener('click', () => {
          const control = document.querySelector('#tag-control');
          selected.forEach((value) => {
            const chip = document.createElement('span');
            chip.className = 'selection-item';
            chip.textContent = value;
            control.appendChild(chip);
          });
          dialog.style.display = 'none';
        });
      </script>
    `);

    await selectTaobaoDramaCollectionTags(page, ["AI动漫解说漫", "逆袭"]);

    assert.equal(await page.locator("#tag-dialog").isVisible(), false);
    assert.deepEqual(await page.locator("#tag-control .selection-item").allInnerTexts(), ["AI动漫解说漫", "逆袭"]);
  } finally {
    await page.close();
  }
});

test("uploads a collection cover through image space and confirms the delayed crop dialog", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="next-form-item">
        <div class="next-form-item-label"><label>* 封面</label></div>
        <div id="cover-control" class="next-form-item-control"><button id="open-cover">添加封面</button></div>
      </div>
      <div id="media-dialog" role="dialog" class="next-dialog" style="display:none">
        <h2>选择图片</h2>
        <div class="media-operation">
          <button type="button">上传新图片</button>
          <input id="cover-file" type="file" hidden multiple accept="image/*">
        </div>
        <button id="apply-cover" type="button">确认</button>
      </div>
      <div id="crop-dialog" role="dialog" class="next-dialog speedster-image-space-dialog" style="display:none">
        <div class="next-dialog-header">裁剪图片</div>
        <div class="next-dialog-body"><canvas width="307" height="439"></canvas></div>
        <div class="next-dialog-footer"><button id="confirm-crop" type="button">确定</button></div>
      </div>
      <script>
        const mediaDialog = document.querySelector('#media-dialog');
        const cropDialog = document.querySelector('#crop-dialog');
        document.querySelector('#open-cover').addEventListener('click', () => {
          mediaDialog.style.display = 'block';
        });
        document.querySelector('#cover-file').addEventListener('change', () => {
          setTimeout(() => cropDialog.style.display = 'block', 700);
        });
        document.querySelector('#confirm-crop').addEventListener('click', () => {
          cropDialog.style.display = 'none';
        });
        document.querySelector('#apply-cover').addEventListener('click', () => {
          mediaDialog.style.display = 'none';
          const preview = document.createElement('img');
          preview.id = 'cover-preview';
          preview.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
          document.querySelector('#cover-control').appendChild(preview);
        });
      </script>
    `);

    await uploadTaobaoCollectionCover(page, path.join(workspaceRoot, "public/taobao.png"));

    assert.equal(await page.locator("#media-dialog").isVisible(), false);
    assert.equal(await page.locator("#crop-dialog").isVisible(), false);
    assert.equal(await page.locator("#cover-file").evaluate((element: HTMLInputElement) => element.files?.length), 1);
    assert.equal(await page.locator("#cover-preview").isVisible(), true);
  } finally {
    await page.close();
  }
});

test("uploads the cost contract through its hidden image input", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="next-form-item next-medium">
        <div class="next-form-item-label"><label for="costConfigFileKey" required>成本配置材料</label></div>
        <div class="next-form-item-control">
          <div class="next-upload"><div role="application" class="next-upload-inner" tabindex="0">
            <input id="costConfigFileKey" type="file" name="file" accept="image/*" aria-hidden="true" style="display:none">
            <div class="wrap--test"><div class="poster--test"></div></div>
          </div></div>
        </div>
      </div>
      <script>
        document.querySelector("#costConfigFileKey").addEventListener("change", () => {
          const preview = document.createElement("img");
          preview.id = "cost-preview";
          preview.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
          document.querySelector(".next-upload-inner").append(preview);
        });
      </script>
    `);

    await uploadTaobaoCostConfigMaterial(page, path.join(workspaceRoot, "public/taobao.png"));

    assert.equal(
      await page.locator("#costConfigFileKey").evaluate((element: HTMLInputElement) => element.files?.length),
      1,
    );
    assert.equal(await page.locator("#cost-preview").isVisible(), true);
  } finally {
    await page.close();
  }
});
