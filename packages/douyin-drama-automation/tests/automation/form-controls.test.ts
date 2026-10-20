import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PDFDocument, rgb } from "pdf-lib";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  assertNoDouyinFormError,
  DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS,
  DOUYIN_DRAMA_VIDEO_TOPICS,
  fillDouyinEpisodeBatchEdit,
  fillDouyinSeriesDialog,
  fillDouyinRoleNameWithoutSuggestion,
  fillNearestDouyinCompletionPromiseDateTime,
  fillDouyinPublishDateTime,
  hasInvalidDouyinEpisodeDuration,
  hasTooShortDouyinEpisodeDuration,
  installDouyinPageMessageCapture,
  isTransientDouyinUploadMessage,
  normalizeDouyinPublishDateTime,
  resolveDouyinScheduledPublishDateTime,
  resetRestoredDouyinFormIfPresent,
  reuploadFailedDouyinEpisodeAfterDelete,
  readDouyinUploadPdfPageCount,
  sanitizeDouyinDescriptionText,
  selectDouyinChargeEpisodes,
  selectDropdownValues,
  selectFirstDropdownByPlaceholder,
  selectRequiredDropdownByContractName,
  selectRequiredDropdownByStableId,
  selectSearchableDropdownByPlaceholder,
  uploadFormFiles,
} from "../../src/automation/form-controls.js";
import {
  enterSalesConfiguration,
  locateDouyinEpisodeUploadControls,
  waitForDouyinSubmitSuccess,
} from "../../src/automation/publish-runner.js";
import { createDouyinDramaDropdownRecorder } from "../../src/shared/dropdown-options.js";

function launchTestBrowser() {
  const executablePath = fileURLToPath(new URL(
    "../../../../.cache/playwright-browsers/chromium-1228/chrome-win64/chrome.exe",
    import.meta.url,
  ));
  return chromium.launch({ executablePath, headless: true });
}

test("cleans unsupported punctuation from Douyin descriptions", () => {
  const source = "母亲终于明白：做母亲是她的身份, 但不是她的全部…（完）";
  const cleaned = sanitizeDouyinDescriptionText(source);
  assert.equal(cleaned, "母亲终于明白，做母亲是她的身份，但不是她的全部（完）");
  assert.doesNotMatch(cleaned, /[:：,…\s]/u);
});

test("fills an already-open Douyin series dialog", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div role="dialog" class="arco-modal series-add-modal">
        <div class="arco-modal-title">添加系列剧信息</div>
        <div class="arco-form-item">
          <div id="series_drama_book_name">
            <input placeholder="请输入系列剧名">
          </div>
        </div>
        <div id="series_drama_type" class="arco-form-item">
          <label><input type="radio" value="1">季播剧</label>
          <label><input type="radio" value="2">衍生剧</label>
          <label><input type="radio" value="3">单元剧</label>
        </div>
        <div class="arco-form-item series-cover-url-item">
          <div id="series_drama_thumb_url_input">
            <input type="file" accept=".png,.jpg,.jpeg,.bmp">
          </div>
          <div class="arco-upload-list"></div>
        </div>
        <div class="arco-form-item">
          <textarea id="series_abstract_input" maxlength="200"></textarea>
        </div>
        <button id="confirm-series" type="button">确定</button>
      </div>
      <script>
        const dialog = document.querySelector('[role=dialog]');
        const upload = document.querySelector('input[type=file]');
        upload.addEventListener('change', () => {
          const item = document.createElement('div');
          item.className = 'arco-upload-list-item';
          dialog.querySelector('.arco-upload-list').append(item);
        });
        document.querySelector('#confirm-series').addEventListener('click', () => {
          dialog.style.display = 'none';
        });
      </script>
    `);

    const title = "太子心上喜！";
    const summary = "这是一段用于验证系列剧简介填写逻辑的测试内容。".repeat(5);
    await fillDouyinSeriesDialog(page, {
      coverFile: fileURLToPath(import.meta.url),
      summary,
      title,
    });

    assert.equal(await page.getByPlaceholder("请输入系列剧名").inputValue(), title);
    assert.equal(await page.locator("#series_drama_type input[value='1']").isChecked(), true);
    assert.equal(await page.locator("#series_abstract_input").inputValue(), summary.slice(0, 200));
    assert.equal(await page.locator("[role=dialog]").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("locates the current Douyin short-play episode upload control", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <section class="edit-page-video-upload-shortplay">
        <div class="novel-cloud-upload-video-container">
          <section class="file-picker-box">
            <input type="file" accept=".mp4,.flv,.wmv,.mkv,.mov,.webm" multiple>
            <div class="trigger-box">点击上传</div>
          </section>
        </div>
      </section>
    `);
    const { input, panel } = locateDouyinEpisodeUploadControls(page);
    assert.equal(await panel.getAttribute("class"), "edit-page-video-upload-shortplay");
    assert.equal(await input.getAttribute("multiple"), "");
  } finally {
    await browser.close();
  }
});

