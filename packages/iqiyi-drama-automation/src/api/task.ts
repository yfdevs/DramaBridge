import { z } from "zod";
import { formatAutomationErrorReport, isBrowserClosedError } from "@dramabridge/automation-logging";

import {
  claimedIqiyiDramaTaskSchema,
  type ClaimedIqiyiDramaTask,
  type IqiyiDramaApiConfig,
  type IqiyiDramaRuntimeOptions,
  type IqiyiDramaTaskFailStage,
  type IqiyiDramaTaskStatus,
} from "../shared/types.js";
import { log } from "../shared/logger.js";
import { createIqiyiDramaHttpClient, type IqiyiDramaHttpClient } from "./http-client.js";

export type IqiyiDramaTaskApiEndpoints = {
  accountTaskPage: string;
  claimTask: string;
  reportTask: string;
};

export type IqiyiDramaTaskApiOptions = {
  apiConfig?: IqiyiDramaApiConfig;
  client?: IqiyiDramaHttpClient;
  endpoints?: Partial<IqiyiDramaTaskApiEndpoints>;
};

export type ClaimNextIqiyiDramaTaskOptions = IqiyiDramaTaskApiOptions & {
  runtimeOptions?: IqiyiDramaRuntimeOptions;
  rpaStatus?: IqiyiDramaTaskStatus;
};

export type IqiyiDramaTaskSuccessReport = IqiyiDramaTaskApiOptions & {
  runtimeOptions?: IqiyiDramaRuntimeOptions;
  accountTaskId: number;
  resultJson?: Record<string, unknown>;
};

export type IqiyiDramaTaskErrorReport = IqiyiDramaTaskApiOptions & {
  runtimeOptions?: IqiyiDramaRuntimeOptions;
  accountTaskId: number;
  failStage: IqiyiDramaTaskFailStage;
  errorMessage: string;
  resultJson?: Record<string, unknown>;
};

const defaultEndpoints: IqiyiDramaTaskApiEndpoints = {
  accountTaskPage: "/dramaAiRpa/iqiyi/accountTask/page",
  claimTask: "/dramaAiRpa/iqiyi/rpa/claim",
  reportTask: "/dramaAiRpa/iqiyi/rpa/report",
};
const readyTaskPageSize = 100;
const apiResponseBaseSchema = z.object({
  code: z.number(),
  msg: z.string().nullish(),
});

const readyTaskSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    dramaId: z.coerce.number().int().positive().optional(),
    accountId: z.string().trim().min(1),
    accountName: z.string().nullish(),
    status: z.string().nullish(),
    originalTitle: z.string().nullish(),
  })
  .passthrough();
