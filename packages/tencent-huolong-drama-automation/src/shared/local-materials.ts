import { normalizePathKey, walkFiles } from "@dramabridge/file-utils";
import path from "node:path";
import {
  listLocalOwnershipMaterials,
  listLocalPosterImages,
  validateLocalEpisodeVideos,
} from "@dramabridge/media-assets";
import { log } from "./logger.js";
import type { ClaimedTencentHuolongDramaTask, TencentHuolongRuntimeOptions } from "./types.js";

export function materialRoot(options: TencentHuolongRuntimeOptions) {
  const root = options.localMaterialRoot?.trim();
  if (!root) throw new Error("请先配置腾讯火龙漫剧本地素材目录。");
  return root;
}

export async function sourcePoster(task: ClaimedTencentHuolongDramaTask, options: TencentHuolongRuntimeOptions) {
  const posters = await listLocalPosterImages({ root: materialRoot(options), resourceName: task.originalTitle });
  const poster = posters[0];
  if (!poster) throw new Error(`[poster-material-invalid] 未找到剧集封面：${task.originalTitle}`);
  const sourceKind = /AI海报/u.test(poster.name)
    ? "网盘缺少海报后的AI兜底源图"
    : "百度网盘或本地剧集素材";
  log(
    options,
    `[tencent-huolong-drama] 封面AI参考图已选定：来源=${sourceKind} file=${poster.file}`,
  );
  return poster.file;
}

export async function validateEpisodeVideos(task: ClaimedTencentHuolongDramaTask, options: TencentHuolongRuntimeOptions) {
  await validateLocalEpisodeVideos({
    localEpisodeVideoRoot: materialRoot(options),
    resourceName: task.originalTitle,
    episodeCount: task.playlet.episodeCount,
  });
}

const supportedDocumentExtensions = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

function uniqueFiles(files: string[]) {
  return [...new Map(files.map((file) => [normalizePathKey(file), file])).values()];
}

async function localFiles(
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
  matches: (normalizedPath: string) => boolean,
) {
  const resourceDir = path.join(materialRoot(options), task.originalTitle);
  const files = await walkFiles(resourceDir);
  return files.filter((file) => (
    supportedDocumentExtensions.has(path.extname(file).toLowerCase())
    && matches(file.replace(/\s+/g, "").toLowerCase())
  )).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function assertFiles(label: string, files: string[], minimum: number) {
  if (files.length < minimum) {
    throw new Error(`TENCENT_HUOLONG_DRAMA_MATERIAL_COUNT_INVALID: ${label}至少需要${minimum}个，实际=${files.length}`);
  }
}

export function validateTencentHuolongTaskMaterialReferences(
  task: ClaimedTencentHuolongDramaTask,
) {
  // The cost analysis document is business data supplied by the task API. Unlike
  // posters, episodes and project screenshots, it cannot be derived from the
  // netdisk resource, so reject the task before starting a potentially large download.
  const missing = [
    task.playlet.costAnalysisFiles.length < 1
      ? `成本配置分析（承诺函）至少需要1个，实际=${task.playlet.costAnalysisFiles.length}`
      : null,
  ].filter((message): message is string => Boolean(message));
  if (missing.length > 0) {
    throw new Error(`TENCENT_HUOLONG_DRAMA_TASK_MATERIAL_INVALID: ${missing.join("；")}`);
  }
}

export async function prepareTencentHuolongRequiredMaterials(
  task: ClaimedTencentHuolongDramaTask,
  options: TencentHuolongRuntimeOptions,
) {
  validateTencentHuolongTaskMaterialReferences(task);
  await validateEpisodeVideos(task, options);
  const ownership = await listLocalOwnershipMaterials({
    root: materialRoot(options),
    resourceName: task.originalTitle,
    includePortraitImages: true,
  });

  if (task.playlet.costAnalysisFiles.length === 0) {
    task.playlet.costAnalysisFiles = await localFiles(
      task,
      options,
      (file) => /成本配置|制作成本/.test(file) && path.extname(file) === ".pdf",
    );
  }
  if (task.playlet.copyrightProofFiles.length === 0) {
    const proofFiles = await localFiles(
      task,
      options,
      (file) => /版权证明|权属文件|制作协议|授权协议|授权链|权利声明/.test(file),
    );
    task.playlet.copyrightProofFiles = proofFiles.length > 0
      ? proofFiles
      : ownership.slice(0, 2).map((file) => file.file);
  }
  if (task.playlet.productionProcessFiles.length === 0) {
    const processFiles = await localFiles(
      task,
      options,
      (file) => /提示词|ai生成剧本|素材展示|设计图|矢量图|剧本|工程文件|剪映|jianying|capcut|剧创|即梦|jimeng|dreamina|权属协议/.test(file),
    );
    task.playlet.productionProcessFiles = uniqueFiles([
      ...processFiles,
      ...ownership.map((file) => file.file),
    ]);
  }

  assertFiles("成本配置分析（承诺函）", task.playlet.costAnalysisFiles, 1);
  assertFiles("版权证明文件", task.playlet.copyrightProofFiles, 1);
  assertFiles("生成过程和工程文件截图", task.playlet.productionProcessFiles, 8);
}
