import type { BrowserContext, Locator, Page } from "playwright";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  listLocalPosterImages,
  prepareCroppedImageVariant,
} from "@dramabridge/media-assets";
import { fetchApprovedShortplays } from "./shortplay-manage-page.js";
import { PinduoduoUploadRecordsRepository } from "../storage/pinduoduo-upload-records-repository.js";
import {
  PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE,
  PinduoduoLegacyResourceLinksRepository,
  resolvePinduoduoResource,
} from "../storage/pinduoduo-legacy-resource-links.js";
import type {
  PinduoduoUploadRecord,
  PinduoduoUploadRecordStage,
} from "../storage/pinduoduo-upload-records-types.js";
import { log } from "../shared/logger.js";
import type { PinduoduoDramaRuntimeOptions } from "../shared/types.js";

const CREATOR_PUBLISH_URL = "https://mcn.pinduoduo.com/home/creator/publish";
const VIDEO_EXTENSIONS = new Set([".mp4", ".wmv", ".mov", ".avi", ".m4v"]);
const DEFAULT_UPLOAD_VERIFY_TIMEOUT_MINUTES = 60;
const VIDEO_UPLOAD_INPUT_SELECTOR = 'input[data-testid="beast-core-upload-input"][accept*=".mp4"]';
const AI_CONTENT_DECLARATION_LABEL = "含AI生成内容";
const PLATFORM_UPLOAD_FAILURE_MARKER = "视频上传失败";
const POST_PUBLISH_SETTLE_MS = 10_000;
const EXISTING_DRAMA_LOOKUP_TIMEOUT_MS = 5 * 60_000;
const MAX_FILES_PER_UPLOAD_PAGE = 50;
const COVER_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const COVER_UPLOAD_LOG_INTERVAL_MS = 5_000;
const VIDEO_UPLOAD_PROGRESS_LOG_INTERVAL_MS = 10_000;
const DRAMA_LIST_SCROLL_INTERVAL_MS = 120;
const DRAMA_LIST_BOTTOM_POLL_INTERVAL_MS = 400;
const DRAMA_LIST_STABLE_BOTTOM_POLLS = 10;

function throwIfRuntimeStopped(options: PinduoduoDramaRuntimeOptions): void {
  options.signal?.throwIfAborted();
}

function runtimeWasStopped(options: PinduoduoDramaRuntimeOptions): boolean {
  return options.signal?.aborted === true;
}

export function pinduoduoUploadVerifyTimeoutMs(options: PinduoduoDramaRuntimeOptions): number {
  const configured = Number.parseInt(
    String(options.config?.video?.videoUploadTimeoutMinutes ?? ""),
    10,
  );
  const minutes = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_UPLOAD_VERIFY_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

function creatorPublishUrl(options: PinduoduoDramaRuntimeOptions): string {
  const uid = options.config?.creatorUid?.trim();
  if (!uid) throw new Error("Pinduoduo creator UID is required.");
  return `${CREATOR_PUBLISH_URL}?uid=${encodeURIComponent(uid)}`;
}

function openRecordPage(
  context: BrowserContext,
  record: PinduoduoUploadRecord,
  options: PinduoduoDramaRuntimeOptions,
): Promise<Page> {
  return context.newPage().then(async (page) => {
    await page.goto(creatorPublishUrl(options), { waitUntil: "domcontentloaded", timeout: 60_000 });
    log(options, "info", "runtime", "opened creator video upload page", {
      title: record.title,
      uid: options.config?.creatorUid,
      url: page.url(),
    });
    return page;
  });
}

async function listVideoFiles(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) =>
      basename(left).localeCompare(basename(right), "zh-CN", { numeric: true }),
    );
}

export function splitPinduoduoVideoFiles(files: string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < files.length; index += MAX_FILES_PER_UPLOAD_PAGE) {
    batches.push(files.slice(index, index + MAX_FILES_PER_UPLOAD_PAGE));
  }
  return batches;
}

