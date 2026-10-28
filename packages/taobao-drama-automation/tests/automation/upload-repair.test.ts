import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isTaobaoVideoResolutionFailure, retryFailedTaobaoEpisodes, waitForUploadComplete } from "../../src/automation/episodes.js";
import { prepareTaobaoEpisodeVideos } from "../../src/shared/local-materials.js";

const cacheRoot = path.resolve(import.meta.dirname, "../../../../.cache");
const browserRoot = path.join(cacheRoot, "playwright-browsers");
const revision = (await readdir(browserRoot)).filter((name) => /^chromium-\d+$/.test(name))
  .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];
assert.ok(revision);
const { chromium } = await import("playwright");
const browser = await chromium.launch({ executablePath: path.join(browserRoot, revision, "chrome-win64/chrome.exe"), headless: true });
after(async () => { await browser.close(); });

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(path.join(cacheRoot, "taobao-upload-repair-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(`${cacheRoot}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("only explicit resolution requirements trigger resolution repair", () => {
  assert.equal(isTaobaoVideoResolutionFailure("上传视频的宽高是720x1280不符合要求，视频宽高均要大于1080"), true);
  assert.equal(isTaobaoVideoResolutionFailure("视频分辨率低于平台要求"), true);
  assert.equal(isTaobaoVideoResolutionFailure("视频格式不符合要求"), false);
  assert.equal(isTaobaoVideoResolutionFailure("网络错误，请重试"), false);
});

test("initial video preparation retains original files without probing or converting them", async (t) => {
  const directory = await temporaryDirectory(t);
  const title = "原片优先";
  const sourceDir = path.join(directory, title);
  await mkdir(sourceDir);
  const original = path.join(sourceDir, `${title} - 第1集.mp4`);
  // This deliberately has no decodable video: preparation must not invoke a
  // dimension probe or encoder before Taobao has rejected an upload.
  await writeFile(original, "original video bytes");
  const result = await prepareTaobaoEpisodeVideos({
    id: "test", originalTitle: title, episodeCount: 1, baiduPanResourceLink: "test", productionCostProofFiles: [],
  }, { localMaterialRoot: directory, assetDownloadDir: path.join(directory, "assets") });
  assert.equal(result.episodes[0].file, original);
  assert.deepEqual(result.prepared.files, []);
  assert.deepEqual(await readdir(result.prepared.uploadDir), []);
});

async function uploadFixture(t: TestContext, reason: string, rejectReplacement = false, automaticRejection = false, deletionDelayMs = 0) {
  const directory = await temporaryDirectory(t);
  const originals = ["accepted-1.mp4", "low-resolution.mp4", "accepted-3.mp4"];
  const files = originals.map((name) => path.join(directory, name));
  const replacement = path.join(directory, "repaired.mp4");
  await Promise.all([...files, replacement].map((file) => writeFile(file, "video")));
  const page = await browser.newPage();
  t.after(async () => { await page.close(); });
  await page.setContent(`
    <div id="publish-container"></div><input type="file" accept="video/mp4" multiple>
    <div class="next-dialog" role="dialog" style="display:none"><p>上传失败</p><p id="reason"></p><button>我知道了</button></div>
    <script>
      const reason = ${JSON.stringify(reason)};
      const rejectReplacement = ${JSON.stringify(rejectReplacement)};
      const automaticRejection = ${JSON.stringify(automaticRejection)};
      const deletionDelayMs = ${JSON.stringify(deletionDelayMs)};
      const root = document.querySelector('#publish-container');
      const dialog = document.querySelector('.next-dialog');
      document.querySelector('#reason').textContent = reason;
      dialog.querySelector('button').onclick = () => dialog.style.display = 'none';
      window.deleted = [];
      window.uploaded = [];
      function addItem(name, failed) {
        const item = document.createElement('div');
        item.className = 'batchItemWrap';
        item.innerHTML = '<div class="batchItemTop"><span class="batchItemTitle"></span><i class="next-icon" style="display:inline-block;padding:10px">删除</i></div><div class="batchItemStatus"></div>';
        item.querySelector('.batchItemTitle').textContent = name;
        item.querySelector('.batchItemStatus').textContent = failed ? '上传失败' : '已上传';
        item.querySelector('i').onclick = () => {
          const remove = () => { window.deleted.push(name); item.remove(); };
          if (!deletionDelayMs) return remove();
          setTimeout(() => {
            const confirmation = document.createElement('div');
            confirmation.className = 'next-dialog';
            confirmation.setAttribute('role', 'dialog');
            confirmation.innerHTML = '<p>是否确认删除视频</p><button>确认</button>';
            confirmation.querySelector('button').onclick = () => { remove(); confirmation.remove(); };
            // The uploader may be in an iframe; the confirmation lives outside it.
            document.body.append(confirmation);
          }, deletionDelayMs);
        };
        if (failed) {
          const link = document.createElement('button');
          link.textContent = '查看原因';
          link.onclick = () => dialog.style.display = 'block';
          item.append(link);
        }
        root.append(item);
        if (failed && automaticRejection) dialog.style.display = 'block';
      }
      ${JSON.stringify(originals)}.forEach((name, index) => addItem(name, index === 1));
      document.querySelector('input').onchange = event => {
        for (const file of event.target.files) {
          window.uploaded.push(file.name);
          addItem(file.name, rejectReplacement);
        }
      };
    </script>
  `);
  return { page, files, replacement };
}

