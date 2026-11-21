import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertLosslessMetadata, compressVideoForPlayback, compressVideoLosslessly, decodedHashes, inspectCompressionVideo, runCompressionBatch, validateCompressionTarget } from "../src/lossless-compression.js";

const run = promisify(execFile);
const rootRequire = createRequire(new URL("../../../package.json", import.meta.url));
const tools = {
  ffmpeg: path.resolve(".cache/ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
  ffprobe: (rootRequire("ffprobe-static") as { path: string }).path,
};
const available = existsSync(tools.ffmpeg) && existsSync(tools.ffprobe);

test("target limits are strict byte budgets and invalid targets are rejected", () => {
  assert.equal(validateCompressionTarget(1024), 1024);
  for (const value of [0, -1, NaN, Infinity, 1023, 1.5, 1024 ** 4 + 1]) assert.throws(() => validateCompressionTarget(value));
});

test("pixel verification requires every mapped audio/video hash and rejects malformed receipts", () => {
  const hash = "a".repeat(64);
  assert.equal(decodedHashes(`# header\n1,a,SHA256=${hash}\n0,v,SHA256=${hash}`), `0,v,SHA256=${hash}\n1,a,SHA256=${hash}`);
  for (const output of ["", "error", `0,v,SHA256=${hash}\ntruncated`]) assert.throws(() => decodedHashes(output));
});

test("metadata validation rejects lost HDR, color depth, audio, rotation and duration", () => {
  const before = { format: { duration: "2" }, streams: [{ index: 0, codec_type: "video", width: 128, height: 96, pix_fmt: "yuv420p10le", color_transfer: "smpte2084", side_data_list: [{ side_data_type: "Mastering display metadata", max_luminance: "1000/1" }] }] };
  assert.doesNotThrow(() => assertLosslessMetadata(before, structuredClone(before)));
  for (const patch of [{ pix_fmt: "yuv420p" }, { side_data_list: [] }, { color_transfer: "bt709" }, { side_data_list: [{ rotation: 90 }] }]) {
    const after = structuredClone(before); Object.assign(after.streams[0], patch);
    assert.throws(() => assertLosslessMetadata(before, after));
  }
  assert.throws(() => assertLosslessMetadata(before, { ...before, streams: [] }));
  assert.throws(() => assertLosslessMetadata(before, { ...before, format: { duration: "1" } }));
});

async function sample(directory: string) {
  const source = path.join(directory, "中文 视频 & sample.avi");
  await run(tools.ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-n", source], { windowsHide: true });
  return source;
}

test("real compression meets a size limit only after exact decoded video/audio verification", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-lossless-real-"));
  try {
    const source = await sample(directory), original = await readFile(source);
    const info = await inspectCompressionVideo(source, tools);
    assert.equal(info.width, 128); assert.equal(info.height, 96);
    const result = await compressVideoLosslessly({ source, targetBytes: Math.floor(original.length * 0.5), outputDirectory: path.join(directory, "result"), tools, effort: "smallest" });
    assert.equal(result.verified, true);
    assert.notEqual(result.method, "原码流封装优化", "this fixture must exercise lossless re-encoding");
    assert.equal(result.targetMet, true);
    assert.ok(result.outputBytes < result.targetBytes);
    assert.ok(result.outputFile);
    assert.deepEqual(await readFile(source), original, "the original file is untouched");
    assert.deepEqual((await readdir(result.outputDirectory)).sort(), [path.basename(result.outputFile!)].sort());
    assert.ok(result.attempts?.some(attempt => attempt.outcome === "已通过完整无损校验"));
    assert.ok((await stat(result.outputFile!)).size < info.bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an impossible target never triggers lossy encoding or falsely reports target success", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-lossless-limit-"));
  try {
    const source = await sample(directory);
    const result = await compressVideoLosslessly({ source, targetBytes: 1024, outputDirectory: path.join(directory, "result"), tools, effort: "smallest" });
    assert.equal(result.targetMet, false);
    assert.ok(result.attempts?.some(attempt => attempt.method === "CPU H.265 无损编码"));
    assert.ok(result.outputBytes >= result.targetBytes);
    if (result.outputFile) assert.equal(result.verified, true);
    assert.ok(result.outputBytes <= result.inputBytes, "never publishes a larger file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("already-small files are copied byte-for-byte without re-encoding", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-lossless-copy-"));
  try {
    const source = await sample(directory), original = await readFile(source);
    const result = await compressVideoLosslessly({ source, targetBytes: original.length + 1, outputDirectory: path.join(directory, "result"), tools });
    assert.equal(result.method, "原样复制"); assert.equal(result.targetMet, true);
    assert.deepEqual(await readFile(result.outputFile!), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation removes partial candidate files and preserves the original", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-lossless-cancel-"));
  try {
    const source = await sample(directory), original = await readFile(source), controller = new AbortController();
    const outputDirectory = path.join(directory, "result");
    await assert.rejects(compressVideoLosslessly({ source, targetBytes: 1024, outputDirectory, tools, signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" });
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("playback compression creates a complete standard-profile MP4 within budget", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-playback-"));
  try {
    const source = await sample(directory), original = await readFile(source);
    const result = await compressVideoForPlayback({ source, targetBytes: 160000, outputDirectory: path.join(directory, "result"), tools });
    assert.equal(result.targetMet, true);
    assert.ok(result.outputBytes < 160000);
    assert.equal(result.verified, false, "lossy output must never claim exact losslessness");
    assert.equal(result.playbackVerified, true);
    const { stdout } = await run(tools.ffprobe, ["-v", "error", "-show_streams", "-of", "json", result.outputFile!]);
    const streams = JSON.parse(stdout).streams;
    const video = streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    assert.equal(video.codec_name, "h264"); assert.equal(video.profile, "High"); assert.equal(video.pix_fmt, "yuv420p");
    assert.ok(streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"));
    assert.deepEqual(await readFile(source), original);
    assert.deepEqual((await readdir(result.outputDirectory)).sort(), [path.basename(result.outputFile!)].sort());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("default lossless mode does not introduce special decoder profiles", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-compatible-lossless-"));
  try {
    const source = await sample(directory);
    const result = await compressVideoLosslessly({ source, targetBytes: 1024, outputDirectory: path.join(directory, "result"), tools });
    assert.equal(result.targetMet, false);
    assert.ok(!result.attempts?.some(attempt => /CPU|GPU/.test(attempt.method)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("batch processes every valid file, isolates failures, and writes only videos", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-batch-"));
  try {
    const source = await sample(directory), info = await inspectCompressionVideo(source, tools);
    const items = [
      { id: "first", file: source, name: info.name, source: info, status: "ready" as const, message: "" },
      { id: "missing", file: path.join(directory, "missing.avi"), name: info.name, source: info, status: "ready" as const, message: "" },
      { id: "last", file: source, name: info.name, source: info, status: "ready" as const, message: "" },
    ];
    const result = await runCompressionBatch({ items, tools, targetBytes: 160000, effort: "balanced", outputDirectory: path.join(directory, "output"), onUpdate: () => {} });
    assert.deepEqual(result.map(item => item.status), ["success", "failed", "success"]);
    assert.notEqual(result[0].result?.outputFile, result[2].result?.outputFile, "identical source names cannot collide");
    assert.deepEqual((await readdir(path.join(directory, "output"))).sort(), [path.basename(result[0].result!.outputFile!), path.basename(result[2].result!.outputFile!)].sort());
    assert.ok(path.basename(result[2].result!.outputFile!).includes("(3)"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("batch cancellation keeps finished videos and skips remaining inputs", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-batch-cancel-"));
  try {
    const source = await sample(directory), info = await inspectCompressionVideo(source, tools), controller = new AbortController();
    const items = ["first", "second", "third"].map(id => ({ id, file: source, name: info.name, source: info, status: "ready" as const, message: "" }));
    const result = await runCompressionBatch({ items, tools, targetBytes: info.bytes + 1, effort: "balanced", signal: controller.signal, outputDirectory: path.join(directory, "output"),
      onUpdate: updated => { if (updated[0].status === "success") controller.abort(); } });
    assert.deepEqual(result.map(item => item.status), ["success", "cancelled", "cancelled"]);
    assert.ok(result[0].result?.outputFile && existsSync(result[0].result.outputFile));
    assert.deepEqual(await readdir(path.join(directory, "output")), [path.basename(result[0].result!.outputFile!)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
