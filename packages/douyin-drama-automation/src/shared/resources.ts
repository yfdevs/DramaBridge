import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  classifyOwnershipProjectProof,
  classifyOwnershipProjectProofName,
  createRuntimeArtifactLease,
  listLocalOwnershipMaterials,
  listLocalPosterImages,
  prepareStretchedImageVariant,
  validateLocalEpisodeVideos,
} from "@drama/drama-media-assets";
import {
  DOUYIN_DRAMA_DOUYIN_COVER,
  DOUYIN_DRAMA_HONGGUO_COVER,
} from "./constants.js";
import { log } from "./logger.js";
import type { ClaimedDouyinDramaTask, DouyinDramaRuntimeOptions } from "./types.js";

const supportedMaterialExtensions = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".webp",
]);

const DOUYIN_ROLE_PHOTO_MIN_BYTES = 50 * 1024;
const DOUYIN_ROLE_PHOTO_TARGET_BYTES = 64 * 1024;
const DOUYIN_ROLE_PHOTO_MAX_BYTES = 4_700_000;
const DOUYIN_ROLE_PHOTO_SIZE = 1_024;

/**
 * Douyin rejects role photos smaller than 50 KiB. Detailed AI portraits can
 * still become much smaller after mozjpeg compression, so role photos need a
 * dedicated encoder instead of the normal poster compression helper.
 */
export async function prepareDouyinRolePhoto(
  inputFile: string,
  outputBaseFile: string,
  onLog?: (message: string) => void,
) {
  await mkdir(path.dirname(outputBaseFile), { recursive: true });
  const image = sharp(inputFile, { failOn: "error" })
    .rotate()
    .resize({
      width: DOUYIN_ROLE_PHOTO_SIZE,
      height: DOUYIN_ROLE_PHOTO_SIZE,
      fit: "cover",
      position: "centre",
    })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb");
  const jpegBuffer = await image.clone().jpeg({
    quality: 100,
    progressive: false,
    mozjpeg: false,
    chromaSubsampling: "4:4:4",
  }).toBuffer();

  let outputFile = outputBaseFile.replace(/\.[^.]+$/u, ".jpg");
  let outputBuffer = jpegBuffer;
  let format = "JPEG";
  if (jpegBuffer.length < DOUYIN_ROLE_PHOTO_TARGET_BYTES) {
    outputFile = outputBaseFile.replace(/\.[^.]+$/u, ".png");
    outputBuffer = await image.clone().png({
      compressionLevel: 0,
      adaptiveFiltering: false,
      palette: false,
    }).toBuffer();
    format = "PNG";
  }

  if (outputBuffer.length < DOUYIN_ROLE_PHOTO_MIN_BYTES) {
    throw new Error(
      `DOUYIN_DRAMA_ROLE_PHOTO_TOO_SMALL_AFTER_PROCESSING: ` +
        `actual=${outputBuffer.length}; minimum=${DOUYIN_ROLE_PHOTO_MIN_BYTES}; file=${inputFile}`,
    );
  }
  if (outputBuffer.length > DOUYIN_ROLE_PHOTO_MAX_BYTES) {
    throw new Error(
      `DOUYIN_DRAMA_ROLE_PHOTO_TOO_LARGE_AFTER_PROCESSING: ` +
        `actual=${outputBuffer.length}; maximum=${DOUYIN_ROLE_PHOTO_MAX_BYTES}; file=${inputFile}`,
    );
  }
  await writeFile(outputFile, outputBuffer);
  const metadata = await sharp(outputBuffer, { failOn: "error" }).metadata();
  if (metadata.width !== DOUYIN_ROLE_PHOTO_SIZE || metadata.height !== DOUYIN_ROLE_PHOTO_SIZE) {
    throw new Error(
      `DOUYIN_DRAMA_ROLE_PHOTO_DIMENSION_INVALID: ` +
        `actual=${metadata.width ?? 0}x${metadata.height ?? 0}; file=${inputFile}`,
    );
  }
  onLog?.(
    `[role-photo] 生成合规角色头像：${inputFile} -> ${outputFile} ` +
      `${format} ${DOUYIN_ROLE_PHOTO_SIZE}x${DOUYIN_ROLE_PHOTO_SIZE} size=${outputBuffer.length}`,
  );
  return { file: outputFile, size: outputBuffer.length };
}

export function douyinDramaResourceName(task: ClaimedDouyinDramaTask) {
  return task.originalTitle.trim();
}

