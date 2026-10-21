import { writeJsonAtomic } from "@dramabridge/file-utils";
import path from "node:path";
import { z } from "zod";
import {
  douyinDramaAudienceValues,
  douyinDramaProductionCostRangeValues,
  douyinDramaPublishModeValues,
  douyinDramaUpdateStatusValues,
  type DouyinDramaRuntimeOptions,
} from "./types.js";
import { log } from "./logger.js";

export const douyinDramaStaticDropdownOptions = {
  updateStatus: [...douyinDramaUpdateStatusValues],
  aiDeclaration: ["是", "否"],
  aigcTools: ["红果漫剧创作Agent"],
  audience: [...douyinDramaAudienceValues],
  series: ["是", "否"],
  copyrightIpAdaptation: ["是", "否"],
  productionCostRange: [...douyinDramaProductionCostRangeValues],
  publishMode: [...douyinDramaPublishModeValues],
} as const;

export const douyinDramaDropdownSnapshotSchema = z.object({
  platform: z.literal("douyin-drama"),
  observedAt: z.string().datetime(),
  fields: z.record(z.string(), z.array(z.string().trim().min(1))),
});

export type DouyinDramaDropdownSnapshot = z.infer<typeof douyinDramaDropdownSnapshotSchema>;

function uniqueOptions(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function createDouyinDramaDropdownRecorder(options: DouyinDramaRuntimeOptions) {
  const fields: Record<string, string[]> = Object.fromEntries(
    Object.entries(douyinDramaStaticDropdownOptions).map(([key, values]) => [key, [...values]]),
  );

  const persist = async () => {
    const snapshot = douyinDramaDropdownSnapshotSchema.parse({
      platform: "douyin-drama",
      observedAt: new Date().toISOString(),
      fields,
    });
    if (!options.assetDownloadDir) return snapshot;
    const targetFile = path.join(options.assetDownloadDir, "observations", "dropdown-options.json");
    await writeJsonAtomic(targetFile, snapshot);
    log(options, "下拉选项记录已更新", { path: targetFile }, "config");
    return snapshot;
  };

  return {
    async record(field: string, values: string[]) {
      const normalized = uniqueOptions(values);
      if (normalized.length > 0) fields[field] = normalized;
      return persist();
    },
    snapshot() {
      return douyinDramaDropdownSnapshotSchema.parse({
        platform: "douyin-drama",
        observedAt: new Date().toISOString(),
        fields,
      });
    },
  };
}

export type DouyinDramaDropdownRecorder = ReturnType<typeof createDouyinDramaDropdownRecorder>;
