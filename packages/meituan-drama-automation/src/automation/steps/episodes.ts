import { writeJsonAtomic } from "@dramabridge/file-utils";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  findRequiredLocalEpisodeVideos,
  validateLocalEpisodeVideos,
} from "../../shared/local-episode-videos.js";
import type {
  ClaimedMeituanDramaTask,
  MeituanCreationRuntimeOptions,
} from "../../shared/types.js";
import { log } from "../browser-session.js";
import { scrollLocatorIntoView } from "../form-controls.js";

const videoUploadRowsSelector = "#video-list .tab-video, .video-list .tab-video";
const videoUploadProgressTimeoutMs = 2 * 60 * 60 * 1000;
const videoUploadProgressPollMs = 2_000;
const videoUploadStartPollMs = 1_000;
const videoUploadStartWaitMsByAttempt = [20_000, 30_000] as const;
const maxEpisodeFilesPerSelection = 100;

export function episodeInputFileBatches(files: string[], supportsMultiple: boolean) {
  return supportsMultiple ? [files] : files.map((file) => [file]);
}

type VideoUploadRow = {
  indexText: string;
  fileName: string;
  uploaded: boolean;
  failed: boolean;
  errorText: string;
  retryAvailable: boolean;
};

type VideoUploadStartSnapshot = {
  rowCount: number;
  matchedFileNames: string[];
};

type FileInputSnapshot = {
  accept: string;
  className: string;
  disabled: boolean;
  multiple: boolean;
  visible: boolean;
};

function normalizeUiText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function unknownErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return error.toString();
  }
  try {
    return JSON.stringify(error) ?? Object.prototype.toString.call(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

// Restored from the working implementation before 2026-08-24. The Meituan
// upload component renders its native file input as the dragger's next sibling.
// Waiting on or evaluating that hidden input before returning it caused the
// upload path to stall even though the control was already attached.
async function episodeVideoInputByDragger(page: Page, timeout = 60_000) {
  const dragger = page.locator(".mtd-upload-dragger:visible").first();
  await dragger.waitFor({ state: "visible", timeout });
  await scrollLocatorIntoView(page, dragger);

  const input = dragger
    .locator(
      "xpath=following-sibling::*[1][contains(concat(' ', normalize-space(@class), ' '), ' mtd-upload-input ')]",
    )
    .first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  return input;
}

async function fileInputSnapshot(input: Locator): Promise<FileInputSnapshot> {
  return input.evaluate((element: HTMLInputElement) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      accept: element.accept,
      className: element.className,
      disabled: element.disabled,
      multiple: element.multiple,
      visible:
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0,
    };
  });
}

async function readVideoUploadStartSnapshot(
  page: Page,
  videoFiles: string[],
): Promise<VideoUploadStartSnapshot> {
  const rows = await readVideoUploadRows(page);
  const fileNames = videoFiles.map((file) => basename(file));
  const matchedFileNames = await page.evaluate((names) => {
    const bodyText = document.body?.innerText ?? "";
    return names.filter((name) => bodyText.includes(name)).slice(0, 10);
  }, fileNames);
  return {
    rowCount: rows.length,
    matchedFileNames,
  };
}

function uploadBatchStarted(snapshot: VideoUploadStartSnapshot, previousRowCount: number) {
  return snapshot.rowCount > previousRowCount || snapshot.matchedFileNames.length > 0;
}

async function waitForVideoUploadStart(
  page: Page,
  videoFiles: string[],
  timeoutMs: number,
  previousRowCount: number,
): Promise<VideoUploadStartSnapshot> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const uploadErrorText = await readReplaceModalContentEvent(page);
    if (uploadErrorText) {
      throw new Error(`MEITUAN_VIDEO_UPLOAD_INVALID: ${uploadErrorText}`);
    }

    const snapshot = await readVideoUploadStartSnapshot(page, videoFiles);
    if (uploadBatchStarted(snapshot, previousRowCount)) return snapshot;
    await page.waitForTimeout(videoUploadStartPollMs);
  }

  return readVideoUploadStartSnapshot(page, videoFiles);
}