export function douyinDramaLocalRoot(options: DouyinDramaRuntimeOptions) {
  const root = options.localEpisodeVideoRoot?.trim();
  if (!root) throw new Error("DOUYIN_DRAMA_LOCAL_VIDEO_ROOT_REQUIRED");
  return root;
}

function playletResourceDir(task: ClaimedDouyinDramaTask, options: DouyinDramaRuntimeOptions) {
  return path.join(douyinDramaLocalRoot(options), douyinDramaResourceName(task));
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function findLocalMaterialFiles(
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  keywords: string[],
) {
  const files = await walkFiles(playletResourceDir(task, options));
  return files
    .filter((file) => supportedMaterialExtensions.has(path.extname(file).toLowerCase()))
    .filter((file) => keywords.some((keyword) => file.replace(/\s+/g, "").includes(keyword)))
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function remoteMaterialExtension(url: URL, contentType: string | null) {
  const urlExtension = path.extname(url.pathname);
  if (urlExtension && urlExtension.length <= 10) return urlExtension;
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return ({
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/bmp": ".bmp",
    "image/webp": ".webp",
  } as Record<string, string>)[type ?? ""] ?? ".bin";
}

async function prepareMaterialReferences(
  references: string[],
  category: string,
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
  materialUploadRoot: string,
  allowedExtensions?: ReadonlySet<string>,
) {
  const outputDir = path.join(materialUploadRoot, category);
  await mkdir(outputDir, { recursive: true });

  return Promise.all(references.map(async (reference, index) => {
    if (!/^https?:\/\//i.test(reference)) {
      const candidate = path.isAbsolute(reference)
        ? reference
        : path.join(playletResourceDir(task, options), reference);
      const fileStat = await stat(candidate).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size <= 0) {
        throw new Error(`DOUYIN_DRAMA_MATERIAL_FILE_NOT_FOUND: ${candidate}`);
      }
      const extension = path.extname(candidate).toLowerCase();
      if (allowedExtensions && !allowedExtensions.has(extension)) {
        throw new Error(
          `DOUYIN_DRAMA_MATERIAL_FORMAT_INVALID: ${category}仅支持${[...allowedExtensions].join("/")}，实际=${extension || "无扩展名"}`,
        );
      }
      const target = path.join(outputDir, `${category}-${index + 1}${extension}`);
      await copyFile(candidate, target);
      return target;
    }

    const url = new URL(reference);
    const response = await fetch(reference, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`DOUYIN_DRAMA_MATERIAL_DOWNLOAD_FAILED: HTTP ${response.status}: ${reference}`);
    }
    const extension = remoteMaterialExtension(url, response.headers.get("content-type"));
    if (allowedExtensions && !allowedExtensions.has(extension.toLowerCase())) {
      throw new Error(
        `DOUYIN_DRAMA_MATERIAL_FORMAT_INVALID: ${category}仅支持${[...allowedExtensions].join("/")}，实际=${extension}`,
      );
    }
    const target = path.join(outputDir, `${category}-${index + 1}${extension}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    log(options, `[douyin-drama] 公共材料下载完成：字段=${category} 文件=${target}`, undefined, "resources");
    return target;
  }));
}

const douyinImageMaterialExtensions = new Set([".png", ".jpg", ".jpeg"]);
const douyinDocumentMaterialExtensions = new Set([".pdf", ...douyinImageMaterialExtensions]);

type DouyinProjectProofClassifier = (
  material: Awaited<ReturnType<typeof listLocalOwnershipMaterials>>[number],
) => Promise<"jianying" | "juchuang" | "unknown">;

export async function selectDouyinJianyingProjectScreenshots(
  ownershipMaterials: Awaited<ReturnType<typeof listLocalOwnershipMaterials>>,
  count = 4,
  classifyUnknown?: DouyinProjectProofClassifier,
) {
  const classified: Array<{
    kind: "jianying" | "juchuang" | "unknown";
    material: Awaited<ReturnType<typeof listLocalOwnershipMaterials>>[number];
  }> = [];
  for (const material of ownershipMaterials) {
    // The platform label can be on an ancestor folder rather than the direct
    // parent, e.g. 权属文件/剪映工程图/截图/1.png.
    const namedKind = classifyOwnershipProjectProofName(`${material.file}/${material.name}`);
    classified.push({
      kind: namedKind ?? (classifyUnknown ? await classifyUnknown(material) : "unknown"),
      material,
    });
    if (classified.filter((item) => item.kind === "jianying").length >= count) break;
  }
  const selectedMaterials = classified
    .filter((item) => item.kind === "jianying")
    .map((item) => item.material)
    .sort((left, right) =>
      (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "zh-CN", { numeric: true }))
    .slice(0, count);
  if (selectedMaterials.length < count) {
    const juchuangCount = classified.filter((item) => item.kind === "juchuang").length;
    const unknown = classified
      .filter((item) => item.kind === "unknown")
      .map((item) => item.material.name)
      .slice(0, 8);
    throw new Error(
      `DOUYIN_DRAMA_JIANYING_SCREENSHOTS_REQUIRED: 工程文件截图需要${count}张剪映图片，`
        + `实际=${selectedMaterials.length}，剧创=${juchuangCount}，未识别=${unknown.length}`
        + (unknown.length > 0 ? `（${unknown.join("、")}）` : ""),
    );
  }
  return selectedMaterials.map((material) => material.file);
}

function assertMaterialCount(label: string, files: string[], minimum: number, maximum?: number) {
  if (files.length < minimum || (maximum !== undefined && files.length > maximum)) {
    const expected = maximum === undefined ? `至少${minimum}个` : `${minimum}-${maximum}个`;
    throw new Error(`DOUYIN_DRAMA_MATERIAL_COUNT_INVALID: ${label}需要${expected}，实际=${files.length}`);
  }
}

type DouyinCoverCandidate = {
  file: string;
  height?: number;
  width?: number;
};

function coverRatioDistance(candidate: DouyinCoverCandidate, targetRatio: number) {
  if (!candidate.width || !candidate.height) return Number.POSITIVE_INFINITY;
  return Math.abs(candidate.width / candidate.height - targetRatio);
}

/**
 * A netdisk folder may contain one shared poster or two platform-specific posters.
 * When there are two usable images, choose the distinct pair whose ratios most
 * closely match 7:10 (Hongguo) and 2:3 (Douyin) before producing exact-size files.
 */
export function selectDouyinCoverSources<T extends DouyinCoverCandidate>(posters: T[]) {
  if (posters.length === 0) {
    throw new Error("[poster-material-invalid] 未找到文件名或目录名包含‘封面’或‘海报’的图片");
  }
  if (posters.length === 1) {
    return { douyin: posters[0], hongguo: posters[0] };
  }

  let best: { douyin: T; hongguo: T; score: number } | undefined;
  for (const hongguo of posters) {
    for (const douyin of posters) {
      if (hongguo === douyin) continue;
      const score = coverRatioDistance(hongguo, DOUYIN_DRAMA_HONGGUO_COVER.aspectRatio)
        + coverRatioDistance(douyin, DOUYIN_DRAMA_DOUYIN_COVER.aspectRatio);
      if (!best || score < best.score) best = { douyin, hongguo, score };
    }
  }

  return best ?? { douyin: posters[0], hongguo: posters[0] };
}

export async function prepareDouyinDramaResources(
  task: ClaimedDouyinDramaTask,
  options: DouyinDramaRuntimeOptions,
) {
  const resourceName = douyinDramaResourceName(task);
  const localEpisodeVideoRoot = douyinDramaLocalRoot(options);
  const materialUploadRoot = path.join(
    options.assetDownloadDir ?? path.resolve(process.cwd(), ".drama-runs/douyin-drama/assets"),
    `material-upload-task-${task.accountTaskId}-${process.pid}-${randomUUID()}`,
  );
  await mkdir(materialUploadRoot, { recursive: true });
  await createRuntimeArtifactLease(materialUploadRoot, "material-upload");
  await validateLocalEpisodeVideos({
    localEpisodeVideoRoot,
    resourceName,
    episodeCount: task.playlet.episodeCount,
  });

  const ownershipMaterials = await listLocalOwnershipMaterials({
    root: localEpisodeVideoRoot,
    resourceName,
    includePortraitImages: true,
    deduplicateByContent: false,
  });
  if (task.playlet.payCommitmentFiles.length === 0) {
    task.playlet.payCommitmentFiles = await findLocalMaterialFiles(
      task,
      options,
      ["片酬承诺"],
    );
  }
  // 抖音要求的是当前剧目的剪映工程截图。即使接口或 mock 误传了通用
  // 图片，也必须由百度网盘下载目录重新选择，避免把占位图/封面传上去。
  const aiClient = options.aiClientFactory?.();
  task.playlet.projectScreenshotFiles = await selectDouyinJianyingProjectScreenshots(
    ownershipMaterials,
    4,
    aiClient
      ? (material) => classifyOwnershipProjectProof(
          material.file,
          material.name,
          aiClient as Parameters<typeof classifyOwnershipProjectProof>[2],
        )
      : undefined,
  );
  log(options, "[douyin-drama] 已从百度网盘权属目录选择 4 张剪映工程截图。", {
    accountTaskId: task.accountTaskId,
    files: task.playlet.projectScreenshotFiles,
  }, "resources");

  const [
    costConfigurationFiles,
    payCommitmentFiles,
    ownershipProofFiles,
    nonInfringementCommitmentFiles,
    projectScreenshotFiles,
  ] = await Promise.all([
    prepareMaterialReferences(
      task.playlet.costConfigurationFiles,
      "cost-configuration",
      task,
      options,
      materialUploadRoot,
      douyinDocumentMaterialExtensions,
    ),
    prepareMaterialReferences(task.playlet.payCommitmentFiles, "pay-commitment", task, options, materialUploadRoot),
    prepareMaterialReferences(task.playlet.ownershipProofFiles, "ownership-proof", task, options, materialUploadRoot),
    prepareMaterialReferences(
      task.playlet.nonInfringementCommitmentFiles,
      "non-infringement-commitment",
      task,
      options,
      materialUploadRoot,
      douyinDocumentMaterialExtensions,
    ),
    prepareMaterialReferences(
      task.playlet.projectScreenshotFiles,
      "project-screenshots",
      task,
      options,
      materialUploadRoot,
      douyinImageMaterialExtensions,
    ),
  ]);
  assertMaterialCount("成本配置情况", costConfigurationFiles, 1);
  assertMaterialCount("权属文件", ownershipProofFiles, 1);
  assertMaterialCount("不侵权承诺函", nonInfringementCommitmentFiles, 1);
  assertMaterialCount("工程文件截图", projectScreenshotFiles, 4, 4);
  task.playlet.costConfigurationFiles = costConfigurationFiles;
  task.playlet.payCommitmentFiles = payCommitmentFiles;
  task.playlet.ownershipProofFiles = ownershipProofFiles;
  task.playlet.nonInfringementCommitmentFiles = nonInfringementCommitmentFiles;
  task.playlet.projectScreenshotFiles = projectScreenshotFiles;

  const posters = await listLocalPosterImages({
    root: localEpisodeVideoRoot,
    resourceName,
    includeAllMatches: true,
  });
  const coverSources = selectDouyinCoverSources(posters);
  const outputDir = path.join(materialUploadRoot, "poster-upload");
  const onResizeLog = (message: string) => log(options, `[douyin-drama] ${message}`, undefined, "resources");
  const [hongguoCover, douyinCover] = await Promise.all([
    prepareStretchedImageVariant({
      inputFile: coverSources.hongguo.file,
      outputFile: path.join(outputDir, "hongguo-cover-700x1000.jpg"),
      width: DOUYIN_DRAMA_HONGGUO_COVER.width,
      height: DOUYIN_DRAMA_HONGGUO_COVER.height,
      jpegQuality: 92,
      maxFileBytes: 4_700_000,
      onLog: onResizeLog,
    }),
    prepareStretchedImageVariant({
      inputFile: coverSources.douyin.file,
      outputFile: path.join(outputDir, "douyin-cover-720x1080.jpg"),
      width: DOUYIN_DRAMA_DOUYIN_COVER.width,
      height: DOUYIN_DRAMA_DOUYIN_COVER.height,
      jpegQuality: 92,
      maxFileBytes: 4_700_000,
      onLog: onResizeLog,
    }),
  ]);
  task.playlet.localHongguoCoverFile = hongguoCover.file;
  task.playlet.localDouyinCoverFile = douyinCover.file;
  const rolePhotoOutputDir = path.join(materialUploadRoot, "role-photo-upload");
  for (const [index, role] of task.playlet.roles.entries()) {
    if (!role.photoFile) {
      throw new Error(`DOUYIN_DRAMA_ROLE_PHOTO_REQUIRED: 网盘中找不到角色图片：${role.name}`);
    }
    const [sourceRolePhoto] = await prepareMaterialReferences(
      [role.photoFile],
      `role-photo-${index + 1}`,
      task,
      options,
      materialUploadRoot,
    );
    const preparedRolePhoto = await prepareDouyinRolePhoto(
      sourceRolePhoto,
      path.join(rolePhotoOutputDir, `role-${index + 1}.jpg`),
      onResizeLog,
    );
    role.photoFile = preparedRolePhoto.file;
  }

  return {
    localEpisodeVideoRoot,
    resourceName,
    hongguoCoverSourceFile: coverSources.hongguo.file,
    douyinCoverSourceFile: coverSources.douyin.file,
    hongguoCoverFile: hongguoCover.file,
    douyinCoverFile: douyinCover.file,
    projectScreenshotFiles,
  };
}
