import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import sharp from "sharp";
import type { DramaAiClient } from "@dramabridge/ai";
import { createRecreationBundleTransfer } from "../../electron/platforms/kuaishou-drama/recreation-bundle-workflow";

test("recreation downloads and uploads covers only, retaining AI variants and one cloud video bundle on retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cloud-recreation-"));
  try {
    const source = path.join(root, "素材", "原剧");
    await mkdir(path.join(source, "封面"), { recursive: true });
    await sharp({ create: { width: 20, height: 30, channels: 3, background: "red" } }).png().toFile(path.join(source, "封面", "海报.png"));
    let generated = 0;
    const client = { generateImage: async () => {
      generated++;
      return { images: [{ data: await sharp({ create: { width: 30, height: 50, channels: 3, background: "blue" } }).png().toBuffer(), mimeType: "image/png" }], model: "test" };
    } } as DramaAiClient;
    const calls: string[] = [];
    const transfer = createRecreationBundleTransfer({
      kuaishouRecreationMaterialRoot: () => root,
      createConfiguredAiClient: () => client, getConfiguredAiImageModel: () => "test", getConfiguredAiCoverGenerationRetryAttempts: () => 0,
      ensureBaiduNetdiskShareDownloaded: async options => {
        assert.equal(options.downloadEpisodeVideos, false);
        assert.equal(options.requireAllDiscoveredAssets, false);
        assert.equal(options.requiredOwnershipFiles, 0);
        calls.push("cover-download");
        return { localPath: source } as Awaited<ReturnType<typeof import("../../electron/platforms/baidu-netdisk").ensureBaiduNetdiskShareDownloaded>>;
      },
      uploadKuaishouRecreationVersion: async options => {
        assert.equal(options.createShare, false, "do not publish an intermediate covers-only link");
        assert.deepEqual(await readdir(options.localDirectory), ["封面"]);
        const names = await readdir(path.join(options.localDirectory, "封面"));
        assert.deepEqual(names.sort(), ["原剧.png", "新剧.png"]);
        calls.push("cover-upload");
        return { remotePath: options.remoteDirectory, shareUrl: "", extractionCode: "", verifiedEntries: names.map(server_filename => ({ server_filename,
          path: options.remoteDirectory + "/封面/" + server_filename, fs_id: server_filename, md5: "verified", size: 100, isdir: 0 })) };
      },
      transferKuaishouRecreationVideos: async options => {
        assert.equal(options.episodeCount, 100);
        assert.equal(options.bundleCovers?.files.length, 2);
        assert.match(options.bundleCovers!.directory, /封面缓存-[a-f0-9]{16}-60%\/封面$/);
        calls.push("cloud-transfer");
        return { path: "/快手_二创集合/原剧/集合", shareUrl: "https://pan.baidu.com/s/1bundle", count: 60 };
      },
    });
    const input = { title: "原剧", versionTitle: "原剧", versions: ["新剧"], episodeCount: 100,
      shareText: "https://pan.baidu.com/s/1source", onProgress: () => {} };
    assert.equal((await transfer(input)).shareUrl, "https://pan.baidu.com/s/1bundle");
    await transfer(input);
    assert.equal(generated, 1, "retry reuses generated AI cover");
    assert.deepEqual(calls, ["cover-download", "cover-upload", "cloud-transfer", "cover-download", "cover-upload", "cloud-transfer"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
