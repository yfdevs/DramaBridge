import type { Page } from "playwright";
import {
  captureAutomationFailureDiagnostics,
  formatAutomationErrorReport,
} from "@dramabridge/automation-logging";
import { isNonRetryableBaiduNetdiskResourceError } from "@dramabridge/media-assets";
import { PINDUODUO_SHORTPLAY_APPLY_EDIT_URL } from "../shared/constants.js";
import {
  type ClaimNextPinduoduoDramaTaskOptions,
  claimNextPinduoduoDramaTaskApi,
  reportPinduoduoDramaTaskErrorApi,
  reportPinduoduoDramaTaskSuccessApi,
} from "../api/task.js";
import { log } from "../shared/logger.js";
import {
  pinduoduoDramaClaimedTaskSchema,
  type ClaimedPinduoduoDramaTask,
  type PinduoduoDramaRuntimeOptions,
} from "../shared/types.js";
import {
  PinduoduoApplyRecordsRepository,
  type PinduoduoTrackedApplyRecord,
} from "../storage/index.js";
import { runPinduoduoApprovedShortplayFlow } from "./approved-shortplay-flow.js";
import { uploadPinduoduoContractFiles } from "./contract-upload.js";
import {
  PinduoduoShortplayApplyEditError,
  submitPinduoduoShortplayApplyEdit,
} from "./shortplay-apply.js";
import {
  fetchSubmittedShortplayApplyRecords,
  findSubmittedShortplayApplyRecord,
  type ShortplayApplyRecord,
  refreshShortplayManagePendingList,
  selectShortplayManageRowByTitle,
  submitSelectedShortplaysForAudit,
} from "./shortplay-manage-page.js";

const VIDEO_RESOURCE_DOWNLOAD_RETRY_DELAY_MS = 5_000;
const SUBMITTED_SHORTPLAY_AUDIT_LIST_PAGE_SIZE = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function claimOptions(
  options: PinduoduoDramaRuntimeOptions,
  rpaStatus: ClaimNextPinduoduoDramaTaskOptions["rpaStatus"],
): ClaimNextPinduoduoDramaTaskOptions {
  return {
    apiConfig: options.config?.api,
    pinduoduoAccountName: options.accountProfileName,
    rpaStatus,
  };
}

async function capturePinduoduoFailure(
  page: Page | undefined,
  options: PinduoduoDramaRuntimeOptions,
  error: unknown,
  stage: string,
  task: { accountTaskId: number; dramaId?: number; title?: string },
) {
  const diagnostics = await captureAutomationFailureDiagnostics({
    platform: "pinduoduo-drama",
    error,
    page,
    logFilePath: options.logFilePath,
    stage,
    task,
  });
  log(options, "error", "runtime", "failure diagnostics saved", {
    accountTaskId: task.accountTaskId,
    diagnosticDir: diagnostics?.directory,
  });
}

async function claimAndSubmitApplyTask(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  applyRecordsRepository: PinduoduoApplyRecordsRepository,
): Promise<boolean> {
  const task = await claimNextPinduoduoDramaTaskApi(claimOptions(options, "READY"));
  if (!task) return false;

  log(options, "info", "runtime", "claimed pinduoduo drama task, submitting shortplay apply edit", {
    accountTaskId: task.accountTaskId,
    dramaId: task.dramaId,
    title: task.playlet.title,
  });

  try {
    log(options, "info", "runtime", "shortplay apply edit request", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      title: task.playlet.title,
      url: PINDUODUO_SHORTPLAY_APPLY_EDIT_URL,
    });

    const response = await submitPinduoduoShortplayApplyEdit(page, task);
    log(options, "info", "runtime", "shortplay apply edit submitted", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      response,
    });
    await refreshShortplayManagePendingList(page, options, task.playlet.title).catch(
      (refreshError: unknown) => {
        log(options, "warn", "runtime", "failed to refresh shortplay manage pending list", {
          accountTaskId: task.accountTaskId,
          dramaId: task.dramaId,
          error: refreshError,
        });
      },
    );
    const selected = await selectShortplayManageRowByTitle(page, options, task.playlet.title);
    if (!selected) {
      throw new Error(`Pinduoduo submitted shortplay row was not selected: ${task.playlet.title}`);
    }

    await uploadPinduoduoContractFiles(page, options, task);
    await submitSelectedShortplaysForAudit(page, options);

    const submittedRecord = await findSubmittedShortplayApplyRecord(
      page,
      options,
      task.playlet.title,
    );

    await reportPinduoduoDramaTaskSuccessApi({
      apiConfig: options.config?.api,
      accountTaskId: task.accountTaskId,
      resultJson: {
        auditStatus: "PENDING",
        platformApplyId: submittedRecord?.id,
        platformStatus: submittedRecord?.status,
        title: task.playlet.title,
      },
      rpaStatus: "AUDIT_PENDING",
    });

    // 后端成功接收提报结果后，再写入本地数据库用于后续审核轮询。
    applyRecordsRepository.upsertSubmittedRecord(task, submittedRecord);
  } catch (error) {
    const errorMessage = formatAutomationErrorReport(error, {
      fallbackMessage: "拼多多短剧申报提交失败，未获取到具体错误原因",
    });
    await capturePinduoduoFailure(page, options, error, "SUBMIT_SHORTPLAY", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      title: task.playlet.title,
    });
    log(options, "error", "runtime", "failed to submit shortplay apply edit", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      error,
    });
    await reportPinduoduoDramaTaskErrorApi({
      apiConfig: options.config?.api,
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      failStage: "SUBMIT_SHORTPLAY",
      errorMessage,
      resultJson: {
        activeUrl: page.url(),
        applyEditResponse:
          error instanceof PinduoduoShortplayApplyEditError ? error.response : undefined,
      },
    }).catch((reportError: unknown) => {
      log(options, "error", "runtime", "failed to report shortplay apply edit error", {
        accountTaskId: task.accountTaskId,
        error: reportError,
      });
    });
  }

  return true;
}

