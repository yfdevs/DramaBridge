import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";
import type {
  ClaimedMeituanDramaTask,
  MeituanCreationAccount,
  MeituanCreationTaskFailStage,
} from "../shared/types.js";
import { claimedMeituanDramaTaskSchema } from "../shared/types.js";

const requiredText = z.string().trim().min(1);
const nullableText = z.string().nullish();
const jsonRecord = z.record(z.string(), z.unknown());
const readyTaskPageSize = 100;

const apiResponseBaseSchema = z.object({
  code: z.number(),
  msg: z.string().nullish(),
});

const accountTaskSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    dramaId: z.coerce.number().int().positive().optional(),
    accountId: requiredText,
    accountName: nullableText,
    status: nullableText,
    originalTitle: nullableText,
  })
  .passthrough();

const accountTaskPageResponseSchema = apiResponseBaseSchema.extend({
  data: z
    .object({
      total: z.coerce.number().int().nonnegative().optional(),
      data: z.array(accountTaskSchema),
    })
    .nullish(),
});

const claimResponseDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: nullableText,
  accountId: nullableText,
  rpaProfileKey: nullableText,
  accountConfigJson: jsonRecord.nullish(),
  payloadJson: z.unknown(),
});

const normalizedClaimResponseDataSchema = claimResponseDataSchema.extend({
  originalTitle: requiredText,
  accountId: requiredText,
  payloadJson: z.union([jsonRecord, z.string()]),
});

const claimResponseSchema = apiResponseBaseSchema.extend({
  data: claimResponseDataSchema.nullish(),
});

const reportResponseSchema = apiResponseBaseSchema.extend({
  data: z.boolean().nullish(),
});

const imageSchema = z
  .object({
    key: z.string().trim().optional(),
    url: z.string().trim().optional(),
  })
  .passthrough();

const meituanContractFileSchema = z
  .object({
    fileUrl: z.string().trim().optional(),
    fileType: z.string().trim().optional(),
  })
  .passthrough();

export type MeituanReadyAccountTask = z.infer<typeof accountTaskSchema>;
export type MeituanClaimResponseData = z.infer<typeof claimResponseDataSchema>;

export type MeituanTaskReport = {
  taskId: number;
  success: boolean;
  externalId?: string;
  platformDramaId?: string;
  failStage?: MeituanCreationTaskFailStage;
  resultJson?: Record<string, unknown>;
  errorMessage?: string;
};

function apiUrl(apiBaseUrl: string, path: string) {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    throw new Error("MEITUAN_API_BASE_URL_REQUIRED");
  }
  return `${normalizedBaseUrl}${path}`;
}

async function postJson(
  apiBaseUrl: string,
  path: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
) {
  const response = await fetcher(apiUrl(apiBaseUrl, path), {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`MEITUAN_TASK_API_REQUEST_FAILED: path=${path} status=${response.status}`);
  }
  return response.json();
}

function assertApiSuccess(payload: z.infer<typeof apiResponseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

export async function fetchReadyMeituanAccountTasksApi(options: {
  apiBaseUrl: string;
  account: MeituanCreationAccount;
  fetcher?: typeof fetch;
}): Promise<MeituanReadyAccountTask[]> {
  const payload = accountTaskPageResponseSchema.parse(
    await postJson(
      options.apiBaseUrl,
      "/dramaAiRpa/meituan/accountTask/page",
      {
        page: 1,
        pageSize: readyTaskPageSize,
        dramaId: null,
        originalTitle: null,
        accountId: options.account.accountId,
        accountName: null,
        status: "READY",
        auditStatus: null,
      },
      options.fetcher ?? fetch,
    ),
  );
  assertApiSuccess(payload, "MEITUAN_ACCOUNT_TASK_PAGE_FAILED");

  return (payload.data?.data ?? [])
    .filter((task) => task.accountId === options.account.accountId && task.status === "READY")
    .slice(0, readyTaskPageSize);
}

export async function claimMeituanAccountTaskApi(options: {
  apiBaseUrl: string;
  accountTaskId: number;
  fetcher?: typeof fetch;
}): Promise<MeituanClaimResponseData | null> {
  void options;
  const response = await postJson(
    options.apiBaseUrl,
    "/dramaAiRpa/meituan/rpa/claim",
    { accountTaskId: options.accountTaskId },
    options.fetcher ?? fetch,
  );

  const payload = claimResponseSchema.parse(response);
  assertApiSuccess(payload, "MEITUAN_ACCOUNT_TASK_CLAIM_FAILED");
  return payload.data ?? null;
}

export async function reportMeituanAccountTaskApi(options: {
  apiBaseUrl: string;
  report: MeituanTaskReport;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (!options.report.success && isBrowserClosedError(options.report.errorMessage)) return;
  const report = options.report.success
    ? options.report
    : {
        ...options.report,
        errorMessage: formatAutomationErrorReport(options.report.errorMessage, {
          fallbackMessage: "美团任务提交失败，未获取到具体错误原因",
        }),
      };
  const payload = reportResponseSchema.parse(
    await postJson(
      options.apiBaseUrl,
      "/dramaAiRpa/meituan/rpa/report",
      report,
      options.fetcher ?? fetch,
    ),
  );
  assertApiSuccess(payload, "MEITUAN_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) {
    throw new Error("MEITUAN_ACCOUNT_TASK_REPORT_FAILED: data=false");
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const normalized = stringValue(item);
        return normalized ? [normalized] : [];
      })
    : [];
}

function parsePayloadJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return jsonRecord.parse(JSON.parse(value));
  }
  return jsonRecord.parse(value);
}