test("reads every page from a PDF before converting upload images", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "douyin-upload-pdf-"));
  try {
    const file = path.join(directory, "two-pages.pdf");
    const document = await PDFDocument.create();
    document.addPage([595, 842]);
    document.addPage([595, 842]);
    await writeFile(file, await document.save());
    assert.equal(await readDouyinUploadPdfPageCount(file), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes failed episode items and reuploads the original file with a retry limit", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="panel" class="edit-page-video-upload-shortplay-container">
        <div class="uploaded_list_item">
          <div class="file-name">测试剧-第1集.mp4</div>
          <span class="file-status-text file-status-text-error">上传失败</span>
          <div class="uploaded_list_item-ops"><button type="button">
            <svg class="serial-icon-general_delete"></svg>
          </button></div>
        </div>
        <input id="upload-picker" type="file" multiple accept=".mp4" style="display:none">
      </div>
      <script>
        const panel = document.querySelector('#panel');
        const picker = document.querySelector('#upload-picker');
        document.querySelector('button').addEventListener('click', () => {
          document.querySelector('.uploaded_list_item').remove();
        });
        picker.addEventListener('change', () => {
          panel.insertAdjacentHTML('afterbegin',
            '<div class="uploaded_list_item">' +
            '<div class="file-name">测试剧-第1集.mp4</div>' +
            '<span class="file-status-text file-status-text-error">上传失败</span>' +
            '<div class="uploaded_list_item-ops"><button type="button" ' +
            'onclick="this.closest(&quot;.uploaded_list_item&quot;).remove()">' +
            '<svg class="serial-icon-general_delete"></svg></button></div></div>');
          picker.value = '';
        });
      </script>
    `);
    const panel = page.locator("#panel");
    const attempts = new Map<string, number>();
    const sourceFile = fileURLToPath(import.meta.url);
    const uploadInput = page.locator("#upload-picker");
    assert.deepEqual(await reuploadFailedDouyinEpisodeAfterDelete(panel, uploadInput, [sourceFile], 2, attempts), [
      { attempt: 1, fileName: "测试剧-第1集.mp4" },
    ]);
    assert.deepEqual(await reuploadFailedDouyinEpisodeAfterDelete(panel, uploadInput, [sourceFile], 2, attempts), [
      { attempt: 2, fileName: "测试剧-第1集.mp4" },
    ]);
    await assert.rejects(
      reuploadFailedDouyinEpisodeAfterDelete(panel, uploadInput, [sourceFile], 2, attempts),
      /DOUYIN_DRAMA_EPISODE_UPLOAD_REUPLOADS_EXHAUSTED/u,
    );
    assert.equal(attempts.get("测试剧-第1集.mp4"), 2);
  } finally {
    await browser.close();
  }
});

test("deletes and reuploads an item marked complete when its duration is malformed", async () => {
  assert.equal(hasInvalidDouyinEpisodeDuration("上传完成 时长：00:00:60"), false);
  assert.equal(hasInvalidDouyinEpisodeDuration("上传完成 时长：00:01:00"), false);
  assert.equal(hasInvalidDouyinEpisodeDuration("上传完成 时长：00:00:61"), true);
  assert.equal(hasTooShortDouyinEpisodeDuration("上传完成 时长：00:00:29"), true);
  assert.equal(hasTooShortDouyinEpisodeDuration("上传完成 时长：00:00:30"), false);
  assert.equal(hasTooShortDouyinEpisodeDuration("上传完成 时长：00:00:60"), false);

  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="panel">
        <div class="uploaded_list_item">
          <div class="file-name">测试剧-第2集.mp4</div>
          <span class="file-status-text file-status-text-success">上传完成</span>
          <span class="file-status-text">时长：00:00:61</span>
          <div class="uploaded_list_item-ops"><button type="button">
            <svg class="serial-icon-general_delete"></svg>
          </button></div>
        </div>
        <input id="upload-picker" type="file" multiple accept=".mp4" style="display:none">
      </div>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          document.querySelector('.uploaded_list_item').remove();
        });
      </script>
    `);
    const sourceFile = fileURLToPath(import.meta.url);
    assert.deepEqual(
      await reuploadFailedDouyinEpisodeAfterDelete(
        page.locator("#panel"),
        page.locator("#upload-picker"),
        [sourceFile],
        5,
        new Map<string, number>(),
      ),
      [{ attempt: 1, fileName: "测试剧-第2集.mp4" }],
    );
  } finally {
    await browser.close();
  }
});

test("fails a video shorter than 30 seconds without deleting or reuploading it", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="panel">
        <div class="uploaded_list_item">
          <div class="file-name">测试剧-第3集.mp4</div>
          <span class="file-status-text file-status-text-success">上传完成</span>
          <span class="file-status-text">时长：00:00:29</span>
          <div class="uploaded_list_item-ops"><button type="button">
            <svg class="serial-icon-general_delete"></svg>
          </button></div>
        </div>
        <input id="upload-picker" type="file" multiple accept=".mp4" style="display:none">
      </div>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          document.querySelector('.uploaded_list_item').remove();
        });
      </script>
    `);
    const attempts = new Map<string, number>();
    await assert.rejects(
      reuploadFailedDouyinEpisodeAfterDelete(
        page.locator("#panel"),
        page.locator("#upload-picker"),
        [fileURLToPath(import.meta.url)],
        5,
        attempts,
      ),
      /DOUYIN_DRAMA_EPISODE_DURATION_TOO_SHORT/u,
    );
    assert.equal(await page.locator(".uploaded_list_item").count(), 1);
    assert.equal(attempts.size, 0);
  } finally {
    await browser.close();
  }
});

test("treats the platform upload-in-progress notice as transient", () => {
  assert.equal(isTransientDouyinUploadMessage("资源上传中请等待"), true);
  assert.equal(isTransientDouyinUploadMessage("图片上传中，请等待"), true);
  assert.equal(isTransientDouyinUploadMessage("正在上传成本配置情况"), true);
});

test("uses the sales fields already shown on the publish configuration page", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="complete_promise_time">
        <input placeholder="请选择更新完成时间">
      </div>
      <input id="unit_price_input" placeholder="请输入价格">
      <div id="charge_episode"><div>2</div></div>
    `);

    await assert.doesNotReject(() => enterSalesConfiguration(page));
  } finally {
    await browser.close();
  }
});

