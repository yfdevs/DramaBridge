import type {
  KuaishouDramaConfig,
  KuaishouDramaRuntimeOptions,
  KuaishouDramaTaskConfig,
  KuaishouDramaTaskInput,
} from "./types.js";
import { kuaishouDramaTaskSchema } from "./types.js";

const taskKeys: Array<keyof KuaishouDramaTaskInput> = [
  "title",
  "episodeCount",
  "baiduPanResourceLink",
  "publishType",
  "adVersionCount",
  "adVersionTitles",
  "adVersion2Title",
  "adVersion3Title",
  "adVersion4Title",
  "adVersion5Title",
  "adVersion6Title",
  "adVersion7Title",
  "adVersion8Title",
  "fullDramaPriceYuan",
  "localCoverFile",
  "summary",
  "genderChannel",
  "categories",
  "plotTags",
  "contentType",
  "productionMethod",
  "isCompleted",
  "fullSceneDisplay",
  "copyrightProofType",
  "copyrightMaterials",
  "copyrightValidityStartDate",
  "copyrightValidityEndDate",
  "sublicensingRight",
  "hasRecordNumber",
  "authorDeclaration",
  "productionYear",
  "productionCostWan",
  "averageEpisodeDurationMinutes",
  "broadcastPlatform",
  "broadcastPaths",
  "broadcastDate",
  "productionOrganization",
  "specialSubjectInvolved",
];

function taskSource(
  config: KuaishouDramaConfig | undefined,
): Partial<KuaishouDramaTaskInput> | KuaishouDramaTaskInput | undefined {
  return config?.task ?? config;
}

function hasTaskConfig(config: KuaishouDramaConfig | undefined) {
  const task = taskSource(config);
  return Boolean(task && taskKeys.some((key) => task[key] !== undefined));
}

export function parseTaskConfig(
  options: KuaishouDramaRuntimeOptions,
): KuaishouDramaTaskConfig | null {
  if (!hasTaskConfig(options.config)) {
    return null;
  }

  const result = kuaishouDramaTaskSchema.safeParse(taskSource(options.config));
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
    .join("; ");
  throw new Error(`KUAISHOU_DRAMA_TASK_CONFIG_INVALID: ${details}`);
}
