import { randomInt } from "node:crypto";
import type { LocalOwnershipMaterialFile } from "@dramabridge/media-assets";
import type { Config } from "./types.js";

export async function prepareWechatAiProductionProofMaterials(
  config: Config,
  ownership: readonly LocalOwnershipMaterialFile[],
): Promise<string[]> {
  if (!(config.playlet.aiContent ?? true)) {
    config.playlet.aiProductionProofFiles = [];
    return [];
  }

  if (ownership.length === 0) {
    throw new Error("[production-proof-invalid] 开启AI内容声明后没有可用的权属图片。");
  }
  const selected = ownership[randomInt(ownership.length)]!;
  config.playlet.aiProductionProofFiles = [selected.file];
  return config.playlet.aiProductionProofFiles;
}
