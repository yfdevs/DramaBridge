import { createHash } from "node:crypto";
import path from "node:path";
import {
  compressImageForUpload,
  type ImageCompressionPolicy,
} from "@dramabridge/media-assets";
import { getWechatVideoRuntimeSettings } from "./runtime-settings.js";
import type { Config } from "./types.js";

const compressibleImageExtensions = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);

function positiveMegabytes(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWechatImageCompressionPolicy(): ImageCompressionPolicy {
  const settings = getWechatVideoRuntimeSettings();
  return {
    compressAboveBytes: positiveMegabytes(settings.imageCompressionThresholdMegabytes, 10) * 1_000_000,
    targetFileBytes: positiveMegabytes(settings.imageCompressionTargetMegabytes, 9) * 1_000_000,
  };
}

export async function prepareWechatImageUploadMaterials(options: {
  config: Config;
  outputDir: string;
  onLog?: (message: string) => void;
}) {
  const policy = getWechatImageCompressionPolicy();
  const preparedBySource = new Map<string, string>();

  const prepareFile = async (file: string) => {
    if (/^https?:\/\//iu.test(file) || !compressibleImageExtensions.has(path.extname(file).toLowerCase())) {
      return file;
    }
    const sourceKey = path.resolve(file).toLowerCase();
    const existing = preparedBySource.get(sourceKey);
    if (existing) return existing;
    const digest = createHash("sha256").update(sourceKey).digest("hex").slice(0, 12);
    const prepared = await compressImageForUpload({
      inputFile: file,
      outputDir: options.outputDir,
      outputFileName: `${path.parse(file).name}-${digest}.jpg`,
      policy,
      onLog: options.onLog,
    });
    preparedBySource.set(sourceKey, prepared.file);
    return prepared.file;
  };
  const prepareFiles = async (files: string[] | undefined) => files
    ? Promise.all(files.map(prepareFile))
    : undefined;

  const playlet = options.config.playlet;
  playlet.posters.main = await prepareFile(playlet.posters.main);
  if (playlet.posters.promotion) playlet.posters.promotion = await prepareFile(playlet.posters.promotion);
  playlet.aiProductionProofFiles = await prepareFiles(playlet.aiProductionProofFiles);
  playlet.copyright.productionProofFiles = await prepareFiles(playlet.copyright.productionProofFiles);
  if (playlet.productionCost) {
    playlet.productionCost.proofFiles = await prepareFiles(playlet.productionCost.proofFiles);
  }
  return options.config;
}
