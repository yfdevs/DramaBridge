import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, writeFile, rm, stat, rename, readdir } from "node:fs/promises";
import sharp from "sharp";
import * as runtime from "../../packages/kuaishou-drama-automation/src/recreation";
import { executeRecreationTask } from "../../electron/platforms/kuaishou-drama/recreation-workflow";
import type { RecreationTask } from "../../src/platforms/kuaishou-drama/recreation-types";

function task(): RecreationTask {
  return { id: "old-task-id", originalTitle: "原剧", episodeCount: 3, downloadCount: 2,
    versions: ["新剧"], shareText: "https://pan.baidu.com/s/1test", state: "failed",
    results: [{ title: "原剧" }, { title: "新剧" }], createdAt: "", updatedAt: "" };
}
async function source(directory: string) {
  await mkdir(path.join(directory, "封面"), { recursive: true });
  for (let index = 1; index <= 2; index++) await writeFile(path.join(directory, `原剧-第${index}集.mp4`), `video${index}`);
  await sharp({ create: { width: 20, height: 30, channels: 3, background: "red" } })
    .png().toFile(path.join(directory, "封面", "海报.png"));
  return directory;
}
const share = (title: string) => ({ remotePath: title, shareUrl: `https://pan.baidu.com/s/${title}`, extractionCode: "abcd" });

test("upload failure resumes the prepared version without downloading or copying again, even without source files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-resume-"));
  try {
    const item = task();
    let downloads = 0, preparations = 0;
    const uploads: string[] = [];
    const states: string[] = [];
    let fail = true;
    item.results[1].remotePath = "/快手_二创集合/原剧/新剧-60%汇总"; // Legacy failed attempt.
    const options = {
      materialRoot: root, signal: new AbortController().signal,
      runtime: { ...runtime, prepareKuaishouRecreationVersion: async (...args: Parameters<typeof runtime.prepareKuaishouRecreationVersion>) => {
        preparations++; return runtime.prepareKuaishouRecreationVersion(...args);
      } },
      update: (fields: Partial<RecreationTask>) => { Object.assign(item, fields); if (fields.state) states.push(fields.state); },
      download: async (target: string) => { downloads++; return source(path.join(target, item.originalTitle)); },
      upload: async (_local: string, title: string, _progress: (message: string) => void, preferred: string | undefined, selected: (directory: string) => void) => {
        uploads.push(title);
        if (title === "新剧") {
          assert.equal(preferred, fail ? "/快手_二创集合/原剧/新剧-60%汇总" : "/快手_二创集合/原剧/新剧-60%");
          selected("/快手_二创集合/原剧/新剧-60%");
          if (fail) throw new Error("模拟上传超时");
        }
        return share(title);
      },
    };
    await assert.rejects(executeRecreationTask(item, options), /模拟上传超时/);
    assert.equal(item.results[0].shareUrl, share("原剧").shareUrl);
    const prepared = item.results[1].localPath!;
    const before = (await stat(path.join(prepared, "成片", "新剧-第1集.mp4"))).mtimeMs;
    assert.ok(item.results[1].localFiles?.length);
    assert.equal(item.results[1].remotePath, "/快手_二创集合/原剧/新剧-60%");
    assert.equal(item.sourcePath, path.join(root, "原剧", "素材"));
    await rename(path.join(prepared, "封面", "封面.png"), path.join(prepared, "封面", "新剧-封面1.png"));
    await writeFile(path.join(prepared, "封面", "新剧-封面2.png"), "legacy extra cover");
    item.results[1].localFiles = await runtime.inspectKuaishouRecreationVersion(prepared, "新剧", 2, true);
    await rm(item.sourcePath!, { recursive: true });
    fail = false; states.length = 0;
    await executeRecreationTask(item, options);
    assert.equal(downloads, 1);
    assert.equal(preparations, 2);
    assert.deepEqual(await readdir(path.join(prepared, "封面")), ["封面.png"]);
    assert.deepEqual(uploads, ["原剧", "新剧", "新剧"]);
    assert.ok(!states.includes("downloading") && !states.includes("processing"));
    assert.equal((await stat(path.join(prepared, "成片", "新剧-第1集.mp4"))).mtimeMs, before);
    assert.equal(item.state, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy task-ID source directories are reused and adopted into the drama directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-legacy-"));
  try {
    const item = task();
    const oldSource = await source(path.join(root, "任务", item.id, "源素材", "原剧"));
    let downloads = 0;
    await executeRecreationTask(item, {
      materialRoot: root, signal: new AbortController().signal, runtime,
      update: fields => Object.assign(item, fields),
      download: async () => { downloads++; throw new Error("不应下载"); },
      upload: async (_local, title) => share(title),
    });
    assert.equal(downloads, 0);
    assert.equal(item.sourcePath, path.join(root, "原剧", "素材"));
    await assert.rejects(stat(oldSource), /ENOENT/);
    assert.equal(item.localPath, path.join(root, "原剧"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed or incomplete version checkpoints are rebuilt from existing source without another download", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-checkpoint-"));
  try {
    const item = task();
    item.sourcePath = await source(path.join(root, "原剧", "素材"));
    let downloads = 0, prepared = 0;
    const options = {
      materialRoot: root, signal: new AbortController().signal,
      runtime: { ...runtime, prepareKuaishouRecreationVersion: async (...args: Parameters<typeof runtime.prepareKuaishouRecreationVersion>) => {
        prepared++; return runtime.prepareKuaishouRecreationVersion(...args);
      } },
      update: (fields: Partial<RecreationTask>) => Object.assign(item, fields),
      download: async () => { downloads++; throw new Error("不应下载"); },
      upload: async () => { throw new Error("模拟上传超时"); },
    };
    await assert.rejects(executeRecreationTask(item, options), /模拟上传超时/);
    await writeFile(path.join(item.results[0].localPath!, "成片", "原剧-第1集.mp4"), "损坏");
    await assert.rejects(executeRecreationTask(item, options), /模拟上传超时/);
    assert.equal(downloads, 0);
    assert.equal(prepared, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
