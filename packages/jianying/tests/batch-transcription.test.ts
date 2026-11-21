import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTranscriptionEpisode, scanTranscriptionEpisodes, selectTranscriptionEpisodes, transcribeEpisodes, type TranscriptionEpisode } from "../src/batch-transcription.js";
import type { transcribeVideo } from "../src/transcription.js";

test("episode names support Arabic and Chinese numbers without treating resolution as a number", () => {
  for (const [name, expected] of [["第002集 高清.mp4", 2], ["EP10.MKV", 10], ["Episode-03.mov", 3], ["01_片名.mp4", 1], ["第十二集.mp4", 12], ["第一百零二集.mp4", 102], ["影片1080p.mp4", undefined], ["预告片.mp4", undefined]] as const) {
    assert.equal(detectTranscriptionEpisode(name), expected, name);
  }
});

test("scan finds all direct video files, preserves duplicate numbers for correction and allocates unknowns", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jianying-batch-scan-"));
  try {
    for (const name of ["第02集.mp4", "EP2.mkv", "第十集.mov", "未命名.WEBM", "简介.txt"]) await writeFile(path.join(directory, name), "test");
    await mkdir(path.join(directory, "第03集.mp4"));
    const items = await scanTranscriptionEpisodes(directory);
    assert.equal(items.length, 4);
    assert.deepEqual(items.map(item => item.episode), [1, 2, 2, 10]);
    assert.equal(items[0].detected, false);
    assert.ok(items.every(item => item.selected && item.status === "waiting"));
    assert.equal(new Set(items.map(item => item.id)).size, 4);
    await assert.rejects(scanTranscriptionEpisodes(path.join(directory, "第03集.mp4")), /没有视频/);
    const selections = items.map((item, index) => ({ id: item.id, selected: true, episode: index + 1 }));
    assert.deepEqual(selectTranscriptionEpisodes(items, selections).map(item => item.episode), [1, 2, 3, 4]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function episode(number: number): TranscriptionEpisode {
  return { id: `episode-${number}`, source: path.resolve(`第${number}集.mp4`), name: `第${number}集.mp4`, episode: number, detected: true, selected: true, status: "waiting" };
}

test("selection rejects duplicate numbers, forged identities and empty selection; renderer cannot replace paths", () => {
  const items = [episode(1), episode(2)];
  assert.throws(() => selectTranscriptionEpisodes(items, items.map(item => ({ ...item, episode: 1 }))), /重复/);
  assert.throws(() => selectTranscriptionEpisodes(items, items.map(item => ({ ...item, selected: false }))), /至少选择/);
  assert.throws(() => selectTranscriptionEpisodes(items, items.map(item => ({ ...item, id: "forged" }))), /列表无效/);
  assert.throws(() => selectTranscriptionEpisodes(items, items.map(item => ({ ...item, episode: 0 }))), /整数/);
  assert.equal(selectTranscriptionEpisodes(items, items.map(item => ({ ...item, source: "forged-path" })))[0].source, items[0].source);
});

function fakeRecognizer(directory: string, run: (source: string) => void): typeof transcribeVideo {
  return async options => {
    run(options.source);
    const file = path.join(directory, path.basename(options.source));
    await writeFile(`${file}.srt`, "1\r\n00:00:00,000 --> 00:00:01,000\r\n测试字幕\r\n");
    await writeFile(`${file}.txt`, "测试字幕");
    return { output: directory, textPath: `${file}.txt`, subtitlePath: `${file}.srt`, text: "测试字幕", sentenceCount: 1 };
  };
}

test("batch skips unchecked episodes, continues after failure and writes independent numbered subtitles", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jianying-batch-run-"));
  try {
    const items = [episode(2), { ...episode(3), selected: false }, episode(5), episode(8)];
    const calls: string[] = [];
    const result = await transcribeEpisodes({ items, output: path.join(directory, "output"), runtime: { bun: "unused", cli: "unused" } }, fakeRecognizer(directory, source => {
      calls.push(path.basename(source));
      if (source === items[2].source) throw new Error("这一集没有音轨");
    }));
    assert.deepEqual(calls, ["第2集.mp4", "第5集.mp4", "第8集.mp4"]);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.items.map(item => item.status), ["success", "waiting", "failed", "success"]);
    assert.deepEqual((await readdir(result.output)).sort(), ["第02集.srt", "第02集.txt", "第08集.srt", "第08集.txt"]);
    assert.match(await readFile(path.join(result.output, "第08集.srt"), "utf8"), /测试字幕/);
    assert.equal(items[0].status, "waiting", "caller state is not mutated");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation preserves finished subtitles and never starts remaining episodes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jianying-batch-cancel-"));
  try {
    const controller = new AbortController();
    let calls = 0;
    const result = await transcribeEpisodes({
      items: [episode(1), episode(2), episode(3)], output: path.join(directory, "output"), runtime: { bun: "unused", cli: "unused" }, signal: controller.signal,
      onProgress: items => { if (items[0].status === "success") controller.abort(); },
    }, fakeRecognizer(directory, () => { calls++; }));
    assert.equal(calls, 1);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.items.map(item => item.status), ["success", "cancelled", "cancelled"]);
    assert.match(await readFile(path.join(result.output, "第01集.srt"), "utf8"), /测试字幕/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
