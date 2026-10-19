import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  areBaiduNetdiskFilesStrictlyIdentical,
  baiduShareFailureText,
  classifyBaiduNetdiskOwnershipProofName,
  collapseIdenticalRemoteEpisodeAliases,
  compareRemoteVideoDirectoryCandidates,
  baiduVideoSubtitleDirectoryPreference,
  inspectContiguousEpisodeIndexes,
  isBaiduAssetRootCovered,
  isAutomationTemporaryTransferPath,
  isBaiduNetdiskIncompleteProgressDirectoryName,
  isBaiduNetdiskOwnershipProofDirectoryName,
  isBaiduNetdiskScreenshotCandidateDirectory,
  isGenericBaiduNetdiskMaterialDirectoryName,
  isSupportedEpisodeVideoFileName,
  matchBaiduLeadingEpisodeIndex,
  planBaiduNetdiskSyncItem,
  resolveBaiduAssetDownloadRoot,
  isSameBaiduCdpTarget,
  selectTrackedBaiduShareTarget,
  selectLeadingEpisodeFiles,
  shouldDownloadMixedPosterAsFile,
  shouldDownloadBaiduOwnershipDirectories,
  validateRemoteEpisodePathSelection,
  type RemoteVideoDirectoryCandidateScore,
} from "../../src/workflows/download-baidu-folder.js";
import type { CdpTarget } from "../../src/domain/types.js";

