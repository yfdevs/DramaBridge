import {
  findOwnershipProjectProofFiles,
  listLocalOwnershipMaterials,
  type LocalOwnershipMaterialFile,
} from "@dramabridge/media-assets";
import { getWechatVideoRuntimeSettings } from "./runtime-settings.js";
import type { Config } from "./types.js";

type OwnershipAiClient = NonNullable<Parameters<typeof findOwnershipProjectProofFiles>[0]["aiClient"]>;

function positiveProofCount(value: string) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 4;
}

export function getWechatOwnershipProofCounts() {
  const settings = getWechatVideoRuntimeSettings();
  return {
    jianying: positiveProofCount(settings.jianyingOwnershipProofCount),
    juchuang: positiveProofCount(settings.juchuangOwnershipProofCount),
  };
}

export function getWechatOwnershipRequirements() {
  const counts = getWechatOwnershipProofCounts();
  return { minimumImages: counts.jianying + counts.juchuang };
}

export async function loadWechatOwnershipMaterials(
  config: Config,
): Promise<LocalOwnershipMaterialFile[]> {
  const localEpisodeVideoRoot = getWechatVideoRuntimeSettings().localEpisodeVideoRoot.trim();
  const ownership = await listLocalOwnershipMaterials({
    root: localEpisodeVideoRoot,
    resourceName: config.originalTitle,
  });
  const required = getWechatOwnershipRequirements().minimumImages;
  if (ownership.length < required) {
    throw new Error(
      `[production-proof-invalid] 微信视频号权属材料不足：至少需要${required}张非竖图工程截图，` +
        `实际找到${ownership.length}张；扫描目录=${localEpisodeVideoRoot}`,
    );
  }
  return ownership;
}

export async function prepareWechatProductionProofMaterials(
  config: Config,
  aiClient: OwnershipAiClient,
) {
  const localEpisodeVideoRoot = getWechatVideoRuntimeSettings().localEpisodeVideoRoot.trim();
  const ownership = await findOwnershipProjectProofFiles({
    root: localEpisodeVideoRoot,
    resourceName: config.originalTitle,
    aiClient,
    filesPerKind: getWechatOwnershipProofCounts(),
  });
  config.playlet.copyright ??= {};
  config.playlet.copyright.productionProofFiles = ownership.files;

  return config.playlet.copyright.productionProofFiles;
}