async function checkLocalAuditTask(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  applyRecordsRepository: PinduoduoApplyRecordsRepository,
): Promise<boolean> {
  const trackedRecords = applyRecordsRepository.findDueAuditRecords();
  if (!trackedRecords.length) return false;

  const submittedRecords = await fetchSubmittedShortplayApplyRecords(page, options, {
    page: 1,
    pageSize: SUBMITTED_SHORTPLAY_AUDIT_LIST_PAGE_SIZE,
  });
  log(options, "info", "runtime", "checking due pinduoduo audit records in batch", {
    dueRecords: trackedRecords.length,
    submittedRecords: submittedRecords.records.length,
    submittedTotalCount: submittedRecords.totalCount,
  });

  for (const trackedRecord of trackedRecords) {
    const record = matchSubmittedShortplayApplyRecord(submittedRecords.records, trackedRecord);
    await reportAndUpdateAuditRecord(page, options, applyRecordsRepository, trackedRecord, record);
  }

  return true;
}

function matchSubmittedShortplayApplyRecord(
  records: ShortplayApplyRecord[],
  trackedRecord: PinduoduoTrackedApplyRecord,
): ShortplayApplyRecord | null {
  return (
    (trackedRecord.platformApplyId
      ? records.find((nextRecord) => nextRecord.id === trackedRecord.platformApplyId)
      : undefined) ??
    records.find((nextRecord) => nextRecord.title === trackedRecord.title) ??
    null
  );
}

