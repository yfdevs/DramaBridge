import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ensureBaiduNetdiskEpisodeVideos, type BaiduNetdiskDownloadTaskStatus } from "../src/baidu-netdisk.js";
import { listLocalPosterImages } from "../src/index.js";

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