test("clicks next only for the legacy stepped publish form", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="next" type="button">下一步</button>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#next').remove();
          document.body.insertAdjacentHTML('beforeend',
            '<div id="complete_promise_time"><input placeholder="请选择更新完成时间"></div>');
        });
      </script>
    `);

    await enterSalesConfiguration(page);
    assert.equal(await page.locator("#complete_promise_time input").count(), 1);
  } finally {
    await browser.close();
  }
});

test("does not hide real upload validation errors", () => {
  assert.equal(isTransientDouyinUploadMessage("请上传成本配置情况"), false);
  assert.equal(isTransientDouyinUploadMessage("文件格式错误"), false);
  assert.equal(isTransientDouyinUploadMessage("上传失败"), false);
});

test("normalizes and fills the publish time returned by the task API", async () => {
  assert.equal(
    normalizeDouyinPublishDateTime("2026-09-22T18:30:00+08:00"),
    "2026-09-22 18:30:00",
  );
  assert.throws(
    () => normalizeDouyinPublishDateTime("not-a-date"),
    /DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_INVALID/u,
  );

  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="hong_guo_app_publish_time">
        <input placeholder="请选择（最早支持设置+72小时的发布时间）">
      </div>
      <div id="complete_promise_time">
        <input placeholder="请选择更新完成时间">
      </div>
      <div id="publish-time-popup" class="arco-picker-container" style="display:none">
        <div class="date-panel">
          <div class="arco-picker-header">
            <button class="arco-picker-header-icon">上一年</button>
            <button class="arco-picker-header-icon">上一月</button>
            <div class="arco-picker-header-value">
              <span class="arco-picker-header-label">2026年</span>
              <span class="arco-picker-header-label">9月</span>
            </div>
            <button class="arco-picker-header-icon">下一月</button>
            <button class="arco-picker-header-icon">下一年</button>
          </div>
          <div class="arco-picker-cell arco-picker-cell-in-view">
            <div class="arco-picker-date"><span>22</span></div>
          </div>
          <button class="arco-picker-btn-select-time" type="button">选择时间</button>
        </div>
        <div class="time-panel" style="display:none">
          <div class="arco-timepicker-list"><ul>
            <li class="arco-timepicker-cell"><span>17</span></li>
            <li class="arco-timepicker-cell"><span>18</span></li>
          </ul></div>
          <div class="arco-timepicker-list"><ul>
            <li class="arco-timepicker-cell"><span>00</span></li>
            <li class="arco-timepicker-cell"><span>30</span></li>
          </ul></div>
          <div class="arco-timepicker-list"><ul>
            <li class="arco-timepicker-cell"><span>00</span></li>
            <li class="arco-timepicker-cell"><span>04</span></li>
          </ul></div>
        </div>
        <button class="arco-picker-btn-confirm" type="button" disabled>确定</button>
      </div>
      <script>
        const inputs = document.querySelectorAll(
          '#hong_guo_app_publish_time input, #complete_promise_time input'
        );
        const popup = document.querySelector('#publish-time-popup');
        const datePanel = popup.querySelector('.date-panel');
        const timePanel = popup.querySelector('.time-panel');
        const confirm = popup.querySelector('.arco-picker-btn-confirm');
        let activeInput;
        let selectedDate = false;
        inputs.forEach((input) => input.addEventListener('click', () => {
          activeInput = input;
          selectedDate = false;
          datePanel.style.display = 'block';
          timePanel.style.display = 'none';
          confirm.disabled = true;
          popup.querySelectorAll('.arco-timepicker-cell-selected').forEach((cell) => {
            cell.classList.remove('arco-timepicker-cell-selected');
          });
          popup.style.display = 'block';
        }));
        popup.querySelector('.arco-picker-date').addEventListener('click', () => {
          selectedDate = true;
        });
        popup.querySelector('.arco-picker-btn-select-time').addEventListener('click', () => {
          datePanel.style.display = 'none';
          timePanel.style.display = 'block';
        });
        popup.querySelectorAll('.arco-timepicker-cell').forEach((cell) => {
          cell.addEventListener('click', () => {
            cell.parentElement.querySelectorAll('.arco-timepicker-cell').forEach((other) => {
              other.classList.remove('arco-timepicker-cell-selected');
            });
            cell.classList.add('arco-timepicker-cell-selected');
            const allSelected = [...popup.querySelectorAll('.arco-timepicker-list')]
              .every((list) => list.querySelector('.arco-timepicker-cell-selected'));
            confirm.disabled = !(selectedDate && allSelected);
          });
        });
        confirm.addEventListener('click', () => {
          const selected = [...popup.querySelectorAll('.arco-timepicker-cell-selected')]
            .map((cell) => cell.textContent.trim());
          activeInput.value = \`2026-09-22 \${selected[0]}:\${selected[1]}\`;
          popup.style.display = 'none';
        });
      </script>
    `);
    const beforeScheduledTime = new Date("2026-09-19T06:00:00.000Z");
    assert.equal(
      await fillDouyinPublishDateTime(page, "2026-09-22 18:30", beforeScheduledTime),
      "2026-09-22 18:30:00",
    );
    assert.equal(
      await page.locator("#hong_guo_app_publish_time input").inputValue(),
      "2026-09-22 18:30",
    );
    assert.equal(
      await fillDouyinPublishDateTime(page, "2026-09-22 18:30:04", beforeScheduledTime),
      "2026-09-22 18:30:04",
    );
    assert.equal(
      await page.locator("#hong_guo_app_publish_time input").inputValue(),
      "2026-09-22 18:30",
    );
    assert.equal(
      await fillNearestDouyinCompletionPromiseDateTime(page),
      "2026-09-22 17:00:00",
    );
    assert.equal(
      await page.locator("#complete_promise_time input").inputValue(),
      "2026-09-22 17:00",
    );
  } finally {
    await browser.close();
  }
});

test("keeps the user publish time while rolling it beyond Douyin's 72-hour minimum", () => {
  const now = new Date("2026-09-20T06:00:00.000Z"); // 2026-09-20 14:00 in Shanghai
  assert.equal(
    resolveDouyinScheduledPublishDateTime("2026-09-20 15:30:00", now),
    "2026-09-23 15:30:00",
  );
  assert.equal(
    resolveDouyinScheduledPublishDateTime("2026-09-20 13:30:00", now),
    "2026-09-24 13:30:00",
  );
  assert.equal(
    resolveDouyinScheduledPublishDateTime("2026-09-18 13:30:00", now),
    "2026-09-24 13:30:00",
  );
  assert.equal(
    resolveDouyinScheduledPublishDateTime(
      "2026-10-03 18:30:00",
      new Date("2026-10-01T03:00:00.000Z"),
    ),
    "2026-10-04 18:30:00",
  );
});

test("reports submit success after an error-free settle window without requiring a toast", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent("<main>提交处理中</main>");
    const startedAt = Date.now();
    await waitForDouyinSubmitSuccess(page, startedAt, { settleMs: 300, timeoutMs: 2_000 });
    assert.ok(Date.now() - startedAt >= 300);
  } finally {
    await browser.close();
  }
});

test("selects every paid episode from the configured starting episode", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>售卖集数</label>
        <div class="wrap-test">
          <div class="item-test disabled-item-test">1</div>
          <div class="item-test">2</div>
          <div class="item-test">3</div>
          <div class="item-test">4</div>
          <div class="item-test">5</div>
        </div>
      </div>
      <script>
        document.querySelectorAll('.item-test:not(.disabled-item-test)').forEach((item) => {
          item.addEventListener('click', () => item.classList.add('selected-item-test'));
        });
      </script>
    `);

    await selectDouyinChargeEpisodes(page, 3, 5);
    assert.equal(await page.getByText("2", { exact: true }).getAttribute("class"), "item-test");
    for (const episode of [3, 4, 5]) {
      assert.match(
        await page.getByText(String(episode), { exact: true }).getAttribute("class") ?? "",
        /selected-item-test/u,
      );
    }
    await assert.rejects(
      () => selectDouyinChargeEpisodes(page, 6, 5),
      /DOUYIN_DRAMA_PAID_EPISODE_RANGE_INVALID/u,
    );
  } finally {
    await browser.close();
  }
});

test("expands collapsed paid episodes before selecting the hidden range", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>售卖集数</label>
        <div class="wrap-test">
          <div class="item-test">2</div>
          <div class="item-test">3</div>
          <div id="collapsed-episodes" style="display:none">
            <div class="item-test">4</div>
            <div class="item-test">5</div>
          </div>
          <div class="expand-giQk7I"><span>展开</span></div>
        </div>
      </div>
      <script>
        document.querySelector('.expand-giQk7I').addEventListener('click', (event) => {
          document.querySelector('#collapsed-episodes').style.display = 'block';
          event.currentTarget.querySelector('span').textContent = '收起';
        });
        document.querySelectorAll('.item-test').forEach((item) => {
          item.addEventListener('click', () => item.classList.add('selected-item-test'));
        });
      </script>
    `);

    await selectDouyinChargeEpisodes(page, 3, 5);
    assert.equal(await page.getByText("展开", { exact: true }).count(), 0);
    for (const episode of [3, 4, 5]) {
      assert.match(
        await page.getByText(String(episode), { exact: true }).getAttribute("class") ?? "",
        /selected-item-test/u,
      );
    }
  } finally {
    await browser.close();
  }
});