export function assertPinduoduoEpisodeFileCount(
  files: string[],
  expectedEpisodeCount: number | undefined,
): void {
  if (!expectedEpisodeCount || expectedEpisodeCount < 1) return;
  if (files.length !== expectedEpisodeCount) {
    throw new Error(
      `PINDUODUO_EPISODE_FILE_COUNT_MISMATCH: 应有 ${expectedEpisodeCount} 集，` +
        `本地实际发现 ${files.length} 个视频；为避免缺集或错集，已停止发布`,
    );
  }
}

function videoCardLocator(page: Page, fileName: string): Locator {
  return page
    .locator("p", { hasText: `文件名：${fileName}` })
    .locator('xpath=ancestor::div[.//*[@data-testid="beast-core-select"]][1]');
}

function firstVideoCardLocator(page: Page): Locator {
  return page
    .locator("p")
    .filter({ hasText: /^\s*文件名：/ })
    .first()
    .locator('xpath=ancestor::div[.//button[contains(.,"添加至已有短剧")]][1]');
}

function videoUploadSuccessMarker(page: Page, fileName: string): Locator {
  return videoCardLocator(page, fileName)
    .getByText("视频上传成功", { exact: true })
    .first();
}

async function fillVideoDescription(card: Locator, fileName: string): Promise<void> {
  const description = fileName.replace(/\.[^.]+$/, "");
  const editor = card.locator('[contenteditable="true"]').first();
  await editor.fill(description);
}

async function selectVideoDeclaration(page: Page, card: Locator): Promise<void> {
  const declarationSelect = card.locator('[data-testid="beast-core-select"]').first();
  await selectAiContentDeclaration(page, declarationSelect);
}

export async function selectAiContentDeclaration(page: Page, declarationSelect: Locator): Promise<void> {
  const input = declarationSelect.locator('[data-testid="beast-core-select-htmlInput"]').first();
  await input.waitFor({ state: "attached", timeout: 10_000 });
  if ((await input.inputValue()) === AI_CONTENT_DECLARATION_LABEL) return;

  const trigger = declarationSelect.locator('[data-testid="beast-core-select-header"]').first();
  await trigger.click({ timeout: 10_000 });
  const dropdown = page.locator('[data-testid="beast-core-portal"]:visible').last();
  await dropdown.waitFor({ state: "visible", timeout: 10_000 });

  const option = dropdown
    .getByText(AI_CONTENT_DECLARATION_LABEL, { exact: true })
    .filter({ visible: true })
    .last();
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click({ timeout: 10_000 });
  await dropdown.waitFor({ state: "hidden", timeout: 5_000 });

  const selectionDeadline = Date.now() + 5_000;
  while ((await input.inputValue().catch(() => "")) !== AI_CONTENT_DECLARATION_LABEL) {
    if (Date.now() >= selectionDeadline) {
      throw new Error(`PINDUODUO_AI_CONTENT_DECLARATION_NOT_SELECTED: ${AI_CONTENT_DECLARATION_LABEL}`);
    }
    await page.waitForTimeout(100);
  }
}

async function readPlatformUploadFailure(page: Page): Promise<{ rejected: boolean; reasons: string[] }> {
  return page.evaluate(
    (marker) => {
      if (!document.body.textContent?.includes(marker)) {
        return { rejected: false, reasons: [] };
      }
      const reasons = new Set<string>();
      document.querySelectorAll("span").forEach((element) => {
        const text = (element.textContent ?? "").trim();
        if (
          text.length > 0 &&
          text.length < 80 &&
          !text.includes(marker) &&
          /不能|不得低于|需满足|不支持|超过|低于/.test(text)
        ) {
          reasons.add(text);
        }
      });
      return { rejected: true, reasons: [...reasons] };
    },
    PLATFORM_UPLOAD_FAILURE_MARKER,
  );
}