const accountTaskPageResponseSchema = apiResponseBaseSchema.extend({
  data: z
    .object({
      total: z.coerce.number().int().nonnegative().optional(),
      data: z.array(readyTaskSchema),
    })
    .nullish(),
});
const claimDataSchema = z.object({
  accountTaskId: z.coerce.number().int().positive(),
  originalTitle: z.string().nullish(),
  accountId: z.string().nullish(),
  rpaProfileKey: z.string().nullish(),
  accountConfigJson: z.record(z.string(), z.unknown()).nullish(),
  payloadJson: z.unknown(),
});
const claimResponseSchema = apiResponseBaseSchema.extend({
  data: claimDataSchema.nullish(),
});
const claimPayloadJsonSchema = z
  .object({
    name: z.string().trim().min(1),
    copyright: z.unknown(),
    iqiyiPlaylet: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const reportResponseSchema = apiResponseBaseSchema.extend({
  data: z.boolean().nullish(),
});

type ReadyTask = z.infer<typeof readyTaskSchema>;
type ClaimData = z.infer<typeof claimDataSchema>;

function taskClient(options: IqiyiDramaTaskApiOptions) {
  if (options.client) return options.client;
  if (!options.apiConfig?.baseUrl.trim()) throw new Error("IQIYI_DRAMA_API_BASE_URL_REQUIRED");
  return createIqiyiDramaHttpClient(options.apiConfig);
}

function taskEndpoints(options: IqiyiDramaTaskApiOptions): IqiyiDramaTaskApiEndpoints {
  return { ...defaultEndpoints, ...options.endpoints };
}

function taskApiUnavailable(payload: z.infer<typeof apiResponseBaseSchema>) {
  return /爱奇艺账号发布任务暂未实现/u.test(payload.msg ?? "");
}

function assertApiSuccess(payload: z.infer<typeof apiResponseBaseSchema>, action: string) {
  if (payload.code !== 0) {
    throw new Error(`${action}: code=${payload.code} message=${payload.msg || "-"}`);
  }
}

function formatZodIssues(issues: z.ZodIssue[], playlet?: Record<string, unknown>): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === z.ZodIssueCode.invalid_union) {
      const branchIndex =
        playlet?.dramaType === "comic-drama"
          ? 0
          : playlet?.dramaType === "short-drama"
            ? playlet.paymentStatus === "免费"
              ? 2
              : 1
            : -1;
      if (branchIndex >= 0) {
        return formatZodIssues(issue.errors[branchIndex] ?? []);
      }
      const discriminatorIssues = issue.errors
        .flatMap((error) => error)
        .filter((item) => item.path[item.path.length - 1] === "dramaType");
      return formatZodIssues(discriminatorIssues.slice(0, 1));
    }
    return `${issue.path.join(".") || "task"}: ${issue.message}`;
  });
}

function normalizeClaimedTask(
  claimed: ClaimData,
  listed: ReadyTask | undefined,
  runtimeOptions: IqiyiDramaRuntimeOptions | undefined,
): ClaimedIqiyiDramaTask {
  const expectedAccountId = runtimeOptions?.iqiyiAccountId?.trim();
  const claimedAccountId = claimed.accountId?.trim();
  if (expectedAccountId && claimedAccountId && expectedAccountId !== claimedAccountId) {
    throw new Error(
      `IQIYI_DRAMA_CLAIMED_ACCOUNT_MISMATCH: expected=${expectedAccountId} actual=${claimedAccountId}`,
    );
  }

  const payload = claimPayloadJsonSchema.parse(
    typeof claimed.payloadJson === "string" ? JSON.parse(claimed.payloadJson) : claimed.payloadJson,
  );
  const playlet = {
    ...payload.iqiyiPlaylet,
    copyright: payload.copyright,
  };
  const result = claimedIqiyiDramaTaskSchema.safeParse({
    accountTaskId: claimed.accountTaskId,
    dramaId: listed?.dramaId,
    originalTitle: claimed.originalTitle ?? listed?.originalTitle ?? payload.name,
    iqiyiAccountId: claimedAccountId ?? listed?.accountId ?? expectedAccountId,
    iqiyiAccountName: listed?.accountName ?? runtimeOptions?.iqiyiAccountName,
    playlet,
  });
  if (result.success) return result.data;
  throw new Error(
    `IQIYI_DRAMA_CLAIMED_TASK_INVALID: ${formatZodIssues(result.error.issues, playlet).join("; ")}`,
  );
}

async function fetchReadyTasks(options: ClaimNextIqiyiDramaTaskOptions) {
  const accountId = options.runtimeOptions?.iqiyiAccountId?.trim();
  if (!accountId) throw new Error("IQIYI_DRAMA_ACCOUNT_ID_REQUIRED");

  const payload = accountTaskPageResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).accountTaskPage, {
      page: 1,
      pageSize: readyTaskPageSize,
      dramaId: null,
      originalTitle: null,
      accountId,
      accountName: null,
      status: options.rpaStatus ?? "READY",
      auditStatus: null,
    }),
  );
  if (taskApiUnavailable(payload)) {
    log(options.runtimeOptions ?? {}, "[iqiyi-drama] task API not deployed; polling idle");
    return [];
  }
  assertApiSuccess(payload, "IQIYI_DRAMA_ACCOUNT_TASK_PAGE_FAILED");
  return (payload.data?.data ?? []).filter(
    (task) => task.accountId === accountId && task.status === (options.rpaStatus ?? "READY"),
  );
}

