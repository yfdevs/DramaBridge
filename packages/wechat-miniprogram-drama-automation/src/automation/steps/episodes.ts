import type { Locator, Page } from "playwright";
import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import { resolveRunDataPath } from "../../shared/config.js";
import { createLogger } from "../../shared/logger.js";
import { getWechatMiniProgramRuntimeSettings } from "../../shared/runtime-settings.js";
import { integerSetting, secondsSettingToMs } from "../../shared/settings-value.js";
import type { Config, PreparedEpisodeVideo } from "../../shared/types.js";
import { uploadPagePath } from "../constants.js";
import { gotoMiniProgramPage } from "../portal-navigation.js";
import { monitorEpisodeVodUploads } from "../upload/vod-monitor.js";

export interface EpisodeUploadStepOptions {
  episodeVideos?: PreparedEpisodeVideo[];
  videoAccountLabel?: string;
  onProgress?: (progress: { completed: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface EpisodeVideosOnlyInput extends EpisodeUploadStepOptions {
  resourceName: string;
  uploadBaseName: string;
  episodeCount: number;
}

const uploadLogger = createLogger("upload");

function normalizeUiText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function episodeUploadWaitTimeoutMs(): number {
  return secondsSettingToMs(
    getWechatMiniProgramRuntimeSettings().episodeUploadWaitTimeoutSeconds,
    120 * 60,
  );
}

function episodeUploadFailedRetryAttempts(): number {
  return integerSetting(
    getWechatMiniProgramRuntimeSettings().episodeUploadFailedRetryAttempts,
    5,
  );
}

async function visibleErrorTexts(page: Page): Promise<string[]> {
  const selectors = [
    ".weui-toptips__inner",
    ".errmsg",
    ".status-error",
    ".weui-desktop-form__msg_warn",
  ];
  const texts: string[] = [];
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const item = matches.nth(index);
      if (!await item.isVisible().catch(() => false)) continue;
      const text = normalizeUiText(await item.innerText().catch(() => ""));
      if (text) texts.push(text);
    }
  }
  return Array.from(new Set(texts));
}

async function waitForPreparedUploadRows(page: Page, expectedCount: number): Promise<void> {
  const rows = page.locator("table tbody tr");
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const rowCount = await rows.count();
    if (rowCount === expectedCount) return;
    const errors = await visibleErrorTexts(page);
    if (errors.length > 0) {
      throw new Error(`[episode-upload-validation-failed] ${errors.join("；")}`);
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`[upload-failed] 本地上传列表未出现完整剧集：期望 ${expectedCount} 集。`);
}

async function cleanupEpisodeUploadDir(uploadDir: string, accountLabel?: string): Promise<void> {
  await cleanupEpisodeUploadFiles({ uploadDir, files: [] }).catch((error: unknown) => {
    uploadLogger.warn("临时剧集目录清理失败", {
      accountName: accountLabel,
      path: uploadDir,
      error,
    });
  });
}

export async function uploadEpisodeFilesStep(
  page: Page,
  config: Config,
  options: EpisodeUploadStepOptions = {},
): Promise<void> {
  return uploadEpisodeVideosOnly(page, {
    resourceName: config.originalTitle,
    uploadBaseName: config.playlet.name,
    episodeCount: config.playlet.episodeCount,
    ...options,
  });
}

export async function uploadEpisodeVideosOnly(
  page: Page,
  input: EpisodeVideosOnlyInput,
): Promise<void> {
  input.signal?.throwIfAborted();
  uploadLogger.info("正在准备本地剧集视频", {
    title: input.uploadBaseName,
    episodeCount: input.episodeCount,
  });
  await gotoMiniProgramPage(page, uploadPagePath);
  await page.getByRole("heading", { name: "视频上传" }).waitFor({ state: "visible", timeout: 30000 });

  const prepared = await prepareEpisodeUploadFiles({
    localEpisodeVideoRoot: getWechatMiniProgramRuntimeSettings().localEpisodeVideoRoot,
    resourceName: input.resourceName,
    uploadRootDir: resolveRunDataPath(),
    uploadBaseName: input.uploadBaseName,
    episodes: input.episodeVideos,
  });
  input.signal?.throwIfAborted();

  try {
    const videoFiles = prepared.files;
    if (videoFiles.length !== input.episodeCount) {
      throw new Error(
        `[upload-failed] 剧集视频：期望 ${input.episodeCount} 个本地文件，实际 ${videoFiles.length} 个。`,
      );
    }

    const batches = Array.from(
      { length: Math.ceil(videoFiles.length / 100) },
      (_, index) => videoFiles.slice(index * 100, (index + 1) * 100),
    );
    const uploadTimeout = episodeUploadWaitTimeoutMs();
    const uploadStartedAt = Date.now();
    const uploadDeadline = uploadStartedAt + uploadTimeout;
    let uploadedCount = 0;
    uploadLogger.info("剧集上传监控参数已加载", {
      accountName: input.videoAccountLabel,
      episodeCount: videoFiles.length,
      timeoutMinutes: Math.round(uploadTimeout / 60000),
      maxRetryAttempts: episodeUploadFailedRetryAttempts(),
    });

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      input.signal?.throwIfAborted();
      const batch = batches[batchIndex];
      if (batchIndex > 0) {
        await gotoMiniProgramPage(page, uploadPagePath);
        await page.getByRole("heading", { name: "视频上传" })
          .waitFor({ state: "visible", timeout: 30000 });
      }

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(batch, { timeout: 120000 });
      await waitForPreparedUploadRows(page, batch.length);

      const startButton = page.getByRole("button", { name: "开始上传", exact: true });
      await startButton.waitFor({ state: "visible", timeout: 30000 });
      uploadLogger.info("本地剧集已加入上传列表", {
        accountName: input.videoAccountLabel,
        batch: batchIndex + 1,
        batchCount: batches.length,
        episodeCount: batch.length,
      });

      const remainingUploadTime = uploadDeadline - Date.now();
      if (remainingUploadTime <= 0) {
        throw new Error(
          `[upload-failed] 剧集上传超时：总等待时间已超过 ${Math.round(uploadTimeout / 60000)} 分钟。`,
        );
      }

      const report = await monitorEpisodeVodUploads(
        page,
        batch.length,
        () => startButton.click({ timeout: 30000 }),
        remainingUploadTime,
        {
          batchIndex: batchIndex + 1,
          batchCount: batches.length,
          completedBefore: uploadedCount,
          totalCount: videoFiles.length,
          accountName: input.videoAccountLabel,
          maxRetryAttempts: episodeUploadFailedRetryAttempts(),
          startedAt: uploadStartedAt,
          totalTimeoutMs: uploadTimeout,
          signal: input.signal,
        },
      );
      if (report.successes.length !== batch.length) {
        throw new Error(
          `[upload-failed] 微信小程序素材库第 ${batchIndex + 1} 批仅确认 ${report.successes.length}/${batch.length} 集上传成功。`,
        );
      }
      uploadedCount += report.successes.length;
      input.onProgress?.({ completed: uploadedCount, total: videoFiles.length });
      uploadLogger.info("剧集上传批次已完成", {
        accountName: input.videoAccountLabel,
        batch: batchIndex + 1,
        batchCount: batches.length,
        completedCount: uploadedCount,
        total: videoFiles.length,
        progress: `${uploadedCount}/${videoFiles.length}`,
      });

      const errors = await visibleErrorTexts(page);
      if (errors.length > 0) {
        throw new Error(`[upload-failed] 微信页面提示：${errors.join("；")}`);
      }
    }
    uploadLogger.info("本地剧集已全部上传到微信小程序素材库", {
      accountName: input.videoAccountLabel,
      episodeCount: uploadedCount,
    });
  } finally {
    await cleanupEpisodeUploadDir(prepared.uploadDir, input.videoAccountLabel);
  }
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function episodeIndexFromFileName(fileName: string, playletName: string): number | null {
  const match = normalizeUiText(fileName).match(
    new RegExp(`^${escapedRegex(playletName)}-第([1-9]\\d*)集\\.(?:mp4|mov)$`, "i"),
  );
  return match ? Number(match[1]) : null;
}

function episodeLibraryTable(page: Page): Locator {
  const fileNameHeader = page.locator("thead th")
    .filter({ hasText: /^\s*文件名\s*$/ });
  return page.locator("table:visible")
    .filter({ has: fileNameHeader })
    .filter({ has: page.locator('tbody input[type="checkbox"]') })
    .last();
}

function episodeLibraryRows(table: Locator): Locator {
  return table.locator("tbody tr:visible");
}

interface EpisodeLibraryRowSnapshot {
  fileName: string;
  rowText: string;
  checked: boolean;
  hasCheckbox: boolean;
}

async function episodeLibraryRowSnapshots(table: Locator): Promise<EpisodeLibraryRowSnapshot[]> {
  const snapshots = await episodeLibraryRows(table).evaluateAll((elements) => elements.map((element) => {
    const cells = Array.from(element.querySelectorAll("td"));
    const fileNameCell = element.querySelector("td.media-table-row.col2")
      ?? element.querySelector("td.table-name")
      ?? cells.find((cell) => /\.(?:mp4|mov)(?:\s|$)/i.test(cell.textContent ?? ""))
      ?? cells[1]
      ?? cells[0];
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    return {
      fileName: fileNameCell?.textContent ?? "",
      rowText: element.textContent ?? "",
      checked: checkbox?.checked ?? false,
      hasCheckbox: Boolean(checkbox),
    };
  })).catch(() => []);
  return snapshots.map((snapshot) => ({
    ...snapshot,
    fileName: normalizeUiText(snapshot.fileName),
    rowText: normalizeUiText(snapshot.rowText),
  }));
}

async function episodeFileNameFromRow(row: Locator): Promise<string> {
  // 在页面脚本中一次性读取，避免对不存在的旧版列选择器调用 innerText() 时
  // 每行触发 Playwright 默认 30 秒自动等待。
  const snapshot = await row.evaluate((element) => {
    const cells = Array.from(element.querySelectorAll("td"));
    const preferredCell = element.querySelector("td.media-table-row.col2")
      ?? element.querySelector("td.table-name")
      ?? cells.find((cell) => /\.(?:mp4|mov)(?:\s|$)/i.test(cell.textContent ?? ""))
      ?? cells[1]
      ?? cells[0];
    return {
      fileName: preferredCell?.textContent ?? "",
      rowText: element.textContent ?? "",
    };
  }).catch(() => ({ fileName: "", rowText: "" }));
  const fileName = normalizeUiText(snapshot.fileName);
  if (fileName) return fileName;

  const rowText = normalizeUiText(snapshot.rowText);
  throw new Error(
    `[episode-selection-failed] 无法从选集表格第二列读取文件名：${rowText || "空行"}`,
  );
}

async function checkboxState(checkbox: Locator): Promise<boolean | undefined> {
  return checkbox.evaluate(
    (element) => (element as HTMLInputElement).checked,
  ).catch(() => undefined);
}

async function waitForCheckboxState(
  checkbox: Locator,
  checked: boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await checkboxState(checkbox);
    if (current === checked) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function setRowChecked(row: Locator, checked: boolean): Promise<void> {
  const checkbox = row.locator('input[type="checkbox"]').first();
  if (await checkbox.count()) {
    if (await checkboxState(checkbox) === checked) return;

    const visibleIcon = checkbox.locator("xpath=following-sibling::i[1]").first();
    const containingLabel = checkbox.locator("xpath=ancestor::label[1]").first();
    const controls = [containingLabel, visibleIcon];
    for (const control of controls) {
      if ((await control.count()) === 0 || !await control.isVisible().catch(() => false)) continue;
      await control.scrollIntoViewIfNeeded().catch(() => undefined);
      await control.click({ force: true, timeout: 1500 }).catch(() => undefined);
      if (await waitForCheckboxState(checkbox, checked, 500)) return;
    }

    // 微信将真实 checkbox 放在可视区域外，仅保留自定义图标。坐标点击不可用时，
    // 再通过原生 click 触发框架监听器。
    await checkbox.evaluate((element, targetChecked) => {
      const input = element as HTMLInputElement;
      if (input.checked !== targetChecked) input.click();
    }, checked).catch(() => undefined);
    if (await waitForCheckboxState(checkbox, checked, 500)) return;

    // setChecked 对微信当前的隐藏 input 通常无效，因此只作为短时兜底，
    // 避免每一集先等待数秒再点击真正有效的可视控件。
    await checkbox.setChecked(checked, { force: true, timeout: 1000 }).catch(() => undefined);
    if (await waitForCheckboxState(checkbox, checked, 500)) return;

    // 最终兼容路径：同步属性并派发 Vue 常用的 input/change 事件。
    await checkbox.evaluate((element, targetChecked) => {
      const input = element as HTMLInputElement;
      input.checked = targetChecked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, checked);
    if (await waitForCheckboxState(checkbox, checked, 500)) return;

    const rowText = normalizeUiText(await row.innerText().catch(() => "未知剧集"));
    throw new Error(`[episode-selection-failed] 剧集复选框状态未更新：${rowText}`);
  }

  const rowText = normalizeUiText(await row.innerText().catch(() => "未知剧集"));
  throw new Error(`[episode-selection-failed] 剧集行未找到可校验的复选框：${rowText}`);
}

async function nextPage(
  page: Page,
  table: Locator,
  previousFirstRow: string,
): Promise<boolean> {
  const pagination = page.locator(".weui-desktop-pagination:visible").last();
  const next = pagination.getByText("下一页", { exact: true }).first();
  if (!await next.isVisible().catch(() => false)) return false;
  const className = await next.getAttribute("class");
  const ariaDisabled = await next.getAttribute("aria-disabled");
  if (ariaDisabled === "true" || /disabled/i.test(className ?? "")) return false;

  const previousPageNumber = normalizeUiText(
    await pagination.locator(".weui-desktop-pagination__num_current").first().innerText().catch(() => ""),
  );
  await next.click({ timeout: 15000 });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const currentPageNumber = normalizeUiText(
      await pagination.locator(".weui-desktop-pagination__num_current").first().innerText().catch(() => ""),
    );
    const currentFirstRow = normalizeUiText(
      await episodeLibraryRows(table).first().innerText({ timeout: 1000 }).catch(() => ""),
    );
    if (
      (previousPageNumber && currentPageNumber && currentPageNumber !== previousPageNumber)
      || (currentFirstRow && currentFirstRow !== previousFirstRow)
    ) {
      return true;
    }
    await page.waitForTimeout(200);
  }

  throw new Error(
    `[episode-selection-failed] 点击“下一页”后页码和剧集列表均未变化，当前页=${previousPageNumber || "未知"}。`,
  );
}

interface EpisodeSelectionSummary {
  selected: number;
  total: number;
  text: string;
}

interface ExactEpisodeSelectionResult {
  selectedIndexes: Set<number>;
  selectedFileNames: Map<number, string>;
  duplicateIndexes: Set<number>;
  ignoredSimilarFileNames: Set<string>;
  pagesScanned: number;
}

const maxEpisodeLibraryPages = 100;

async function readEpisodeSelectionSummary(page: Page): Promise<EpisodeSelectionSummary> {
  const summary = page.locator(".table-operation-left:visible")
    .filter({ hasText: /已选\s*\d+\s*\/\s*\d+\s*集/ })
    .last();
  if ((await summary.count()) === 0) {
    throw new Error("[episode-selection-failed] 未找到页面底部的“已选 N/N 集”统计。");
  }

  const text = normalizeUiText(await summary.innerText().catch(() => ""));
  const match = text.match(/已选\s*(\d+)\s*\/\s*(\d+)\s*集/);
  if (!match) {
    throw new Error(`[episode-selection-failed] 无法解析页面选集统计：${text || "空"}`);
  }
  return { selected: Number(match[1]), total: Number(match[2]), text };
}

async function applyEpisodeSearch(
  page: Page,
  table: Locator,
  searchInput: Locator,
  value: string,
): Promise<string[]> {
  await searchInput.fill(value);
  await searchInput.press("Enter").catch(() => undefined);

  const deadline = Date.now() + 30000;
  let previousSignature = "";
  let stableSamples = 0;
  let lastFileNames: string[] = [];
  while (Date.now() < deadline) {
    if (await table.isVisible().catch(() => false)) {
      const fileNames = (await episodeLibraryRowSnapshots(table))
        .map((snapshot) => snapshot.fileName)
        .filter(Boolean);
      lastFileNames = fileNames;

      // 搜索完成后，当前页每个文件都应包含搜索词；连续两次快照一致，
      // 可避免读取到输入 Enter 前遗留的旧表格内容。
      const matchesSearch = fileNames.length > 0
        && (!value || fileNames.every((fileName) => fileName.includes(value)));
      const signature = fileNames.join("\n");
      if (matchesSearch && signature === previousSignature) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          uploadLogger.info("剧集文件搜索结果已就绪", {
            query: value || "全部文件",
            rowCount: fileNames.length,
          });
          return fileNames;
        }
      } else {
        previousSignature = signature;
        stableSamples = matchesSearch ? 1 : 0;
      }
    }

    const errors = await visibleErrorTexts(page);
    if (errors.length > 0) {
      throw new Error(`[episode-selection-failed] 搜索文件库失败：${errors.join("；")}`);
    }
    await page.waitForTimeout(200);
  }