test("batch edits every uploaded episode before leaving the video step", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="header-right-opt-btn">批量编辑</div>
      <div class="arco-drawer-inner" style="display:none">
        <div class="arco-drawer-header-title">批量编辑</div>
        <input id="item_start_input">
        <input id="item_end_input">
        <input id="item_title_input">
        <button id="add-topic" type="button">#添加话题</button>
        <div data-slate-editor="true" contenteditable="true"></div>
        <label class="arco-radio arco-radio-checked">
          <input type="radio" checked><span>相同封面</span>
        </label>
        <div class="arco-form-item">
          <div id="thumb_url_input">
            <input id="cover-file" type="file">
            <div class="arco-upload-list"></div>
          </div>
        </div>
        <button id="confirm-batch" type="button">确认</button>
      </div>
      <script>
        const drawer = document.querySelector('.arco-drawer-inner');
        const editor = document.querySelector('[data-slate-editor=true]');
        const selectedTopics = [];
        document.querySelector('.header-right-opt-btn').addEventListener('click', () => {
          drawer.style.display = 'block';
        });
        document.querySelector('#add-topic').addEventListener('click', () => {
          editor.append(document.createTextNode('#'));
          editor.focus();
          document.querySelector('.mention-suggest-mount-dom')?.remove();
          const suggestion = document.createElement('div');
          suggestion.className = 'mention-suggest-mount-dom';
          ${JSON.stringify([...DOUYIN_DRAMA_VIDEO_TOPICS].map((topic) => topic.slice(1)))}
            .forEach((topicName) => {
              const option = document.createElement('div');
              option.className = 'tag-test tag-hash-test';
              option.innerHTML = '<span class="tag-hash-view-name-test"></span>';
              option.querySelector('span').textContent = topicName;
              option.addEventListener('click', () => {
                selectedTopics.push('#' + topicName);
                editor.innerHTML = selectedTopics
                  .map((topic) => '<span data-selected-topic="true">' + topic + '</span>')
                  .join('');
                suggestion.remove();
              });
              suggestion.append(option);
            });
          document.body.append(suggestion);
        });
        document.querySelector('#cover-file').addEventListener('change', (event) => {
          const item = document.createElement('div');
          item.className = 'arco-upload-list-item';
          item.textContent = event.currentTarget.files[0].name;
          document.querySelector('.arco-upload-list').append(item);
        });
        document.querySelector('#confirm-batch').addEventListener('click', () => {
          window.batchEditResult = {
            start: document.querySelector('#item_start_input').value,
            end: document.querySelector('#item_end_input').value,
            title: document.querySelector('#item_title_input').value,
            description: document.querySelector('[data-slate-editor=true]').textContent,
            highlightedTopicCount: document.querySelectorAll('[data-selected-topic=true]').length,
            sameCover: document.querySelector('input[type=radio]').checked,
            coverFile: document.querySelector('#cover-file').files[0]?.name,
          };
          drawer.style.display = 'none';
        });
      </script>
    `);

    await fillDouyinEpisodeBatchEdit(page, {
      coverFile: fileURLToPath(import.meta.url),
      episodeCount: 35,
      title: "货车被当免费拉货站，我收车",
    });
    assert.deepEqual(
      await page.evaluate(() => (window as Window & { batchEditResult?: unknown }).batchEditResult),
      {
        start: "1",
        end: "35",
        title: "货车被当免费拉货站，我收车",
        description: DOUYIN_DRAMA_VIDEO_TOPICS.join(""),
        highlightedTopicCount: DOUYIN_DRAMA_VIDEO_TOPICS.length,
        sameCover: true,
        coverFile: "form-controls.test.ts",
      },
    );
  } finally {
    await browser.close();
  }
});

test("ignores publish-configuration advisory alerts but keeps form validation errors", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="arco-alert arco-alert-info" role="alert">
        以下全部内容，在漫剧专辑ID生成后将不可修改，请谨慎操作。原生配置操作说明
      </div>
    `);
    await assert.doesNotReject(() => assertNoDouyinFormError(page, "下一步"));

    await page.locator("body").evaluate((body) => {
      const message = document.createElement("div");
      message.className = "arco-form-message";
      message.textContent = "请选择发布账号";
      body.append(message);
    });
    await assert.rejects(
      () => assertNoDouyinFormError(page, "下一步"),
      /DOUYIN_DRAMA_FORM_ERROR: 下一步: 请选择发布账号/u,
    );
  } finally {
    await browser.close();
  }
});

test("captures a transient Arco error message after it disappears", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent("<main>抖音上传页</main>");
    await installDouyinPageMessageCapture(page);
    await page.locator("body").evaluate((body) => {
      const message = document.createElement("div");
      message.className = "arco-message arco-message-error";
      message.setAttribute("role", "alert");
      message.innerHTML = '<span class="arco-message-content">图片高度不能大于2000</span>';
      body.append(message);
    });
    await page.waitForTimeout(20);
    await page.locator(".arco-message-error").evaluate((message) => message.remove());

    await assert.rejects(
      () => assertNoDouyinFormError(page, "上传红果封面图"),
      /DOUYIN_DRAMA_FORM_ERROR: 上传红果封面图: 图片高度不能大于2000/u,
    );
    await assert.doesNotReject(() => assertNoDouyinFormError(page, "下一步"));
  } finally {
    await browser.close();
  }
});

