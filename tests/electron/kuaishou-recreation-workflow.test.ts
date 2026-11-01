import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, writeFile, rm, stat, rename, readdir, readFile } from "node:fs/promises";
import sharp from "sharp";
import type { DramaAiClient, ImageGenerationOptions } from "@dramabridge/ai";
import { prepareRecreationPoster } from "../../electron/platforms/kuaishou-drama/recreation-poster";
import * as runtime from "../../packages/kuaishou-drama-automation/src/recreation";
import { executeRecreationTask as executeWithPoster } from "../../electron/platforms/kuaishou-drama/recreation-workflow";
import type { RecreationTask } from "../../src/platforms/kuaishou-drama/recreation-types";

const executeRecreationTask = (task: RecreationTask, options: Omit<Parameters<typeof executeWithPoster>[1], "generatePoster">) =>
  executeWithPoster(task, { ...options, generatePoster: async input => ({ recipe: "test", title: input.title, sha256: "test" }) });

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
const share = (title: string) => ({ remotePath: `/快手_二创集合/原剧/${title}-60%`, shareUrl: `https://pan.baidu.com/s/${title}`, extractionCode: "abcd" });

test("each version generates its own portrait from the original poster, then resumes without source or another AI call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-ai-"));
  try {
    const item = task();
    const requests: ImageGenerationOptions[] = [];
    const client = { generateImage: async (input: ImageGenerationOptions) => {
      requests.push(input);
      return { images: [{ data: await sharp({ create: { width: 60, height: 100, channels: 3, background: requests.length === 1 ? "blue" : "green" } }).png().toBuffer(), mimeType: "image/png" }], model: "test" };
    } } as DramaAiClient;
    let fail = true;
    const options: Parameters<typeof executeWithPoster>[1] = {
      materialRoot: root, runtime, signal: new AbortController().signal,
      update: fields => Object.assign(item, fields),
      download: target => source(path.join(target, item.originalTitle)),
      generatePoster: input => prepareRecreationPoster({ ...input, signal: new AbortController().signal, client: () => client,
        model: () => "test", retryAttempts: () => 0, normalize: runtime.normalizeKuaishouRecreationCover }),
      upload: async (local, title) => {
        const meta = await sharp(path.join(local, "封面", "封面.png")).metadata();
        assert.deepEqual([meta.width, meta.height], [1080, 1920]);
        if (title === "新剧" && fail) throw new Error("upload failed");
        return share(title);
      },
    };
    await assert.rejects(executeWithPoster(item, options), /upload failed/);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].referenceImages, requests[1].referenceImages, "both edits use the original poster");
    assert.notEqual(item.results[0].poster!.sha256, item.results[1].poster!.sha256);
    await rm(item.sourcePath!, { recursive: true });
    fail = false;
    await executeWithPoster(item, options);
    assert.equal(requests.length, 2);
    assert.equal(item.state, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AI failure blocks sharing while preserving prepared video files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-ai-fail-"));
  try {
    const item = task(); let uploads = 0;
    await assert.rejects(executeWithPoster(item, { materialRoot: root, runtime, signal: new AbortController().signal,
      update: fields => Object.assign(item, fields), download: target => source(path.join(target, item.originalTitle)),
      generatePoster: async () => { throw new Error("AI unavailable"); }, upload: async () => { uploads++; return share("原剧"); },
    }), /AI unavailable/);
    assert.equal(uploads, 0);
    assert.ok(item.results[0].localFiles?.length);
    assert.ok(await stat(path.join(item.results[0].localPath!, "成片", "原剧-第1集.mp4")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("uploads the first version then passes its completed cloud identity to later renamed versions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-cloud-reuse-"));
  try {
    const item = task();
    const calls: Array<{ title: string; reuseSource: unknown; local: string }> = [];
    const receipt = { path: `${share("原剧").remotePath}/成片/原剧-第1集.mp4`, fsId: "1", size: 6, serverMd5: "server", serverMtime: 1, contentMd5: "content" };
    await executeRecreationTask(item, {
      materialRoot: root, runtime, signal: new AbortController().signal,
      update: fields => Object.assign(item, fields),
      download: async target => source(path.join(target, item.originalTitle)),
      upload: async (local, title, _progress, _preferred, _selected, verification) => {
        calls.push({ title, reuseSource: verification.reuseSource, local });
        if (title === "原剧") verification.onFileVerified(receipt);
        return share(title);
      },
    });
    assert.equal(calls[0].reuseSource, undefined);
    assert.deepEqual(calls[1].reuseSource, { remoteDirectory: share("原剧").remotePath, verifiedFiles: [receipt] });
    assert.deepEqual(await readFile(path.join(calls[0].local, "成片", "原剧-第1集.mp4")), await readFile(path.join(calls[1].local, "成片", "新剧-第1集.mp4")));
    assert.deepEqual(await readFile(path.join(calls[0].local, "封面", "封面.png")), await readFile(path.join(calls[1].local, "封面", "封面.png")));
    assert.notEqual(item.results[0].shareUrl, item.results[1].shareUrl);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resumes using a previously shared sibling even if its local source was removed, never the current checkpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-cloud-resume-"));
  try {
    const item = task();
    Object.assign(item.results[0], share("原剧"));
    const raw = await source(path.join(root, "temporary-source"));
    item.results[1].localPath = await runtime.prepareKuaishouRecreationVersion({ source: raw, originalTitle: item.originalTitle, title: "新剧", episodeCount: 2, outputRoot: path.join(root, "原剧", "版本") });
    item.results[1].remotePath = share("新剧").remotePath;
    await rm(raw, { recursive: true });
    let uploads = 0;
    await executeRecreationTask(item, {
      materialRoot: root, runtime, signal: new AbortController().signal,
      update: fields => Object.assign(item, fields),
      download: async () => { throw new Error("不应下载"); },
      upload: async (_local, title, _progress, preferred, _selected, verification) => {
        uploads++;
        assert.equal(title, "新剧");
        assert.equal(preferred, share("新剧").remotePath);
        assert.equal(verification.reuseSource?.remoteDirectory, share("原剧").remotePath);
        return share(title);
      },
    });
    assert.equal(uploads, 1);
    assert.equal(item.state, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared checkpoints outside the task's drama directory are not used as cloud copy sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recreation-cloud-scope-"));
  try {
    const item = task();
    Object.assign(item.results[0], share("原剧"), { remotePath: "/快手_二创集合/其他剧/原剧-60%" });
    await executeRecreationTask(item, {
      materialRoot: root, runtime, signal: new AbortController().signal,
      update: fields => Object.assign(item, fields),
      download: async target => source(path.join(target, item.originalTitle)),
      upload: async (_local, title, _progress, _preferred, _selected, verification) => {
        assert.equal(verification.reuseSource, undefined);
        return share(title);
      },
    });
    assert.equal(item.state, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
