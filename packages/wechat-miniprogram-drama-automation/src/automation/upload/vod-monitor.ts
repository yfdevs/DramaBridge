import { writeJsonAtomic } from "@dramabridge/file-utils";
import type { Page, Request, Response } from "playwright";
import { resolveRunDataPath } from "../../shared/config.js";
import { minutesToMs } from "../../shared/settings-value.js";
import type {
  VodUploadFailure,
  VodUploadObservation,
  VodUploadReport,
  VodUploadSuccess,
} from "../../shared/types.js";
import { createLogger } from "../../shared/logger.js";

const vodLogger = createLogger("upload");
const uploadProgressPollMs = 2_000;

export interface VodUploadProgressContext {
  batchIndex?: number;
  batchCount?: number;
  completedBefore?: number;
  totalCount?: number;
  accountName?: string;
  maxRetryAttempts?: number;
  startedAt?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
  writeReport?: boolean;
}

interface PageUploadProgress {
  signature: string;
  summary: string;
  failure?: string;
}

const failedUploadPattern = /上传失败|未能上传|上传异常|上传出错/;
const retryStateWaitMs = 30_000;
const missingUploadPageTimeoutMs = 30_000;

function interruptionError(signal?: AbortSignal, fallback = "上传任务已终止。"): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(fallback);
  error.name = "AbortError";
  return error;
}

function parseJsonPayload(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isVodUploadReportRequest(request: Request): boolean {
  return request.method().toUpperCase() === "POST" && request.url() === "https://vodreport.qcloud.com/ugcupload_new";
}

function isVodUploadFinishedResponse(response: Response): boolean {
  return response.request().method().toUpperCase() === "POST"
    && response.url().includes("https://mp.weixin.qq.com/webpocnew/cgi/playletUpload/onVodCliSdkUploadFinished");
}

function readVodObservation(request: Request): VodUploadObservation | null {
  if (!isVodUploadReportRequest(request)) return null;

  const payload = objectValue(parseJsonPayload(request.postData()));
  const fileId = stringValue(payload?.fileId);
  const fileName = stringValue(payload?.fileName);
  if (!fileId || !fileName) return null;

  return {
    fileId,
    fileName,
    fileSize: numberValue(payload?.fileSize),
    reqKey: stringValue(payload?.reqKey),
    reqTime: numberValue(payload?.reqTime),
    observedAt: new Date().toISOString(),
  };
}

function readVodFinishedRequestFileId(request: Request): string | undefined {
  const payload = objectValue(parseJsonPayload(request.postData()));
  return stringValue(payload?.fileId);
}

async function readVodFinishedResponse(
  response: Response,
  fileNameById: Map<string, string>,
): Promise<VodUploadSuccess | VodUploadFailure | null> {
  if (!isVodUploadFinishedResponse(response)) return null;

  const body = objectValue(await response.json().catch(() => null));
  if (!body) return null;

  const fileId = stringValue(body.fileId) ?? readVodFinishedRequestFileId(response.request());
  const name = stringValue(body.name);

  if (fileId && name) {
    return {
      fileId,
      fileName: name,
      fileSize: stringValue(body.fileSize),
      duration: numberValue(body.duration),
      uploadTime: numberValue(body.uploadTime),
      observedAt: new Date().toISOString(),
    };
  }

  const nestedMessage = stringValue(body.msg);
  const parsedNested = objectValue(parseJsonPayload(nestedMessage ?? null));
  let errMsg = stringValue(body.errMsg) ?? stringValue(parsedNested?.errMsg) ?? nestedMessage;
  if (errMsg === "{}" || errMsg === "null" || errMsg?.trim() === "") {
    errMsg = undefined;
  }

  const retInNode = numberValue(body.retInNode);
  if (!errMsg && (retInNode === 0 || retInNode === undefined)) {
    if (!fileId) return null;
    return {
      fileId,
      fileName: fileNameById.get(fileId) ?? "Unknown Video",
      fileSize: stringValue(body.fileSize),
      duration: numberValue(body.duration),
      uploadTime: numberValue(body.uploadTime),
      observedAt: new Date().toISOString(),
    };
  }

  return {
    fileId,
    fileName: fileId ? fileNameById.get(fileId) : undefined,
    errMsg: errMsg ?? `VOD upload failed with retInNode=${retInNode}`,
    retInNode,
    observedAt: new Date().toISOString(),
  };
}

async function writeVodUploadReport(report: VodUploadReport): Promise<void> {
  const reportPath = resolveRunDataPath("episode-vod-upload-report.json");
  await writeJsonAtomic(reportPath, report);
  vodLogger.info("上传诊断报告已保存", { path: reportPath });
}

async function readPageUploadProgress(page: Page): Promise<PageUploadProgress | null> {
  const rowTexts = (await page.locator("table tbody tr:visible").allInnerTexts().catch(() => []))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (rowTexts.length === 0) return null;

  const failedCount = rowTexts.filter((text) => failedUploadPattern.test(text)).length;
  const failure = rowTexts.find((text) => failedUploadPattern.test(text));
  const succeededCount = rowTexts.filter((text) => /上传成功|上传完成|已上传|处理完成/.test(text)).length;
  const uploadingCount = rowTexts.filter((text) => /上传中|正在上传|等待上传|处理中/.test(text)).length;
  const percentages = Array.from(new Set(rowTexts.flatMap((text) =>
    Array.from(text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g), (match) => `${match[1]}%`)
  )));
  const parts = [
    succeededCount > 0 ? `页面成功 ${succeededCount} 个` : "",
    uploadingCount > 0 ? `上传中 ${uploadingCount} 个` : "",
    failedCount > 0 ? `上传失败 ${failedCount} 个，准备重试` : "",
    percentages.length > 0 ? `文件进度 ${percentages.join("、")}` : "",
  ].filter(Boolean);
  const summary = parts.join("，") || `上传列表 ${rowTexts.length} 个文件，等待状态更新`;

  return {
    signature: `${succeededCount}|${uploadingCount}|${percentages.join(",")}|${failure ?? ""}`,
    summary,
    failure,
  };
}