test("fills a new Douyin role name without selecting an autocomplete suggestion", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div role="dialog" class="arco-modal role-add-modal">
        <div class="arco-modal-title">添加角色</div>
        <div id="role"><input placeholder="请输入角色姓名"></div>
        <div id="role_type_input" role="combobox">请选择角色性质</div>
      </div>
      <div id="role-suggestions" class="arco-auto-complete-popup" role="listbox" style="display:none">
        <div role="option">小宇（已有角色）</div>
      </div>
      <script>
        window.roleSuggestionSelectionCount = 0;
        const input = document.querySelector('#role input');
        const popup = document.querySelector('#role-suggestions');
        input.addEventListener('input', () => { popup.style.display = 'block'; });
        popup.querySelector('[role=option]').addEventListener('click', () => {
          window.roleSuggestionSelectionCount += 1;
          input.value = '小宇（已有角色）';
        });
        document.querySelector('.arco-modal-title').addEventListener('click', () => {
          popup.style.display = 'none';
        });
      </script>
    `);

    const dialog = page.locator("[role='dialog']");
    await fillDouyinRoleNameWithoutSuggestion(page, dialog, "小宇");

    assert.equal(await dialog.locator("#role input").inputValue(), "小宇");
    assert.equal(await page.locator("#role-suggestions").isVisible(), false);
    assert.equal(
      await page.evaluate(() => (window as unknown as { roleSuggestionSelectionCount: number })
        .roleSuggestionSelectionCount),
      0,
    );
    assert.equal(await dialog.isVisible(), true);
  } finally {
    await browser.close();
  }
});

test("dismisses the onboarding guide before resetting the restored draft", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>
        .guide-popup-content-mask { position: fixed; inset: 0; z-index: 10; }
        .guide-popup-content { position: fixed; left: 20px; top: 20px; z-index: 11; }
      </style>
      <input id="book_name_input" value="上次填写的剧名">
      <div class="arco-upload-list"><div class="arco-upload-list-item">旧附件.png</div></div>
      <div class="arco-message arco-message-success" role="alert">
        <span>已同步上次填写内容</span>
        <button type="button" id="reset">点此重置为空</button>
      </div>
      <div class="guide-popup-content-mask"></div>
      <div class="guide-popup-content">
        <div>新增日收益展示功能</div>
        <button type="button" id="dismiss-guide">我知道了</button>
      </div>
      <script>
        document.querySelector('#dismiss-guide').addEventListener('click', () => {
          document.querySelector('.guide-popup-content-mask').remove();
          document.querySelector('.guide-popup-content').remove();
        });
        document.querySelector('#reset').addEventListener('click', () => {
          document.querySelector('#book_name_input').value = '';
          document.querySelector('.arco-upload-list').replaceChildren();
          document.querySelector('.arco-message').remove();
        });
      </script>
    `);

    assert.equal(await resetRestoredDouyinFormIfPresent(page, 1_000), true);
    assert.equal(await page.locator(".guide-popup-content-mask").count(), 0);
    assert.equal(await page.locator("#book_name_input").inputValue(), "");
    assert.equal(await page.locator(".arco-upload-list-item").count(), 0);
  } finally {
    await browser.close();
  }
});

test("confirms selections from control state and closes persistent dropdown popups", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const recorder = createDouyinDramaDropdownRecorder({});
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>关联AIGC工具</label>
        <div id="aigc" role="combobox" class="arco-select" style="width:240px;height:32px"><span class="value">请选择</span></div>
      </div>
      <div id="aigc-popup" class="arco-select-popup" role="listbox">
        <div role="option" class="arco-select-option">红果漫剧创作Agent</div>
      </div>
      <div id="contract" role="combobox" class="arco-select" style="width:320px;height:32px">
        <input placeholder="请选择合同" value=""><span class="value"></span>
      </div>
      <div id="contract-popup" class="arco-select-popup" role="listbox" style="display:none">
        <div role="option" class="arco-select-option">CT20260521191189 【明星说】漫剧合作协议（框架）</div>
      </div>
      <script>
        const setup = (triggerId, popupId, shortenedValue) => {
          const trigger = document.querySelector(triggerId);
          const popup = document.querySelector(popupId);
          trigger.addEventListener('click', () => { popup.style.display = 'block'; });
          popup.querySelector('[role=option]').addEventListener('click', (event) => {
            event.currentTarget.setAttribute('aria-selected', 'true');
            event.currentTarget.classList.add('arco-select-option-selected');
            trigger.querySelector('.value').textContent = shortenedValue;
          });
          document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') popup.style.display = 'none';
          });
        };
        setup('#aigc', '#aigc-popup', '红果漫剧创作Agent');
        setup('#contract', '#contract-popup', 'CT20260521191189');
      </script>
    `);

    await selectDropdownValues(page, "关联AIGC工具", ["红果漫剧创作Agent"], recorder);
    assert.equal(await page.locator("#aigc-popup").isVisible(), false);
    const selected = await selectFirstDropdownByPlaceholder(
      page,
      "请选择合同",
      "contract",
      recorder,
    );
    assert.match(selected, /^CT20260521191189/u);
    assert.equal(await page.locator("#contract-popup").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("waits up to 20 seconds for dropdown options loaded by an API", async () => {
  assert.equal(DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS, 20_000);
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const recorder = createDouyinDramaDropdownRecorder({});
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>分类</label>
        <div id="category" role="combobox" class="arco-select" style="width:240px;height:32px">
          <span class="value">请选择</span>
        </div>
      </div>
      <div id="category-popup" class="arco-select-popup" role="listbox" style="display:none">
        <div role="option" class="arco-select-option">加载中</div>
      </div>
      <script>
        const trigger = document.querySelector('#category');
        const popup = document.querySelector('#category-popup');
        trigger.addEventListener('click', () => {
          popup.style.display = 'block';
          setTimeout(() => {
            popup.innerHTML = '<div role="option" class="arco-select-option">都市</div>';
          }, 100);
        });
        popup.addEventListener('click', (event) => {
          const option = event.target.closest('[role=option]');
          if (!option || option.textContent !== '都市') return;
          option.setAttribute('aria-selected', 'true');
          trigger.querySelector('.value').textContent = option.textContent;
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') popup.style.display = 'none';
        });
      </script>
    `);

    await selectDropdownValues(page, "分类", ["都市"], recorder);
    assert.equal(await page.locator("#category .value").innerText(), "都市");
  } finally {
    await browser.close();
  }
});

