import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ensureBaiduNetdiskEpisodeVideos, type BaiduNetdiskDownloadTaskStatus } from "../src/baidu-netdisk.js";
import { listLocalPosterImages } from "../src/index.js";

test("recognizes a hash-named image beside video and ownership folders, preferring explicit covers and rejecting ambiguous roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hashed-poster-"));
  const resourceName = "一元餐盒的代价";
  const resource = path.join(root, resourceName);
  const hash = "b45d282d3a0b4caa2413ff0af78b97d8.png";
  try {
    await mkdir(path.join(resource, "权属"), { recursive: true });
    await mkdir(path.join(resource, "视频"));
    const image = await sharp({ create: { width: 20, height: 30, channels: 3, background: "blue" } }).png().toBuffer();
    await writeFile(path.join(resource, hash), image);
    await writeFile(path.join(resource, "权属", "工程.png"), image);
    await writeFile(path.join(resource, "简介.txt"), "简介");
    assert.equal((await listLocalPosterImages({ root, resourceName }))[0]?.name, hash);
    assert.equal((await listLocalPosterImages({ root: path.join(resource, "权属"), resourceName, rootIsResourceDir: true })).length, 0);
    await mkdir(path.join(resource, "封面"));
    await writeFile(path.join(resource, "封面", "001.png"), image);
    assert.equal((await listLocalPosterImages({ root, resourceName }))[0]?.name, "001.png", "dedicated cover directory wins over a generic root image");
    await rm(path.join(resource, "封面"), { recursive: true });
    await writeFile(path.join(resource, "avatar.png"), image);
    assert.equal((await listLocalPosterImages({ root, resourceName })).length, 0, "do not guess among multiple unnamed root images");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const shape of [{ width: 30, height: 20 }, { width: 20, height: 20 }, { width: 20, height: 30 }]) {
  test(`poster-only download accepts a complete ${shape.width}x${shape.height} image without waiting for unrelated files`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "poster-only-"));
    try {
      const downloaded = path.join(root, "batch", "海报封面");
      await mkdir(downloaded, { recursive: true });
      const image = await sharp({ create: { ...shape, channels: 3, background: "red" } }).png().toBuffer();
      let checks = 0;
      const result = await ensureBaiduNetdiskEpisodeVideos({
        shareText: "https://pan.baidu.com/s/test", resourceName: "原剧", localEpisodeVideoRoot: path.join(root, "output"),
        downloadEpisodeVideos: false, requiredPosterImages: 1, stableCompletePolls: 2, pollIntervalMs: 1, timeoutMs: 2000,
        downloadShare: async () => ({ share: { link: "", pwd: "", name: "视频目录" }, completed: false, skippedExisting: false,
          posterDownload: { root: downloaded, files: [{ name: "001.png", size: image.length }] } }),
        getDownloadTaskStatus: async request => {
          assert.equal(request.targetName, "001.png"); assert.equal(request.expectedDownloadRoot, downloaded);
          checks++;
          if (checks === 1) await writeFile(path.join(downloaded, "001.png"), image);
          await writeFile(path.join(root, "batch", "第1集.mp4"), String(checks));
          return { found: true, completed: false, status: "2", tasks: [] };
        },
      });
      assert.equal(result.episodeCount, 0);
      assert.ok(checks < 4);
      assert.deepEqual((await readdir(path.join(result.localPath, "海报封面"))).filter(x => x.endsWith(".png")), ["原剧 - 海报.png"]);
      assert.equal((await listLocalPosterImages({ root: result.localPath, rootIsResourceDir: true, resourceName: "原剧" })).length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["missing", "corrupt", "partial", "paused", "failed", "unavailable"] as const) {
  test(`poster-only download reports ${mode} promptly with the exact file and directory`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "poster-error-"));
    try {
      await assert.rejects(ensureBaiduNetdiskEpisodeVideos({
        shareText: "https://pan.baidu.com/s/test", resourceName: "原剧", localEpisodeVideoRoot: path.join(root, "out"),
        downloadEpisodeVideos: false, requiredPosterImages: 1, pollIntervalMs: 1, timeoutMs: 2000,
        downloadShare: async () => ({ share: { link: "", pwd: "", name: "视频目录" }, completed: false, skippedExisting: false,
          posterDownload: { root, files: [{ name: "001.png", size: 10 }] } }),
        getDownloadTaskStatus: async (): Promise<BaiduNetdiskDownloadTaskStatus> => {
          if (mode === "unavailable") throw new Error("客户端不可用");
          if (mode === "corrupt" || mode === "partial") await writeFile(path.join(root, "001.png"), mode === "corrupt" ? "1234567890" : "123");
          return { found: mode !== "missing", completed: mode === "corrupt" || mode === "partial", status: mode === "paused" ? "3" : mode === "failed" ? "5" : "2", tasks: [] };
        },
      }), error => {
        const text = String(error);
        assert.match(text, /poster-download-(missing|invalid|stopped|status)/);
        assert.doesNotMatch(text, /超时/);
        if (mode !== "unavailable") { assert.ok(text.includes(root)); assert.match(text, /001.png/); }
        return true;
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
