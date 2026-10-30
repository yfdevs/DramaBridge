import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { normalizeBaiduMd5 } from "../domain/file-checksum.js";

export async function selectIncompleteEpisodeDownloads<T extends { name: string; size?: number; contentHash?: string }>(
  episodes: T[], directory: string, signal?: AbortSignal,
): Promise<T[]> {
  const pending: T[] = [];
  for (const episode of episodes) {
    signal?.throwIfAborted();
    if (path.basename(episode.name) !== episode.name || /[\\/]/.test(episode.name)) throw new Error("剧集文件名包含无效路径");
    const file = path.join(directory, episode.name);
    const info = await lstat(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    });
    let complete = info?.isFile() && Boolean(episode.size) && info.size === episode.size;
    if (complete && episode.contentHash) {
      const hash = createHash("md5");
      for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
      complete = hash.digest("hex") === normalizeBaiduMd5(episode.contentHash);
    }
    if (!complete) pending.push(episode);
  }
  return pending;
}