test("selects only the required contract id and reports missing or disabled contracts", async () => {
  const browser = await launchTestBrowser();
  const recorder = createDouyinDramaDropdownRecorder({});
  const placeholder = "请选择（温馨提示：合同绑定错误会影响结算）";
  const render = async (options: string) => {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="contract" role="combobox" class="arco-select" style="width:320px;height:32px">
        <input placeholder="${placeholder}" value=""><span class="value"></span>
      </div>
      <div id="contract-popup" class="arco-select-popup" role="listbox" style="display:none">${options}</div>
      <script>
        const trigger = document.querySelector('#contract');
        const popup = document.querySelector('#contract-popup');
        trigger.addEventListener('click', () => { popup.style.display = 'block'; });
        popup.querySelectorAll('[role=option]').forEach((option) => {
          option.addEventListener('click', () => {
            if (option.getAttribute('aria-disabled') === 'true' || option.classList.contains('arco-select-option-disabled')) return;
            option.setAttribute('aria-selected', 'true');
            trigger.querySelector('.value').textContent = option.textContent;
          });
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') popup.style.display = 'none';
        });
      </script>
    `);
    return page;
  };
  try {
    const page = await render(`
      <div role="option" class="arco-select-option">CT00000000000000 其他合同</div>
      <div role="option" class="arco-select-option">CT20260521191189 【明星说】漫剧合作协议（框架）</div>
    `);
    const selected = await selectRequiredDropdownByStableId(
      page,
      placeholder,
      "contract",
      "CT20260521191189",
      recorder,
    );
    assert.match(selected, /^CT20260521191189/u);
    await page.close();

    const missingPage = await render(`
      <div role="option" class="arco-select-option">CT00000000000000 其他合同</div>
    `);
    await assert.rejects(
      selectRequiredDropdownByStableId(
        missingPage,
        placeholder,
        "contract",
        "CT20260521191189",
        recorder,
        { loadTimeoutMs: 100 },
      ),
      /DOUYIN_DRAMA_REQUIRED_CONTRACT_NOT_FOUND/u,
    );
    await missingPage.close();

    const transientPage = await render(`
      <div role="option" aria-disabled="true" class="arco-select-option arco-select-option-disabled">CT20260521191189 【明星说】漫剧合作协议（框架）</div>
    `);
    await transientPage.evaluate(() => {
      setTimeout(() => {
        const option = document.querySelector<HTMLElement>('[role="option"]');
        option?.removeAttribute('aria-disabled');
        option?.classList.remove('arco-select-option-disabled');
      }, 50);
    });
    const transientSelected = await selectRequiredDropdownByStableId(
      transientPage,
      placeholder,
      "contract",
      "CT20260521191189",
      recorder,
      { attempts: 2, delayMs: 100 },
    );
    assert.match(transientSelected, /^CT20260521191189/u);
    await transientPage.close();

    const disabledPage = await render(`
      <div role="option" aria-disabled="true" class="arco-select-option arco-select-option-disabled">CT20260521191189 【明星说】漫剧合作协议（框架）</div>
      <div role="option" class="arco-select-option">CT20260928151015 漫剧合作协议（对公签约-番茄 IP 改编）</div>
    `);
    await assert.rejects(
      selectRequiredDropdownByStableId(
        disabledPage,
        placeholder,
        "contract",
        "CT20260521191189",
        recorder,
        { attempts: 1, delayMs: 0 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /DOUYIN_DRAMA_REQUIRED_CONTRACT_DISABLED/u);
        assert.match(error.message, /CT20260928151015/u);
        return true;
      },
    );
    await disabledPage.close();
  } finally {
    await browser.close();
  }
});

test("selects the ordinary authorization contract by exact name without depending on its id", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const recorder = createDouyinDramaDropdownRecorder({});
  const placeholder = "请选择（温馨提示：合同绑定错误会影响结算）";
  const contractName =
    "动态漫授权合作协议(对公签约-付免一体-普通授权-纯分成）- 主协议-明星说北京科技有限公司";
  try {
    await page.setContent(`
      <div id="contract" role="combobox" class="arco-select" style="width:320px;height:32px">
        <input placeholder="${placeholder}" value=""><span class="value"></span>
      </div>
      <div id="contract-popup" class="arco-select-popup" role="listbox" style="display:none">
        <div role="option" class="arco-select-option arco-select-option-disabled" aria-disabled="true">
          CT20260928151015 漫剧合作协议（对公签约-番茄 IP 改编）-明星说北京科技有限公司
        </div>
        <div role="option" class="arco-select-option">
          CT20251231125707 动态漫IP授权合作协议(对公签约-纯分成-动态漫版权共有) - 主协议-明星说北京科技有限公司
        </div>
        <div role="option" class="arco-select-option">CT20251230112335 ${contractName}</div>
        <div role="option" class="arco-select-option">CT20251127121461 ${contractName}</div>
      </div>
      <script>
        const trigger = document.querySelector('#contract');
        const popup = document.querySelector('#contract-popup');
        trigger.addEventListener('click', () => { popup.style.display = 'block'; });
        popup.querySelectorAll('[role=option]:not(.arco-select-option-disabled)').forEach((option) => {
          option.addEventListener('click', () => {
            option.setAttribute('aria-selected', 'true');
            trigger.querySelector('.value').textContent = option.textContent.trim();
          });
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') popup.style.display = 'none';
        });
      </script>
    `);

    const selected = await selectRequiredDropdownByContractName(
      page,
      placeholder,
      "contract",
      contractName,
      recorder,
    );
    assert.match(selected, /^CT20251230112335/u);
    assert.doesNotMatch(selected, /版权共有/u);
  } finally {
    await browser.close();
  }
});

test("selects the publish account name returned by the task API", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const recorder = createDouyinDramaDropdownRecorder({});
  try {
    await page.setContent(`
      <div id="publish-account" role="combobox" class="arco-select" style="width:320px;height:32px">
        <input placeholder="请选择发布账号" value=""><span class="value"></span>
      </div>
      <div id="publish-account-popup" class="arco-select-popup" role="listbox" style="display:none">
        <div role="option" class="arco-select-option">兜兜动漫 B号 每日限额2000</div>
        <div role="option" class="arco-select-option">其他发布账号</div>
      </div>
      <script>
        const trigger = document.querySelector('#publish-account');
        const input = trigger.querySelector('input');
        const popup = document.querySelector('#publish-account-popup');
        trigger.addEventListener('click', () => { popup.style.display = 'block'; });
        input.addEventListener('input', () => { popup.style.display = 'block'; });
        popup.querySelectorAll('[role=option]').forEach((option) => {
          option.addEventListener('click', (event) => {
            event.currentTarget.setAttribute('aria-selected', 'true');
            event.currentTarget.classList.add('arco-select-option-selected');
            trigger.querySelector('.value').textContent = event.currentTarget.textContent;
          });
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') popup.style.display = 'none';
        });
      </script>
    `);

    await selectSearchableDropdownByPlaceholder(
      page,
      "请选择发布账号",
      "publishAccount",
      "兜兜动漫",
      recorder,
    );
    assert.match(
      await page.locator("#publish-account .value").innerText(),
      /^兜兜动漫/u,
    );
    assert.equal(await page.locator("#publish-account-popup").isVisible(), false);
  } finally {
    await browser.close();
  }
});

test("confirms a publish account when Arco moves its value outside the searchable trigger", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  const recorder = createDouyinDramaDropdownRecorder({});
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>发布账号</label>
        <div id="publish-account" role="combobox" class="arco-select">
          <input placeholder="请选择发布账号" value="">
        </div>
        <span id="selected-account"></span>
      </div>
      <div id="publish-account-popup" class="arco-select-popup" role="listbox" style="display:none">
        <div role="option" class="arco-select-option">兜兜动漫 B号 每日限额2000</div>
      </div>
      <script>
        const trigger = document.querySelector('#publish-account');
        const input = trigger.querySelector('input');
        const popup = document.querySelector('#publish-account-popup');
        trigger.addEventListener('click', () => { popup.style.display = 'block'; });
        input.addEventListener('input', () => { popup.style.display = 'block'; });
        popup.querySelector('[role=option]').addEventListener('click', (event) => {
          document.querySelector('#selected-account').textContent = event.currentTarget.textContent;
          input.value = '';
          popup.remove();
        });
      </script>
    `);

    await selectSearchableDropdownByPlaceholder(
      page,
      "请选择发布账号",
      "publishAccount",
      "兜兜动漫",
      recorder,
    );
    assert.match(await page.locator("#selected-account").innerText(), /^兜兜动漫/u);
  } finally {
    await browser.close();
  }
});