async function retryFailedEpisodeRows(
  page: Page,
  retryAttemptsByFile: Map<string, number>,
  retryPendingSinceByFile: Map<string, number>,
  maxRetryAttempts: number,
  startedAt: number,
  timeout: number,
  accountName?: string,
): Promise<void> {
  const rows = page.locator("table tbody tr:visible");
  const rowCount = await rows.count();
  const failedFileNames = new Set<string>();

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);
    const rowText = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!failedUploadPattern.test(rowText)) continue;

    const fileName = (
      await row.locator("td.table-name").first().innerText().catch(() => "")
      || await row.locator("td").first().innerText().catch(() => "")
      || `第 ${rowIndex + 1} 行剧集文件`
    ).replace(/\s+/g, " ").trim();
    failedFileNames.add(fileName);

    const pendingSince = retryPendingSinceByFile.get(fileName);
    if (pendingSince && Date.now() - pendingSince < retryStateWaitMs) continue;

    const attempts = retryAttemptsByFile.get(fileName) ?? 0;
    if (attempts >= maxRetryAttempts) {
      throw new Error(
        `[upload-failed] 剧集视频 ${fileName}: 重试 ${attempts} 次后仍显示“上传失败”。`,
      );
    }

    const retryLink = row
      .locator("a.error_link, a.action-link")
      .filter({ hasText: /^\s*重试\s*$/ })
      .first();
    if ((await retryLink.count()) === 0 || !await retryLink.isVisible().catch(() => false)) {
      throw new Error(
        `[upload-failed] 剧集视频 ${fileName}: 页面显示“上传失败”，但找不到可点击的“重试”。`,
      );
    }

    const nextAttempt = attempts + 1;
    retryAttemptsByFile.set(fileName, nextAttempt);
    retryPendingSinceByFile.set(fileName, Date.now());
    vodLogger.warn("剧集上传失败，准备重试", {
      accountName,
      fileName,
      attempt: nextAttempt,
      maxAttempts: maxRetryAttempts,
      elapsedMinutes: Math.round((Date.now() - startedAt) / 6000) / 10,
      timeoutMinutes: Math.round(timeout / 60000),
    });

    await retryLink.scrollIntoViewIfNeeded().catch(() => undefined);
    await retryLink.click({ timeout: 15000 });
    vodLogger.info("已点击剧集上传重试", {
      accountName,
      fileName,
      attempt: nextAttempt,
      maxAttempts: maxRetryAttempts,
    });

    const failureStatus = row.locator("p.error-text, div.status-error")
      .filter({ hasText: failedUploadPattern })
      .first();
    const leftFailureState = await failureStatus.waitFor({
      state: "hidden",
      timeout: 1000,
    }).then(() => true, () => false);
    if (leftFailureState) {
      retryPendingSinceByFile.delete(fileName);
    } else {
      vodLogger.info("已点击重试，等待页面更新上传状态", {
        accountName,
        fileName,
        attempt: nextAttempt,
        stateWaitSeconds: retryStateWaitMs / 1000,
      });
    }
  }

  for (const fileName of retryPendingSinceByFile.keys()) {
    if (!failedFileNames.has(fileName)) retryPendingSinceByFile.delete(fileName);
  }
}