async function waitForVideoUploadBatchQueued(
  page: Page,
  expectedRowCount: number,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let rowCount = 0;
  while (Date.now() < deadline) {
    const uploadErrorText = await readReplaceModalContentEvent(page);
    if (uploadErrorText) {
      throw new Error(`MEITUAN_VIDEO_UPLOAD_INVALID: ${uploadErrorText}`);
    }
    rowCount = (await readVideoUploadRows(page)).length;
    if (rowCount >= expectedRowCount) return rowCount;
    await page.waitForTimeout(videoUploadStartPollMs);
  }
  throw new Error(
    `MEITUAN_VIDEO_UPLOAD_BATCH_ROWS_INCOMPLETE: expectedRows=${expectedRowCount} actualRows=${rowCount}`,
  );
}

function shouldFailWithoutUploadStartRetry(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /MEITUAN_VIDEO_UPLOAD_INVALID|Target page, context or browser has been closed/i.test(message);
}

async function saveVideoUploadStartDiagnostics(options: {
  page: Page;
  task: ClaimedMeituanDramaTask;
  runtimeOptions: MeituanCreationRuntimeOptions;
  videoFiles: string[];
  attempts: number;
  lastSnapshot: VideoUploadStartSnapshot;
  lastInputSnapshot: FileInputSnapshot | null;
  lastError: unknown;
}) {
  const {
    page,
    task,
    runtimeOptions,
    videoFiles,
    attempts,
    lastSnapshot,
    lastInputSnapshot,
    lastError,
  } = options;
  if (!runtimeOptions.logFilePath) return null;

  const taskSegment = String(task.accountTaskId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const diagnosticDir = join(
    dirname(runtimeOptions.logFilePath),
    "diagnostics",
    `${taskSegment}-${timestamp}`,
  );
  await mkdir(diagnosticDir, { recursive: true });

  const allFileInputs = await page
    .locator('input[type="file"]')
    .evaluateAll((elements: HTMLInputElement[]) => elements.map((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        accept: element.accept,
        className: element.className,
        disabled: element.disabled,
        multiple: element.multiple,
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0,
      };
    }))
    .catch(() => []);
  const videoFileDetails = await Promise.all(videoFiles.map(async (file) => ({
    name: basename(file),
    size: await stat(file).then((value) => value.size).catch(() => null),
  })));
  const uploadAreaHtml = await page
    .locator(".mtd-upload-dragger")
    .first()
    .evaluate((element) => element.parentElement?.outerHTML ?? element.outerHTML)
    .catch(() => "");
  const record = {
    time: new Date().toISOString(),
    platform: "meituan-drama",
    accountTaskId: task.accountTaskId,
    attempts,
    expectedCount: videoFiles.length,
    visibleUploadRows: lastSnapshot.rowCount,
    matchedFileNames: lastSnapshot.matchedFileNames,
    matchedFileInputs: allFileInputs.length,
    selectedInput: lastInputSnapshot,
    activeUrl: page.url(),
    lastError: unknownErrorMessage(lastError),
    videoFiles: videoFileDetails,
  };

  await Promise.all([
    writeJsonAtomic(join(diagnosticDir, "details.json"), record),
    writeFile(join(diagnosticDir, "upload-area.html"), uploadAreaHtml, "utf8"),
    page.screenshot({ path: join(diagnosticDir, "page.png"), fullPage: true }),
    page.locator(".mtd-upload-dragger").first().screenshot({
      path: join(diagnosticDir, "upload-area.png"),
    }),
  ].map((operation) => operation.catch(() => undefined)));

  return diagnosticDir;
}