test("uses the chooser opened by copyright drag uploaders", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div role="alert" class="arco-message">资源上传中请等待</div>
      <div class="arco-form-item">
        <label>权属文件</label>
        <div id="copyright_files_input" class="arco-upload">
          <input id="unused-outer-input" type="file" style="display: none">
          <section class="file-picker-box">
            <input id="active-picker-input" type="file" style="display: none">
            <span>点击或拖拽文件到此上传</span>
          </section>
        </div>
        <div class="arco-upload-list"></div>
      </div>
      <script>
        document.querySelector('.file-picker-box').addEventListener('click', () => {
          document.querySelector('#active-picker-input').click();
        });
        document.querySelector('#active-picker-input').addEventListener('change', (event) => {
          const list = document.querySelector('.arco-form-item');
          for (const file of event.currentTarget.files) {
            const item = document.createElement('div');
            item.className = 'uploaded_list_item';
            item.innerHTML = \`<div class="file-name">\${file.name}</div>
              <div class="file-status-text file-status-text-success">上传完成</div>\`;
            list.append(item);
          }
        });
      </script>
    `);

    await uploadFormFiles(
      page,
      "权属文件",
      [fileURLToPath(import.meta.url)],
      5_000,
      "copyright_files_input",
    );
    assert.equal(await page.locator("#active-picker-input").evaluate((input: HTMLInputElement) =>
      input.files?.length), 1);
    assert.equal(await page.locator("#unused-outer-input").evaluate((input: HTMLInputElement) =>
      input.files?.length), 0);
    assert.equal(await page.locator(".uploaded_list_item").count(), 1);
    assert.equal(await page.locator(".file-status-text-success").innerText(), "上传完成");
  } finally {
    await browser.close();
  }
});