export async function monitorEpisodeVodUploads(
  page: Page,
  expectedCount: number,
  action: () => Promise<void>,
  timeout = minutesToMs(120),
  progressContext: VodUploadProgressContext = {},
): Promise<VodUploadReport> {
  if (progressContext.signal?.aborted) {
    throw interruptionError(progressContext.signal);
  }
  const observationsById = new Map<string, VodUploadObservation>();
  const successesByFile = new Map<string, VodUploadSuccess>();
  const failures: VodUploadFailure[] = [];
  const fileNameById = new Map<string, string>();
  const retryAttemptsByFile = new Map<string, number>();
  const retryPendingSinceByFile = new Map<string, number>();
  const completedBefore = Math.max(0, progressContext.completedBefore ?? 0);
  const totalCount = Math.max(expectedCount, progressContext.totalCount ?? expectedCount);
  const maxRetryAttempts = Math.max(0, progressContext.maxRetryAttempts ?? 5);
  const startedAt = progressContext.startedAt ?? Date.now();
  const totalTimeout = progressContext.totalTimeoutMs ?? timeout;

  const progressFields = (status?: string) => {
    const current = Math.min(totalCount, completedBefore + successesByFile.size);
    const percent = totalCount > 0 ? Math.round(current / totalCount * 100) : 100;
    return {
      batch: progressContext.batchIndex,
      batchCount: progressContext.batchCount,
      current,
      total: totalCount,
      progress: `${current}/${totalCount} (${percent}%)`,
      elapsedMinutes: Math.round((Date.now() - startedAt) / 6000) / 10,
      timeoutMinutes: Math.round(totalTimeout / 60000),
      retryCount: Array.from(retryAttemptsByFile.values()).reduce((sum, value) => sum + value, 0),
      retryLimit: maxRetryAttempts,
      status,
    };
  };

  return new Promise<VodUploadReport>((resolve, reject) => {
    let settled = false;
    let actionDone = false;
    let readingPageProgress = false;
    let lastPageProgressSignature = "";
    let missingPageProgressSince: number | undefined;
    const timer = setTimeout(() => {
      finish(new Error(
        `[upload-failed] 剧集上传超时：总等待时间达到 ${Math.round(totalTimeout / 60000)} 分钟后仍未完成，`
        + `本批次已成功 ${successesByFile.size}/${expectedCount} 个文件。`,
      ));
    }, timeout);
    const progressTimer = setInterval(() => {
      if (settled || readingPageProgress) return;
      readingPageProgress = true;
      void readPageUploadProgress(page)
        .then(async (pageProgress) => {
          if (settled) return;
          if (!pageProgress) {
            missingPageProgressSince ??= Date.now();
            if (Date.now() - missingPageProgressSince >= missingUploadPageTimeoutMs) {
              finish(new Error("[upload-interrupted] 上传页面已离开或不再可用，任务已中断。"));
            }
            return;
          }
          missingPageProgressSince = undefined;
          if (pageProgress.signature !== lastPageProgressSignature) {
            lastPageProgressSignature = pageProgress.signature;
            vodLogger.info("video upload progress", progressFields(pageProgress.summary));
          }
          await retryFailedEpisodeRows(
            page,
            retryAttemptsByFile,
            retryPendingSinceByFile,
            maxRetryAttempts,
            startedAt,
            totalTimeout,
            progressContext.accountName,
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          finish(new Error(message));
        })
        .finally(() => {
          readingPageProgress = false;
        });
    }, uploadProgressPollMs);

    const buildReport = (): VodUploadReport => ({
      expectedCount,
      observations: Array.from(observationsById.values()),
      successes: Array.from(successesByFile.values()),
      failures,
    });

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("close", onPageClose);
      progressContext.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const report = buildReport();
      if (error) {
        if (progressContext.writeReport === false) {
          reject(error);
          return;
        }
        void writeVodUploadReport(report).catch(() => undefined).finally(() => reject(error));
        return;
      }
      void writeVodUploadReport(report).finally(() => resolve(report));
    };

    const finishIfComplete = () => {
      if (actionDone && successesByFile.size >= expectedCount) {
        finish();
      }
    };

    const onRequest = (request: Request) => {
      const observation = readVodObservation(request);
      if (!observation || observationsById.has(observation.fileId)) return;

      observationsById.set(observation.fileId, observation);
      fileNameById.set(observation.fileId, observation.fileName);
      vodLogger.info("已记录上传文件", {
        fileId: observation.fileId,
        file: observation.fileName,
        discoveredCount: observationsById.size,
        total: expectedCount,
      });
      finishIfComplete();
    };

    const onResponse = (response: Response) => {
      if (!isVodUploadFinishedResponse(response)) return;

      void readVodFinishedResponse(response, fileNameById)
        .then((result) => {
          if (settled || !result) return;

          if ("errMsg" in result) {
            failures.push(result);
            const target = [result.fileName, result.fileId].filter(Boolean).join(" / ") || "unknown file";
            vodLogger.warn("检测到剧集上传失败回调，等待页面重试", {
              accountName: progressContext.accountName,
              target,
              errorMessage: result.errMsg,
              maxAttempts: maxRetryAttempts,
            });
            return;
          }

          const successKey = result.fileName && result.fileName !== "Unknown Video"
            ? result.fileName
            : result.fileId;
          if (successesByFile.has(successKey)) return;
          successesByFile.set(successKey, result);
          retryPendingSinceByFile.delete(result.fileName);
          vodLogger.info("文件上传成功", { fileId: result.fileId, file: result.fileName });
          vodLogger.info("video upload progress", progressFields(
            `本批次已成功 ${successesByFile.size}/${expectedCount} 个文件`,
          ));
          finishIfComplete();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          finish(new Error(`[upload-failed] 剧集视频: failed to parse VOD upload result: ${message}`));
        });
    };

    const onPageClose = () => {
      finish(new Error("[upload-interrupted] 上传页面或浏览器已关闭，任务已中断。"));
    };

    const onAbort = () => {
      finish(interruptionError(progressContext.signal));
    };

    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("close", onPageClose);
    progressContext.signal?.addEventListener("abort", onAbort, { once: true });
    vodLogger.info("开始监控剧集上传进度", progressFields(
      `等待本批次 ${expectedCount} 个文件上传，单文件最多重试 ${maxRetryAttempts} 次`,
    ));
    void action()
      .then(() => {
        actionDone = true;
        vodLogger.info("已点击开始上传，正在等待微信上传回调", {
          batch: progressContext.batchIndex,
          batchCount: progressContext.batchCount,
          expectedCount,
        });
        finishIfComplete();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(new Error(`[upload-failed] 剧集视频: upload action failed: ${message}`));
      });
  });
}
