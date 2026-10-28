import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureBaiduNetdiskEpisodeVideos,
  resolveBaiduNetdiskAssetCompletionRequirements,
} from "../src/baidu-netdisk.js";
import {
  isNonRetryableBaiduNetdiskResourceError,
  isOwnershipDirectoryName,
  listLocalOwnershipMaterials,
} from "../src/index.js";

test("expired and deleted Baidu shares do not retry on platform runtimes", () => {
  assert.equal(
    isNonRetryableBaiduNetdiskResourceError(new Error("分享链接不可用：分享文件已过期")),
    true,
  );
  assert.equal(
    isNonRetryableBaiduNetdiskResourceError(new Error("分享链接不可用：分享的文件已经被删除")),
    true,
  );
});

test("a broken Baidu client or unavailable CDP requires repair instead of repeated resource retries", () => {
  for (const message of [
    "[BAIDU_NETDISK_CLIENT_RESTART_REQUIRED] 百度网盘客户端下载组件不可用",
    "端口 9337 不是可用百度网盘 CDP",
    "百度网盘 CDP 核心页面不可用",
  ]) {
    assert.equal(isNonRetryableBaiduNetdiskResourceError(new Error(message)), true);
  }
  assert.equal(isNonRetryableBaiduNetdiskResourceError(new Error("temporary HTTP 503")), false);
});

test("optional remotely discovered ownership does not block a poster-only platform", () => {
  assert.deepEqual(
    resolveBaiduNetdiskAssetCompletionRequirements({
      requiredOwnershipImages: 0,
      requiredOwnershipFiles: 0,
      requiredPosterImages: 1,
      discoveredOwnershipImages: 13,
      discoveredOwnershipFiles: 13,
      discoveredPosterImages: 1,
    }),
    {
      ownershipImages: 0,
      ownershipFiles: 0,
      posterImages: 1,
      aiProductionProofFiles: 0,
      metadataFiles: 0,
    },
  );
});

test("explicit ownership requirements remain blocking", () => {
  assert.deepEqual(
    resolveBaiduNetdiskAssetCompletionRequirements({
      requiredOwnershipImages: 13,
      requiredOwnershipFiles: 13,
      discoveredOwnershipImages: 13,
      discoveredOwnershipFiles: 13,
    }),
    {
      ownershipImages: 13,
      ownershipFiles: 13,
      posterImages: 0,
      aiProductionProofFiles: 0,
      metadataFiles: 0,
    },
  );
});

test("strict mode waits for every remotely discovered optional asset", () => {
  assert.deepEqual(
    resolveBaiduNetdiskAssetCompletionRequirements({
      requiredOwnershipImages: 0,
      requiredOwnershipFiles: 0,
      discoveredOwnershipImages: 13,
      discoveredOwnershipFiles: 13,
      discoveredPosterImages: 4,
      discoveredAiProductionProofFiles: 2,
      discoveredMetadataFiles: 7,
      requireAllDiscoveredAssets: true,
    }),
    {
      ownershipImages: 13,
      ownershipFiles: 13,
      posterImages: 4,
      aiProductionProofFiles: 2,
      metadataFiles: 7,
    },
  );
});

test("local ownership directory recognition matches the remote scanner", () => {
  for (const name of ["工程文件", "权属", "主体资质", "版权证明", " 版 权 资料 ", "剪映", "剧创", "AI生成记录", "AI 创作过程"]) {
    assert.equal(isOwnershipDirectoryName(name), true, name);
  }
  assert.equal(isOwnershipDirectoryName("海报封面"), false);
});