test("confirms a custom uploader from its bound URL when the result card is outside the form item", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>不侵权承诺函</label>
        <div id="non_infringement_letter_url_input" class="arco-upload">
          <input id="uploaded-url" type="hidden" value="">
          <section class="file-picker-box">
            <input id="commitment-picker-input" type="file" style="display: none">
            <span>点击或拖拽文件到此上传</span>
          </section>
        </div>
      </div>
      <div id="upload-result-portal"></div>
      <script>
        const picker = document.querySelector('#commitment-picker-input');
        document.querySelector('.file-picker-box').addEventListener('click', () => picker.click());
        picker.addEventListener('change', (event) => {
          const file = event.currentTarget.files[0];
          document.querySelector('#uploaded-url').value = 'https://upload.example/' + file.name;
          document.querySelector('#upload-result-portal').innerHTML =
            '<div class="arco-upload-list-item"><span class="file-name" title="' + file.name + '">' +
            file.name + '</span><span>上传完成</span></div>';
        });
      </script>
    `);

    await uploadFormFiles(
      page,
      "不侵权承诺函",
      [fileURLToPath(import.meta.url)],
      5_000,
      "non_infringement_letter_url_input",
    );
    assert.match(await page.locator("#uploaded-url").inputValue(), /^https:\/\/upload\.example\//u);
  } finally {
    await browser.close();
  }
});

test("merges every commitment PDF page into one image for a single-file control", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "douyin-multipage-upload-"));
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  const runtimeProcess = process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
  };
  const originalGetBuiltinModule = runtimeProcess.getBuiltinModule;
  runtimeProcess.getBuiltinModule = undefined;
  try {
    const pdfFile = path.join(directory, "commitment.pdf");
    const document = await PDFDocument.create();
    document.addPage([595, 842]).drawRectangle({
      x: 0,
      y: 0,
      width: 595,
      height: 842,
      color: rgb(1, 0, 0),
    });
    document.addPage([595, 842]).drawRectangle({
      x: 0,
      y: 0,
      width: 595,
      height: 842,
      color: rgb(0, 0, 1),
    });
    await writeFile(pdfFile, await document.save());

    const page = await context.newPage();
    await page.setContent(`
      <div class="arco-form-item">
        <label>不侵权承诺函</label>
        <div id="non_infringement_letter_url_input" class="arco-upload">
          <section class="file-picker-box">
            <input id="pdf-pages-picker" type="file" style="display:none">
            <span>点击或拖拽文件到此上传</span>
          </section>
        </div>
      </div>
      <script>
        const picker = document.querySelector('#pdf-pages-picker');
        document.querySelector('.file-picker-box').addEventListener('click', () => picker.click());
        picker.addEventListener('change', (event) => {
          for (const file of event.currentTarget.files) {
            const item = document.createElement('div');
            item.className = 'uploaded_list_item';
            item.innerHTML = '<span class="file-name">' + file.name + '</span>' +
              '<span class="file-status-text file-status-text-success">上传完成</span>';
            document.querySelector('.arco-form-item').append(item);
          }
        });
      </script>
    `);
    await uploadFormFiles(
      page,
      "不侵权承诺函",
      [pdfFile],
      30_000,
      "non_infringement_letter_url_input",
    );
    const uploadedNames = await page.locator(".file-name").allTextContents();
    assert.deepEqual(uploadedNames, ["commitment-upload-v4-all-pages.jpg"]);
    const merged = await sharp(path.join(directory, uploadedNames[0]!)).metadata();
    assert.ok((merged.height ?? 0) > (merged.width ?? 0) * 2);
  } finally {
    runtimeProcess.getBuiltinModule = originalGetBuiltinModule;
    await context.close();
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uploads only the first PDF page for the single-file cost configuration control", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "douyin-cost-upload-"));
  const browser = await launchTestBrowser();
  try {
    const pdfFile = path.join(directory, "cost.pdf");
    const document = await PDFDocument.create();
    document.addPage([595, 842]).drawRectangle({
      x: 0,
      y: 0,
      width: 595,
      height: 842,
      color: rgb(1, 0, 0),
    });
    document.addPage([595, 842]).drawRectangle({
      x: 0,
      y: 0,
      width: 595,
      height: 842,
      color: rgb(0, 0, 1),
    });
    await writeFile(pdfFile, await document.save());

    const page = await browser.newPage();
    await page.setContent(`
      <div class="arco-form-item">
        <label>成本配置情况</label>
        <input id="cost-picker" type="file">
        <div class="arco-upload-list"></div>
      </div>
      <script>
        document.querySelector('#cost-picker').addEventListener('change', (event) => {
          const file = event.currentTarget.files[0];
          document.querySelector('.arco-upload-list').innerHTML =
            '<div class="arco-upload-list-item"><span class="file-name">' + file.name +
            '</span><span>上传完成</span></div>';
        });
      </script>
    `);
    await uploadFormFiles(page, "成本配置情况", [pdfFile], 30_000);
    assert.equal(await page.locator(".file-name").textContent(), "cost-upload-v3-page-1.jpg");
    assert.equal(await stat(path.join(directory, "cost-upload-v3-page-2.jpg")).catch(() => undefined), undefined);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes and retries only a cloud image stuck at upload 100 percent", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>工程文件截图</label>
        <div id="engineering_file_screenshots_input" class="arco-upload">
          <section class="file-picker-box">
            <input id="project-picker-input" type="file" multiple style="display: none">
            <span>点击或拖拽文件到此上传</span>
          </section>
        </div>
        <div class="arco-upload-list"></div>
      </div>
      <div role="dialog" class="arco-modal global-confirm-modal" style="display:none">
        <div>删除图片</div>
        <div>删除图片后不可恢复，是否要删除该图片？</div>
        <button type="button">取消</button>
        <button id="confirm-delete" type="button">确定</button>
      </div>
      <script>
        window.uploadChangeCount = 0;
        window.deleteConfirmCount = 0;
        let pendingDelete;
        const picker = document.querySelector('#project-picker-input');
        const formItem = document.querySelector('.arco-form-item');
        const dialog = document.querySelector('[role=dialog]');
        document.querySelector('.file-picker-box').addEventListener('click', () => picker.click());
        picker.addEventListener('change', (event) => {
          window.uploadChangeCount += 1;
          [...event.currentTarget.files].forEach((file, index) => {
            const stalled = window.uploadChangeCount === 1 && index === 0;
            const item = document.createElement('div');
            item.className = 'uploaded_list_item';
            item.innerHTML = \`<div class="file-name">\${file.name}</div>
              <div class="file-status-text \${stalled ? '' : 'file-status-text-success'}">
                \${stalled ? '上传中 100%' : '上传完成'}
              </div>
              <div class="uploaded_list_item-ops"><button type="button">
                <svg class="serial-icon-general_delete"></svg>
              </button></div>\`;
            item.querySelector('button').addEventListener('click', () => {
              pendingDelete = item;
              dialog.style.display = 'block';
            });
            formItem.append(item);
          });
          event.currentTarget.value = '';
        });
        document.querySelector('#confirm-delete').addEventListener('click', () => {
          window.deleteConfirmCount += 1;
          pendingDelete.remove();
          pendingDelete = undefined;
          dialog.style.display = 'none';
        });
      </script>
    `);

    const fixture = fileURLToPath(import.meta.url);
    await uploadFormFiles(
      page,
      "工程文件截图",
      [fixture, fixture, fixture, fixture],
      5_000,
      "engineering_file_screenshots_input",
    );

    assert.equal(await page.evaluate(() => (
      window as Window & { uploadChangeCount?: number }
    ).uploadChangeCount), 2);
    assert.equal(await page.evaluate(() => (
      window as Window & { deleteConfirmCount?: number }
    ).deleteConfirmCount), 1);
    assert.equal(await page.locator(".uploaded_list_item").count(), 4);
    assert.equal(await page.locator(".file-status-text-success").count(), 4);
  } finally {
    await browser.close();
  }
});

test("fails after five retries when a cloud image stays at upload 100 percent", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div class="arco-form-item">
        <label>工程文件截图</label>
        <div id="engineering_file_screenshots_input" class="arco-upload">
          <section class="file-picker-box">
            <input id="project-picker-input" type="file" style="display: none">
            <span>点击或拖拽文件到此上传</span>
          </section>
        </div>
        <div class="arco-upload-list"></div>
      </div>
      <div role="dialog" class="arco-modal global-confirm-modal" style="display:none">
        <div>删除图片</div><div>删除图片后不可恢复，是否要删除该图片？</div>
        <button id="confirm-delete" type="button">确定</button>
      </div>
      <script>
        window.uploadChangeCount = 0;
        let pendingDelete;
        const picker = document.querySelector('#project-picker-input');
        const formItem = document.querySelector('.arco-form-item');
        const dialog = document.querySelector('[role=dialog]');
        document.querySelector('.file-picker-box').addEventListener('click', () => picker.click());
        picker.addEventListener('change', (event) => {
          window.uploadChangeCount += 1;
          const file = event.currentTarget.files[0];
          const item = document.createElement('div');
          item.className = 'uploaded_list_item';
          item.innerHTML = \`<div class="file-name">\${file.name}</div>
            <div class="file-status-text">上传中 100%</div>
            <div class="uploaded_list_item-ops"><button type="button">
              <svg class="serial-icon-general_delete"></svg>
            </button></div>\`;
          item.querySelector('button').addEventListener('click', () => {
            pendingDelete = item;
            dialog.style.display = 'block';
          });
          formItem.append(item);
          event.currentTarget.value = '';
        });
        document.querySelector('#confirm-delete').addEventListener('click', () => {
          pendingDelete.remove();
          pendingDelete = undefined;
          dialog.style.display = 'none';
        });
      </script>
    `);

    await assert.rejects(
      () => uploadFormFiles(
        page,
        "工程文件截图",
        [fileURLToPath(import.meta.url)],
        3_000,
        "engineering_file_screenshots_input",
      ),
      /DOUYIN_DRAMA_UPLOAD_NOT_CONFIRMED: 工程文件截图; stalledAt100Retries=5/u,
    );
    assert.equal(await page.evaluate(() => (
      window as Window & { uploadChangeCount?: number }
    ).uploadChangeCount), 6);
  } finally {
    await browser.close();
  }
});