async function claimTask(
  options: ClaimNextIqiyiDramaTaskOptions,
  accountTaskId: number,
  listedTask?: ReadyTask,
) {
  const payload = claimResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).claimTask, { accountTaskId }),
  );
  if (taskApiUnavailable(payload)) return null;
  assertApiSuccess(payload, "IQIYI_DRAMA_ACCOUNT_TASK_CLAIM_FAILED");
  if (!payload.data) return null;
  if (payload.data.accountTaskId !== accountTaskId) {
    throw new Error(
      `IQIYI_DRAMA_CLAIMED_TASK_ID_MISMATCH: expected=${accountTaskId} ` +
        `actual=${payload.data.accountTaskId}`,
    );
  }

  try {
    return normalizeClaimedTask(payload.data, listedTask, options.runtimeOptions);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await reportIqiyiDramaTaskErrorApi({
      ...options,
      accountTaskId: payload.data.accountTaskId,
      failStage: "OTHER",
      errorMessage,
    }).catch((reportError) => {
      log(
        options.runtimeOptions ?? {},
        `[iqiyi-drama] invalid claimed task report failed: accountTaskId=${accountTaskId} ` +
          `error=${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    });
    throw error;
  }
}

export async function claimNextIqiyiDramaTaskApi(
  options: ClaimNextIqiyiDramaTaskOptions,
): Promise<ClaimedIqiyiDramaTask | null> {
  const readyTasks = await fetchReadyTasks(options);
  if (readyTasks.length === 0) return null;

  log(options.runtimeOptions ?? {}, `[iqiyi-drama] fetched ${readyTasks.length} READY task(s)`);
  for (const listedTask of readyTasks) {
    try {
      const claimed = await claimTask(options, listedTask.id, listedTask);
      if (claimed) return claimed;
    } catch (error) {
      log(
        options.runtimeOptions ?? {},
        `[iqiyi-drama] task claim failed: accountTaskId=${listedTask.id} ` +
          `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
}

async function reportIqiyiDramaTask(
  options: IqiyiDramaTaskApiOptions & {
    taskId: number;
    success: boolean;
    failStage?: IqiyiDramaTaskFailStage;
    errorMessage?: string;
    resultJson?: Record<string, unknown>;
  },
) {
  const payload = reportResponseSchema.parse(
    await taskClient(options).post(taskEndpoints(options).reportTask, {
      taskId: options.taskId,
      success: options.success,
      failStage: options.failStage,
      errorMessage: options.errorMessage,
      resultJson: options.resultJson,
    }),
  );
  assertApiSuccess(payload, "IQIYI_DRAMA_ACCOUNT_TASK_REPORT_FAILED");
  if (payload.data === false) {
    throw new Error("IQIYI_DRAMA_ACCOUNT_TASK_REPORT_FAILED: data=false");
  }
}

export async function reportIqiyiDramaTaskSuccessApi(
  options: IqiyiDramaTaskSuccessReport,
): Promise<void> {
  await reportIqiyiDramaTask({
    ...options,
    taskId: options.accountTaskId,
    success: true,
  });
}

export async function reportIqiyiDramaTaskErrorApi(
  options: IqiyiDramaTaskErrorReport,
): Promise<void> {
  if (isBrowserClosedError(options.errorMessage)) return;
  const errorMessage = formatAutomationErrorReport(options.errorMessage, {
    fallbackMessage: "爱奇艺任务提交失败，未获取到具体错误原因",
  });
  await reportIqiyiDramaTask({
    ...options,
    taskId: options.accountTaskId,
    success: false,
    failStage: options.failStage,
    errorMessage,
  });
}
