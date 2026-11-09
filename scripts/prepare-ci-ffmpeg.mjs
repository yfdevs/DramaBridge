import process from "node:process";
import console from "node:console";
import { setTimeout } from "node:timers";
import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const { fetch, AbortSignal } = globalThis;

// Keep aligned with ffmpeg-static 5.3.0. Cache keys include this script.
export const release = "b6.1.1";
export async function downloadAsset(url, destination, { gzip = false, delay = 1000 } = {}) {
  const temporary = `${destination}.download`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}: ${url}`);
      }
      const streams = [Readable.fromWeb(response.body)];
      if (gzip) streams.push(createGunzip());
      streams.push(createWriteStream(temporary));
      await pipeline(...streams);
      if (!(await stat(temporary)).size) throw new Error(`Empty download: ${url}`);
      await rename(temporary, destination);
      return;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 5) throw error;
      console.warn(`FFmpeg download attempt ${attempt}/5 failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay * 2 ** (attempt - 1)));
    }
  }
}

export async function prepareFfmpeg(root = process.cwd()) {
  const directory = path.join(root, ".cache", "ffmpeg-static");
  const binary = path.join(directory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const marker = path.join(directory, "release.json");
  const identity = JSON.stringify({ release, platform: process.platform, arch: process.arch });
  await mkdir(directory, { recursive: true });
  const reusable = await readFile(marker, "utf8")
    .then((value) => value === identity)
    .catch(() => false);
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`;
  for (const [asset, destination, gzip] of [
    [`${process.platform}-${process.arch}.README`, `${binary}.README`, false],
    [`${process.platform}-${process.arch}.LICENSE`, `${binary}.LICENSE`, false],
    [`ffmpeg-${process.platform}-${process.arch}.gz`, binary, true],
  ]) {
    const exists =
      reusable &&
      (await stat(destination)
        .then((value) => value.isFile() && value.size > 0)
        .catch(() => false));
    if (!exists) await downloadAsset(`${base}/${asset}`, destination, { gzip });
  }
  await chmod(binary, 0o755);
  const result = await promisify(execFile)(binary, ["-version"], {
    timeout: 15000,
    windowsHide: true,
  });
  if (!/^ffmpeg version\b/im.test(result.stdout))
    throw new Error("Invalid cached FFmpeg executable");
  await writeFile(marker, identity);
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `FFMPEG_BIN=${binary}\n`);
  console.log(`FFmpeg ${release} prepared with README and LICENSE: ${binary}`);
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareFfmpeg().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
