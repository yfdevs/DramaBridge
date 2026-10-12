import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  adjustVideoPlaybackSpeed,
  ensureVideoMinimumDimensions,
  readVideoDurationSeconds,
  readVideoDimensions,
  resolveFfmpegExecutablePath,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

test("uses FFmpeg to slow video and audio to 0.9x", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "drama-video-speed-"));
  const inputFile = path.join(directory, "episode.mp4");
  const executable = resolveFfmpegExecutablePath();
  try {
    await execFileAsync(executable, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=320x240:r=25:d=3",
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=44100:duration=3",
      "-c:v", "libx264",
      "-c:a", "aac",
      "-shortest",
      inputFile,
    ], { windowsHide: true });

    const sourceDurationSeconds = await readVideoDurationSeconds(inputFile);
    const adjusted = await adjustVideoPlaybackSpeed({
      inputFile,
      speed: 0.9,
      sourceDurationSeconds,
    });

    assert.ok(adjusted.outputDurationSeconds > sourceDurationSeconds);
    assert.ok(Math.abs(adjusted.outputDurationSeconds - sourceDurationSeconds / 0.9) <= 1);
    assert.equal(
      (await readVideoDurationSeconds(inputFile)).toFixed(2),
      adjusted.outputDurationSeconds.toFixed(2),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses FFmpeg to raise both video dimensions above Taobao's minimum", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "drama-video-dimensions-"));
  const inputFile = path.join(directory, "episode.mp4");
  const outputFile = path.join(directory, "episode.taobao.mp4");
  const executable = resolveFfmpegExecutablePath();
  try {
    await execFileAsync(executable, [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=720x1280:r=10:d=0.2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      inputFile,
    ], { windowsHide: true });

    const result = await ensureVideoMinimumDimensions({
      inputFile,
      outputFile,
      minimumWidth: 1_088,
      minimumHeight: 1_088,
    });
    assert.equal(result.transcoded, true);
    assert.deepEqual(await readVideoDimensions(inputFile), { width: 720, height: 1280 });
    const output = await readVideoDimensions(outputFile);
    assert.ok(output.width >= 1_088);
    assert.ok(output.height >= 1_088);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