export async function waitForPinduoduoVideoUploads(
  page: Page,
  files: string[],
  timeoutMs: number,
  onProgress?: (uploadedCount: number, totalCount: number, elapsedSeconds: number) => void,
  signal?: AbortSignal,
): Promise<{ rejected: boolean; reasons: string[] }> {
  const startedAt = Date.now();
  let lastUploadedCount = -1;
  let nextProgressLogAt = startedAt;

  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted();
    let uploadedCount = 0;
    for (const file of files) {
      const successMarker = videoUploadSuccessMarker(page, basename(file));
      if (await successMarker.isVisible().catch(() => false)) uploadedCount += 1;
    }

    const now = Date.now();
    if (uploadedCount !== lastUploadedCount || now >= nextProgressLogAt) {
      onProgress?.(uploadedCount, files.length, Math.floor((now - startedAt) / 1_000));
      lastUploadedCount = uploadedCount;
      nextProgressLogAt = now + VIDEO_UPLOAD_PROGRESS_LOG_INTERVAL_MS;
    }
    if (uploadedCount === files.length) {
      return { rejected: false, reasons: [] };
    }

    const platformFailure = await readPlatformUploadFailure(page);
    if (platformFailure.rejected) return platformFailure;
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `等待视频上传成功数量达标超时：已成功 ${Math.max(0, lastUploadedCount)}/${files.length}，` +
      `等待 ${Math.round(timeoutMs / 60_000)} 分钟`,
  );
}

async function findDramaCheckboxByScrolling(
  page: Page,
  list: Locator,
  dramaTitle: string,
): Promise<Locator | undefined> {
  const deadline = Date.now() + EXISTING_DRAMA_LOOKUP_TIMEOUT_MS;
  let lastScrollHeight = -1;
  let stableBottomPolls = 0;
  while (Date.now() < deadline) {
    const row = list
      .getByText(dramaTitle, { exact: true })
      .locator('xpath=ancestor::label[@data-testid="beast-core-checkbox"][1]')
      .last();
    if ((await row.count()) > 0) {
      await row.scrollIntoViewIfNeeded();
      return row;
    }

    const scrollState = await list.evaluate((root) => {
      const candidates: HTMLElement[] = [root as HTMLElement];
      let parent = root.parentElement;
      while (parent && candidates.length < 8) {
        candidates.push(parent);
        parent = parent.parentElement;
      }
      const scroller = candidates.find(
        (element) => element.scrollHeight > element.clientHeight + 2,
      );
      if (!scroller) return { atBottom: true, scrollHeight: 0 };
      // Keep a small overlap between viewports so virtualized rows cannot be
      // skipped while still moving through long lists quickly.
      const step = Math.max(240, Math.floor(scroller.clientHeight * 0.9));
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      return {
        atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
        scrollHeight: scroller.scrollHeight,
      };
    });
    if (scrollState.atBottom && scrollState.scrollHeight === lastScrollHeight) {
      stableBottomPolls += 1;
    } else {
      stableBottomPolls = 0;
    }
    lastScrollHeight = scrollState.scrollHeight;
    if (stableBottomPolls >= DRAMA_LIST_STABLE_BOTTOM_POLLS) return undefined;
    await page.waitForTimeout(
      scrollState.atBottom
        ? DRAMA_LIST_BOTTOM_POLL_INTERVAL_MS
        : DRAMA_LIST_SCROLL_INTERVAL_MS,
    );
  }
  return undefined;
}

async function ensureBeastCheckboxChecked(page: Page, label: Locator, name: string): Promise<void> {
  const input = label.locator('input[type="checkbox"]').first();
  if (await input.isChecked().catch(() => false)) return;

  await input.setChecked(true, { force: true }).catch(async () => {
    await label.locator('[data-testid="beast-core-checkbox-checkIcon"]').first().click({ force: true });
  });
  const deadline = Date.now() + 5_000;
  while (!(await input.isChecked().catch(() => false))) {
    if (Date.now() >= deadline) throw new Error(`PINDUODUO_CHECKBOX_NOT_CHECKED: ${name}`);
    await page.waitForTimeout(100);
  }
}