  throw new Error(
    `[episode-selection-failed] 搜索“${value || "全部文件"}”后 30 秒内未出现稳定结果，`
    + `最后读取到 ${lastFileNames.length} 行。`,
  );
}

async function clearExistingEpisodeSelections(
  page: Page,
  table: Locator,
  searchInput: Locator,
): Promise<void> {
  const before = await readEpisodeSelectionSummary(page);
  if (before.selected === 0) return;

  uploadLogger.warn("检测到历史选集状态，开始清空后重新精确选择", {
    selected: before.selected,
    total: before.total,
    status: before.text,
  });
  await applyEpisodeSearch(page, table, searchInput, "");

  let clearedCount = 0;
  let clearingFinished = false;
  for (let pageIndex = 0; pageIndex < maxEpisodeLibraryPages; pageIndex += 1) {
    const rows = episodeLibraryRows(table);
    const rowCount = await rows.count();
    let firstRowText = "";

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex);
      const rowText = normalizeUiText(await row.innerText().catch(() => ""));
      firstRowText ||= rowText;
      const checkbox = row.locator('input[type="checkbox"]').first();
      if ((await checkbox.count()) === 0 || !await checkboxState(checkbox)) continue;
      await setRowChecked(row, false);
      clearedCount += 1;
    }

    if (clearedCount >= before.selected) {
      clearingFinished = true;
      break;
    }
    if (!await nextPage(page, table, firstRowText)) {
      clearingFinished = true;
      break;
    }
  }

  if (!clearingFinished) {
    throw new Error(
      `[episode-selection-failed] 清理历史选集时文件库超过 ${maxEpisodeLibraryPages} 页，已停止提交。`,
    );
  }

  const after = await readEpisodeSelectionSummary(page);
  if (after.selected !== 0) {
    throw new Error(
      `[episode-selection-failed] 历史选集未清空：页面仍显示 ${after.selected}/${after.total} 集。`,
    );
  }
  uploadLogger.info("历史选集状态已清空", { clearedCount, status: after.text });
}