async function reportAndUpdateAuditRecord(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  applyRecordsRepository: PinduoduoApplyRecordsRepository,
  trackedRecord: PinduoduoTrackedApplyRecord,
  record: ShortplayApplyRecord | null,
): Promise<void> {
  try {
    if (!record) {
      const errorMessage = `在平台最近 ${SUBMITTED_SHORTPLAY_AUDIT_LIST_PAGE_SIZE} 条已提交记录中未找到该短剧，无法确认审核状态。`;
      const resultJson = {
        activeUrl: page.url(),
        checkedSubmittedRecordCount: SUBMITTED_SHORTPLAY_AUDIT_LIST_PAGE_SIZE,
        platformApplyId: trackedRecord.platformApplyId,
        title: trackedRecord.title,
      };
      applyRecordsRepository.markAuditRecordMissing(trackedRecord, errorMessage, resultJson);
      await reportPinduoduoDramaTaskErrorApi({
        apiConfig: options.config?.api,
        accountTaskId: trackedRecord.accountTaskId,
        dramaId: trackedRecord.dramaId,
        errorMessage,
        failStage: "CHECK_AUDIT",
        resultJson,
      });
      return;
    }

    if (record.status === 3) {
      const errorMessage = record.rejectReason || "拼多多短剧审核未通过，平台未返回具体驳回原因。";
      await reportPinduoduoDramaTaskErrorApi({
        apiConfig: options.config?.api,
        accountTaskId: trackedRecord.accountTaskId,
        dramaId: trackedRecord.dramaId,
        errorMessage,
        failStage: "CHECK_AUDIT",
        resultJson: {
          activeUrl: page.url(),
          platformApplyId: trackedRecord.platformApplyId,
          title: trackedRecord.title,
        },
      });
      applyRecordsRepository.markAuditChecked(trackedRecord, "REJECTED", record);
      return;
    }

    if (record.status === 1) {
      await reportPinduoduoDramaTaskSuccessApi({
        apiConfig: options.config?.api,
        accountTaskId: trackedRecord.accountTaskId,
        resultJson: {
          auditStatus: "PENDING",
          platformApplyId: record.id,
          platformStatus: record.status,
          title: record.title,
        },
        rpaStatus: "AUDIT_PENDING",
      });
      applyRecordsRepository.markAuditChecked(trackedRecord, "PENDING", record);
      return;
    }

    await reportPinduoduoDramaTaskSuccessApi({
      apiConfig: options.config?.api,
      accountTaskId: trackedRecord.accountTaskId,
      resultJson: {
        auditStatus: "APPROVED",
        platformApplyId: record.id,
        platformStatus: record.status,
        title: record.title,
      },
      rpaStatus: "VIDEO_UPLOAD_READY",
    });
    applyRecordsRepository.markAuditChecked(trackedRecord, "APPROVED", record);
  } catch (error) {
    const errorMessage = formatAutomationErrorReport(error, {
      fallbackMessage: "拼多多短剧审核状态检查失败，未获取到具体错误原因",
    });
    await capturePinduoduoFailure(page, options, error, "CHECK_AUDIT", {
      accountTaskId: trackedRecord.accountTaskId,
      dramaId: trackedRecord.dramaId,
      title: trackedRecord.title,
    });
    await reportPinduoduoDramaTaskErrorApi({
      apiConfig: options.config?.api,
      accountTaskId: trackedRecord.accountTaskId,
      dramaId: trackedRecord.dramaId,
      errorMessage,
      failStage: "CHECK_AUDIT",
      resultJson: {
        activeUrl: page.url(),
        platformApplyId: trackedRecord.platformApplyId,
        title: trackedRecord.title,
      },
    });
  }
}

