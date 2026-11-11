import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { youtubeMediaDirectories } from "../../electron/platforms/youtube-drama/media-tools";

test("YouTube uses a complete installed toolchain instead of mixing probes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "youtube-media-tools-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    const installed = path.join(root, "installed"),
      bundle = path.join(root, "bundle");
    await mkdir(installed);
    await mkdir(bundle);
    const encoder = path.join(bundle, `ffmpeg${suffix}`),
      probe = path.join(bundle, `ffprobe${suffix}`);
    await writeFile(encoder, "");
    await writeFile(probe, "");
    await writeFile(path.join(installed, `ffmpeg${suffix}`), "");
    assert.deepEqual(youtubeMediaDirectories(encoder, probe, installed), [bundle]);
    await writeFile(path.join(installed, `ffprobe${suffix}`), "");
    assert.deepEqual(youtubeMediaDirectories(encoder, probe, installed), [installed]);
    assert.deepEqual(youtubeMediaDirectories(path.join(root, "missing"), probe, ""), [bundle]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