async function selectExactEpisodeRows(
  page: Page,
  table: Locator,
  searchInput: Locator,
  playletName: string,
  expectedCount: number,
): Promise<ExactEpisodeSelectionResult> {
  const firstPageFileNames = await applyEpisodeSearch(page, table, searchInput, playletName);
  uploadLogger.info("开始精确勾选剧集文件", {
    title: playletName,
    expectedCount,
    firstPageRowCount: firstPageFileNames.length,
  });
  const selectedIndexes = new Set<number>();
  const selectedFileNames = new Map<number, string>();
  const duplicateIndexes = new Set<number>();
  const ignoredSimilarFileNames = new Set<string>();
  let selectionScanFinished = false;
  let pagesScanned = 0;

  for (let pageIndex = 0; pageIndex < maxEpisodeLibraryPages; pageIndex += 1) {
    pagesScanned = pageIndex + 1;
    const rows = episodeLibraryRows(table);
    const rowCount = await rows.count();
    let firstRowText = "";

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex);
      const rowText = normalizeUiText(await row.innerText().catch(() => ""));
      firstRowText ||= rowText;
      const fileName = await episodeFileNameFromRow(row);
      const episodeIndex = episodeIndexFromFileName(fileName, playletName);

      if (!episodeIndex || episodeIndex < 1 || episodeIndex > expectedCount) {
        if (fileName.startsWith(`${playletName}-第`)) ignoredSimilarFileNames.add(fileName);
        const checkbox = row.locator('input[type="checkbox"]').first();
        if ((await checkbox.count()) > 0 && await checkboxState(checkbox)) {
          await setRowChecked(row, false);
        }
        continue;
      }

      if (selectedIndexes.has(episodeIndex)) {
        duplicateIndexes.add(episodeIndex);
        const checkbox = row.locator('input[type="checkbox"]').first();
        if ((await checkbox.count()) > 0 && await checkboxState(checkbox)) {
          await setRowChecked(row, false);
        }
        continue;
      }

      uploadLogger.info("正在勾选剧集文件", {
        episode: episodeIndex,
        fileName,
        current: selectedIndexes.size + 1,
        total: expectedCount,
      });
      await setRowChecked(row, true);
      selectedIndexes.add(episodeIndex);
      selectedFileNames.set(episodeIndex, fileName);
      uploadLogger.info("剧集文件选择进度", {
        episode: episodeIndex,
        fileName,
        current: selectedIndexes.size,
        total: expectedCount,
        progress: `${selectedIndexes.size}/${expectedCount}`,
      });
    }

    uploadLogger.info("剧集文件分页筛选进度", {
      page: pageIndex + 1,
      selectedCount: selectedIndexes.size,
      expectedCount,
      progress: `${selectedIndexes.size}/${expectedCount}`,
    });
    if (selectedIndexes.size >= expectedCount) {
      selectionScanFinished = true;
      break;
    }
    if (!await nextPage(page, table, firstRowText)) {
      selectionScanFinished = true;
      break;
    }
    uploadLogger.info("已进入下一页继续筛选剧集", {
      page: pageIndex + 2,
      selectedCount: selectedIndexes.size,
      expectedCount,
    });
  }

  if (!selectionScanFinished) {
    throw new Error(
      `[episode-selection-failed] 搜索结果超过 ${maxEpisodeLibraryPages} 页，无法完成全部重复项检查。`,
    );
  }
  return {
    selectedIndexes,
    selectedFileNames,
    duplicateIndexes,
    ignoredSimilarFileNames,
    pagesScanned,
  };
}

