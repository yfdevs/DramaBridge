import { existsSync } from "node:fs";
import path from "node:path";

export function youtubeMediaDirectories(
  bundledFfmpeg: string,
  bundledFfprobe: string,
  searchPath = process.env.PATH ?? "",
) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const directories = searchPath
    .split(path.delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  // Prefer one complete installed toolchain over mixing a recent FFmpeg with
  // ffprobe-static's legacy probe. This also matches standalone DramaVox.
  const paired = directories.find(
    (directory) =>
      existsSync(path.join(directory, `ffmpeg${suffix}`)) &&
      existsSync(path.join(directory, `ffprobe${suffix}`)),
  );
  if (paired) return [paired];
  return [
    ...new Set(
      [bundledFfmpeg, bundledFfprobe]
        .filter((file) => existsSync(file))
        .map((file) => path.dirname(file)),
    ),
  ];
}
