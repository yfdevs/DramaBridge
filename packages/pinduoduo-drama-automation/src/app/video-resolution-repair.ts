import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ensureVideoMinimumDimensions, readVideoStreamMetadata } from "@dramabridge/media-assets";

/** Keep derivatives outside the episode list, preserving the original card filename. */
export async function preparePinduoduoResolutionRepair(
  file: string,
  signal?: AbortSignal,
  onLog?: (message: string) => void,
): Promise<string> {
  signal?.throwIfAborted();
  const identity = await stat(file);
  const source = await readVideoStreamMetadata(file, signal);
  const speed = source.durationSeconds < 30 ? 0.85 : 1;
  onLog?.(`[pinduoduo-video-check] ${basename(file)}：${source.width}x${source.height}，平均视频码率${source.videoBitrateKbps}kbps，时长${source.durationSeconds.toFixed(2)}秒，处理速度${speed}倍`);
  const key = createHash("sha256")
    .update(JSON.stringify([file, identity.size, identity.mtimeMs, "1080p-6000kbps-30s-speed085-v2"]))
    .digest("hex");
  const outputFile = join(dirname(file), ".pinduoduo-1080p", key, basename(file));
  const cached = await stat(outputFile).catch(() => undefined);
  if (cached?.isFile() && cached.size > 0) {
    const metadata = await readVideoStreamMetadata(outputFile, signal).catch(() => undefined);
    if (metadata && Math.min(metadata.width, metadata.height) >= 1080
      && metadata.videoBitrateKbps >= 6000 && metadata.durationSeconds >= 30) return outputFile;
  }
  const result = await ensureVideoMinimumDimensions({
    inputFile: file, outputFile, minimumWidth: 1080, minimumHeight: 1080,
    minimumVideoBitrateKbps: 6000, minimumDurationSeconds: 30, playbackSpeed: speed, signal, onLog,
  });
  if (!result.transcoded) {
    throw new Error(`${basename(file)}：本地分辨率、平均码率和时长均已达标，平台仍拒绝，需人工检查视频`);
  }
  return result.file;
}
