import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { readPlatformUploadFailure, waitForPinduoduoVideoUploads } from "../../src/app/approved-shortplay-cycle.js";

function card(name: string, status: string) {
  return `<section><div><p>文件名：${name}</p><div class="status">${status}</div>
    <input type="file" data-testid="beast-core-upload-input" accept=".mp4">
    <div data-testid="beast-core-select"></div></div></section>`;
}
const resolutionFailure = '<span>视频上传失败，视频需满足以下条件，请点此</span><div><svg data-testid="beast-core-icon-warning-circle_filled"></svg><span>视频分辨率不能低于1080P</span></div>';

test("scopes each failure to the exact filename and ignores page notices", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<span>视频时长不能低于30秒</span>${card("1.mp4", "视频上传成功")}${card("1.mp4.mp4", resolutionFailure)}`);
    const result = await readPlatformUploadFailure(page, ["1.mp4", "1.mp4.mp4"]);
    assert.deepEqual(result.failedFiles, [{ file: "1.mp4.mp4", reasons: ["视频分辨率不能低于1080P"] }]);
    assert.match(result.reasons[0]!, /^1\.mp4\.mp4：/);
  } finally { await browser.close(); }
});

test("reuploads multiple failed episodes in place, including a later failure, retaining successful cards", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const directory = await mkdtemp(join(tmpdir(), "pdd-recovery-"));
  try {
    const files = ["1.mp4", "2.mp4", "3.mp4"].map(name => join(directory, name));
    for (const file of files) await writeFile(file, "test replacement");
    const page = await browser.newPage();
    await page.setContent(card("1.mp4", "视频上传成功") + card("2.mp4", resolutionFailure) + card("3.mp4", "视频质量检测中..."));
    await page.evaluate(failure => {
      const sections = [...document.querySelectorAll("section")];
      sections.forEach(section => section.querySelector("input")!.addEventListener("change", () => {
        section.dataset.retries = String(Number(section.dataset.retries ?? 0) + 1);
        section.querySelector(".status")!.textContent = "视频上传成功";
      }));
      setTimeout(() => { sections[2]!.querySelector(".status")!.innerHTML = failure; }, 200);
    }, resolutionFailure);
    const prepared: string[] = [];
    const result = await waitForPinduoduoVideoUploads(page, files, 5_000, undefined, undefined, {
      prepare: async file => { prepared.push(file); return file; },
    });
    assert.equal(result.rejected, false);
    assert.deepEqual(prepared, files.slice(1));
    assert.deepEqual(await page.locator("section").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.retries ?? "0")), ["0", "1", "1"]);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("bounds repair to one attempt and reports the rejected episode", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const directory = await mkdtemp(join(tmpdir(), "pdd-retry-limit-"));
  try {
    const file = join(directory, "1.mp4");
    await writeFile(file, "test replacement");
    const page = await browser.newPage();
    await page.setContent(card("1.mp4", resolutionFailure));
    let calls = 0;
    const result = await waitForPinduoduoVideoUploads(page, [file], 5_000, undefined, undefined, {
      prepare: async () => { calls++; return file; },
    });
    assert.equal(calls, 1);
    assert.equal(result.rejected, true);
    assert.equal(result.failedFiles[0]?.file, file);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("does not transcode an episode with additional unsupported failures", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(card("1.mp4", `${resolutionFailure}<div><svg data-testid="beast-core-icon-warning-circle_filled"></svg><span>视频文件已损坏</span></div>`));
    const result = await waitForPinduoduoVideoUploads(page, ["1.mp4"], 5_000, undefined, undefined, {
      prepare: async () => { assert.fail("unsupported failure must not be repaired"); },
    });
    assert.equal(result.rejected, true);
    assert.deepEqual(result.failedFiles[0]?.reasons, ["视频分辨率不能低于1080P", "视频文件已损坏"]);
  } finally { await browser.close(); }
});

for (const reason of ["视频平均码率不能小于要求，需上传≥6Mbps的视频", "视频时长不能低于30秒"]) {
  test(`repairs the exact rejected card for ${reason}`, async () => {
    const browser = await chromium.launch({ channel: "chromium", headless: true });
    const directory = await mkdtemp(join(tmpdir(), "pdd-spec-repair-"));
    try {
      const file = join(directory, "1.mp4");
      await writeFile(file, "replacement");
      const page = await browser.newPage();
      await page.setContent(card("1.mp4", `<span>视频上传失败</span><div><svg data-testid="beast-core-icon-warning-circle_filled"></svg><span>${reason}</span></div>`));
      await page.locator('input').evaluate(node => node.addEventListener('change', () => document.querySelector('.status')!.textContent = '视频上传成功'));
      let repairs = 0;
      const result = await waitForPinduoduoVideoUploads(page, [file], 5000, undefined, undefined, {
        prepare: async source => { assert.equal(source, file); repairs++; return file; },
      });
      assert.equal(repairs, 1);
      assert.equal(result.rejected, false);
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("cancels after video preparation without uploading a replacement", async () => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(card("1.mp4", resolutionFailure));
    const controller = new AbortController();
    await assert.rejects(waitForPinduoduoVideoUploads(page, ["1.mp4"], 5_000, undefined, controller.signal, {
      prepare: async () => { controller.abort(new Error("service stopped")); return "missing.mp4"; },
    }), /service stopped/);
  } finally { await browser.close(); }
});