async function auditExactEpisodeSelections(
  page: Page,
  table: Locator,
  searchInput: Locator,
  playletName: string,
  expectedCount: number,
  refreshSearch: boolean,
): Promise<void> {
  if (refreshSearch) {
    await applyEpisodeSearch(page, table, searchInput, playletName);
  }
  const beforeAudit = await readEpisodeSelectionSummary(page);
  if (beforeAudit.selected !== expectedCount || beforeAudit.total !== expectedCount) {
    throw new Error(
      `[episode-selection-failed] 页面选集计数错误：要求 ${expectedCount}/${expectedCount}，`
      + `实际 ${beforeAudit.selected}/${beforeAudit.total}。`,
    );
  }
  const checkedIndexes = new Set<number>();
  const checkedFileNames = new Set<string>();
  let auditScanFinished = false;

  for (let pageIndex = 0; pageIndex < maxEpisodeLibraryPages; pageIndex += 1) {
    const snapshots = await episodeLibraryRowSnapshots(table);
    const firstRowText = snapshots[0]?.rowText ?? "";

    for (const snapshot of snapshots) {
      if (!snapshot.hasCheckbox || !snapshot.checked) continue;

      const fileName = snapshot.fileName;
      const episodeIndex = episodeIndexFromFileName(fileName, playletName);
      if (!episodeIndex || episodeIndex < 1 || episodeIndex > expectedCount) {
        throw new Error(`[episode-selection-failed] 勾选了名称或集数不正确的文件：${fileName}`);
      }
      if (checkedIndexes.has(episodeIndex) || checkedFileNames.has(fileName)) {
        throw new Error(`[episode-selection-failed] 第 ${episodeIndex} 集被重复勾选：${fileName}`);
      }
      checkedIndexes.add(episodeIndex);
      checkedFileNames.add(fileName);
    }

    if (checkedIndexes.size >= expectedCount) {
      auditScanFinished = true;
      break;
    }
    if (!await nextPage(page, table, firstRowText)) {
      auditScanFinished = true;
      break;
    }
  }

  if (!auditScanFinished) {
    throw new Error(
      `[episode-selection-failed] 复核选集时搜索结果超过 ${maxEpisodeLibraryPages} 页，已停止提交。`,
    );
  }

  const missingIndexes = Array.from({ length: expectedCount }, (_, index) => index + 1)
    .filter((index) => !checkedIndexes.has(index));
  if (checkedIndexes.size !== expectedCount || missingIndexes.length > 0) {
    throw new Error(
      `[episode-selection-failed] 实际勾选不完整：已勾选 ${checkedIndexes.size}/${expectedCount} 集，`
      + `缺少第 ${missingIndexes.join("、") || "未知"} 集。`,
    );
  }

  const summary = await readEpisodeSelectionSummary(page);
  if (summary.selected !== expectedCount || summary.total !== expectedCount) {
    throw new Error(
      `[episode-selection-failed] 页面选集计数错误：要求 ${expectedCount}/${expectedCount}，`
      + `实际 ${summary.selected}/${summary.total}。`,
    );
  }
  uploadLogger.info("剧集勾选复核通过", {
    checkedCount: checkedIndexes.size,
    expectedCount,
    status: summary.text,
  });
}