async function ensurePinduoduoVideoResourceReady(
  options: PinduoduoDramaRuntimeOptions,
  task: ClaimedPinduoduoDramaTask,
): Promise<void> {
  const shareText = task.playlet.demoUrl.trim();
  const localEpisodeVideoRoot = options.config?.video?.localEpisodeVideoRoot?.trim();
  if (!localEpisodeVideoRoot) {
    throw new Error("PINDUODUO_LOCAL_VIDEO_ROOT_REQUIRED");
  }
  if (!options.ensureBaiduNetdiskResource) {
    throw new Error("Pinduoduo video upload task requires Baidu Netdisk download integration.");
  }

  const retryAttempts = Math.max(
    0,
    Number.parseInt(String(options.config?.video?.baiduNetdiskDownloadRetryAttempts ?? 3), 10) || 3,
  );
  const maxAttempts = retryAttempts + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await options.ensureBaiduNetdiskResource({
        episodeCount: task.playlet.episodeCount,
        localEpisodeVideoRoot,
        resourceName: task.originalTitle,
        shareText,
      });
      return;
    } catch (error) {
      lastError = error;
      if (isNonRetryableBaiduNetdiskResourceError(error) || attempt >= maxAttempts) break;
      await sleep(VIDEO_RESOURCE_DOWNLOAD_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function trackedRecordToTask(record: PinduoduoTrackedApplyRecord): ClaimedPinduoduoDramaTask {
  return pinduoduoDramaClaimedTaskSchema.parse({
    accountTaskId: record.accountTaskId,
    dramaId: record.dramaId,
    originalTitle: record.originalTitle,
    pinduoduoAccountId: record.pinduoduoAccountId,
    pinduoduoAccountName: record.pinduoduoAccountName,
    playlet: JSON.parse(record.payloadJson) as unknown,
  });
}

async function prepareLocalVideoResourceTask(
  options: PinduoduoDramaRuntimeOptions,
  applyRecordsRepository: PinduoduoApplyRecordsRepository,
  trackedRecord: PinduoduoTrackedApplyRecord,
): Promise<boolean> {
  const task = trackedRecordToTask(trackedRecord);

  try {
    await ensurePinduoduoVideoResourceReady(options, task);
    await reportPinduoduoDramaTaskSuccessApi({
      apiConfig: options.config?.api,
      accountTaskId: task.accountTaskId,
      resultJson: {
        localEpisodeVideoRoot: options.config?.video?.localEpisodeVideoRoot,
        originalTitle: task.originalTitle,
        title: task.playlet.title,
        videoResourceStatus: "READY",
      },
      rpaStatus: "VIDEO_RESOURCE_READY",
    });
    applyRecordsRepository.markVideoResourceReady(trackedRecord);
    return true;
  } catch (error) {
    const errorMessage = formatAutomationErrorReport(error, {
      fallbackMessage: "拼多多视频素材准备失败，未获取到具体错误原因",
    });
    await capturePinduoduoFailure(undefined, options, error, "PREPARE_VIDEO_RESOURCE", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      title: task.playlet.title,
    });
    await reportPinduoduoDramaTaskErrorApi({
      apiConfig: options.config?.api,
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      errorMessage,
      failStage: "PREPARE_VIDEO_RESOURCE",
      resultJson: {
        originalTitle: task.originalTitle,
        title: task.playlet.title,
      },
    });
    return false;
  }
}

async function runApprovedShortplayFlowTask(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  applyRecordsRepository: PinduoduoApplyRecordsRepository,
  trackedRecord: PinduoduoTrackedApplyRecord,
): Promise<boolean> {
  const task = trackedRecordToTask(trackedRecord);

  try {
    const result = await runPinduoduoApprovedShortplayFlow(page, options, task);
    await reportPinduoduoDramaTaskSuccessApi({
      apiConfig: options.config?.api,
      accountTaskId: task.accountTaskId,
      resultJson: {
        contentManagementUrl: result.contentManagementUrl,
        originalTitle: task.originalTitle,
        title: task.playlet.title,
        videoStatus: "UPLOADING",
      },
      rpaStatus: "VIDEO_UPLOADING",
    });
    await options.cleanupBaiduNetdiskResourceAfterTaskSuccess?.({
      shareText: task.playlet.demoUrl,
      resourceName: task.originalTitle,
    }).catch((error) => log(options, "warn", "runtime", "task succeeded but baidu netdisk cleanup failed", {
      accountTaskId: task.accountTaskId,
      error,
    }));
    applyRecordsRepository.markVideoUploading(trackedRecord);
    return true;
  } catch (error) {
    const errorMessage = formatAutomationErrorReport(error, {
      fallbackMessage: "拼多多视频上传失败，未获取到具体错误原因",
    });
    await capturePinduoduoFailure(page, options, error, "UPLOAD_VIDEO", {
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      title: task.playlet.title,
    });
    await reportPinduoduoDramaTaskErrorApi({
      apiConfig: options.config?.api,
      accountTaskId: task.accountTaskId,
      dramaId: task.dramaId,
      errorMessage,
      failStage: "UPLOAD_VIDEO",
      resultJson: {
        activeUrl: page.url(),
        originalTitle: task.originalTitle,
        title: task.playlet.title,
      },
    });
    return false;
  }
}

async function runApprovedShortplayQueue(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  applyRecordsRepository: PinduoduoApplyRecordsRepository,
): Promise<boolean> {
  const trackedRecords = applyRecordsRepository.findApprovedVideoQueueRecords();
  if (!trackedRecords.length) return false;

  log(options, "info", "runtime", "processing approved pinduoduo shortplay upload queue", {
    queuedRecords: trackedRecords.length,
  });

  for (const trackedRecord of trackedRecords) {
    if (trackedRecord.videoStatus === "READY") {
      const prepared = await prepareLocalVideoResourceTask(
        options,
        applyRecordsRepository,
        trackedRecord,
      );
      if (!prepared) continue;
    }

    await runApprovedShortplayFlowTask(page, options, applyRecordsRepository, trackedRecord);
  }

  return true;
}

export async function claimAndSubmitNextTask(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
): Promise<void> {
  const applyRecordsRepository = new PinduoduoApplyRecordsRepository(options);
  let checkedAuditRecords = false;
  let processedApprovedQueue = false;
  try {
    checkedAuditRecords = await checkLocalAuditTask(page, options, applyRecordsRepository);
    processedApprovedQueue = await runApprovedShortplayQueue(page, options, applyRecordsRepository);
    if (checkedAuditRecords || processedApprovedQueue) return;
    if (await claimAndSubmitApplyTask(page, options, applyRecordsRepository)) return;
  } finally {
    applyRecordsRepository.close();
  }

  log(options, "info", "runtime", "no pinduoduo drama task to run");
}
