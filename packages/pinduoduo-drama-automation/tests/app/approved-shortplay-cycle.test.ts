import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import {
  assertPinduoduoEpisodeFileCount,
  bindAllUploadedVideosToDrama,
  createDramaAndBindAllUploadedVideos,
  pinduoduoUploadVerifyTimeoutMs,
  publishAllUploadedVideos,
  selectAiContentDeclaration,
  splitPinduoduoVideoFiles,
  waitForPinduoduoVideoUploads,
} from "../../src/app/approved-shortplay-cycle.js";
import {
  readShortplayApplyRecords,
  shouldUploadApprovedShortplay,
} from "../../src/app/shortplay-manage-page.js";
import { createdTopicRepairState } from "../../src/storage/pinduoduo-upload-records-repository.js";

test("only queues approved shortplays whose topic has not been created", () => {
  const records = readShortplayApplyRecords({
    result: {
      list: [
        { id: 1, title: "未创建短剧", status: 2, topic_create_status: 0 },
        { id: 2, title: "已经创建短剧", status: 2, topic_create_status: 1 },
        { id: 3, title: "未通过审核", status: 3, topic_create_status: 0 },
        { id: 4, title: "旧数据无创建字段", status: 2 },
        { id: 5, title: "带创建时间", status: 2, gmt_create: 1791002365363 },
      ],
    },
  });

  assert.equal(records[0]?.topicCreateStatus, 0);
  assert.equal(records[1]?.topicCreateStatus, 1);
  assert.equal(records[4]?.gmtCreate, 1791002365363);
  assert.deepEqual(
    records.filter(shouldUploadApprovedShortplay).map((record) => record.id),
    [1, 4, 5],
  );
});

test("uses a configurable Pinduoduo video upload timeout with a 60-minute default", () => {
  assert.equal(pinduoduoUploadVerifyTimeoutMs({}), 60 * 60_000);
  assert.equal(
    pinduoduoUploadVerifyTimeoutMs({ config: { video: { videoUploadTimeoutMinutes: "120" } } }),
    120 * 60_000,
  );
});

test("splits Pinduoduo videos into upload pages of at most 50 files", () => {
  const files = Array.from({ length: 123 }, (_, index) => `第${index + 1}集.mp4`);
  const batches = splitPinduoduoVideoFiles(files);

  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 23]);
  assert.deepEqual(batches.flat(), files);
});

test("rejects an incomplete local episode directory before uploading", () => {
  assert.throws(
    () => assertPinduoduoEpisodeFileCount(["第1集.mp4", "第2集.mp4"], 3),
    /PINDUODUO_EPISODE_FILE_COUNT_MISMATCH.*应有 3 集.*实际发现 2 个视频/u,
  );
  assert.doesNotThrow(() =>
    assertPinduoduoEpisodeFileCount(["第1集.mp4", "第2集.mp4"], 2),
  );
});

test("retains an interrupted multi-batch record without replaying completed batches", () => {
  assert.deepEqual(
    createdTopicRepairState({
      attempts: 2,
      createdAt: "2026-09-27T00:00:00.000Z",
      episodeCount: 83,
      platformApplyId: 2,
      status: "FAILED",
      title: "断点短剧",
      totalBatchCount: 2,
      updatedAt: "2026-09-27T00:00:00.000Z",
      uploadedBatchCount: 1,
    }),
    {
      resetToPending: false,
      totalBatchCount: 2,
      uploadedBatchCount: 1,
    },
  );
});

test("does not reopen a fully completed multi-batch record", () => {
  assert.equal(
    createdTopicRepairState({
      attempts: 1,
      createdAt: "2026-09-27T00:00:00.000Z",
      episodeCount: 83,
      platformApplyId: 3,
      status: "UPLOADED",
      title: "完整短剧",
      totalBatchCount: 2,
      updatedAt: "2026-09-27T00:00:00.000Z",
      uploadedBatchCount: 2,
    }),
    undefined,
  );
});

test("waits until every file card reports video upload success", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="card-1"><p>文件名：测试剧 - 第1集.mp4</p><div data-testid="beast-core-select"></div></div>
      <div class="card-2"><p>文件名：测试剧 - 第2集.mp4</p><div data-testid="beast-core-select"></div></div>
      <script>
        setTimeout(() => {
          document.querySelector('.card-1').insertAdjacentHTML('beforeend', '<div><svg data-testid="beast-core-icon-check-circle_filled"></svg>视频上传成功</div>');
        }, 100);
        setTimeout(() => {
          document.querySelector('.card-2').insertAdjacentHTML('beforeend', '<div><svg data-testid="beast-core-icon-check-circle_filled"></svg>视频上传成功</div>');
        }, 300);
      </script>
    `);
    const progress: number[] = [];

    const result = await waitForPinduoduoVideoUploads(
      page,
      ["C:\\videos\\测试剧 - 第1集.mp4", "C:\\videos\\测试剧 - 第2集.mp4"],
      5_000,
      (uploadedCount) => progress.push(uploadedCount),
    );

    assert.equal(result.rejected, false);
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), 2);
  } finally {
    await browser.close();
  }
});

test("stops waiting for Pinduoduo uploads when the service is cancelled", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div><p>文件名：取消测试 - 第1集.mp4</p><div data-testid="beast-core-select"></div></div>
    `);
    const controller = new AbortController();
    const waiting = waitForPinduoduoVideoUploads(
      page,
      ["C:\\videos\\取消测试 - 第1集.mp4"],
      60_000,
      undefined,
      controller.signal,
    );
    controller.abort(new Error("PINDUODUO_DRAMA_RUNTIME_STOPPED"));

    await assert.rejects(waiting, /PINDUODUO_DRAMA_RUNTIME_STOPPED/);
  } finally {
    await browser.close();
  }
});

