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

export async function monitorEpisodeVodUploads(
  page: Page,
  expectedCount: number,
  action: () => Promise<void>,
  timeout = minutesToMs(30),
): Promise<VodUploadReport> {
  const observationsById = new Map<string, VodUploadObservation>();
  const successesById = new Map<string, VodUploadSuccess>();
  const failures: VodUploadFailure[] = [];
  const fileNameById = new Map<string, string>();

  return new Promise<VodUploadReport>((resolve, reject) => {
    let settled = false;
    let actionDone = false;
    const timer = setTimeout(() => {
      finish(new Error(`[upload-failed] 剧集视频: timed out waiting for ${expectedCount} VOD upload report(s), got ${observationsById.size}.`));
    }, timeout);

    const buildReport = (): VodUploadReport => ({
      expectedCount,
      observations: Array.from(observationsById.values()),
      successes: Array.from(successesById.values()),
      failures,
    });

    const cleanup = () => {
      clearTimeout(timer);
      page.off("request", onRequest);
      page.off("response", onResponse);
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const report = buildReport();
      if (error) {
        void writeVodUploadReport(report).finally(() => reject(error));
        return;
      }
      void writeVodUploadReport(report).finally(() => resolve(report));
    };

    const finishIfComplete = () => {
      if (actionDone && observationsById.size >= expectedCount) {
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
            finish(new Error(`[upload-failed] 剧集视频 ${target}: ${result.errMsg}`));
            return;
          }

          successesById.set(result.fileId, result);
          vodLogger.info("文件上传成功", { fileId: result.fileId, file: result.fileName });
          finishIfComplete();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          finish(new Error(`[upload-failed] 剧集视频: failed to parse VOD upload result: ${message}`));
        });
    };

    page.on("request", onRequest);
    page.on("response", onResponse);
    void action()
      .then(() => {
        actionDone = true;
        finishIfComplete();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish(new Error(`[upload-failed] 剧集视频: upload action failed: ${message}`));
      });
  });
}
