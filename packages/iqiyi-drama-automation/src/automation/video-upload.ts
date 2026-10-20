import path from "node:path";

import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
  type PreparedEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import type { FileChooser, Locator, Page } from "playwright";

import { log } from "../shared/logger.js";
import type { ClaimedIqiyiDramaTask, IqiyiDramaRuntimeOptions } from "../shared/types.js";
import { throwIfIqiyiFormInvalid } from "./form-controls.js";

const maximumFilesPerSelection = 50;
const batchRegistrationInitialWaitMs = 5_000;
const batchRegistrationQuietMs = 2_000;
const episodeRegistrationPollIntervalMs = 250;
const episodeRegistrationTimeoutMs = 30_000;
const uploadPollIntervalMs = 2_000;
const videoInputSelector = [
  "input[type='file'][multiple][accept*='.mp4']",
  "input[type='file'][multiple][accept*='.mov']",
  "input[type='file'][multiple][accept*='.mkv']",
].join(",");

type IqiyiVideoUploadRow = {
  fileName: string;
  uploading: boolean;
  failed: boolean;
  terminal: boolean;
  errorText: string;
};

type IqiyiVideoUploadSnapshot = {
  rows: IqiyiVideoUploadRow[];
  globalErrors: string[];
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function iqiyiVideoUploadRoot(page: Page) {
  const root = page.locator(".proj-catalog-wrap")
    .filter({ has: page.locator(videoInputSelector) })
    .filter({ visible: true })
    .last();
  await root.waitFor({ state: "visible", timeout: 30_000 });
  return root;
}

async function readIqiyiVideoUploadSnapshot(
  page: Page,
  root: Locator,
): Promise<IqiyiVideoUploadSnapshot> {
  const rows = await root.locator(".catalog-item-form:visible").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const status = element.querySelector(".file-status");
      const statusIcon = status?.querySelector("svg");
      const statusMarkup = statusIcon?.outerHTML.toLowerCase() ?? "";
      const statusStyle = statusIcon
        ? `${getComputedStyle(statusIcon).color} ${getComputedStyle(statusIcon).fill}`.toLowerCase()
        : "";
      const errorText = Array.from(element.querySelectorAll([
        ".mp-form-item__error",
        ".file-message-list",
        "[class*='error']",
        "[class*='fail']",
      ].join(",")))
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden";
        })
        .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
        .join("；");
      const uploading = Boolean(status?.querySelector(".left,.right,.leftcircle,.rightcircle"));
      const failed = Boolean(errorText)
        || /fail|error|failed|batch-failed|#f45c50|#fa4b5c|rgb\(244,\s*92,\s*80\)/u
          .test(`${statusMarkup} ${statusStyle}`);
      const fileName = element.querySelector(".catalog-form-text")?.textContent?.trim() ?? "";
      const row = {
        fileName,
        uploading,
        failed,
        terminal: Boolean(fileName) && Boolean(statusIcon) && !uploading,
        errorText,
      };
      return fileName || uploading || failed || errorText ? [row] : [];
    })
  );
  const globalErrors = (await page.locator([
    ".mp-message--error:visible",
    ".el-message--error:visible",
    ".mp-toast--error:visible",
    ".mp-form-item__error:visible",
    "[class*='upload-error']:visible",
    "[class*='upload-fail']:visible",
  ].join(",")).allInnerTexts().catch(() => []))
    .map(normalizeText)
    .filter(Boolean);
  return { rows, globalErrors: [...new Set(globalErrors)] };
}

async function existingIqiyiVideoRow(root: Locator) {
  const rows = root.locator(".catalog-item-form:visible");
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const fileName = normalizeText(await row.locator(".catalog-form-text").textContent().catch(() => ""));
    const hasUploadActivity = await row.locator(
      ".file-status .left,.file-status .right,.file-status .leftcircle,.file-status .rightcircle",
    ).count() > 0;
    const hasVisibleError = await row.locator(
      ".mp-form-item__error:visible,.file-message-list:visible [class*='error'],[class*='upload-fail']:visible",
    ).count() > 0;
    if (fileName || hasUploadActivity || hasVisibleError) return { fileName, row };
  }
  return undefined;
}