async function createReplaceModalContentListener(page: Page): Promise<void> {
  await page.evaluate(() => {
    const modalWindow = window as Window & {
      __modalEvents?: Array<{ text: string; time: number }>;
      __modalObserver?: MutationObserver;
    };

    modalWindow.__modalEvents = [];
    modalWindow.__modalObserver?.disconnect();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          const element = node as HTMLElement;
          if (element.matches?.(".mtd-modal")) {
            modalWindow.__modalEvents?.push({
              text: element.innerText,
              time: Date.now(),
            });
          }

          const modal = element.querySelector?.<HTMLElement>(".mtd-modal");
          if (modal) {
            modalWindow.__modalEvents?.push({
              text: modal.innerText,
              time: Date.now(),
            });
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    modalWindow.__modalObserver = observer;
  });
}

async function readReplaceModalContentEvent(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const modalWindow = window as Window & {
      __modalEvents?: Array<{ text: string; time: number }>;
    };
    return modalWindow.__modalEvents?.[0]?.text?.trim() || null;
  });
}

async function disposeReplaceModalContentListener(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const modalWindow = window as Window & {
        __modalObserver?: MutationObserver;
      };

      modalWindow.__modalObserver?.disconnect();
      delete modalWindow.__modalObserver;
    })
    .catch(() => undefined);
}

async function readVideoUploadRows(page: Page): Promise<VideoUploadRow[]> {
  return page.evaluate((selector) => {
    const isVisible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    return Array.from(document.querySelectorAll<HTMLElement>(selector)).map((row) => {
      const uploadSuccess = row.querySelector<HTMLElement>(".upload-success");
      const successText = uploadSuccess?.innerText.trim() ?? "";
      const uploadError = row.querySelector<HTMLElement>(".upload-error");
      const failed = Boolean(uploadError && isVisible(uploadError));
      const retryAvailable = Array.from(
        row.querySelectorAll<HTMLElement>(".error-btn .scale-text"),
      ).some((element) => element.innerText.trim() === "重试" && isVisible(element));
      return {
        indexText: row.querySelector<HTMLElement>(".video-index")?.innerText.trim() ?? "",
        fileName: row.querySelector<HTMLElement>(".file-name")?.innerText.trim() ?? "",
        uploaded: Boolean(
          uploadSuccess && (successText.includes("上传成功") || isVisible(uploadSuccess)),
        ),
        failed,
        errorText:
          row.querySelector<HTMLElement>(".show-error-name")?.innerText.trim() ||
          uploadError?.innerText.trim() ||
          "",
        retryAvailable,
      };
    });
  }, videoUploadRowsSelector);
}

function failedVideoUploadError(
  failures: VideoUploadRow[],
  retryAttemptsByFile: Map<string, number>,
  maxRetryAttempts: number,
) {
  const details = failures
    .map((failure, index) => {
      const fileName = failure.fileName || failure.indexText || `未知剧集-${index + 1}`;
      const errorText = failure.errorText || "页面仅显示上传失败，未提供具体原因";
      const retryAttempts = retryAttemptsByFile.get(fileName) ?? 0;
      return `${failure.indexText || "未知集号"} ${fileName}：${errorText}` +
        `（已重试 ${retryAttempts}/${maxRetryAttempts} 次）`;
    })
    .join("；");
  return new Error(
    `[upload-failed] 美团剧集视频上传失败：${details || "未读取到失败剧集信息"}`,
  );
}

