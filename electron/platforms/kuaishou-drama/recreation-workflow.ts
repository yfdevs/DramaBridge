import path from "node:path";
import { lstat, mkdir, rename, rmdir } from "node:fs/promises";
import type { RecreationTask, RecreationVersion } from "../../../src/platforms/kuaishou-drama/recreation-types";
import { validateRecreationTitle } from "./recreation-excel";

type Runtime = Pick<typeof import("@dramabridge/kuaishou-drama-automation"),
  "prepareKuaishouRecreationVersion" | "hasKuaishouRecreationSource" | "inspectKuaishouRecreationVersion" | "normalizeKuaishouRecreationCover">;

export async function executeRecreationTask(task: RecreationTask, options: {
  materialRoot: string;
  runtime: Runtime;
  signal: AbortSignal;
  legacySourcePath?: string;
  update: (fields: Partial<RecreationTask>) => void;
  download: (targetRoot: string) => Promise<string>;
  upload: (localPath: string, title: string, onProgress: (message: string) => void,
    preferredRemoteDirectory: string | undefined, onRemoteDirectorySelected: (directory: string) => void,
    verification: { verifiedFiles?: RecreationVersion["verifiedFiles"]; onFileVerified: (file: NonNullable<RecreationVersion["verifiedFiles"]>[number]) => void }) => Promise<{
    remotePath: string; shareUrl: string; extractionCode: string;
  }>;
}) {
  validateRecreationTitle(task.originalTitle);
  task.results.forEach(result => validateRecreationTitle(result.title));
  const { runtime, signal, update } = options;
  const root = path.join(options.materialRoot, task.originalTitle);
  const source = path.join(root, "素材");
  const versions = path.join(root, "版本");
  const previousVersions = task.localPath;
  const legacyRoots = [task.originalTitle, task.id].map(name => path.join(options.materialRoot, "任务", name));
  update({ localPath: root, state: "checking", message: "检查已下载素材和已整理版本" });
  await mkdir(root, { recursive: true });
  const exists = async (file: string) => {
    try { return await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  };
  const adopt = async (from: string, to: string) => {
    if (path.resolve(from) === path.resolve(to)) return to;
    const relative = path.relative(options.materialRoot, from);
    // Relocate only our own task artifacts. External directories remain untouched.
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || (await exists(from))?.isSymbolicLink()) return from;
    if (await exists(to)) return from;
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
    let empty = path.dirname(from);
    while (path.resolve(empty) !== path.resolve(options.materialRoot)) {
      try { await rmdir(empty); } catch { break; }
      empty = path.dirname(empty);
    }
    return to;
  };
  let resolvedSource: string | undefined;
  const ensureSource = async (required = true) => {
    if (resolvedSource) return resolvedSource;
    const candidates = [task.sourcePath, source, options.legacySourcePath,
      ...legacyRoots.map(legacy => path.join(legacy, "源素材", task.originalTitle)),
      path.join(root, ".整理中", task.originalTitle)];
    for (const candidate of new Set(candidates.filter((value): value is string => Boolean(value)))) {
      signal.throwIfAborted();
      if (!(await exists(candidate)) || !(await runtime.hasKuaishouRecreationSource(candidate, task.originalTitle, task.downloadCount))) continue;
      resolvedSource = await adopt(candidate, source);
      update({ sourcePath: resolvedSource, message: "已复用本地素材，无需重新下载" });
      return resolvedSource;
    }
    if (!required) return;
    signal.throwIfAborted();
    update({ state: "downloading", message: `本地素材不完整，下载前 ${task.downloadCount} 集和封面` });
    const downloaded = await options.download(path.join(root, ".整理中"));
    if (!(await runtime.hasKuaishouRecreationSource(downloaded, task.originalTitle, task.downloadCount)))
      throw new Error("下载素材校验失败：剧集或封面不完整");
    resolvedSource = await adopt(downloaded, source);
    await rmdir(path.join(root, ".整理中")).catch(() => undefined); // Empty staging directories only.
    update({ sourcePath: resolvedSource });
    return resolvedSource;
  };
  await ensureSource(false); // Adopt completed legacy downloads without starting a new download.
  for (const version of task.results) {
    signal.throwIfAborted();
    update({ state: "checking", message: `检查版本：${version.title}` });
    const target = path.join(versions, `${version.title}-60%`);
    const candidates = [version.localPath, target,
      ...(previousVersions ? [path.join(previousVersions, `${version.title}-60%`)] : []),
      ...legacyRoots.map(legacy => path.join(legacy, "版本", `${version.title}-60%`))];
    let localPath: string | undefined;
    for (const candidate of new Set(candidates.filter((value): value is string => Boolean(value)))) {
      const files = await runtime.inspectKuaishouRecreationVersion(candidate, version.title, task.downloadCount, true);
      if (!files) continue;
      if (version.localFiles && (files.length !== version.localFiles.length || files.some((file, index) => {
        const saved = version.localFiles![index];
        return file.path !== saved.path || file.size !== saved.size || file.modifiedAtMs !== saved.modifiedAtMs;
      }))) continue;
      localPath = await adopt(candidate, target);
      break;
    }
    if (!localPath) {
      if (version.shareUrl) continue; // A shared version never needs to be rebuilt.
      const sourcePath = await ensureSource();
      if (!sourcePath) throw new Error("缺少二创源素材");
      signal.throwIfAborted();
      update({ state: "processing", message: `整理版本：${version.title}` });
      localPath = await runtime.prepareKuaishouRecreationVersion({
        source: sourcePath, originalTitle: task.originalTitle, title: version.title,
        episodeCount: task.downloadCount, outputRoot: versions, signal,
      });
    }
    await runtime.normalizeKuaishouRecreationCover(localPath, version.title, signal);
    const files = await runtime.inspectKuaishouRecreationVersion(localPath, version.title, task.downloadCount);
    if (!files) throw new Error(`版本目录不完整或含有额外文件：${localPath}`);
    Object.assign(version, { localPath, localFiles: files });
    if (version.shareUrl) {
      update({ results: task.results });
      continue;
    }
    // Persist the completed local stage before attempting any network operation.
    update({ state: "uploading", message: `上传版本：${version.title}` });
    Object.assign(version, await options.upload(localPath, version.title, message => update({ message: `${version.title}：${message}` }),
      version.remotePath, directory => {
        version.remotePath = directory;
        update({ results: task.results });
      }, {
        verifiedFiles: version.verifiedFiles,
        onFileVerified: file => {
          version.verifiedFiles = [...(version.verifiedFiles ?? []).filter(saved => saved.path !== file.path), file];
          update({ results: task.results });
        },
      }));
    update({ results: task.results });
  }
  update({ state: "completed", message: "所有版本已上传并生成分享链接" });
}