async function waitForIqiyiVideoRowRemoval(
  page: Page,
  root: Locator,
  previousRowCount: number,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await readIqiyiVideoUploadSnapshot(page, root);
    if (snapshot.rows.length < previousRowCount) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function clearExistingIqiyiVideoRows(
  page: Page,
  root: Locator,
  options: IqiyiDramaRuntimeOptions,
) {
  let cleared = 0;
  while (cleared < 500) {
    const snapshot = await readIqiyiVideoUploadSnapshot(page, root);
    if (snapshot.rows.length === 0) return cleared;
    const existing = await existingIqiyiVideoRow(root);
    if (!existing) {
      throw new Error(
        `IQIYI_DRAMA_VIDEO_UPLOAD_PAGE_CLEAR_FAILED: reason=row-not-locatable rows=${snapshot.rows.length}`,
      );
    }

    const deleteControl = existing.row.locator(".item-del-video:visible").first();
    const fallbackDeleteControl = existing.row.getByText("删除", { exact: true }).last();
    const target = await deleteControl.count() > 0 ? deleteControl : fallbackDeleteControl;
    if (await target.count() === 0) {
      throw new Error(
        `IQIYI_DRAMA_VIDEO_UPLOAD_PAGE_CLEAR_FAILED: reason=delete-control-not-found ` +
          `file=${existing.fileName || "unknown"} rows=${snapshot.rows.length}`,
      );
    }

    log(
      options,
      `[iqiyi-drama] removing video already present before upload: ` +
        `${existing.fileName || `row-${cleared + 1}`}`,
    );
    await target.click({ timeout: 10_000 });
    const confirmation = page.locator([
      ".cancel-confirm:visible",
      ".mp-message-box:visible",
      ".el-message-box:visible",
    ].join(",")).filter({ hasText: "确定删除该视频" }).last();
    const confirmationVisible = await confirmation
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true, () => false);
    if (confirmationVisible) {
      await confirmation.getByRole("button", { name: "确定", exact: true })
        .last()
        .click({ timeout: 10_000 });
    }
    if (!await waitForIqiyiVideoRowRemoval(page, root, snapshot.rows.length)) {
      throw new Error(
        `IQIYI_DRAMA_VIDEO_UPLOAD_PAGE_CLEAR_FAILED: reason=delete-timeout ` +
          `file=${existing.fileName || "unknown"} rows=${snapshot.rows.length}`,
      );
    }
    cleared += 1;
  }
  throw new Error("IQIYI_DRAMA_VIDEO_UPLOAD_PAGE_CLEAR_FAILED: reason=too-many-rows");
}

function expectedFileMatched(row: IqiyiVideoUploadRow, file: string) {
  const basename = path.basename(file);
  const stem = path.basename(file, path.extname(file));
  const text = normalizeText(row.fileName);
  return text.includes(basename) || text.includes(stem);
}

function matchedExpectedFiles(rows: IqiyiVideoUploadRow[], expectedFiles: string[]) {
  const unmatchedRows = [...rows];
  const matchedFiles: string[] = [];
  for (const file of expectedFiles) {
    const rowIndex = unmatchedRows.findIndex((row) => expectedFileMatched(row, file));
    if (rowIndex < 0) continue;
    unmatchedRows.splice(rowIndex, 1);
    matchedFiles.push(file);
  }
  return matchedFiles;
}

function matchedExpectedFileCount(rows: IqiyiVideoUploadRow[], expectedFiles: string[]) {
  return matchedExpectedFiles(rows, expectedFiles).length;
}

function throwForIqiyiVideoUploadErrors(snapshot: IqiyiVideoUploadSnapshot) {
  const failedRows = snapshot.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.failed);
  if (snapshot.globalErrors.length === 0 && failedRows.length === 0) return;

  const rowErrors = failedRows.map(({ row, index }) =>
    `第${index + 1}行${row.errorText ? `：${row.errorText}` : "上传失败"}`
  );
  throw new Error(
    `IQIYI_DRAMA_VIDEO_UPLOAD_FAILED: ${[
      ...snapshot.globalErrors,
      ...rowErrors,
    ].join("；")}`,
  );
}

async function waitForIqiyiEpisodeRegistration(
  page: Page,
  root: Locator,
  expectedFiles: string[],
  deadline: number,
) {
  const registrationDeadline = Math.min(
    deadline,
    Date.now() + episodeRegistrationTimeoutMs,
  );
  let stableRegisteredPolls = 0;
  let lastSnapshot: IqiyiVideoUploadSnapshot = { rows: [], globalErrors: [] };
  let lastMatchedCount = 0;

  while (Date.now() < registrationDeadline) {
    lastSnapshot = await readIqiyiVideoUploadSnapshot(page, root);
    throwForIqiyiVideoUploadErrors(lastSnapshot);
    lastMatchedCount = matchedExpectedFileCount(lastSnapshot.rows, expectedFiles);
    const registered = lastSnapshot.rows.length >= expectedFiles.length
      && lastMatchedCount === expectedFiles.length;
    stableRegisteredPolls = registered ? stableRegisteredPolls + 1 : 0;
    if (stableRegisteredPolls >= 2) return;
    await page.waitForTimeout(episodeRegistrationPollIntervalMs);
  }

  const file = expectedFiles[expectedFiles.length - 1];
  throw new Error(
    `IQIYI_DRAMA_VIDEO_REGISTRATION_TIMEOUT: file=${file ? path.basename(file) : "unknown"} `
      + `expectedRows=${expectedFiles.length} rows=${lastSnapshot.rows.length} `
      + `matched=${lastMatchedCount}`,
  );
}