test("ownership images under qualification and copyright directories are scanned", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-ownership-scan-"));
  const resourceName = "测试短剧";
  try {
    for (const [index, directory] of ["主体资质", "版权证明"].entries()) {
      const target = path.join(root, resourceName, directory);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, `${directory}.jpg`), Buffer.from([index + 1]));
    }

    const materials = await listLocalOwnershipMaterials({ root, resourceName });
    assert.equal(materials.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unnamed leaf folders with multiple screenshots enter AI proof candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-unnamed-ownership-scan-"));
  const resourceName = "测试短剧";
  const candidate = path.join(root, resourceName, "随意命名资料A");
  const poster = path.join(root, resourceName, "封面");
  try {
    await Promise.all([mkdir(candidate, { recursive: true }), mkdir(poster, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(candidate, "one.png"), Buffer.from([1])),
      writeFile(path.join(candidate, "two.png"), Buffer.from([2])),
      writeFile(path.join(poster, "cover.png"), Buffer.from([3])),
    ]);
    const materials = await listLocalOwnershipMaterials({ root, resourceName });
    assert.deepEqual(materials.map((item) => item.name), ["one.png", "two.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("poster and role-image folders do not enter ownership candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-non-ownership-scan-"));
  const resourceName = "测试短剧";
  const ownership = path.join(root, resourceName, "权属文件", "剪映工程图");
  const poster = path.join(root, resourceName, "海报封面", "原始图片");
  const avatars = path.join(root, resourceName, "海报封面", "AI角色头像");
  try {
    await Promise.all([
      mkdir(ownership, { recursive: true }),
      mkdir(poster, { recursive: true }),
      mkdir(avatars, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(ownership, "剪映1.png"), Buffer.from([1])),
      writeFile(path.join(ownership, "剪映2.png"), Buffer.from([2])),
      writeFile(path.join(poster, "封面-1.png"), Buffer.from([3])),
      writeFile(path.join(poster, "封面-2.png"), Buffer.from([4])),
      writeFile(path.join(avatars, "角色-1.png"), Buffer.from([5])),
      writeFile(path.join(avatars, "角色-2.png"), Buffer.from([6])),
    ]);

    const materials = await listLocalOwnershipMaterials({ root, resourceName });
    assert.deepEqual(materials.map((item) => item.name), ["剪映1.png", "剪映2.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource readiness returns when only unrequested remote ownership is incomplete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-ready-"));
  const resourceName = "鑫沐痴心";
  try {
    const result = await ensureBaiduNetdiskEpisodeVideos({
      shareText: "https://pan.baidu.com/s/test?pwd=test",
      resourceName,
      localEpisodeVideoRoot: root,
      episodeCount: 0,
      downloadEpisodeVideos: false,
      forceAssetDownload: true,
      requiredPosterImages: 0,
      timeoutMs: 100,
      pollIntervalMs: 1,
      stableCompletePolls: 1,
      downloadShare: async () => ({
        share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
        localPath: path.join(root, "temporary-download", resourceName),
        expectedOwnershipImages: 13,
        expectedOwnershipFiles: 13,
        completed: false,
        skippedExisting: false,
      }),
    });

    assert.equal(result.completed, true);
    assert.equal(result.localPath, path.join(root, resourceName));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requests missing Jianying proofs even when unrelated cached ownership images are plentiful", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-jianying-refresh-"));
  const resourceName = "亡妻归来，替身入局";
  const cachedOwnership = path.join(root, resourceName, "权属文件", "剧创工程图");
  let requestedJianyingImages = 0;
  try {
    await mkdir(cachedOwnership, { recursive: true });
    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      writeFile(path.join(cachedOwnership, `剧创${index + 1}.png`), Buffer.from([index + 1]))
    )));

    await assert.rejects(
      ensureBaiduNetdiskEpisodeVideos({
        shareText: "https://pan.baidu.com/s/test?pwd=test",
        resourceName,
        localEpisodeVideoRoot: root,
        episodeCount: 0,
        downloadEpisodeVideos: false,
        requiredOwnership: { minimumImages: 4, minimumJianyingImages: 4 },
        timeoutMs: 10,
        pollIntervalMs: 1,
        stableCompletePolls: 1,
        downloadShare: async (request) => {
          requestedJianyingImages = request.expectedOwnershipCounts?.minimumJianyingImages ?? 0;
          return {
            share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
            localPath: path.join(root, "empty-download", resourceName),
            completed: false,
            skippedExisting: false,
          };
        },
      }),
      /等待百度网盘资源下载完成超时/u,
    );
    assert.equal(requestedJianyingImages, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("video-only readiness ignores remotely discovered metadata files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-video-only-"));
  const resourceName = "最后一道公差";
  try {
    const result = await ensureBaiduNetdiskEpisodeVideos({
      shareText: "https://pan.baidu.com/s/test?pwd=test",
      resourceName,
      localEpisodeVideoRoot: root,
      episodeCount: 0,
      downloadEpisodeVideos: false,
      downloadAssetMaterials: false,
      forceAssetDownload: true,
      requireAllDiscoveredAssets: true,
      timeoutMs: 100,
      pollIntervalMs: 1,
      stableCompletePolls: 1,
      downloadShare: async (request) => {
        assert.equal(request.requireAllDiscoveredAssets, false);
        return {
          share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
          localPath: path.join(root, "temporary-download", resourceName),
          expectedMetadataFiles: 7,
          completed: false,
          skippedExisting: false,
        };
      },
    });

    assert.equal(result.completed, true);
    assert.equal(result.localPath, path.join(root, resourceName));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the exact episode directory separate from sibling assets and preserves all covers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-sibling-assets-"));
  const resourceName = "货车被当免费拉货站，我收车";
  const batch = path.join(root, "download-batch");
  const videoDir = path.join(batch, `成片-${resourceName}`);
  const ownershipDir = path.join(batch, "权属工程文件");
  const posterDir = path.join(batch, "海报");
  const unrelatedDir = path.join(batch, "其他下载");
  const targetRoot = path.join(root, "standardized");
  try {
    await Promise.all([
      mkdir(videoDir, { recursive: true }),
      mkdir(ownershipDir, { recursive: true }),
      mkdir(posterDir, { recursive: true }),
      mkdir(unrelatedDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(videoDir, `${resourceName}-第1集.mp4`), Buffer.from([1, 2, 3])),
      writeFile(path.join(unrelatedDir, `${resourceName}-第1集.mp4`), Buffer.from([9, 9, 9])),
      writeFile(path.join(ownershipDir, `${resourceName}-工程文件1.png`), Buffer.from([4])),
      writeFile(path.join(posterDir, "封面2比3.jpg"), Buffer.from([5])),
      writeFile(path.join(posterDir, "封面7比10.jpg"), Buffer.from([6])),
    ]);

    const result = await ensureBaiduNetdiskEpisodeVideos({
      shareText: "https://pan.baidu.com/s/test?pwd=test",
      resourceName,
      localEpisodeVideoRoot: targetRoot,
      episodeCount: 1,
      requiredOwnership: { minimumImages: 1 },
      requiredPosterImages: 1,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      stableCompletePolls: 1,
      downloadShare: async () => ({
        share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
        downloadRoot: batch,
        localPath: videoDir,
        expectedOwnershipImages: 1,
        expectedOwnershipFiles: 1,
        expectedPosterImages: 2,
        completed: true,
        skippedExisting: false,
      }),
    });

    assert.equal(result.completed, true);
    assert.deepEqual(
      (await readdir(path.join(targetRoot, resourceName, "海报封面")))
        .filter((name) => name.endsWith(".jpg")),
      [`${resourceName} - 海报.jpg`, `${resourceName} - 海报2.jpg`],
    );
    assert.deepEqual(
      (await readdir(path.join(targetRoot, resourceName))).filter((name) => name.endsWith(".mp4")),
      [`${resourceName} - 第1集.mp4`],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads and preserves a nested wrapped synopsis directory for Douyin metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-metadata-"));
  const resourceName = "货车被当免费拉货站，我收车";
  const batch = path.join(root, "download-batch");
  const resourceDir = path.join(batch, resourceName);
  const posterDir = path.join(batch, "海报");
  const wrapperName = `A刘晓-${resourceName}`;
  const metadataDir = path.join(batch, wrapperName, "简介");
  const targetRoot = path.join(root, "standardized");
  let requestedMetadataTextFiles = 0;
  try {
    await Promise.all([
      mkdir(resourceDir, { recursive: true }),
      mkdir(posterDir, { recursive: true }),
      mkdir(metadataDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(posterDir, "封面.jpg"), Buffer.from([1, 2, 3])),
      writeFile(path.join(metadataDir, "剧情及角色介绍.txt"), "刘晓是货车司机。", "utf8"),
      writeFile(path.join(metadataDir, "刘晓-角色头像.png"), Buffer.from([4, 5, 6])),
    ]);

    const result = await ensureBaiduNetdiskEpisodeVideos({
      shareText: "https://pan.baidu.com/s/test?pwd=test",
      resourceName,
      localEpisodeVideoRoot: targetRoot,
      episodeCount: 0,
      downloadEpisodeVideos: false,
      requiredPosterImages: 1,
      requiredMetadataTextFiles: 1,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      stableCompletePolls: 1,
      downloadShare: async (request) => {
        requestedMetadataTextFiles = request.expectedMetadataTextFiles ?? 0;
        return {
          share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
          downloadRoot: batch,
          localPath: resourceDir,
          expectedPosterImages: 1,
          expectedMetadataTextFiles: 1,
          expectedMetadataFiles: 2,
          remoteMetadata: {
            files: [
              { name: "剧情及角色介绍.txt", path: `/分享/${wrapperName}/简介/剧情及角色介绍.txt` },
              { name: "刘晓-角色头像.png", path: `/分享/${wrapperName}/简介/刘晓-角色头像.png` },
            ],
            textFiles: [
              { name: "剧情及角色介绍.txt", path: `/分享/${wrapperName}/简介/剧情及角色介绍.txt` },
            ],
            roots: [{ path: `/分享/${wrapperName}/简介`, fsId: 1 }],
          },
          completed: true,
          skippedExisting: false,
        };
      },
    });

    assert.equal(result.completed, true);
    assert.equal(requestedMetadataTextFiles, 1);
    assert.deepEqual(
      await readdir(path.join(targetRoot, resourceName, "海报封面", "剧情资料")),
      ["剧情及角色介绍.txt"],
    );
    assert.deepEqual(
      await readdir(path.join(targetRoot, resourceName, "海报封面", "原始图片")),
      ["刘晓-角色头像.png", "封面.jpg"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a download wait stops promptly and cancels the native task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-abort-"));
  const resourceName = "终止测试短剧";
  const controller = new AbortController();
  const cancelledTasks: string[] = [];
  try {
    const pending = ensureBaiduNetdiskEpisodeVideos({
      shareText: "https://pan.baidu.com/s/test?pwd=test",
      resourceName,
      localEpisodeVideoRoot: root,
      episodeCount: 1,
      timeoutMs: 60_000,
      pollIntervalMs: 10_000,
      signal: controller.signal,
      downloadShare: async () => ({
        share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
        localPath: path.join(root, "temporary-download", resourceName),
        completed: false,
        skippedExisting: false,
      }),
      cancelDownloadTask: async ({ targetName }) => {
        cancelledTasks.push(targetName);
      },
      onProgress: ({ phase }) => {
        if (phase === "download-submitted") {
          queueMicrotask(() => controller.abort(new Error("用户已终止当前任务。")));
        }
      },
    });

    await assert.rejects(pending, /用户已终止当前任务/);
    assert.deepEqual(cancelledTasks, [resourceName]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails after a completed native download remains locally incomplete for 15 polls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-stalled-complete-"));
  const resourceName = "本地缺集测试剧";
  const downloadDir = path.join(root, "download");

  try {
    await mkdir(downloadDir, { recursive: true });
    await writeFile(path.join(downloadDir, `${resourceName}-第1集.mp4`), "episode-1");

    await assert.rejects(
      ensureBaiduNetdiskEpisodeVideos({
        shareText: "https://pan.baidu.com/s/test?pwd=test",
        resourceName,
        localEpisodeVideoRoot: root,
        episodeCount: 2,
        requiredPosterImages: 0,
        timeoutMs: 2_000,
        pollIntervalMs: 1,
        stableCompletePolls: 1,
        downloadShare: async () => ({
          share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
          localPath: downloadDir,
          completed: false,
          skippedExisting: false,
        }),
        getDownloadTaskStatus: async () => ({
          found: true,
          name: resourceName,
          localPath: downloadDir,
          status: "下载完成",
          completed: true,
          tasks: [resourceName],
        }),
      }),
      /连续15次检查无变化：期望2集，实际识别1集，缺少第2集/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails quickly when a submitted native download task disappears", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-baidu-missing-native-task-"));
  const resourceName = "传输列表消失测试剧";
  let statusChecks = 0;

  try {
    await assert.rejects(
      ensureBaiduNetdiskEpisodeVideos({
        shareText: "https://pan.baidu.com/s/test?pwd=test",
        resourceName,
        localEpisodeVideoRoot: root,
        episodeCount: 2,
        requiredPosterImages: 0,
        timeoutMs: 2_000,
        pollIntervalMs: 1,
        stableCompletePolls: 1,
        downloadShare: async () => ({
          share: { link: "https://pan.baidu.com/s/test", pwd: "test", name: resourceName },
          localPath: path.join(root, "download"),
          completed: false,
          skippedExisting: false,
        }),
        getDownloadTaskStatus: async () => {
          statusChecks += 1;
          return {
            found: false,
            name: resourceName,
            completed: false,
            tasks: [],
          };
        },
      }),
      /\[download-task-missing\].*连续3次检查均不存在.*本地识别0\/2集/,
    );
    assert.equal(statusChecks, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