async function retryFirstFailedVideoRow(
  page: Page,
  rows: VideoUploadRow[],
  retryAttemptsByFile: Map<string, number>,
  maxRetryAttempts: number,
  options: MeituanCreationRuntimeOptions,
) {
  const failures = rows.filter((row) => row.failed);
  if (failures.length === 0) return false;

  const exhausted = failures.filter((failure, index) => {
    const key = failure.fileName || failure.indexText || `未知剧集-${index + 1}`;
    return (retryAttemptsByFile.get(key) ?? 0) >= maxRetryAttempts;
  });
  if (exhausted.length > 0) {
    throw failedVideoUploadError(failures, retryAttemptsByFile, maxRetryAttempts);
  }

  const failure = failures[0];
  const key = failure.fileName || failure.indexText || "未知剧集";
  if (!failure.retryAvailable) {
    throw failedVideoUploadError(failures, retryAttemptsByFile, maxRetryAttempts);
  }

  const escapedFileName = failure.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = page
    .locator(videoUploadRowsSelector)
    .filter({
      has: page.locator(".file-name").filter({
        hasText: new RegExp(`^\\s*${escapedFileName}\\s*$`),
      }),
    })
    .first();
  const retryControl = row
    .locator(".error-btn .scale-text")
    .filter({ hasText: /^\s*重试\s*$/ })
    .filter({ visible: true })
    .first();
  if ((await retryControl.count()) === 0) {
    throw failedVideoUploadError(failures, retryAttemptsByFile, maxRetryAttempts);
  }

  const nextAttempt = (retryAttemptsByFile.get(key) ?? 0) + 1;
  retryAttemptsByFile.set(key, nextAttempt);
  log(
    options,
    `[meituan-drama] retrying failed episode video: ` +
      `episode=${failure.indexText || "-"} file=${key} ` +
      `attempt=${nextAttempt}/${maxRetryAttempts} ` +
      `error=${normalizeUiText(failure.errorText) || "上传失败"}`,
  );
  await retryControl.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await retryControl.click({ timeout: 30_000 });

  const leftFailedState = await row
    .locator(".upload-error:visible")
    .waitFor({ state: "hidden", timeout: 30_000 })
    .then(() => true, () => false);
  if (!leftFailedState && nextAttempt >= maxRetryAttempts) {
    const latestRows = await readVideoUploadRows(page);
    throw failedVideoUploadError(
      latestRows.filter((item) => item.failed),
      retryAttemptsByFile,
      maxRetryAttempts,
    );
  }
  return true;
}

async function waitForVideoUploadProgress(
  page: Page,
  expectedCount: number,
  options: MeituanCreationRuntimeOptions,
): Promise<void> {
  const deadline = Date.now() + videoUploadProgressTimeoutMs;
  const maxRetryAttempts = Math.max(0, options.episodeUploadFailedRetryAttempts ?? 5);
  const retryAttemptsByFile = new Map<string, number>();
  const loggedSuccessKeys = new Set<string>();
  let lastProgressLine = "";

  while (Date.now() < deadline) {
    const uploadErrorText = await readReplaceModalContentEvent(page);
    if (uploadErrorText) {
      throw new Error(`MEITUAN_VIDEO_UPLOAD_INVALID: ${uploadErrorText}`);
    }

    const rows = await readVideoUploadRows(page);
    const rowsToCheck = rows.slice(0, expectedCount);
    if (
      await retryFirstFailedVideoRow(
        page,
        rowsToCheck,
        retryAttemptsByFile,
        maxRetryAttempts,
        options,
      )
    ) {
      await page.waitForTimeout(videoUploadProgressPollMs);
      continue;
    }
    const uploadedRows = rowsToCheck.filter((row) => row.uploaded);
    const progressLine = `${uploadedRows.length}/${expectedCount} uploaded, ${rows.length} row(s) visible`;

    if (progressLine !== lastProgressLine) {
      log(options, `[meituan-drama] video upload progress: ${progressLine}`);
      lastProgressLine = progressLine;
    }

    rowsToCheck.forEach((row, index) => {
      if (!row.uploaded) return;

      const key = row.fileName || row.indexText || String(index + 1);
      if (loggedSuccessKeys.has(key)) return;

      const indexText = row.indexText || `第${index + 1}条`;
      const fileName = row.fileName ? ` ${row.fileName}` : "";
      log(options, `[meituan-drama] video upload success: ${indexText}${fileName}`);
      loggedSuccessKeys.add(key);
    });

    if (uploadedRows.length >= expectedCount) {
      log(options, `[meituan-drama] all ${expectedCount} episode video(s) uploaded`);
      return;
    }

    await page.waitForTimeout(videoUploadProgressPollMs);
  }

  const rows = await readVideoUploadRows(page);
  const rowsToCheck = rows.slice(0, expectedCount);
  const failures = rowsToCheck.filter((row) => row.failed);
  if (failures.length > 0) {
    throw failedVideoUploadError(failures, retryAttemptsByFile, maxRetryAttempts);
  }
  const uploadedCount = rowsToCheck.filter((row) => row.uploaded).length;
  throw new Error(
    `MEITUAN_VIDEO_UPLOAD_TIMEOUT: expected ${expectedCount} uploaded episode video(s), got ${uploadedCount}`,
  );
}