async function waitForIqiyiBatchRegistration(
  page: Page,
  root: Locator,
  batchFiles: string[],
  deadline: number,
) {
  const startedAt = Date.now();
  const registrationDeadline = Math.min(
    deadline,
    startedAt + episodeRegistrationTimeoutMs,
  );
  let bestMatchedFiles: string[] = [];
  let lastImprovementAt = startedAt;

  while (Date.now() < registrationDeadline) {
    const snapshot = await readIqiyiVideoUploadSnapshot(page, root);
    throwForIqiyiVideoUploadErrors(snapshot);
    const matchedFiles = matchedExpectedFiles(snapshot.rows, batchFiles);
    if (matchedFiles.length > bestMatchedFiles.length) {
      bestMatchedFiles = matchedFiles;
      lastImprovementAt = Date.now();
    }
    if (bestMatchedFiles.length === batchFiles.length) return bestMatchedFiles;

    const now = Date.now();
    if (bestMatchedFiles.length > 0 && now - lastImprovementAt >= batchRegistrationQuietMs) {
      return bestMatchedFiles;
    }
    if (bestMatchedFiles.length === 0 && now - startedAt >= batchRegistrationInitialWaitMs) {
      return [];
    }
    await page.waitForTimeout(episodeRegistrationPollIntervalMs);
  }

  return bestMatchedFiles;
}

async function selectIqiyiEpisodeFiles(
  page: Page,
  root: Locator,
  files: string[],
  options: IqiyiDramaRuntimeOptions,
) {
  const uploadTrigger = root.locator(".catalog-upload-video-wrap")
    .filter({ visible: true })
    .first();
  if (await uploadTrigger.count() > 0) {
    let chooser: FileChooser | null = null;
    try {
      [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10_000 }),
        uploadTrigger.click({ timeout: 10_000 }),
      ]);
    } catch (error) {
      log(
        options,
        `[iqiyi-drama] upload trigger file chooser unavailable; using attached input: ${message(error)}`,
      );
    }
    if (chooser) {
      if (files.length > 1 && !chooser.isMultiple()) {
        throw new Error("IQIYI_DRAMA_VIDEO_CHOOSER_NOT_MULTIPLE");
      }
      await chooser.setFiles(files, { timeout: 120_000 });
      return;
    }
  }

  const input = root.locator(videoInputSelector).last();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  await input.setInputFiles(files, { timeout: 120_000 });
}

async function waitForIqiyiVideoUploadComplete(
  page: Page,
  root: Locator,
  expectedFiles: string[],
  deadline: number,
  options: IqiyiDramaRuntimeOptions,
) {
  let stableCompletePolls = 0;
  let lastProgress = "";
  let lastSnapshot: IqiyiVideoUploadSnapshot = { rows: [], globalErrors: [] };

  while (Date.now() < deadline) {
    lastSnapshot = await readIqiyiVideoUploadSnapshot(page, root);
    throwForIqiyiVideoUploadErrors(lastSnapshot);
    const matchedCount = matchedExpectedFileCount(lastSnapshot.rows, expectedFiles);
    const terminalCount = lastSnapshot.rows.filter((row) => row.terminal).length;
    const uploadingCount = lastSnapshot.rows.filter((row) => row.uploading).length;
    const progress = `${terminalCount}/${expectedFiles.length}（行=${lastSnapshot.rows.length}`
      + `，文件名匹配=${matchedCount}，上传中=${uploadingCount}）`;
    if (progress !== lastProgress) {
      lastProgress = progress;
      log(options, `[iqiyi-drama] episode upload progress: ${progress}`);
    }

    const complete = lastSnapshot.rows.length === expectedFiles.length
      && matchedCount === expectedFiles.length
      && terminalCount === expectedFiles.length
      && uploadingCount === 0;
    stableCompletePolls = complete ? stableCompletePolls + 1 : 0;
    if (stableCompletePolls >= 2) {
      log(options, `[iqiyi-drama] all ${expectedFiles.length} episode videos uploaded`);
      return;
    }
    await page.waitForTimeout(uploadPollIntervalMs);
  }

  throw new Error(
    `IQIYI_DRAMA_VIDEO_UPLOAD_TIMEOUT: expected=${expectedFiles.length} `
      + `rows=${lastSnapshot.rows.length} status=${lastProgress || "not-started"}`,
  );
}