const cdpTarget = (id: string, url: string): CdpTarget => ({
  id,
  type: "webview",
  title: "百度网盘",
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9337/devtools/page/${id}`,
});

test("keeps tracking the same Baidu target after extraction removes the share id", () => {
  const before = cdpTarget("share-1", "https://pan.baidu.com/s/1abc");
  const after = cdpTarget("share-1", "https://pan.baidu.com/disk/main#/index?category=all");

  assert.equal(isSameBaiduCdpTarget(before, after), true);
  assert.equal(selectTrackedBaiduShareTarget([after], [before]), after);
});

test("adopts a unique replacement Baidu target but rejects an ambiguous replacement", () => {
  const before = cdpTarget("share-1", "https://pan.baidu.com/s/1abc");
  const replacement = cdpTarget("share-2", "https://pan.baidu.com/disk/main#/index?category=all");
  const another = cdpTarget("share-3", "https://pan.baidu.com/disk/main#/index?category=video");

  assert.equal(selectTrackedBaiduShareTarget([replacement], [before]), replacement);
  assert.equal(selectTrackedBaiduShareTarget([replacement, another], [before]), undefined);
});

test("limits episode downloads without changing the default full selection", () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    name: `第${index + 1}集.mp4`,
  }));
  assert.equal(selectLeadingEpisodeFiles(files), files);
  assert.deepEqual(
    selectLeadingEpisodeFiles(files, 4).map((file) => file.index),
    [1, 2, 3, 4],
  );
  assert.throws(() => selectLeadingEpisodeFiles(files, 0), /正整数/);
});

test("isolates generic asset directories under each drama download root", () => {
  const first = resolveBaiduAssetDownloadRoot("D:\\短剧素材", "剧目甲");
  const second = resolveBaiduAssetDownloadRoot("D:\\短剧素材", "剧目乙");
  assert.equal(first, "D:\\短剧素材\\剧目甲");
  assert.equal(second, "D:\\短剧素材\\剧目乙");
  assert.notEqual(first, second);
});

test("downloads a poster as an individual file when it shares the video root in asset-only mode", () => {
  assert.equal(shouldDownloadMixedPosterAsFile({
    videoRootFullyDownloaded: false,
    posterRoot: "/剧目甲/正片",
    videoRoot: "/剧目甲/正片/",
    remoteVideoCount: 24,
  }), true);
  assert.equal(shouldDownloadMixedPosterAsFile({
    videoRootFullyDownloaded: true,
    posterRoot: "/剧目甲/正片",
    videoRoot: "/剧目甲/正片",
    remoteVideoCount: 24,
  }), false);
  assert.equal(shouldDownloadMixedPosterAsFile({
    videoRootFullyDownloaded: false,
    posterRoot: "/剧目甲/海报",
    videoRoot: "/剧目甲/正片",
    remoteVideoCount: 24,
  }), false);
});

test("treats nested asset roots as covered without matching sibling names", () => {
  const submitted = new Set(["/剧目甲/权属文件"]);
  assert.equal(isBaiduAssetRootCovered(submitted, "/剧目甲/权属文件"), true);
  assert.equal(isBaiduAssetRootCovered(submitted, "/剧目甲/权属文件/截图"), true);
  assert.equal(isBaiduAssetRootCovered(submitted, "/剧目甲/权属文件2"), false);
  assert.equal(isBaiduAssetRootCovered(submitted, "/剧目乙/权属文件"), false);
});

test("downloads ownership directories only when the platform requires them", () => {
  assert.equal(shouldDownloadBaiduOwnershipDirectories({
    downloadAssetMaterials: true,
    requiredOwnershipImages: 0,
    requiredOwnershipFiles: 0,
    requireAllDiscoveredAssets: false,
  }), false);
  assert.equal(shouldDownloadBaiduOwnershipDirectories({
    downloadAssetMaterials: true,
    requiredOwnershipImages: 8,
    requiredOwnershipFiles: 0,
    requireAllDiscoveredAssets: false,
  }), true);
  assert.equal(shouldDownloadBaiduOwnershipDirectories({
    downloadAssetMaterials: true,
    requiredOwnershipImages: 0,
    requiredOwnershipFiles: 1,
    requireAllDiscoveredAssets: false,
  }), true);
  assert.equal(shouldDownloadBaiduOwnershipDirectories({
    downloadAssetMaterials: true,
    requiredOwnershipImages: 0,
    requiredOwnershipFiles: 0,
    requireAllDiscoveredAssets: true,
  }), true);
  assert.equal(shouldDownloadBaiduOwnershipDirectories({
    downloadAssetMaterials: false,
    requiredOwnershipImages: 8,
    requiredOwnershipFiles: 8,
    requireAllDiscoveredAssets: true,
  }), false);
});

test("falls back to recursive sync when a missing directory was already saved elsewhere", () => {
  assert.equal(
    planBaiduNetdiskSyncItem({ isdir: 1 }),
    "transfer-directory-with-recursive-fallback",
  );
  assert.equal(
    planBaiduNetdiskSyncItem({ isdir: 1 }, { isdir: 1 }),
    "recurse-existing-directory",
  );
  assert.equal(planBaiduNetdiskSyncItem({ isdir: 0 }), "transfer-file");
  assert.equal(planBaiduNetdiskSyncItem({ isdir: 1 }, { isdir: 0 }), "conflict");
});

test("only reuses files from another Netdisk directory with strong identity evidence", () => {
  assert.equal(
    areBaiduNetdiskFilesStrictlyIdentical(
      { isdir: 0, fs_id: 123, size: 10 },
      { isdir: 0, fs_id: 123, size: 10 },
    ),
    true,
  );
  assert.equal(
    areBaiduNetdiskFilesStrictlyIdentical(
      { isdir: 0, md5: "ABC", size: 10 },
      { isdir: 0, server_md5: "abc", size: 10 },
    ),
    true,
  );
  assert.equal(
    areBaiduNetdiskFilesStrictlyIdentical(
      { isdir: 0, size: 10 },
      { isdir: 0, size: 10 },
    ),
    false,
  );
  assert.equal(
    areBaiduNetdiskFilesStrictlyIdentical(
      { isdir: 1, fs_id: 123 },
      { isdir: 1, fs_id: 123 },
    ),
    false,
  );
});

test("recognizes deleted and expired Baidu share pages before waiting for a file list", () => {
  assert.equal(
    baiduShareFailureText("啊哦，你来晚了，分享的文件已经被删除了，下次要早点哟。"),
    "分享的文件已经被删除",
  );
  assert.equal(
    baiduShareFailureText("啊哦，来晚了，该分享文件已过期"),
    "分享文件已过期",
  );
  assert.equal(baiduShareFailureText("全部文件 正在加载"), "");
});

test("recognizes labeled ownership screenshots from Baidu filenames", () => {
  assert.equal(classifyBaiduNetdiskOwnershipProofName("权属/剪映.png"), "jianying");
  assert.equal(classifyBaiduNetdiskOwnershipProofName("权属/剪映 1.PNG"), "jianying");
  assert.equal(classifyBaiduNetdiskOwnershipProofName("权属/剧创2.png"), "juchuang");
  assert.equal(classifyBaiduNetdiskOwnershipProofName("权属/剪映和剧创/工程1.png"), undefined);
  assert.equal(classifyBaiduNetdiskOwnershipProofName("权属/权属工程文件1.png"), undefined);
});

test("discovers proof screenshots in separately named creation-record directories", () => {
  for (const name of ["工程文件", "剪映", "剧创", "AI生成记录", "AI 创作过程"]) {
    assert.equal(isBaiduNetdiskOwnershipProofDirectoryName(name), true, name);
  }
  assert.equal(isBaiduNetdiskOwnershipProofDirectoryName("封面"), false);
});

test("discovers screenshot directories by structure even when names are arbitrary", () => {
  const images = [
    { name: "a.png", isDirectory: false },
    { name: "b.JPG", isDirectory: false },
  ];
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory(images, 1), true);
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory(images, 2, "/海报封面/原始图片"), false);
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory(images, 2, "/海报封面/AI角色头像"), false);
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory(images, 1, "/剪映工程图"), true);
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory(images, 0), false);
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory([
    ...images, { name: "第1集.mp4", isDirectory: false },
  ], 1), false);
  assert.equal(isBaiduNetdiskScreenshotCandidateDirectory([
    ...images, { name: "子目录", isDirectory: true },
  ], 1), false);
});

test("browser-injected Baidu helpers run after serialization without module scope", () => {
  const isolate = <T>(helper: T): T => runInNewContext(`(${String(helper)})`) as T;
  const images = [
    { name: "a.png", isDirectory: false },
    { name: "b.jpg", isDirectory: false },
  ];

  assert.equal(isolate(isSupportedEpisodeVideoFileName)("第1集.mp4"), true);
  assert.equal(isolate(isBaiduNetdiskIncompleteProgressDirectoryName)("剧名-60%"), true);
  assert.equal(isolate(isGenericBaiduNetdiskMaterialDirectoryName)("1.成片"), true);
  assert.equal(
    isolate(planBaiduNetdiskSyncItem)({ isdir: 1 }),
    "transfer-directory-with-recursive-fallback",
  );
  assert.equal(
    isolate(areBaiduNetdiskFilesStrictlyIdentical)(
      { isdir: 0, md5: "same", size: 10 },
      { isdir: 0, md5: "same", size: 10 },
    ),
    true,
  );
  assert.equal(isolate(classifyBaiduNetdiskOwnershipProofName)("剪映.png"), "jianying");
  assert.equal(isolate(isBaiduNetdiskOwnershipProofDirectoryName)("工程文件"), true);
  assert.equal(isolate(baiduVideoSubtitleDirectoryPreference)("/剧名/有字幕"), 1);
  const isolatedDetector = isolate(isBaiduNetdiskScreenshotCandidateDirectory);
  assert.equal(isolatedDetector(images, 1), true);
  assert.equal(isolatedDetector([...images, { name: "第1集.mp4", isDirectory: false }], 1), false);
  const score = videoDirectoryCandidate({});
  assert.equal(isolate(compareRemoteVideoDirectoryCandidates)(score, score), 0);
  assert.equal(
    isolate(collapseIdenticalRemoteEpisodeAliases)([
      { index: 1, name: "剧名-第1集.mp4", path: "/剧名-第1集.mp4", size: 100 },
      { index: 1, name: "分集-1.mp4", path: "/分集-1.mp4", size: 100 },
    ]).files.length,
    1,
  );
});

test("collapses renamed remote episode copies only when their exact sizes match", () => {
  const matching = collapseIdenticalRemoteEpisodeAliases([
    { index: 1, name: "瘸腿-分集-1.mp4", path: "/瘸腿-分集-1.mp4", size: 162_214_707 },
    { index: 1, name: "全村笑我娶瘸腿姑娘-第1集.mp4", path: "/全村笑我娶瘸腿姑娘-第1集.mp4", size: 162_214_707 },
    { index: 2, name: "瘸腿-分集-2.mp4", path: "/瘸腿-分集-2.mp4", size: 155_608_678 },
    { index: 2, name: "全村笑我娶瘸腿姑娘-第2集.mp4", path: "/全村笑我娶瘸腿姑娘-第2集.mp4", size: 155_608_678 },
  ]);

  assert.deepEqual(matching.files.map((file) => file.index), [1, 2]);
  assert.ok(matching.files.every((file) => file.name.includes("第")));
  assert.equal(matching.ignored.length, 2);

  const conflicting = collapseIdenticalRemoteEpisodeAliases([
    { index: 1, name: "版本A-1.mp4", path: "/版本A-1.mp4", size: 100 },
    { index: 1, name: "版本B-1.mp4", path: "/版本B-1.mp4", size: 101 },
  ]);
  assert.equal(conflicting.files.length, 2);
  assert.equal(conflicting.ignored.length, 0);

  const differentHashes = collapseIdenticalRemoteEpisodeAliases([
    { index: 1, name: "版本A-1.mp4", path: "/版本A-1.mp4", size: 100, contentHash: "aaa" },
    { index: 1, name: "版本B-1.mp4", path: "/版本B-1.mp4", size: 100, contentHash: "bbb" },
  ]);
  assert.equal(differentHashes.files.length, 2);
});

test("reduces two renamed 1-60 sets to one complete 60-episode set", () => {
  const candidates = Array.from({ length: 60 }, (_, position) => position + 1).flatMap((index) => [
    {
      index,
      name: `瘸腿-分集-${index}.mp4`,
      path: `/瘸腿-分集-${index}.mp4`,
      size: 100_000_000 + index,
    },
    {
      index,
      name: `全村笑我娶瘸腿姑娘-第${index}集.mp4`,
      path: `/全村笑我娶瘸腿姑娘-第${index}集.mp4`,
      size: 100_000_000 + index,
    },
  ]);
  const resolved = collapseIdenticalRemoteEpisodeAliases(candidates);
  assert.equal(resolved.files.length, 60);
  assert.deepEqual(resolved.files.map((file) => file.index), Array.from({ length: 60 }, (_, index) => index + 1));
  assert.equal(resolved.ignored.length, 60);
});

test("accepts only one complete continuous AI-selected episode set", () => {
  const candidates = [
    { index: 1, name: "A-1.mp4", path: "/A-1.mp4", size: 100 },
    { index: 1, name: "B-1.mp4", path: "/B-1.mp4", size: 101 },
    { index: 2, name: "A-2.mp4", path: "/A-2.mp4", size: 200 },
    { index: 2, name: "B-2.mp4", path: "/B-2.mp4", size: 201 },
  ];
  assert.deepEqual(
    validateRemoteEpisodePathSelection(candidates, [
      { path: "/B-1.mp4", index: 1 },
      { path: "/B-2.mp4", index: 2 },
    ], 2)
      ?.map((file) => file.path),
    ["/B-1.mp4", "/B-2.mp4"],
  );
  assert.equal(
    validateRemoteEpisodePathSelection(candidates, [
      { path: "/A-1.mp4", index: 1 },
      { path: "/B-1.mp4", index: 1 },
    ], 2),
    undefined,
  );
  assert.equal(
    validateRemoteEpisodePathSelection(candidates, [{ path: "/A-1.mp4", index: 1 }], 2),
    undefined,
  );
});

test("uses a leading ordinal as the episode for segmented source names", () => {
  assert.equal(matchBaiduLeadingEpisodeIndex("1·三分钱的取舍.mp4"), 1);
  assert.equal(matchBaiduLeadingEpisodeIndex("14·桃-2-1.mp4"), 14);
  assert.equal(matchBaiduLeadingEpisodeIndex("58·桃-3-22.mp4"), 58);
  assert.equal(matchBaiduLeadingEpisodeIndex("桃-3-22.mp4"), undefined);
});

test("recognizes the complete 58-episode naming scheme from the reported Baidu share", () => {
  const names = Array.from({ length: 58 }, (_, offset) => {
    const episode = offset + 1;
    if (episode <= 10) return `${episode}·三分钱的取舍.mp4`;
    if (episode <= 13) return `${episode}·桃-1-${episode}.mp4`;
    if (episode <= 36) return `${episode}·桃-2-${episode - 13}.mp4`;
    return `${episode}·桃-3-${episode - 36}.mp4`;
  });

  assert.deepEqual(
    names.map(matchBaiduLeadingEpisodeIndex),
    Array.from({ length: 58 }, (_, offset) => offset + 1),
  );
});

test("only accepts root-level timestamped automation transfer directories", () => {
  const createdAt = Date.parse("2026-09-05T06:31:54.375Z");
  assert.equal(
    isAutomationTemporaryTransferPath("/九千罚单__ewfjCNKLmw__mto096h3", createdAt),
    true,
  );
  assert.equal(isAutomationTemporaryTransferPath("/九千罚单", createdAt), false);
  assert.equal(
    isAutomationTemporaryTransferPath("/用户目录/九千罚单__ewfjCNKLmw__mto096h3", createdAt),
    false,
  );
  assert.equal(
    isAutomationTemporaryTransferPath("/九千罚单__ewfjCNKLmw__not-time", createdAt),
    false,
  );
});

test("recognizes MP4 and MOV episode video suffixes case-insensitively", () => {
  assert.equal(isSupportedEpisodeVideoFileName("第1集.mp4"), true);
  assert.equal(isSupportedEpisodeVideoFileName("第2集.MOV"), true);
  assert.equal(isSupportedEpisodeVideoFileName("第3集.avi"), false);
});

test("excludes directories containing an incomplete percentage from remote resource scans", () => {
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("劫骨燃尽渡苍生-60%"), true);
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("劫骨燃尽渡苍生（60％）"), true);
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("剧名_99.5%"), true);
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("成片"), false);
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("100%完成"), false);
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("剧名-100%"), false);
  assert.equal(isBaiduNetdiskIncompleteProgressDirectoryName("剧名-60%修复版"), true);
});

test("recognizes numbered generic material directories instead of treating them as drama names", () => {
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("成片"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("1.成片"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("01-正片"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("2_ 视频"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("(3)权属文件"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("AI生成记录"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("2.剧创"), true);
  assert.equal(isGenericBaiduNetdiskMaterialDirectoryName("来福的呼唤"), false);
});

function videoDirectoryCandidate(
  overrides: Partial<RemoteVideoDirectoryCandidateScore>,
): RemoteVideoDirectoryCandidateScore {
  return {
    validEpisodeSequence: true,
    materialDirectory: false,
    subtitlePreference: 0,
    preferredEpisodeDirectory: false,
    uniqueEpisodeCount: 8,
    recognizedVideoCount: 8,
    mp4Count: 8,
    depth: 1,
    path: "/剧名",
    ...overrides,
  };
}

test("infers the highest continuous episode as total count", () => {
  assert.deepEqual(inspectContiguousEpisodeIndexes([3, 1, 2]), {
    episodeCount: 3,
    indexes: [1, 2, 3],
    missingIndexes: [],
    duplicateIndexes: [],
    valid: true,
  });
});

test("rejects a missing middle episode", () => {
  const result = inspectContiguousEpisodeIndexes([1, 2, 4]);
  assert.equal(result.episodeCount, 4);
  assert.deepEqual(result.missingIndexes, [3]);
  assert.equal(result.valid, false);
});

test("requires the sequence to start at episode one", () => {
  const result = inspectContiguousEpisodeIndexes([2, 3, 4]);
  assert.deepEqual(result.missingIndexes, [1]);
  assert.equal(result.valid, false);
});

test("rejects duplicate episode indexes", () => {
  const result = inspectContiguousEpisodeIndexes([1, 2, 3], [2]);
  assert.deepEqual(result.duplicateIndexes, [2]);
  assert.equal(result.valid, false);
});

test("rejects a listing without recognizable episode indexes", () => {
  const result = inspectContiguousEpisodeIndexes([]);
  assert.equal(result.episodeCount, 0);
  assert.equal(result.valid, false);
});

test("prefers a valid episode directory over a material directory with more mp4 clips", () => {
  const candidates = [
    videoDirectoryCandidate({
      validEpisodeSequence: false,
      materialDirectory: true,
      uniqueEpisodeCount: 8,
      recognizedVideoCount: 347,
      mp4Count: 347,
      path: "/九千罚单/素材",
    }),
    videoDirectoryCandidate({
      preferredEpisodeDirectory: true,
      path: "/九千罚单/成片",
    }),
  ];

  candidates.sort(compareRemoteVideoDirectoryCandidates);
  assert.equal(candidates[0]?.path, "/九千罚单/成片");
});

test("prefers a clean neutral episode directory over a numbered material directory", () => {
  const candidates = [
    videoDirectoryCandidate({
      materialDirectory: true,
      uniqueEpisodeCount: 80,
      recognizedVideoCount: 80,
      mp4Count: 80,
      path: "/九千罚单/素材",
    }),
    videoDirectoryCandidate({ path: "/九千罚单" }),
  ];

  candidates.sort(compareRemoteVideoDirectoryCandidates);
  assert.equal(candidates[0]?.path, "/九千罚单");
});

test("prefers an explicitly subtitled video directory over unsubtitled and neutral versions", () => {
  assert.equal(baiduVideoSubtitleDirectoryPreference("/四达这一炉羊，我不敢卖便宜/有字幕"), 1);
  assert.equal(baiduVideoSubtitleDirectoryPreference("/四达这一炉羊，我不敢卖便宜/无字幕"), -1);
  assert.equal(baiduVideoSubtitleDirectoryPreference("/四达这一炉羊，我不敢卖便宜/字幕"), 0);

  const candidates = [
    videoDirectoryCandidate({
      subtitlePreference: -1,
      uniqueEpisodeCount: 60,
      recognizedVideoCount: 60,
      mp4Count: 60,
      path: "/四达这一炉羊，我不敢卖便宜/无字幕",
    }),
    videoDirectoryCandidate({
      subtitlePreference: 1,
      uniqueEpisodeCount: 58,
      recognizedVideoCount: 58,
      mp4Count: 58,
      path: "/四达这一炉羊，我不敢卖便宜/有字幕",
    }),
    videoDirectoryCandidate({ path: "/四达这一炉羊，我不敢卖便宜/其他版本" }),
  ];

  candidates.sort(compareRemoteVideoDirectoryCandidates);
  assert.equal(candidates[0]?.path, "/四达这一炉羊，我不敢卖便宜/有字幕");
});

test("prefers the directory with the most episodes over a one-episode valid sequence", () => {
  const candidates = [
    videoDirectoryCandidate({
      validEpisodeSequence: true,
      uniqueEpisodeCount: 1,
      recognizedVideoCount: 1,
      mp4Count: 1,
      path: "/山风吹醒少年心/第1集30秒",
    }),
    videoDirectoryCandidate({
      validEpisodeSequence: false,
      uniqueEpisodeCount: 41,
      recognizedVideoCount: 41,
      mp4Count: 41,
      path: "/山风吹醒少年心/胖子有字",
    }),
  ];

  candidates.sort(compareRemoteVideoDirectoryCandidates);
  assert.equal(candidates[0]?.path, "/山风吹醒少年心/胖子有字");
});