function meituanImageUrl(payload: Record<string, unknown>, key: string) {
  const images = z.array(imageSchema).safeParse(payload.meituanImages);
  if (!images.success) return undefined;
  return images.data.find((image) => image.key === key)?.url?.trim() || undefined;
}

function meituanContractFileUrl(
  payload: Record<string, unknown>,
  fileType: "CONTRACT" | "AUTHORIZATION",
) {
  const files = z.array(meituanContractFileSchema).safeParse(payload.meituanContractFiles);
  if (!files.success) return undefined;
  return (
    files.data.find((file) => file.fileType?.toUpperCase() === fileType)?.fileUrl?.trim() ||
    undefined
  );
}

function meituanTimeFieldValue(
  payload: Record<string, unknown>,
  extra: Record<string, unknown>,
  key: "expectedPremiereTimeText" | "otherPlatformPremiereDateText",
) {
  const extraValue = stringValue(extra[key]);
  const rootValue = stringValue(payload[key]);
  if (extraValue && rootValue && extraValue !== rootValue) {
    throw new Error(
      `美团任务时间字段冲突：payloadJson.meituanExtraInfo.${key}=${extraValue}，` +
        `payloadJson.${key}=${rootValue}`,
    );
  }
  return extraValue ?? rootValue;
}

export function normalizeClaimedMeituanDramaTask(options: {
  claimed: MeituanClaimResponseData;
  listedTask: MeituanReadyAccountTask;
  account: MeituanCreationAccount;
}): ClaimedMeituanDramaTask {
  const claimed = normalizedClaimResponseDataSchema.parse(options.claimed);
  if (claimed.accountId !== options.account.accountId) {
    throw new Error(
      `MEITUAN_CLAIMED_ACCOUNT_MISMATCH: expected=${options.account.accountId} ` +
        `actual=${claimed.accountId}`,
    );
  }

  const payload = parsePayloadJson(claimed.payloadJson);
  const extra = recordValue(payload.meituanExtraInfo);
  const posters = recordValue(payload.posters);
  const copyright = recordValue(payload.copyright);
  const productionProofFiles = stringArray(copyright.productionProofFiles);
  const licenseProofFiles = stringArray(copyright.licenseProofFiles);
  const fallbackProductionProofFile = meituanContractFileUrl(payload, "CONTRACT");
  const fallbackLicenseProofFile = meituanContractFileUrl(payload, "AUTHORIZATION");
  const playlet = {
    ...extra,
    baiduPanResourceLink: stringValue(payload.baiduPanResourceLink),
    collectionTitle: stringValue(extra.collectionTitle) ?? stringValue(payload.name),
    collectionCoverUrl:
      stringValue(extra.collectionCoverUrl) ??
      stringValue(posters.main) ??
      meituanImageUrl(payload, "collectionCover"),
    productionProofFiles:
      productionProofFiles.length > 0
        ? productionProofFiles
        : fallbackProductionProofFile
          ? [fallbackProductionProofFile]
          : [],
    licenseProofFiles:
      licenseProofFiles.length > 0
        ? licenseProofFiles
        : fallbackLicenseProofFile
          ? [fallbackLicenseProofFile]
          : [],
    expectedPremiereTimeText: meituanTimeFieldValue(payload, extra, "expectedPremiereTimeText"),
    otherPlatformPremiereDateText: meituanTimeFieldValue(
      payload,
      extra,
      "otherPlatformPremiereDateText",
    ),
    premiereProofUrl: meituanImageUrl(payload, "premiereProof"),
    totalEpisodes: numberValue(extra.totalEpisodes) ?? numberValue(payload.episodeCount),
    productionCompanyText:
      stringValue(extra.productionCompanyText) ?? stringValue(payload.producerName),
    plotSynopsisText: stringValue(extra.plotSynopsisText) ?? stringValue(payload.summary),
  };

  const result = claimedMeituanDramaTaskSchema.safeParse({
    accountTaskId: claimed.accountTaskId,
    dramaId: options.listedTask.dramaId,
    originalTitle: claimed.originalTitle,
    meituanAccountId: claimed.accountId,
    meituanAccountName: options.account.accountName,
    playlet,
  });
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
    .join("; ");
  throw new Error(`MEITUAN_CLAIMED_TASK_INVALID: ${details}`);
}