export async function bindAllUploadedVideosToDrama(
  page: Page,
  firstCard: Locator,
  dramaTitle: string,
): Promise<boolean> {
  await firstCard.getByRole("button", { name: "添加至已有短剧", exact: true }).click();

  const list = page.locator('[data-testid="beast-core-pullToRefresh"]:visible').last();
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const dramaCheckbox = await findDramaCheckboxByScrolling(page, list, dramaTitle);
  if (!dramaCheckbox) {
    const cancelButton = page
      .getByRole("button", { name: "取消添加", exact: true })
      .filter({ visible: true })
      .last();
    await cancelButton.waitFor({ state: "visible", timeout: 10_000 });
    await cancelButton.click({ timeout: 10_000 });
    await list.waitFor({ state: "hidden", timeout: 10_000 });
    return false;
  }
  await ensureBeastCheckboxChecked(page, dramaCheckbox, dramaTitle);

  const applyAllCheckbox = page
    .getByText("将所上传视频全部添加至此短剧", { exact: true })
    .filter({ visible: true })
    .last()
    .locator('xpath=ancestor::label[@data-testid="beast-core-checkbox"][1]');
  await applyAllCheckbox.waitFor({ state: "visible", timeout: 10_000 });
  await ensureBeastCheckboxChecked(page, applyAllCheckbox, "将所上传视频全部添加至此短剧");

  const confirmButton = page
    .getByRole("button", { name: "确认添加", exact: true })
    .filter({ visible: true })
    .last();
  await confirmButton.waitFor({ state: "visible", timeout: 10_000 });
  await confirmButton.click({ timeout: 10_000 });
  await list.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

async function preparePinduoduoDramaCover(resourceRoot: string, dramaTitle: string): Promise<string> {
  const posters = await listLocalPosterImages({
    root: resourceRoot,
    resourceName: dramaTitle,
    rootIsResourceDir: true,
    includeAllMatches: true,
  });
  const source = posters[0];
  if (!source) {
    throw new Error(`PINDUODUO_DRAMA_COVER_NOT_FOUND: 新建短剧需要封面，但未找到“${dramaTitle}”的封面素材`);
  }
  const prepared = await prepareCroppedImageVariant({
    inputFile: source.file,
    outputFile: join(resourceRoot, ".pinduoduo-upload", "cover-3x4.jpg"),
    width: 900,
    height: 1_200,
    jpegQuality: 92,
    maxFileBytes: 5 * 1024 * 1024,
  });
  return prepared.file;
}

async function isPinduoduoCoverUploadComplete(panel: Locator): Promise<boolean> {
  const [completedImageVisible, replaceCoverVisible, loadingVisible] = await Promise.all([
    panel.locator('img[data-retry-status="success"][src^="blob:"]').first().isVisible().catch(() => false),
    panel.getByText("更换封面", { exact: true }).first().isVisible().catch(() => false),
    panel.locator('[data-testid="beast-core-icon-loading"]').first().isVisible().catch(() => false),
  ]);
  return completedImageVisible && replaceCoverVisible && !loadingVisible;
}

export async function createDramaAndBindAllUploadedVideos(
  page: Page,
  firstCard: Locator,
  dramaTitle: string,
  coverFile: string,
  onCoverUploadProgress?: (elapsedSeconds: number, completed: boolean) => void,
): Promise<void> {
  await firstCard.getByRole("button", { name: "新建短剧", exact: true }).click();
  const titleInput = page
    .getByPlaceholder("请输入短剧的标题", { exact: true })
    .filter({ visible: true })
    .last();
  await titleInput.waitFor({ state: "visible", timeout: 10_000 });
  const panel = titleInput.locator(
    'xpath=ancestor::div[.//button[.//span[normalize-space()="确认创建"]]][1]',
  );
  await titleInput.fill(dramaTitle);
  await panel
    .locator('input[data-testid="beast-core-upload-input"][type="file"][accept*=".jpg"]')
    .first()
    .setInputFiles(coverFile);

  const coverUploadStartedAt = Date.now();
  let nextProgressLogAt = coverUploadStartedAt;
  while (Date.now() - coverUploadStartedAt < COVER_UPLOAD_TIMEOUT_MS) {
    const uploadCompleted = await isPinduoduoCoverUploadComplete(panel);
    const elapsedSeconds = Math.floor((Date.now() - coverUploadStartedAt) / 1_000);
    if (uploadCompleted) {
      onCoverUploadProgress?.(elapsedSeconds, true);
      break;
    }
    if (Date.now() >= nextProgressLogAt) {
      onCoverUploadProgress?.(elapsedSeconds, false);
      nextProgressLogAt = Date.now() + COVER_UPLOAD_LOG_INTERVAL_MS;
    }
    await page.waitForTimeout(500);
  }

  const coverUploaded = await isPinduoduoCoverUploadComplete(panel);
  if (!coverUploaded) {
    throw new Error("PINDUODUO_DRAMA_COVER_UPLOAD_TIMEOUT: 等待短剧封面上传完成超时（5 分钟）");
  }

  const applyAllCheckbox = panel
    .getByText("将所上传视频全部添加至此短剧", { exact: true })
    .locator('xpath=ancestor::label[@data-testid="beast-core-checkbox"][1]');
  await ensureBeastCheckboxChecked(page, applyAllCheckbox, "将所上传视频全部添加至此短剧");
  const agreementCheckbox = panel
    .getByText("我已阅读并同意", { exact: true })
    .locator('xpath=ancestor::label[@data-testid="beast-core-checkbox"][1]');
  await ensureBeastCheckboxChecked(page, agreementCheckbox, "我已阅读并同意");

  const confirmButton = panel.getByRole("button", { name: "确认创建", exact: true });
  await confirmButton.waitFor({ state: "visible", timeout: 10_000 });
  await confirmButton.click({ timeout: 10_000 });
  await titleInput.waitFor({ state: "hidden", timeout: 30_000 });
}

export async function publishAllUploadedVideos(page: Page): Promise<void> {
  const uploadedVideoCards = page.locator("p", { hasText: /^\s*文件名：/ });
  const uploadedVideoCardCount = await uploadedVideoCards.count();
  const publishButton = page
    .getByRole("button", { name: "一键发布", exact: true })
    .filter({ visible: true })
    .last();
  await publishButton.waitFor({ state: "visible", timeout: 60_000 });
  await publishButton.click({ timeout: 60_000 });

  await page.waitForTimeout(1_000);
  const incompleteWarning = page
    .getByText(/你有未上传完成的作品.*立即发布将会丢失.*继续发布吗？/)
    .filter({ visible: true })
    .last();
  if (await incompleteWarning.isVisible().catch(() => false)) {
    const warningContainer = incompleteWarning.locator('xpath=ancestor::*[.//button][1]');
    const cancelButton = warningContainer
      .getByRole("button", { name: /取消|返回|继续等待|暂不发布/ })
      .filter({ visible: true })
      .first();
    if (await cancelButton.isVisible().catch(() => false)) {
      await cancelButton.click().catch(() => undefined);
    }
    throw new Error(
      "PINDUODUO_UPLOAD_INCOMPLETE_WARNING: 平台提示仍有视频未上传完成，已停止发布",
    );
  }

  const dialogConfirm = page
    .locator('[role="dialog"], [class*="modal" i], [class*="Modal" i]')
    .last()
    .getByRole("button", { name: /^(确定|确认|确认发布|发布)$/ })
    .first();
  if (await dialogConfirm.isVisible().catch(() => false)) {
    await dialogConfirm.click();
  }

  const successDeadline = Date.now() + 60_000;
  while (Date.now() < successDeadline) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/发布成功|已发布/.test(bodyText)) return;
    if (uploadedVideoCardCount > 0 && (await uploadedVideoCards.count()) === 0) return;
    if (!(await publishButton.isVisible().catch(() => false))) return;
    if (!(await publishButton.isEnabled().catch(() => false))) return;
    await page.waitForTimeout(250);
  }
  throw new Error("点击一键发布后未检测到成功信号");
}

