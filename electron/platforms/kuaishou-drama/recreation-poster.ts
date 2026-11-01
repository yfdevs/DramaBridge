import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DramaAiClient } from "@dramabridge/ai";
import {
  ensureRenamedPortraitPoster,
  renamedPortraitPosterRecipe,
  listLocalPosterImages,
} from "@dramabridge/media-assets";
import type { RecreationVersion } from "../../../src/platforms/kuaishou-drama/recreation-types";

export async function prepareRecreationPoster(options: {
  localDirectory: string;
  originalTitle: string;
  title: string;
  source: () => Promise<string>;
  checkpoint?: RecreationVersion["poster"];
  client: () => DramaAiClient;
  model: () => string;
  retryAttempts: () => number;
  normalize: (
    directory: string,
    title: string,
    signal?: AbortSignal,
    preferredFilename?: string,
  ) => Promise<void>;
  signal: AbortSignal;
  onLog?: (message: string) => void;
}): Promise<NonNullable<RecreationVersion["poster"]>> {
  const target = path.join(options.localDirectory, "封面", "封面.png");
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  options.signal.throwIfAborted();
  if (
    options.checkpoint?.recipe === renamedPortraitPosterRecipe &&
    options.checkpoint.title === options.title
  ) {
    const data = await readFile(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (data && digest(data) === options.checkpoint.sha256) return options.checkpoint;
  }
  const source = await options.source();
  const posters = await listLocalPosterImages({
    root: source,
    resourceName: options.originalTitle,
    rootIsResourceDir: true,
  });
  if (!posters[0]) throw new Error("缺少原版海报，无法生成改名竖屏海报");
  const result = await ensureRenamedPortraitPoster({
    client: options.client(),
    model: options.model(),
    referenceFile: posters[0].file,
    originalTitle: options.originalTitle,
    title: options.title,
    cacheDirectory: path.join(path.dirname(path.dirname(options.localDirectory)), ".二创海报缓存"),
    retryAttempts: options.retryAttempts(),
    signal: options.signal,
    onLog: options.onLog,
  });
  options.signal.throwIfAborted();
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, result.data);
    options.signal.throwIfAborted();
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  await options.normalize(options.localDirectory, options.title, options.signal, "封面.png");
  return { recipe: renamedPortraitPosterRecipe, title: options.title, sha256: digest(result.data) };
}