test("selects the visible Pinduoduo AI declaration option instead of the hidden mirror", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-testid="beast-core-select">
        <div data-testid="beast-core-select-header">
          <input data-testid="beast-core-select-htmlInput" readonly value="内容无需标注">
          <div class="IPT_mirror_5-152-0" style="display: none">含AI生成内容</div>
        </div>
      </div>
      <div data-testid="beast-core-portal" style="display: none">
        <div data-testid="beast-core-portal-main">
          <div class="fCLstg_M">内容无需标注<span>（作品不含AI生成信息）</span></div>
          <div class="fCLstg_M ai-option">含AI生成内容<span></span></div>
          <div class="fCLstg_M">含虚构演绎内容<span></span></div>
        </div>
      </div>
      <script>
        const select = document.querySelector('[data-testid="beast-core-select"]');
        const portal = document.querySelector('[data-testid="beast-core-portal"]');
        select.querySelector('[data-testid="beast-core-select-header"]').addEventListener('click', () => {
          portal.style.display = 'block';
        });
        document.querySelector('.ai-option').addEventListener('click', () => {
          select.querySelector('input').value = '含AI生成内容';
          portal.style.display = 'none';
        });
      </script>
    `);

    const select = page.locator('[data-testid="beast-core-select"]');
    await selectAiContentDeclaration(page, select);

    assert.equal(await select.locator("input").inputValue(), "含AI生成内容");
    assert.equal(await page.locator('[data-testid="beast-core-portal"]').isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("scrolls to a drama and binds every uploaded video in one action", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="first-card">
        <button type="button">添加至已有短剧</button>
      </div>
      <section class="chooser" style="display: none">
        <div data-testid="beast-core-pullToRefresh" style="height: 80px; overflow-y: auto">
          <div class="spacer" style="height: 400px">其他短剧</div>
        </div>
        <label data-testid="beast-core-checkbox">
          <input type="checkbox">
          <span>将所上传视频全部添加至此短剧</span>
        </label>
        <button type="button">确认添加</button>
      </section>
      <script>
        const chooser = document.querySelector('.chooser');
        const list = document.querySelector('[data-testid="beast-core-pullToRefresh"]');
        document.querySelector('.first-card button').addEventListener('click', () => {
          chooser.style.display = 'block';
        });
        list.addEventListener('scroll', () => {
          if (list.querySelector('.target-drama')) return;
          const row = document.createElement('label');
          row.className = 'target-drama';
          row.dataset.testid = 'beast-core-checkbox';
          row.innerHTML = '<input type="checkbox"><div>果园的天平</div>';
          list.append(row);
        });
        document.querySelector('.chooser button').addEventListener('click', () => {
          chooser.style.display = 'none';
        });
      </script>
    `);

    const bound = await bindAllUploadedVideosToDrama(
      page,
      page.locator(".first-card"),
      "果园的天平",
    );

    assert.equal(bound, true);
    assert.equal(await page.locator(".target-drama input").isChecked(), true);
    assert.equal(
      await page
        .getByText("将所上传视频全部添加至此短剧", { exact: true })
        .locator("xpath=ancestor::label[1]")
        .locator("input")
        .isChecked(),
      true,
    );
    assert.equal(await page.locator(".chooser").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("creates a missing drama with its title, cover, batch binding and agreement", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="first-card"><button type="button">新建短剧</button></div>
      <div class="create-panel" style="display: none">
        <input placeholder="请输入短剧的标题" type="text">
        <input data-testid="beast-core-upload-input" type="file" accept=".jpg,.jpeg,.png">
        <label data-testid="beast-core-checkbox">
          <input type="checkbox"><span>将所上传视频全部添加至此短剧</span>
        </label>
        <label data-testid="beast-core-checkbox">
          <input type="checkbox"><span>我已阅读并同意</span>
        </label>
        <button type="button"><span>确认创建</span></button>
      </div>
      <script>
        const panel = document.querySelector('.create-panel');
        document.querySelector('.first-card button').addEventListener('click', () => {
          panel.style.display = 'block';
        });
        panel.querySelector('input[type="file"]').addEventListener('change', () => {
          panel.insertAdjacentHTML(
            'beforeend',
            '<div class="cover-state"><div data-testid="beast-core-icon-loading">加载中</div></div>',
          );
          setTimeout(() => {
            panel.querySelector('.cover-state').innerHTML = '<img data-retry-status="success" src="blob:https://mcn.pinduoduo.com/test-cover" style="width: 90px; height: 120px"><div>更换封面</div>';
          }, 200);
        });
        panel.querySelector('button').addEventListener('click', () => {
          panel.style.display = 'none';
        });
      </script>
    `);

    const panel = page.locator(".create-panel");
    const coverProgress: Array<{ completed: boolean; elapsedSeconds: number }> = [];
    await createDramaAndBindAllUploadedVideos(
      page,
      page.locator(".first-card"),
      "我租村厂赚钱，全村上门分利润",
      fileURLToPath(import.meta.url),
      (elapsedSeconds, completed) => coverProgress.push({ completed, elapsedSeconds }),
    );

    assert.equal(
      await panel.getByPlaceholder("请输入短剧的标题").inputValue(),
      "我租村厂赚钱，全村上门分利润",
    );
    assert.equal(await panel.locator('input[type="file"]').evaluate((input: HTMLInputElement) => input.files?.length), 1);
    assert.equal(await panel.getByText("将所上传视频全部添加至此短剧").locator("xpath=ancestor::label[1]").locator("input").isChecked(), true);
    assert.equal(await panel.getByText("我已阅读并同意").locator("xpath=ancestor::label[1]").locator("input").isChecked(), true);
    assert.equal(coverProgress.some((progress) => !progress.completed), true);
    assert.equal(coverProgress.at(-1)?.completed, true);
    assert.equal(await panel.isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("cancels the existing-drama chooser after reaching the bottom without a match", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="first-card"><button type="button">添加至已有短剧</button></div>
      <section class="chooser" style="display: none">
        <div data-testid="beast-core-pullToRefresh" style="height: 80px; overflow-y: auto">
          <div style="height: 160px">只有其他短剧</div>
        </div>
        <button type="button">取消添加</button>
      </section>
      <script>
        const chooser = document.querySelector('.chooser');
        document.querySelector('.first-card button').addEventListener('click', () => {
          chooser.style.display = 'block';
        });
        chooser.querySelector('button').addEventListener('click', () => {
          chooser.style.display = 'none';
        });
      </script>
    `);

    const bound = await bindAllUploadedVideosToDrama(
      page,
      page.locator(".first-card"),
      "不存在的短剧",
    );

    assert.equal(bound, false);
    assert.equal(await page.locator(".chooser").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("publishes every uploaded video with the global one-click action", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <article>
        <p>文件名：果园的天平 - 第1集.mp4</p>
        <button type="button">发布</button>
      </article>
      <article>
        <p>文件名：果园的天平 - 第2集.mp4</p>
        <button type="button">发布</button>
      </article>
      <button class="publish-all" type="button">一键发布</button>
      <script>
        document.querySelector('.publish-all').addEventListener('click', (event) => {
          event.currentTarget.disabled = true;
          document.body.insertAdjacentHTML('beforeend', '<div>发布成功</div>');
        });
      </script>
    `);

    await publishAllUploadedVideos(page);

    assert.equal(await page.locator(".publish-all").isDisabled(), true);
    assert.equal(await page.getByText("发布成功", { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "发布", exact: true }).count(), 2);
  } finally {
    await browser.close();
  }
});

test("accepts cleared upload cards as a Pinduoduo publish success signal", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <article class="upload-card"><p>文件名：第二批 - 第51集.mp4</p></article>
      <button class="publish-all" type="button">一键发布</button>
      <script>
        document.querySelector('.publish-all').addEventListener('click', () => {
          document.querySelector('.upload-card').remove();
        });
      </script>
    `);

    await publishAllUploadedVideos(page);

    assert.equal(await page.locator(".upload-card").count(), 0);
    assert.equal(await page.locator(".publish-all").isEnabled(), true);
  } finally {
    await browser.close();
  }
});

test("never confirms publishing when Pinduoduo reports unfinished uploads", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button class="publish-all" type="button">一键发布</button>
      <script>
        window.continuePublishClicked = false;
        document.querySelector('.publish-all').addEventListener('click', () => {
          document.body.insertAdjacentHTML('beforeend', \
            '<div role="dialog"><div>你有未上传完成的作品，立即发布将会丢失，继续发布吗？</div><button class="cancel">取消</button><button class="continue">继续发布</button></div>');
          document.querySelector('.continue').addEventListener('click', () => {
            window.continuePublishClicked = true;
          });
          document.querySelector('.cancel').addEventListener('click', (event) => {
            event.currentTarget.closest('[role="dialog"]').remove();
          });
        });
      </script>
    `);

    await assert.rejects(
      () => publishAllUploadedVideos(page),
      /PINDUODUO_UPLOAD_INCOMPLETE_WARNING/,
    );
    assert.equal(await page.evaluate(() => (window as unknown as { continuePublishClicked: boolean }).continuePublishClicked), false);
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
  } finally {
    await browser.close();
  }
});