async function syncApprovedUploadRecords(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  repository: PinduoduoUploadRecordsRepository,
): Promise<{ cleaned: number; eligibleIds: Set<number>; synced: number }> {
  let pageNumber = 1;
  let cleaned = 0;
  let synced = 0;
  const eligibleIds = new Set<number>();
  while (true) {
    const result = await fetchApprovedShortplays(page, options, pageNumber);
    pageNumber += 1;
    const retainedCreatedTopicIds = new Set(
      repository.retainIncompleteCreatedTopics(result.createdTopicIds),
    );
    cleaned += repository.deleteByPlatformApplyIds(
      result.createdTopicIds.filter((id) => !retainedCreatedTopicIds.has(id)),
    );
    repository.upsertFromApprovedList(result.records);
    for (const record of result.records) {
      if (record.id === undefined) continue;
      eligibleIds.add(record.id);
      synced += 1;
    }
    for (const id of retainedCreatedTopicIds) {
      eligibleIds.add(id);
      synced += 1;
    }
    const scannedAll = result.totalCount !== undefined
      ? (result.page - 1) * result.pageSize + result.rawCount >= result.totalCount
      : result.rawCount < result.pageSize;
    if (scannedAll) break;
  }
  return { cleaned, eligibleIds, synced };
}

async function processUploadRecord(
  context: BrowserContext,
  options: PinduoduoDramaRuntimeOptions,
  repository: PinduoduoUploadRecordsRepository,
  legacyResourceRepository: PinduoduoLegacyResourceLinksRepository,
  record: PinduoduoUploadRecord,
): Promise<boolean> {
  throwIfRuntimeStopped(options);
  if (!options.config?.creatorUid?.trim()) {
    repository.markFailed(
      record.platformApplyId,
      "OPEN_PAGE",
      "未配置创作者 UID（creatorUid），无法打开发布页",
    );
    log(options, "error", "runtime", "approved shortplay upload skipped: creator UID missing", {
      platformApplyId: record.platformApplyId,
      title: record.title,
    });
    return false;
  }

  let stage: PinduoduoUploadRecordStage = "DOWNLOAD";
  try {
    throwIfRuntimeStopped(options);
    repository.markDownloading(record.platformApplyId);
    const shouldUseLegacyResource =
      record.gmtCreate !== undefined &&
      record.gmtCreate < PINDUODUO_PLATFORM_RESOURCE_CUTOFF_GMT_CREATE;
    const legacyResource = shouldUseLegacyResource
      ? legacyResourceRepository.findByTitle(record.title)
      : undefined;
    const resource = resolvePinduoduoResource(
      record.title,
      record.demoUrl,
      record.gmtCreate,
      legacyResource,
    );
    repository.markResourceSource(
      record.platformApplyId,
      resource.source,
      resource.sourceRows,
    );
    log(options, "info", "runtime", "approved shortplay resource resolved", {
      platformApplyId: record.platformApplyId,
      title: record.title,
      resourceSource: resource.source,
      sourceRows: resource.sourceRows,
    });
    let downloadPath: string | undefined;
    if (options.ensureBaiduNetdiskResource) {
      const downloadResult = await options.ensureBaiduNetdiskResource({
        shareText: resource.shareText,
        resourceName: record.title,
        localEpisodeVideoRoot: options.config?.video?.localEpisodeVideoRoot ?? "",
        episodeCount: record.episodeCount ?? 1,
        downloadEpisodeVideos: true,
        downloadAssetMaterials: true,
        forceAssetDownload: true,
        requireAllDiscoveredAssets: false,
        requiredPosterImages: 1,
        posterFallback: {
          title: record.title,
          summary: `短剧《${record.title}》封面，用于拼多多短剧发布。`,
        },
        signal: options.signal,
      });
      downloadPath = downloadResult.localPath;
    }
    throwIfRuntimeStopped(options);
    repository.markReady(record.platformApplyId);

    const files = downloadPath ? await listVideoFiles(downloadPath) : [];
    if (files.length === 0) {
      repository.markFailed(record.platformApplyId, "DOWNLOAD", "本地下载目录中没有可上传的视频文件");
      log(options, "error", "runtime", "approved shortplay upload skipped: no video files", {
        platformApplyId: record.platformApplyId,
        title: record.title,
        downloadPath,
      });
      return false;
    }
    assertPinduoduoEpisodeFileCount(files, record.episodeCount);

    repository.markUploading(record.platformApplyId);
    const fileBatches = splitPinduoduoVideoFiles(files);
    const completedBatchCount = repository.prepareUploadBatches(
      record.platformApplyId,
      fileBatches.length,
    );
    log(options, "info", "runtime", "approved shortplay upload batches prepared", {
      platformApplyId: record.platformApplyId,
      title: record.title,
      fileCount: files.length,
      batchCount: fileBatches.length,
      batchSizes: fileBatches.map((batch) => batch.length),
      completedBatchCount,
    });

    let dramaCreatedInThisRun = false;
    for (let batchIndex = completedBatchCount; batchIndex < fileBatches.length; batchIndex += 1) {
      let uploadPage: Page | undefined;
      try {
        throwIfRuntimeStopped(options);
        const batchFiles = fileBatches[batchIndex];
        if (!batchFiles) continue;
        stage = "OPEN_PAGE";
        uploadPage = await openRecordPage(context, record, options);
        stage = "UPLOAD";
        await uploadPage.locator(VIDEO_UPLOAD_INPUT_SELECTOR).setInputFiles(batchFiles);
        await uploadPage
          .locator("p", { hasText: "文件名：" })
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });

        for (const file of batchFiles) {
          const fileName = basename(file);
          await fillVideoDescription(videoCardLocator(uploadPage, fileName), fileName);
        }
        for (const file of batchFiles) {
          await selectVideoDeclaration(uploadPage, videoCardLocator(uploadPage, basename(file)));
        }

        log(options, "info", "runtime", "approved shortplay batch tab started", {
          platformApplyId: record.platformApplyId,
          title: record.title,
          batchIndex: batchIndex + 1,
          batchCount: fileBatches.length,
          fileCount: batchFiles.length,
        });

        throwIfRuntimeStopped(options);
        stage = "VERIFY";
        const uploadVerifyTimeoutMs = pinduoduoUploadVerifyTimeoutMs(options);
        const platformFailure = await waitForPinduoduoVideoUploads(
          uploadPage,
          batchFiles,
          uploadVerifyTimeoutMs,
          (uploadedCount, totalCount, elapsedSeconds) => {
            log(options, "info", "runtime", "Pinduoduo video upload progress", {
              platformApplyId: record.platformApplyId,
              title: record.title,
              batchIndex: batchIndex + 1,
              batchCount: fileBatches.length,
              uploadedCount,
              totalCount,
              elapsedSeconds,
            });
          },
          options.signal,
        ).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`第 ${batchIndex + 1}/${fileBatches.length} 批${message}`);
        });

        if (platformFailure.rejected) {
          const errorMessage = `第 ${batchIndex + 1}/${fileBatches.length} 批视频上传失败${
            platformFailure.reasons.length > 0 ? `：${platformFailure.reasons.join("；")}` : ""
          }`;
          repository.markRejected(record.platformApplyId, errorMessage);
          log(options, "error", "runtime", "approved shortplay batch rejected by platform", {
            platformApplyId: record.platformApplyId,
            title: record.title,
            batchIndex: batchIndex + 1,
            batchCount: fileBatches.length,
            errorMessage,
          });
          return false;
        }

        stage = "BIND";
        let boundToExistingDrama = await bindAllUploadedVideosToDrama(
          uploadPage,
          firstVideoCardLocator(uploadPage),
          record.title,
        );
        if (!boundToExistingDrama && (completedBatchCount > 0 || dramaCreatedInThisRun)) {
          const lookupDeadline = Date.now() + EXISTING_DRAMA_LOOKUP_TIMEOUT_MS;
          while (!boundToExistingDrama && Date.now() < lookupDeadline) {
            await uploadPage.waitForTimeout(5_000);
            boundToExistingDrama = await bindAllUploadedVideosToDrama(
              uploadPage,
              firstVideoCardLocator(uploadPage),
              record.title,
            );
          }
        }
        if (!boundToExistingDrama) {
          if (completedBatchCount > 0 || dramaCreatedInThisRun) {
            throw new Error(
              `PINDUODUO_EXISTING_DRAMA_NOT_FOUND: 已滚动到底，仍未找到“${record.title}”；为避免重复创建短剧，已取消添加`,
            );
          }
          if (!downloadPath) {
            throw new Error("PINDUODUO_DRAMA_COVER_ROOT_MISSING: 无法定位已下载的封面素材目录");
          }
          const coverFile = await preparePinduoduoDramaCover(downloadPath, record.title);
          await createDramaAndBindAllUploadedVideos(
            uploadPage,
            firstVideoCardLocator(uploadPage),
            record.title,
            coverFile,
            (elapsedSeconds, completed) => {
              log(
                options,
                "info",
                "runtime",
                completed
                  ? "Pinduoduo drama cover upload completed"
                  : "Pinduoduo drama cover uploading",
                {
                  platformApplyId: record.platformApplyId,
                  title: record.title,
                  batchIndex: batchIndex + 1,
                  elapsedSeconds,
                  coverFile,
                },
              );
            },
          );
          dramaCreatedInThisRun = true;
          log(options, "info", "runtime", "created missing Pinduoduo drama and bound batch", {
            platformApplyId: record.platformApplyId,
            title: record.title,
            batchIndex: batchIndex + 1,
            coverFile,
          });
        }

        stage = "PUBLISH";
        throwIfRuntimeStopped(options);
        await publishAllUploadedVideos(uploadPage);
        await uploadPage.waitForTimeout(POST_PUBLISH_SETTLE_MS);
        throwIfRuntimeStopped(options);
        repository.markUploadBatchPublished(record.platformApplyId, batchIndex + 1);
        log(options, "info", "runtime", "approved shortplay batch published", {
          platformApplyId: record.platformApplyId,
          title: record.title,
          batchIndex: batchIndex + 1,
          batchCount: fileBatches.length,
          fileCount: batchFiles.length,
        });
      } finally {
        await uploadPage?.close().catch(() => undefined);
      }
    }

    repository.markUploaded(record.platformApplyId);
    log(options, "info", "runtime", "approved shortplay published", {
      platformApplyId: record.platformApplyId,
      title: record.title,
      fileCount: files.length,
      batchCount: fileBatches.length,
    });
    return true;
  } catch (error) {
    if (runtimeWasStopped(options)) {
      repository.markInterrupted(record.platformApplyId);
      log(options, "info", "runtime", "approved shortplay upload interrupted by service stop", {
        platformApplyId: record.platformApplyId,
        title: record.title,
        stage,
      });
      return false;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    repository.markFailed(record.platformApplyId, stage, errorMessage);
    log(options, "error", "runtime", "approved shortplay upload failed", {
      platformApplyId: record.platformApplyId,
      title: record.title,
      stage,
      error,
    });
    return false;
  }
}

