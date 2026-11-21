import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  classifyOwnershipProjectProof,
  classifyOwnershipProjectProofName,
  isOwnershipDirectoryName,
  isExplicitNonOwnershipImageDirectoryPath,
  listLocalAiProductionProofFiles,
  listLocalOwnershipMaterials,
  listLocalPosterImages,
  prepareImageForUpload,
} from "@dramabridge/media-assets";
import type { ClaimedWeiboDramaTask, WeiboDramaRuntimeOptions } from "./types.js";
import { log } from "./logger.js";

export async function findWeiboOwnershipFiles(
  query: { root: string; resourceName: string },
  options: WeiboDramaRuntimeOptions,
) {
  const images = await listLocalOwnershipMaterials({ ...query, includePortraitImages: true });
  const aiProofs = await listLocalAiProductionProofFiles(query);
  const candidates = new Map(
    [...images, ...aiProofs].map((file) => [path.resolve(file.file), file.file]),
  );
  const resourceDir = path.join(query.root, query.resourceName);
  async function scan(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(file);
        continue;
      }
      // The common image scanner intentionally excludes PDFs and single loose screenshots.
      const relative = path.relative(resourceDir, file);
      if (/-权属工程文件合成[12]\.jpg$/i.test(entry.name)) continue;
      if (
        entry.isFile() &&
        /\.(pdf|png|jpe?g|webp|bmp)$/i.test(entry.name) &&
        relative.split(path.sep).some(isOwnershipDirectoryName) &&
        !isExplicitNonOwnershipImageDirectoryPath(path.relative(resourceDir, dir))
      )
        candidates.set(path.resolve(file), file);
    }
  }
  await scan(resourceDir);
  const selected: Array<{ file: string; kind?: string }> = [];
  const seen = new Set<string>();
  let aiClient: ReturnType<NonNullable<WeiboDramaRuntimeOptions["aiClientFactory"]>> | undefined;
  for (const file of candidates.values()) {
    options.signal?.throwIfAborted();
    const relative = path.relative(resourceDir, file);
    if (
      isExplicitNonOwnershipImageDirectoryPath(path.dirname(relative)) ||
      /海报|封面|poster|cover/iu.test(path.basename(file))
    )
      continue;
    const fileStat = await stat(file);
    if (!fileStat.size) continue;
    const contents = await readFile(file);
    const digest = createHash("sha256").update(contents).digest("hex");
    if (seen.has(digest)) continue;
    seen.add(digest);
    let kind = classifyOwnershipProjectProofName(relative);
    const explicitProof =
      relative.split(path.sep).some(isOwnershipDirectoryName) || /AI制作证明/iu.test(relative);
    if (!kind && !explicitProof) {
      if (!options.aiClientFactory)
        throw new Error(
          `WEIBO_DRAMA_OWNERSHIP_RECOGNITION_FAILED: 找到待识别截图 ${relative}，请配置AI识别后重试，不能直接用海报替代`,
        );
      aiClient ??= options.aiClientFactory();
      const classified = await classifyOwnershipProjectProof(file, relative, aiClient);
      if (classified === "unknown") continue;
      kind = classified;
    }
    selected.push({ file, kind });
  }
  // Include both sources when available; the remaining slots may come from either source.
  const proofs: string[] = [];
  for (const kind of ["jianying", "juchuang"]) {
    const first = selected.find((file) => file.kind === kind);
    if (first) proofs.push(first.file);
  }
  for (const item of selected) if (!proofs.includes(item.file)) proofs.push(item.file);
  log(
    options,
    `[weibo-drama] 权属文件识别：候选${candidates.size}个，可用${selected.length}个，选取${Math.min(proofs.length, 5)}个`,
    {
      files: proofs.slice(0, 5).map((file) => path.relative(resourceDir, file)),
    },
  );
  return proofs.slice(0, 5);
}

export async function prepareWeiboMaterials(
  task: ClaimedWeiboDramaTask,
  options: WeiboDramaRuntimeOptions,
) {
  if (!options.localEpisodeVideoRoot || !options.assetDownloadDir)
    throw new Error("WEIBO_DRAMA_MATERIAL_DIRECTORIES_REQUIRED");
  const query = { root: options.localEpisodeVideoRoot, resourceName: task.originalTitle };
  const posters = await listLocalPosterImages(query);
  if (!posters[0]) throw new Error("WEIBO_DRAMA_COVER_MISSING: 未找到本剧封面或海报");
  const cover = await prepareImageForUpload({
    inputFile: posters[0].file,
    outputDir: path.join(options.assetDownloadDir, String(task.accountTaskId), "cover"),
    outputFileName: "weibo-cover.jpg",
    policy: {
      maxFileBytes: 9_900_000,
      targetFileBytes: 9_000_000,
      minimumWidth: 594,
      minimumHeight: 792,
      minimumJpegQuality: 80,
    },
  });
  const files = await findWeiboOwnershipFiles(query, options);
  task.playlet.localCoverFile = cover.file;
  task.playlet.ownershipFiles = files.length
    ? await Promise.all(
        files.map(async (file, index) => {
          if (path.extname(file).toLowerCase() === ".pdf") {
            if ((await stat(file)).size >= 10_000_000)
              throw new Error(
                `WEIBO_DRAMA_OWNERSHIP_FILE_TOO_LARGE: 权属PDF超过10MB，请压缩后重试：${file}`,
              );
            if (!(await readFile(file)).subarray(0, 5).equals(Buffer.from("%PDF-")))
              throw new Error(`WEIBO_DRAMA_OWNERSHIP_FILE_INVALID: 权属PDF格式异常：${file}`);
            return file;
          }
          const prepared = await prepareImageForUpload({
            inputFile: file,
            outputDir: path.join(
              options.assetDownloadDir!,
              String(task.accountTaskId),
              "ownership",
            ),
            outputFileName: `ownership-${index + 1}.jpg`,
            policy: {
              maxFileBytes: 9_900_000,
              targetFileBytes: 9_000_000,
              minimumWidth: 1,
              minimumHeight: 1,
              minimumJpegQuality: 80,
            },
          });
          return prepared.file;
        }),
      )
    : [cover.file];
  log(
    options,
    files.length
      ? `[weibo-drama] 使用${files.length}个权属文件，未使用海报兜底`
      : "[weibo-drama] 已扫描本剧权属材料，未找到可用文件，使用1张封面兜底",
  );
}