test("repairs and reuploads only the resolution-rejected item, preserving successful uploads", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "上传视频的宽高是720x1280不符合要求，视频宽高均要大于1080");
  const converted: string[] = [];
  const originalFailedFile = files[1];
  await retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async (file) => {
    converted.push(file);
    return replacement;
  });
  assert.deepEqual(converted, [originalFailedFile]);
  assert.equal(files[1], replacement);
  assert.deepEqual(await page.evaluate(() => ({
    deleted: (window as any).deleted, uploaded: (window as any).uploaded,
    statuses: Array.from(document.querySelectorAll('.batchItemStatus')).map((node) => node.textContent),
  })), { deleted: ["low-resolution.mp4"], uploaded: ["repaired.mp4"], statuses: ["已上传", "已上传", "已上传"] });
});

test("an automatic resolution dialog reaches per-item repair instead of terminating the batch", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "上传视频的宽高是1280x720不符合要求，视频宽高均要大于1080");
  await page.getByText("查看原因", { exact: true }).click();
  const result = await waitForUploadComplete(page, files, {}, true);
  assert.deepEqual(result.failedFileNames, ["low-resolution.mp4"]);
  assert.equal(await page.getByRole("dialog").isVisible(), false);
  let converted = 0;
  await retryFailedTaobaoEpisodes(page, files, result.failedFileNames, {}, async () => {
    converted += 1;
    return replacement;
  });
  assert.equal(converted, 1);
  assert.deepEqual((await waitForUploadComplete(page, files, {})).failedFileNames, []);
  assert.deepEqual(await page.evaluate(() => (window as any).deleted), ["low-resolution.mp4"]);
});

test("per-item repair handles a resolution dialog already open when locating the failed item", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "上传视频的宽高是1280x720不符合要求，视频宽高均要大于1080");
  await page.getByText("查看原因", { exact: true }).click();
  await retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async () => replacement);
  assert.deepEqual(await page.evaluate(() => (window as any).uploaded), ["repaired.mp4"]);
});

test("per-item repair reads a failure dialog rendered outside the upload iframe", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "上传视频的宽高是1280x720不符合要求，视频宽高均要大于1080");
  // Keep the failure modal in the parent page while moving the uploader into a frame.
  await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    const loaded = new Promise<void>((resolve) => { frame.onload = () => resolve(); });
    document.body.append(frame);
    await loaded;
    const frameDocument = frame.contentDocument!;
    frameDocument.body.append(document.querySelector("#publish-container")!, document.querySelector("input")!);
  });
  await retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async () => replacement);
  assert.deepEqual(await page.evaluate(() => (window as any).deleted), ["low-resolution.mp4"]);
  assert.deepEqual(await page.evaluate(() => (window as any).uploaded), ["repaired.mp4"]);
});

test("automatic non-resolution rejections remain fatal without deleting or reuploading videos", async (t) => {
  const { page, files } = await uploadFixture(t, "视频格式不符合要求");
  await page.getByText("查看原因", { exact: true }).click();
  await assert.rejects(waitForUploadComplete(page, files, {}, true), /VIDEO_UPLOAD_REJECTED/);
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  assert.deepEqual(await page.evaluate(() => ({ deleted: (window as any).deleted, uploaded: (window as any).uploaded })), { deleted: [], uploaded: [] });
});

test("waits for the delayed delete confirmation before uploading the replacement", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "视频分辨率低于平台要求", false, false, 750);
  await retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async () => replacement);
  assert.deepEqual(await page.evaluate(() => (window as any).deleted), ["low-resolution.mp4"]);
  assert.deepEqual(await page.evaluate(() => (window as any).uploaded), ["repaired.mp4"]);
});

test("resolution rejection outside the repairable upload phase remains fatal", async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  await page.getByText("查看原因", { exact: true }).click();
  await assert.rejects(waitForUploadComplete(page, files, {}), /VIDEO_UPLOAD_REJECTED/);
});

test("a format rejection cannot trigger conversion or delete an uploaded item", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "视频格式不符合要求");
  let converted = 0;
  await assert.rejects(retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async () => {
    converted += 1;
    return replacement;
  }), /VIDEO_UPLOAD_REJECTED/);
  assert.equal(converted, 0);
  assert.deepEqual(await page.evaluate(() => (window as any).deleted), []);
});

test("a repeated resolution rejection stops instead of converting the same episode again", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "分辨率低于平台要求", true);
  let converted = 0;
  await assert.rejects(retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async () => {
    converted += 1;
    return replacement;
  }), /转换后仍被淘宝拒绝/);
  assert.equal(converted, 1);
  assert.deepEqual(await page.evaluate(() => (window as any).deleted), ["low-resolution.mp4"]);
});

test("an automatic rejection after conversion still reports that repair was already attempted", async (t) => {
  const { page, files, replacement } = await uploadFixture(t, "视频分辨率低于平台要求", true, true);
  let converted = 0;
  await assert.rejects(retryFailedTaobaoEpisodes(page, files, ["low-resolution.mp4"], {}, async () => {
    converted += 1;
    return replacement;
  }), /转换后仍被淘宝拒绝/);
  assert.equal(converted, 1);
  assert.deepEqual(await page.evaluate(() => (window as any).uploaded), ["repaired.mp4"]);
  assert.deepEqual(await page.evaluate(() => (window as any).deleted), ["low-resolution.mp4"]);
});

test("a failed item cannot bypass repair through an enabled publish button while another item is pending", async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  await page.evaluate(() => {
    // This wording is not covered by the generic page-text pending matcher.
    document.querySelectorAll('.batchItemStatus')[2].textContent = '等待上传';
    const button = document.createElement('button');
    button.textContent = '批量发布';
    document.body.append(button);
    setTimeout(() => { document.querySelectorAll('.batchItemStatus')[2].textContent = '已上传'; }, 1_500);
  });
  const result = await waitForUploadComplete(page, files, {}, true);
  assert.deepEqual(result.failedFileNames, ["low-resolution.mp4"]);
});
