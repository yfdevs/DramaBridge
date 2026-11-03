import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isTaobaoVideoResolutionFailure, retryFailedTaobaoEpisodes, restartTaobaoBatchForResolution, waitForUploadComplete } from "../../src/automation/episodes.js";
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
  assert.deepEqual(await readdir(result.prepared.uploadDir), [".drama-artifact-lease.json"]);
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


test("automatic resolution modals can animate continuously without aborting the batch", async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  await page.addStyleTag({ content: `@keyframes moveDialog { from { transform:translateX(0) } to { transform:translateX(10px) } } .next-dialog { animation:moveDialog 30ms infinite alternate; }` });
  await page.getByText("查看原因", { exact: true }).click();
  const result = await waitForUploadComplete(page, files, {}, true);
  assert.deepEqual(result.failedFileNames, ["low-resolution.mp4"]);
});

test("a replaced automatic modal never retargets a different rejection by visible-list index", async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  await page.getByText("查看原因", { exact: true }).click();
  await page.evaluate(() => {
    const dialog = document.querySelector('.next-dialog')!;
    dialog.querySelector('button')!.addEventListener('pointerdown', () => {
      const replacement = dialog.cloneNode(true) as HTMLElement;
      replacement.querySelector('button')!.addEventListener('click', () => replacement.remove());
      dialog.replaceWith(replacement);
    }, { once: true });
  });
  const result = await waitForUploadComplete(page, files, {}, true);
  assert.deepEqual(result.failedFileNames, ["low-resolution.mp4"]);
});

test("a pending structured row cannot be bypassed by an enabled publish button", async (t) => {
  const { page, files } = await uploadFixture(t, "网络超时");
  await page.evaluate(() => {
    const statuses = document.querySelectorAll('.batchItemStatus');
    statuses[1].textContent = '等待上传';
    document.querySelectorAll('.batchItemWrap button').forEach(button => button.remove());
    const publish = document.createElement('button');publish.textContent='批量发布';document.body.append(publish);
    setTimeout(() => statuses[1].textContent='已上传', 1200);
  });
  const started = Date.now();
  await waitForUploadComplete(page, files, {});
  assert.ok(Date.now() - started >= 1000);
});


test("a button replaced inside the same modal is reacquired without failing the task", async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  await page.getByText("查看原因", { exact: true }).click();
  await page.evaluate(() => {
    const dialog = document.querySelector('.next-dialog') as HTMLElement;
    const button = dialog.querySelector('button')!;
    button.addEventListener('pointerdown', () => {
      const next = button.cloneNode(true);
      next.addEventListener('click', () => dialog.style.display = 'none');
      button.replaceWith(next);
    }, { once:true });
  });
  assert.deepEqual((await waitForUploadComplete(page, files, {}, true)).failedFileNames, ["low-resolution.mp4"]);
});


async function resolutionBurst(t: TestContext, reasons: string[], pending = false) {
  const { page } = await uploadFixture(t, "视频分辨率低于平台要求");
  const files = reasons.map((_, index) => `burst-${index}.mp4`).concat('last.mp4');
  await page.addScriptTag({ content: `
    document.querySelector('#publish-container').replaceChildren();
    const reasons = ${JSON.stringify(reasons)};
    ${JSON.stringify(files)}.forEach((name, index) => {
      const item = document.createElement('div');item.className='batchItemWrap';
      const title = document.createElement('span');title.className='batchItemTitle';title.textContent=name;
      const status = document.createElement('span');status.className='batchItemStatus';
      status.textContent = index < reasons.length ? '上传失败' : ${JSON.stringify(pending ? '等待上传中' : '已上传')};
      const reasonButton = document.createElement('button');reasonButton.textContent='查看原因';
      reasonButton.onclick = () => { document.querySelector('#reason').textContent=reasons[index];document.querySelector('.next-dialog').style.display='block'; };
      item.append(title,status,reasonButton);document.querySelector('#publish-container').append(item);
    });
    setTimeout(() => document.querySelectorAll('.batchItemStatus')[reasons.length].textContent='已上传', 2000);
  ` });
  return { page, files };
}

test("five confirmed dimension failures in the first minute escape a blocked pending queue", async (t) => {
  const { page, files } = await resolutionBurst(t, Array(5).fill("视频宽高均需大于1080，当前宽高不符合要求"), true);
  const result = await waitForUploadComplete(page, files, {}, true, Date.now());
  assert.equal(result.restartForResolution, true);
  assert.equal(result.failedFileNames.length, 5);
});

test("a mixed failure reason cannot trigger full dimension conversion", async (t) => {
  const { page, files } = await resolutionBurst(t, ["网络错误", ...Array(4).fill("分辨率低于平台要求")]);
  const result = await waitForUploadComplete(page, files, {}, true, Date.now());
  assert.equal(result.restartForResolution, undefined);
});

test("four failures or failures outside the first minute retain per-item repair", async (t) => {
  for (const [count, elapsed] of [[4, 0], [5, 60001]]) {
    const { page, files } = await resolutionBurst(t, Array(count).fill("分辨率低于平台要求"));
    assert.equal((await waitForUploadComplete(page, files, {}, true, Date.now() - elapsed)).restartForResolution, undefined);
  }
});

test("missing per-item reasons cannot be inferred from other episodes", async (t) => {
  const { page, files } = await resolutionBurst(t, [...Array(4).fill("分辨率低于平台要求"), ""]);
  assert.equal((await waitForUploadComplete(page, files, {}, true, Date.now())).restartForResolution, undefined);
});

test("full recovery normalizes every file before refreshing once and reuploading in the same tab", { timeout: 15000 }, async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  const html = `<div id="publish-container"></div><input type="file" accept="video/mp4" multiple><button>添加视频</button>
    <script>document.querySelector('input').onchange=event=>{for(const file of event.target.files){
      const item=document.createElement('div');item.className='batchItemWrap';
      const title=document.createElement('span');title.className='batchItemTitle';title.textContent=file.name;
      const status=document.createElement('span');status.className='batchItemStatus';status.textContent='已上传';
      item.append(title,status);document.querySelector('#publish-container').append(item);
    }}</script>`;
  await page.route('**/*', route => route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  await page.goto('https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish');
  let refreshes = 0;
  page.on('load', () => refreshes++);
  const pagesBefore = page.context().pages().length;
  const converted: string[] = [];
  const episodes = files.map(file => ({file}));
  const result = await restartTaobaoBatchForResolution(page, episodes, {}, async file => {
    assert.equal(refreshes, 0);
    converted.push(file);return file;
  });
  assert.deepEqual(converted, files);
  assert.equal(refreshes, 1);
  assert.equal(page.context().pages().length, pagesBefore);
  assert.equal(await page.locator('.batchItemWrap').count(), files.length);
  assert.deepEqual(result.failedFileNames, []);
  assert.equal(result.restartForResolution, undefined);
});

test("conversion failure preserves the current queue without refreshing or changing episode references", async (t) => {
  const { page, files } = await uploadFixture(t, "视频分辨率低于平台要求");
  const episodes = files.map(file => ({file}));
  const before = await page.content();
  let calls = 0;
  await assert.rejects(restartTaobaoBatchForResolution(page, episodes, {}, async file => {
    if (++calls === 2) throw new Error('transcode failed');
    return file+'.converted';
  }), /transcode failed/);
  assert.deepEqual(episodes.map(episode => episode.file), files);
  assert.equal(await page.content(), before);
});
