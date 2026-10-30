import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { listLocalEpisodeFiles, listLocalPosterImages } from "@dramabridge/media-assets";

export async function hasKuaishouRecreationSource(source: string, originalTitle: string, episodeCount: number) {
  const episodes = (await listLocalEpisodeFiles({ root: source, resourceName: originalTitle, allowArbitraryDir: true }))
    .filter(file => file.index <= episodeCount);
  if (episodes.length !== episodeCount || new Set(episodes.map(file => file.index)).size !== episodeCount
    || episodes.some(file => file.index < 1 || file.size <= 0)) return false;
  return (await listLocalPosterImages({ root: source, resourceName: originalTitle, rootIsResourceDir: true })).length > 0;
}

/** Only complete, isolated version directories can resume directly at upload. */
export async function inspectKuaishouRecreationVersion(directory: string, title: string, episodeCount: number, allowLegacyCover = false) {
  try {
    const top = await readdir(directory, { withFileTypes: true });
    if (top.length !== 2 || top.some(entry => !entry.isDirectory() || !["成片", "封面"].includes(entry.name))) return;
    const files: Array<{ path: string; size: number; modifiedAtMs: number }> = [];
    for (const category of ["成片", "封面"]) {
      const entries = await readdir(path.join(directory, category), { withFileTypes: true });
      if (!entries.length || entries.some(entry => !entry.isFile())) return;
      if (category === "封面" && !allowLegacyCover && (entries.length !== 1 || path.parse(entries[0].name).name !== "封面")) return;
      const indexes = new Set<number>();
      for (const entry of entries) {
        const extensions = category === "成片" ? [".mp4", ".mov"] : [".png", ".jpg", ".jpeg", ".bmp", ".webp"];
        if (!extensions.includes(path.extname(entry.name).toLowerCase())) return;
        const stem = path.parse(entry.name).name;
        if (category === "封面" && stem === "封面") {
          const file = await stat(path.join(directory, category, entry.name));
          if (!file.size) return;
          files.push({ path: path.join(category, entry.name), size: file.size, modifiedAtMs: file.mtimeMs });
          continue;
        }
        const prefix = category === "成片" ? `${title}-第` : `${title}-封面`;
        const suffix = category === "成片" ? "集" : "";
        if (!stem.startsWith(prefix) || !stem.endsWith(suffix)) return;
        const text = stem.slice(prefix.length, suffix ? -suffix.length : undefined);
        if (!/^[1-9]\d*$/.test(text)) return;
        const index = Number(text);
        if (indexes.has(index) || (category === "成片" && index > episodeCount)) return;
        indexes.add(index);
        const file = await stat(path.join(directory, category, entry.name));
        if (!file.size) return;
        files.push({ path: path.join(category, entry.name), size: file.size, modifiedAtMs: file.mtimeMs });
      }
      if (category === "成片" && indexes.size !== episodeCount) return;
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

/** Migrate only generated cover files; retain video files and source materials. */
export async function normalizeKuaishouRecreationCover(directory: string, title: string, signal?: AbortSignal, preferredFilename?: string) {
  const cover = path.join(directory, "封面");
  const entries = await readdir(cover, { withFileTypes: true });
  const managed = entries.filter(entry => {
    if (!entry.isFile() || ![".png", ".jpg", ".jpeg", ".bmp", ".webp"].includes(path.extname(entry.name).toLowerCase())) return false;
    const stem = path.parse(entry.name).name;
    return stem === "封面" || (stem.startsWith(`${title}-封面`) && /^[1-9]\d*$/.test(stem.slice(`${title}-封面`.length)));
  }).sort((a, b) => Number(b.name === preferredFilename) - Number(a.name === preferredFilename)
    || Number(path.parse(b.name).name === "封面") - Number(path.parse(a.name).name === "封面")
    || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  if (!managed.length || managed.length !== entries.length) throw new Error(`封面目录包含无法识别的文件：${cover}`);
  signal?.throwIfAborted();
  const selected = managed[0];
  const filename = `封面${path.extname(selected.name)}`;
  if (selected.name !== filename) await rename(path.join(cover, selected.name), path.join(cover, filename));
  for (const extra of managed.slice(1)) {
    signal?.throwIfAborted();
    await unlink(path.join(cover, extra.name));
  }
}

export async function prepareKuaishouRecreationVersion(options: {
  source: string;
  originalTitle: string;
  title: string;
  episodeCount: number;
  outputRoot: string;
  signal?: AbortSignal;
}) {
  const episodes = (
    await listLocalEpisodeFiles({
      root: options.source,
      resourceName: options.originalTitle,
      allowArbitraryDir: true,
    })
  ).filter((file) => file.index <= options.episodeCount);
  if (
    episodes.length !== options.episodeCount ||
    new Set(episodes.map((file) => file.index)).size !== options.episodeCount ||
    episodes.some((file) => file.index < 1)
  )
    throw new Error(
      `视频集数不完整，期望第 1–${options.episodeCount} 集，找到 ${episodes.length} 集`,
    );
  const posters = await listLocalPosterImages({
    root: options.source,
    resourceName: options.originalTitle,
    rootIsResourceDir: true,
    includeAllMatches: false,
  });
  if (!posters.length) throw new Error("下载素材中没有可用封面");
  const directory = path.join(options.outputRoot, `${options.title}-60%`);
  await mkdir(path.join(directory, "封面"), { recursive: true });
  await mkdir(path.join(directory, "成片"), { recursive: true });
  const copy = async (source: string, destination: string) => {
    options.signal?.throwIfAborted();
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
    if ((await stat(source)).size !== (await stat(destination)).size)
      throw new Error(`复制素材不完整：${destination}`);
  };
  for (const episode of episodes)
    await copy(
      episode.file,
      path.join(
        directory,
        "成片",
        `${options.title}-第${episode.index}集${path.extname(episode.file)}`,
      ),
    );
  const poster = posters[0];
  await copy(poster.file, path.join(directory, "封面", `封面${path.extname(poster.file)}`));
  await normalizeKuaishouRecreationCover(directory, options.title, options.signal, `封面${path.extname(poster.file)}`);
  return directory;
}