export async function selectUploadedEpisodeFilesStep(page: Page, config: Config): Promise<void> {
  const expectedCount = config.playlet.episodeCount;
  const searchInput = page.getByPlaceholder("搜索文件名").first();
  await searchInput.waitFor({ state: "visible", timeout: 30000 });
  const table = episodeLibraryTable(page);
  await table.waitFor({ state: "visible", timeout: 30000 });
  uploadLogger.info("已定位剧集文件库表格，准备筛选", {
    title: config.playlet.name,
    expectedCount,
  });

  let selectionCompleted = false;
  let lastSelectionError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await clearExistingEpisodeSelections(page, table, searchInput);
      const result = await selectExactEpisodeRows(
        page,
        table,
        searchInput,
        config.playlet.name,
        expectedCount,
      );
      const missingIndexes = Array.from({ length: expectedCount }, (_, index) => index + 1)
        .filter((index) => !result.selectedIndexes.has(index));
      if (missingIndexes.length > 0 || result.selectedFileNames.size !== expectedCount) {
        throw new Error(
          `[episode-selection-failed] 已上传文件库缺少 ${config.playlet.name} 的第 ${missingIndexes.join("、")} 集。`,
        );
      }
      if (result.duplicateIndexes.size > 0) {
        uploadLogger.warn("文件库存在同集同名文件，已确保每集只勾选一个", {
          episodes: Array.from(result.duplicateIndexes).sort((left, right) => left - right).join("、"),
        });
      }
      if (result.ignoredSimilarFileNames.size > 0) {
        uploadLogger.warn("已忽略名称或集数不完全匹配的文件", {
          files: Array.from(result.ignoredSimilarFileNames).join("、"),
        });
      }
      await auditExactEpisodeSelections(
        page,
        table,
        searchInput,
        config.playlet.name,
        expectedCount,
        result.pagesScanned > 1,
      );
      selectionCompleted = true;
      break;
    } catch (error) {
      lastSelectionError = error;
      if (attempt >= 2) break;
      uploadLogger.warn("剧集勾选复核未通过，清空后自动重选", {
        attempt,
        maxAttempts: 2,
        error,
      });
    }
  }
  if (!selectionCompleted) {
    throw lastSelectionError ?? new Error("[episode-selection-failed] 剧集勾选未完成。");
  }

  const confirmButton = page.getByRole("button", { name: "确认提审", exact: true }).first();
  await confirmButton.waitFor({ state: "visible", timeout: 30000 });
  await confirmButton.click({ timeout: 30000 });
  await page.waitForTimeout(1000);

  const errors = await visibleErrorTexts(page);
  if (errors.length > 0) {
    throw new Error(`[confirm-review-validation-failed] ${errors.join("；")}`);
  }
  uploadLogger.info("已从微信小程序上传文件库选择全部剧集", { episodeCount: expectedCount });
}