export async function uploadIqiyiEpisodeVideos(
  page: Page,
  task: ClaimedIqiyiDramaTask,
  options: IqiyiDramaRuntimeOptions,
) {
  const localMaterialRoot = options.localMaterialRoot?.trim();
  if (!localMaterialRoot) throw new Error("IQIYI_DRAMA_LOCAL_MATERIAL_ROOT_REQUIRED");
  const uploadRootDir = options.assetDownloadDir?.trim();
  if (!uploadRootDir) throw new Error("IQIYI_DRAMA_EPISODE_UPLOAD_ASSET_DIR_REQUIRED");

  const root = await iqiyiVideoUploadRoot(page);
  const input = root.locator(videoInputSelector).last();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  const visibleRowCount = await root.locator(".catalog-item-form:visible").count();
  const existingSnapshot = await readIqiyiVideoUploadSnapshot(page, root);
  if (existingSnapshot.rows.length > 0) {
    const cleared = await clearExistingIqiyiVideoRows(page, root, options);
    log(options, `[iqiyi-drama] cleared ${cleared} pre-existing video upload row(s)`);
  }
  if (visibleRowCount > 0) {
    log(options, `[iqiyi-drama] ignored ${visibleRowCount} empty video upload placeholder row(s)`);
  }

  let prepared: PreparedEpisodeUploadFiles | null = null;
  try {
    prepared = await prepareEpisodeUploadFiles({
      localEpisodeVideoRoot: localMaterialRoot,
      resourceName: task.originalTitle,
      uploadRootDir,
      uploadBaseName: task.playlet.title,
    });
    if (prepared.files.length !== task.playlet.episodeCount) {
      throw new Error(
        `IQIYI_DRAMA_EPISODE_UPLOAD_FILE_COUNT_INVALID: `
          + `actual=${prepared.files.length} expected=${task.playlet.episodeCount}`,
      );
    }

    const timeoutMinutes = Math.max(1, options.videoUploadTimeoutMinutes ?? 120);
    const deadline = Date.now() + timeoutMinutes * 60_000;
    const selectedFiles: string[] = [];
    const batchCount = Math.ceil(prepared.files.length / maximumFilesPerSelection);
    log(
      options,
      `[iqiyi-drama] registering ${prepared.files.length} episode videos in ${batchCount} batch(es); `
        + `timeout=${timeoutMinutes} minutes`,
    );

    for (let offset = 0; offset < prepared.files.length; offset += maximumFilesPerSelection) {
      const batch = prepared.files.slice(offset, offset + maximumFilesPerSelection);
      const batchNumber = Math.floor(offset / maximumFilesPerSelection) + 1;
      log(
        options,
        `[iqiyi-drama] selecting episode batch ${batchNumber}/${batchCount}: `
          + `${path.basename(batch[0]!)} -> ${path.basename(batch[batch.length - 1]!)}`,
      );
      await selectIqiyiEpisodeFiles(page, root, batch, options);
      const registeredBatchFiles = await waitForIqiyiBatchRegistration(page, root, batch, deadline);
      selectedFiles.push(...registeredBatchFiles);
      log(
        options,
        `[iqiyi-drama] batch registered: ${registeredBatchFiles.length}/${batch.length}; `
          + `total=${selectedFiles.length}/${prepared.files.length}`,
      );

      const registeredBatchSet = new Set(registeredBatchFiles);
      const missingFiles = batch.filter((file) => !registeredBatchSet.has(file));
      if (missingFiles.length > 0) {
        log(
          options,
          `[iqiyi-drama] batch registration incomplete; retrying ${missingFiles.length} missing episode(s)`,
        );
      }
      for (const file of missingFiles) {
        const currentSnapshot = await readIqiyiVideoUploadSnapshot(page, root);
        throwForIqiyiVideoUploadErrors(currentSnapshot);
        if (matchedExpectedFiles(currentSnapshot.rows, [file]).length > 0) {
          selectedFiles.push(file);
          continue;
        }
        await selectIqiyiEpisodeFiles(page, root, [file], options);
        const expectedFiles = [...selectedFiles, file];
        await waitForIqiyiEpisodeRegistration(page, root, expectedFiles, deadline);
        selectedFiles.push(file);
        log(
          options,
          `[iqiyi-drama] missing episode registered: ${selectedFiles.length}/${prepared.files.length}`,
        );
      }
    }

    await waitForIqiyiVideoUploadComplete(page, root, selectedFiles, deadline, options);
    await throwIfIqiyiFormInvalid(page);
  } catch (error) {
    throw Object.assign(
      new Error(`IQIYI_DRAMA_EPISODE_UPLOAD_ERROR: ${message(error)}`),
      { cause: error },
    );
  } finally {
    if (prepared) await cleanupEpisodeUploadFiles(prepared);
  }
}