export async function runApprovedShortplayCycle(
  page: Page,
  context: BrowserContext,
  options: PinduoduoDramaRuntimeOptions,
): Promise<number> {
  const repository = new PinduoduoUploadRecordsRepository(options);
  let legacyResourceRepository: PinduoduoLegacyResourceLinksRepository | undefined;
  let uploaded = 0;
  try {
    throwIfRuntimeStopped(options);
    legacyResourceRepository = new PinduoduoLegacyResourceLinksRepository(options);
    const recovered = repository.recoverInterruptedRecords();
    if (recovered > 0) {
      log(options, "info", "runtime", "recovered interrupted approved upload records", {
        recovered,
      });
    }
    const { cleaned, eligibleIds, synced } = await syncApprovedUploadRecords(
      page,
      options,
      repository,
    );
    log(options, "info", "runtime", "approved upload records synced", { cleaned, synced });

    const storedProcessableRecords = repository.findProcessableRecords();
    const processableRecords = storedProcessableRecords.filter((record) =>
      eligibleIds.has(record.platformApplyId),
    );
    log(options, "info", "runtime", "approved upload processable records", {
      count: processableRecords.length,
      skippedBecauseCreatedOrUnapproved:
        storedProcessableRecords.length - processableRecords.length,
    });

    for (const record of processableRecords) {
      if (runtimeWasStopped(options)) break;
      if (
        await processUploadRecord(
          context,
          options,
          repository,
          legacyResourceRepository,
          record,
        )
      ) {
        uploaded += 1;
      }
    }
    return uploaded;
  } finally {
    legacyResourceRepository?.close();
    repository.close();
  }
}
