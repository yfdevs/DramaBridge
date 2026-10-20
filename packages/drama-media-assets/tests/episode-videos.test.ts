import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collapseIdenticalLocalEpisodeAliases,
  cleanupEpisodeUploadFiles,
  findEpisodeMinimumDurationViolations,
  matchLocalEpisodeIndex,
  findLocalEpisodeVideos,
  isCompleteEpisodeFileSet,
  listDirectLocalEpisodeFiles,
  prepareEpisodeUploadFiles,
} from "../src/index.js";

test("prefers a leading episode ordinal over trailing segment numbers", () => {
  assert.equal(matchLocalEpisodeIndex("1·三分钱的取舍.mp4", "三分钱的取舍"), 1);
  assert.equal(matchLocalEpisodeIndex("14·桃-2-1.mp4", "三分钱的取舍"), 14);
  assert.equal(matchLocalEpisodeIndex("58·桃-3-22.mp4", "三分钱的取舍"), 58);
});

test("treats episode durations at or below the configured minimum as invalid", () => {
  const episodes = [
    { index: 1, file: "1.mp4", durationSeconds: 179.99 },
    { index: 2, file: "2.mp4", durationSeconds: 180 },
    { index: 3, file: "3.mp4", durationSeconds: 180.01 },
  ];

  assert.deepEqual(
    findEpisodeMinimumDurationViolations(episodes, 180).map((episode) => episode.index),
    [1, 2],
  );
});

test("finds MP4 and MOV episodes and preserves their suffixes for upload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-episode-videos-"));
  const resourceName = "MOV识别测试剧";
  const episodeDir = path.join(root, resourceName, "成片");
  const uploadRootDir = path.join(root, "uploads");

  try {
    await mkdir(episodeDir, { recursive: true });
    await writeFile(path.join(episodeDir, `${resourceName}-第1集.mp4`), "episode-1");
    await writeFile(path.join(episodeDir, `${resourceName}-第2集.MOV`), "episode-2");
    await writeFile(path.join(episodeDir, `${resourceName}-第3集.avi`), "unsupported");

    const episodes = await findLocalEpisodeVideos({ localEpisodeVideoRoot: root, resourceName });
    assert.deepEqual(episodes.map((episode) => episode.index), [1, 2]);
    assert.deepEqual(episodes.map((episode) => path.extname(episode.file).toLowerCase()), [".mp4", ".mov"]);

    const prepared = await prepareEpisodeUploadFiles({
      localEpisodeVideoRoot: root,
      resourceName,
      uploadRootDir,
      uploadBaseName: "上传剧名",
      episodes,
    });
    try {
      assert.deepEqual(prepared.files.map((file) => path.basename(file)), [
        "上传剧名-第1集.mp4",
        "上传剧名-第2集.mov",
      ]);
      assert.deepEqual(prepared.sourceFiles, episodes.map((episode) => episode.file));
    } finally {
      await cleanupEpisodeUploadFiles(prepared);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collapses renamed local episode copies only when their exact sizes match", () => {
  const resolved = collapseIdenticalLocalEpisodeAliases([
    {
      index: 1,
      file: "C:\\video\\瘸腿-分集-1.mp4",
      size: 162_214_707,
      modifiedAtMs: 1,
    },
    {
      index: 1,
      file: "C:\\video\\全村笑我娶瘸腿姑娘-第1集.mp4",
      size: 162_214_707,
      modifiedAtMs: 2,
    },
    {
      index: 2,
      file: "C:\\video\\瘸腿-分集-2.mp4",
      size: 155_608_678,
      modifiedAtMs: 3,
    },
    {
      index: 2,
      file: "C:\\video\\全村笑我娶瘸腿姑娘-第2集.mp4",
      size: 155_608_678,
      modifiedAtMs: 4,
    },
  ]);

  assert.deepEqual(resolved.files.map((file) => file.index), [1, 2]);
  assert.ok(resolved.files.every((file) => path.basename(file.file).includes("第")));
  assert.equal(resolved.ignored.length, 2);
  assert.equal(isCompleteEpisodeFileSet(resolved.files, 2), true);

  const conflicting = collapseIdenticalLocalEpisodeAliases([
    { index: 1, file: "C:\\video\\版本A-1.mp4", size: 100, modifiedAtMs: 1 },
    { index: 1, file: "C:\\video\\版本B-1.mp4", size: 101, modifiedAtMs: 2 },
  ]);
  assert.equal(conflicting.files.length, 2);
  assert.equal(conflicting.ignored.length, 0);
  assert.equal(isCompleteEpisodeFileSet(conflicting.files, 1), false);
});

test("local scanning verifies equal-size aliases by sampled content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-episode-aliases-"));
  const resourceName = "重复视频测试剧";
  const episodeDir = path.join(root, resourceName);

  try {
    await mkdir(episodeDir, { recursive: true });
    await writeFile(path.join(episodeDir, `${resourceName}-第1集.mp4`), "same-content");
    await writeFile(path.join(episodeDir, "另一套名称-1.mp4"), "same-content");
    await writeFile(path.join(episodeDir, `${resourceName}-第2集.mp4`), "version-two-A");
    await writeFile(path.join(episodeDir, "另一套名称-2.mp4"), "version-two-B");

    const episodes = await findLocalEpisodeVideos({ localEpisodeVideoRoot: root, resourceName });
    assert.deepEqual(episodes.map((episode) => episode.index), [1, 2, 2]);

    const selected = await listDirectLocalEpisodeFiles(episodeDir, resourceName, [
      { index: 1, name: `${resourceName}-第1集.mp4`, size: 12 },
      { index: 2, name: "另一套名称-2.mp4", size: 13 },
    ]);
    assert.deepEqual(selected.map((file) => path.basename(file.file)), [
      `${resourceName}-第1集.mp4`,
      "另一套名称-2.mp4",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses AI-selected episode indexes for filenames that local patterns cannot parse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drama-selected-episode-indexes-"));
  const fileName = "最终交付版本甲.mp4";

  try {
    await writeFile(path.join(root, fileName), "selected-episode");

    const selected = await listDirectLocalEpisodeFiles(root, "识别测试剧", [
      { index: 88, name: fileName, size: 16 },
    ]);

    assert.deepEqual(selected.map((file) => file.index), [88]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
