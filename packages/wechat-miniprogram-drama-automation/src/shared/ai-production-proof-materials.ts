import { listLocalAiProductionProofFiles } from "@dramabridge/media-assets";
import { prepareUploadFiles } from "../automation/upload/upload-helpers.js";
import { resolveFromRoot } from "./config.js";
import { getWechatMiniProgramRuntimeSettings } from "./runtime-settings.js";
import type { Config } from "./types.js";

export const wechatAiProductionProofRequirements = {
  minimumFiles: 1,
} as const;

export async function prepareWechatAiProductionProofMaterials(
  config: Config,
  options: { allowMissing?: boolean } = {},
): Promise<string[]> {
  if (!(config.playlet.aiContent ?? true)) {
    config.playlet.aiProductionProofFiles = [];
    return [];
  }

  const taskFiles = config.playlet.aiProductionProofFiles?.filter(Boolean) ?? [];
  if (taskFiles.length > 0) {
    const resolvedTaskFiles = await prepareUploadFiles(
      taskFiles,
      resolveFromRoot,
      `${config.playlet.name}-ai-production-proof`,
    );
    if (resolvedTaskFiles.length > 0) {
      config.playlet.aiProductionProofFiles = resolvedTaskFiles;
      return resolvedTaskFiles;
    }
  }

  const localEpisodeVideoRoot = getWechatMiniProgramRuntimeSettings().localEpisodeVideoRoot.trim();
  const localFiles = await listLocalAiProductionProofFiles({
    root: localEpisodeVideoRoot,
    resourceName: config.originalTitle,
  });
  if (localFiles.length < wechatAiProductionProofRequirements.minimumFiles) {
    if (options.allowMissing) {
      config.playlet.aiProductionProofFiles = [];
      return [];
    }
    throw new Error(
      `[ai-production-proof-invalid] 开启AI内容声明后必须上传AI制作证明；` +
        `领取任务字段无可用文件，且本地剧目录未匹配到文件名或目录名包含“AI制作证明”的图片/PDF；` +
        `扫描目录=${localEpisodeVideoRoot}`,
    );
  }

  config.playlet.aiProductionProofFiles = [localFiles[0].file];
  return config.playlet.aiProductionProofFiles;
}
