import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readVideoStreamMetadata, resolveFfmpegExecutablePath } from "@dramabridge/media-assets";
import { preparePinduoduoResolutionRepair } from "../../src/app/video-resolution-repair.js";

test("repairs resolution, bitrate and short duration together, preserves source and reuses verified output", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pdd-specs-"));
  try {
    const source = join(root, "1.mp4");
    await promisify(execFile)(resolveFfmpegExecutablePath(), ["-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=2:d=27",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=27", "-c:v", "libx264", "-c:a", "aac", "-shortest", source], { windowsHide: true });
    const original = await stat(source);
    const output = await preparePinduoduoResolutionRepair(source);
    const metadata = await readVideoStreamMetadata(output);
    assert.ok(Math.min(metadata.width, metadata.height) >= 1080);
    assert.ok(metadata.videoBitrateKbps >= 6000, JSON.stringify(metadata));
    assert.ok(metadata.durationSeconds >= 30);
    assert.ok(Math.abs(metadata.durationSeconds - 27 / 0.85) < 1);
    assert.equal((await stat(source)).size, original.size);
    const processed = await stat(output);
    assert.equal(await preparePinduoduoResolutionRepair(source), output);
    assert.equal((await stat(output)).mtimeMs, processed.mtimeMs);
    const short = join(root, "2.mp4");
    await promisify(execFile)(resolveFfmpegExecutablePath(), ["-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=2:d=2", "-c:v", "libx264", short], { windowsHide: true });
    await assert.rejects(preparePinduoduoResolutionRepair(short), /0.85倍速后.*仍不足30秒/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
