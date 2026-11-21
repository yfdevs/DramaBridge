import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ensureBaiduNetdiskEpisodeVideos } from "../src/baidu-netdisk.js";
import { listLocalOwnershipMaterials } from "../src/index.js";

test("cached episodes still probe the share and preserve portrait proofs before source cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "baidu-weibo-proof-"));
  const resourceName = "权属补下载";
  const target = path.join(root, "output");
  const resource = path.join(target, resourceName);
  const source = path.join(root, "download", "工程截图");
  await mkdir(resource, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(resource, "第1集.mp4"), "cached video");
  const portrait = await sharp({
    create: { width: 100, height: 200, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(source, "剪映1.png"), portrait);
  await writeFile(path.join(source, "授权.pdf"), "%PDF-1.7 fixture");
  let probes = 0;
  const result = await ensureBaiduNetdiskEpisodeVideos({
    shareText: "https://pan.baidu.com/s/test",
    resourceName,
    localEpisodeVideoRoot: target,
    episodeCount: 1,
    forceAssetDownload: true,
    requireAllDiscoveredAssets: true,
    mergeOwnershipMaterials: false,
    timeoutMs: 5000,
    pollIntervalMs: 1,
    stableCompletePolls: 1,
    downloadShare: async (request) => {
      probes++;
      assert.equal(request.requireAllDiscoveredAssets, true);
      assert.equal(
        request.expectedEpisodeCount,
        undefined,
        "cached episodes are not downloaded again",
      );
      return {
        share: { link: "https://pan.baidu.com/s/test", pwd: "", name: resourceName },
        downloadRoot: path.join(root, "download"),
        expectedOwnershipImages: 1,
        expectedOwnershipFiles: 2,
        completed: true,
        skippedExisting: false,
      };
    },
  });
  assert.equal(probes, 1);
  assert.equal(result.completed, true);
  const files = await listLocalOwnershipMaterials({
    root: target,
    resourceName,
    includePortraitImages: true,
  });
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(files[0].file), portrait);
  assert.match(await readFile(path.join(resource, "权属文件", "授权.pdf"), "utf8"), /^%PDF-/);
});