export async function uploadEpisodeVideosStep(
  page: Page,
  task: ClaimedMeituanDramaTask,
  options: MeituanCreationRuntimeOptions,
) {
  log(options, "[meituan-drama] preparing local episode videos");
  await validateLocalEpisodeVideos(task, options);
  const episodes = await findRequiredLocalEpisodeVideos(task, options);
  const videoFiles = episodes.map((episode) => episode.file);

  log(options, `[meituan-drama] uploading ${videoFiles.length} episode video(s)`);
  const videoFileBatches: string[][] = [];
  for (let offset = 0; offset < videoFiles.length; offset += maxEpisodeFilesPerSelection) {
    videoFileBatches.push(videoFiles.slice(offset, offset + maxEpisodeFilesPerSelection));
  }
  await createReplaceModalContentListener(page);
  try {
    let previousRowCount = 0;
    for (let batchIndex = 0; batchIndex < videoFileBatches.length; batchIndex += 1) {
      const batchFiles = videoFileBatches[batchIndex];
      const batchNumber = batchIndex + 1;
      let uploadStartedSuccessfully = false;
      let lastSnapshot: VideoUploadStartSnapshot = {
        rowCount: previousRowCount,
        matchedFileNames: [],
      };
      let lastInputSnapshot: FileInputSnapshot | null = null;
      let lastError: unknown;

      log(
        options,
        `[meituan-drama] selecting video upload batch ${batchNumber}/${videoFileBatches.length}: ` +
          `files=${batchFiles.length} previousRows=${previousRowCount}`,
      );

      for (let attempt = 1; attempt <= videoUploadStartWaitMsByAttempt.length; attempt += 1) {
        const timeoutMs = videoUploadStartWaitMsByAttempt[attempt - 1];
        log(
          options,
          `[meituan-drama] video upload start attempt ${attempt}/${videoUploadStartWaitMsByAttempt.length}: ` +
            `batch=${batchNumber}/${videoFileBatches.length} files=${batchFiles.length} waitMs=${timeoutMs}`,
        );

        try {
          const videoInput = await episodeVideoInputByDragger(
            page,
            attempt === 1 ? 60_000 : 15_000,
          );
          lastInputSnapshot = await fileInputSnapshot(videoInput).catch(() => null);
          const supportsMultiple = lastInputSnapshot?.multiple !== false;
          if (attempt > 1 && supportsMultiple) {
            await videoInput.setInputFiles([], { timeout: 30_000 });
          }
          const inputBatches = episodeInputFileBatches(batchFiles, supportsMultiple);
          const currentRowCount = (await readVideoUploadRows(page)).length;
          const alreadyQueuedCount = supportsMultiple
            ? 0
            : Math.max(0, Math.min(batchFiles.length, currentRowCount - previousRowCount));
          for (let inputBatchIndex = alreadyQueuedCount; inputBatchIndex < inputBatches.length; inputBatchIndex += 1) {
            const currentInput = inputBatchIndex === 0
              ? videoInput
              : await episodeVideoInputByDragger(page, 30_000);
            await currentInput.setInputFiles(inputBatches[inputBatchIndex], { timeout: 120_000 });
            if (!supportsMultiple) {
              await waitForVideoUploadBatchQueued(
                page,
                previousRowCount + inputBatchIndex + 1,
              );
            }
          }
          log(
            options,
            `[meituan-drama] episode files assigned to upload input: ` +
              `batch=${batchNumber}/${videoFileBatches.length} ` +
              `attempt=${attempt}/${videoUploadStartWaitMsByAttempt.length} files=${batchFiles.length} ` +
              `mode=${supportsMultiple ? "multiple" : "single-sequential"}`,
          );
          lastSnapshot = await waitForVideoUploadStart(
            page,
            batchFiles,
            timeoutMs,
            previousRowCount,
          );
          if (uploadBatchStarted(lastSnapshot, previousRowCount)) {
            uploadStartedSuccessfully = true;
            log(
              options,
              `[meituan-drama] video upload batch started: batch=${batchNumber}/${videoFileBatches.length} ` +
                `attempt=${attempt} rows=${lastSnapshot.rowCount} ` +
                `matchedFileNames=${lastSnapshot.matchedFileNames.length}`,
            );
            break;
          }
        } catch (error) {
          lastError = error;
          if (shouldFailWithoutUploadStartRetry(error)) throw error;
          log(
            options,
            `[meituan-drama] video upload start attempt failed: ` +
              `batch=${batchNumber}/${videoFileBatches.length} ` +
              `attempt=${attempt}/${videoUploadStartWaitMsByAttempt.length} ` +
              `error=${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (attempt < videoUploadStartWaitMsByAttempt.length) {
          lastSnapshot = await readVideoUploadStartSnapshot(page, batchFiles);
          if (uploadBatchStarted(lastSnapshot, previousRowCount)) {
            uploadStartedSuccessfully = true;
            log(
              options,
              `[meituan-drama] video upload batch started before retry: ` +
                `batch=${batchNumber}/${videoFileBatches.length} rows=${lastSnapshot.rowCount} ` +
                `matchedFileNames=${lastSnapshot.matchedFileNames.length}`,
            );
            break;
          }
          log(
            options,
            `[meituan-drama] no new upload rows after ${timeoutMs}ms, ` +
              `retrying batch ${batchNumber}/${videoFileBatches.length} once`,
          );
        }
      }

      if (!uploadStartedSuccessfully) {
        const diagnosticDir = await saveVideoUploadStartDiagnostics({
          page,
          task,
          runtimeOptions: options,
          videoFiles: batchFiles,
          attempts: videoUploadStartWaitMsByAttempt.length,
          lastSnapshot,
          lastInputSnapshot,
          lastError,
        }).catch(() => null);
        const detail = {
          batch: `${batchNumber}/${videoFileBatches.length}`,
          attempts: videoUploadStartWaitMsByAttempt.length,
          batchExpectedCount: batchFiles.length,
          totalExpectedCount: videoFiles.length,
          previousRowCount,
          visibleUploadRows: lastSnapshot.rowCount,
          matchedFileNames: lastSnapshot.matchedFileNames.length,
          selectedInput: lastInputSnapshot,
          diagnosticDir,
          lastError: unknownErrorMessage(lastError),
        };
        throw new Error(`MEITUAN_VIDEO_UPLOAD_NOT_STARTED: ${JSON.stringify(detail)}`);
      }

      const expectedRowCount = previousRowCount + batchFiles.length;
      previousRowCount = await waitForVideoUploadBatchQueued(page, expectedRowCount);
      log(
        options,
        `[meituan-drama] video upload batch queued: batch=${batchNumber}/${videoFileBatches.length} ` +
          `batchFiles=${batchFiles.length} totalRows=${previousRowCount}/${videoFiles.length}`,
      );
    }

    await waitForVideoUploadProgress(page, videoFiles.length, options);
  } finally {
    await disposeReplaceModalContentListener(page);
  }

  log(options, "[meituan-drama] episode video files submitted");
}
