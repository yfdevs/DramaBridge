import path from "node:path";
import type { Frame, Locator, Page, Request } from "playwright";
import {
  TAOBAO_DRAMA_EPISODE_UPLOAD_RETRY_ATTEMPTS,
  TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH,
  TAOBAO_DRAMA_MIN_SETTLE_MS,
} from "../shared/constants.js";
import {
  cleanupEpisodeUploadFiles,
  convertTaobaoEpisodeForResolutionFailure,
  findTaobaoEpisodeVideos,
  prepareTaobaoEpisodeVideos,
} from "../shared/local-materials.js";
import { log } from "../shared/logger.js";
import type { TaobaoBatchUploadTask, TaobaoDramaRuntimeOptions } from "../shared/types.js";
import {
  formatTaobaoVideoDescription,
  taobaoContentTags,
  type TaobaoEpisodeMetadata,
} from "../shared/episode-metadata.js";
import {
  isTaobaoBatchPublishSuccessUrl,
  isTaobaoCreatorSuccessNavigation,
  taobaoTaskPages,
  waitForTaobaoPage,
} from "./browser-session.js";
import {
  runWithTaobaoVerificationRetry,
  waitForTaobaoHumanVerification,
} from "./human-verification.js";
import { applyTaobaoConfirmedSubmissions, planTaobaoEpisodeUploadBatches } from "../shared/collection-resume.js";
import { refreshTaobaoCollectionUploadPlan } from "./collection-progress.js";
import { pasteTaobaoTagWithClipboard } from "./tag-clipboard.js";

export { isTaobaoVerificationChallenge } from "./human-verification.js";

export const TAOBAO_MAX_FILES_PER_SELECTION = TAOBAO_DRAMA_MAX_VIDEOS_PER_BATCH;
export const TAOBAO_DROPDOWN_END_SETTLE_MS = 12_000;
export const TAOBAO_DROPDOWN_SEARCH_TIMEOUT_MS = 120_000;
export const TAOBAO_PUBLISH_PRECLICK_MIN_MS = 3_000;
export const TAOBAO_PUBLISH_PRECLICK_MAX_MS = 4_500;
type TaobaoDomScope = Page | Frame;

export interface TaobaoDropdownSearchState {
  signature?: string;
  stableAtEndSince?: number;
}

export function advanceTaobaoDropdownSearchState(
  state: TaobaoDropdownSearchState,
  snapshot: {
    atEnd: boolean;
    moved: boolean;
    loading: boolean;
    signature: string;
  },
  now: number,
  settleMs = TAOBAO_DROPDOWN_END_SETTLE_MS,
) {
  const progressed = snapshot.moved || snapshot.loading || snapshot.signature !== state.signature;
  const stableAtEndSince = snapshot.atEnd && !progressed
    ? (state.stableAtEndSince ?? now)
    : undefined;
  return {
    state: { signature: snapshot.signature, stableAtEndSince },
    shouldStop: stableAtEndSince !== undefined && now - stableAtEndSince >= settleMs,
  };
}

function ownerPage(scope: TaobaoDomScope): Page {
  return "page" in scope && typeof scope.page === "function"
    ? (scope as Frame).page()
    : scope as Page;
}

async function paceTaobaoForm(page: Page, minimumMs = 80, maximumMs = 160) {
  const duration = minimumMs + Math.floor(Math.random() * (maximumMs - minimumMs + 1));
  await page.waitForTimeout(duration);
}

export type TaobaoUploadTextSummary = {
  matchedFileCount: number;
  completedFileCount: number;
  pending: boolean;
  failed: boolean;
  complete: boolean;
  progressText?: string;
};

export type TaobaoBatchItemState = {
  title: string;
  status: string;
};

const taobaoUploadSuccessPattern = /^(?:已上传|上传完成|上传成功|处理完成|处理成功)$/;
const taobaoUploadFailurePattern = /上传失败|上传异常|解析失败|转码失败|重新上传/;

export function summarizeTaobaoBatchItems(
  items: TaobaoBatchItemState[],
  fileNames: string[],
) {
  const normalizeTitle = (value: string) => value.replace(/\s+/g, " ").trim();
  const expected = [...new Set(fileNames.map((file) => normalizeTitle(path.basename(file))))];
  const byTitle = new Map(
    items.map((item) => [normalizeTitle(item.title), item.status.replace(/\s+/g, " ").trim()]),
  );
  const matchedItems = expected
    .map((file) => ({ file, status: byTitle.get(file) }))
    .filter((item): item is { file: string; status: string } => item.status !== undefined);
  const completedFileCount = matchedItems.filter((item) =>
    taobaoUploadSuccessPattern.test(item.status)
  ).length;
  const failedFileNames = matchedItems
    .filter((item) => taobaoUploadFailurePattern.test(item.status))
    .map((item) => item.file);
  const terminalFileCount = completedFileCount + failedFileNames.length;
  return {
    matchedFileCount: matchedItems.length,
    completedFileCount,
    terminalFileCount,
    failedFileNames,
    failed: failedFileNames.length > 0,
    settled: expected.length > 0 && terminalFileCount === expected.length,
    complete: expected.length > 0 && completedFileCount === expected.length,
  };
}

export function summarizeTaobaoUploadText(text: string, fileNames: string[]): TaobaoUploadTextSummary {
  const normalized = text.replace(/\s+/g, " ");
  const baseNames = [...new Set(fileNames.map((file) => path.basename(file)))];
  const matchedFileCount = baseNames.filter((file) => normalized.includes(file)).length;
  const progressText = normalized.match(/(?:上传进度\s*)?\d+\s*\/\s*\d+|\b\d{1,3}%/)?.[0];
  const fraction = progressText?.match(/(\d+)\s*\/\s*(\d+)/);
  const completedFileCount = baseNames.filter((file) => {
    const fileStart = normalized.indexOf(file);
    if (fileStart < 0) return false;
    const statusStart = fileStart + file.length;
    const nextFileStart = baseNames.reduce((nearest, candidate) => {
      if (candidate === file) return nearest;
      const position = normalized.indexOf(candidate, statusStart);
      return position >= 0 && position < nearest ? position : nearest;
    }, normalized.length);
    const itemStatus = normalized.slice(statusStart, Math.min(nextFileStart, statusStart + 160));
    return /已上传|上传完成|上传成功|处理完成|处理成功|100%/.test(itemStatus);
  }).length;
  const fractionComplete = Boolean(
    fraction &&
      Number(fraction[2]) > 0 &&
      Number(fraction[1]) >= Number(fraction[2]) &&
      (baseNames.length === 0 || Number(fraction[2]) >= baseNames.length),
  );
  const complete = /(?:全部|所有)(?:视频|文件|剧集)?(?:上传|处理)(?:完成|成功)/.test(normalized) ||
    fractionComplete ||
    (baseNames.length > 0 && completedFileCount >= baseNames.length) ||
    (baseNames.length === 1 && /\b100%/.test(normalized));
  return {
    matchedFileCount,
    completedFileCount,
    pending: /上传中|正在上传|排队中|解析中|转码中|视频处理中|文件处理中|\b(?:[0-9]|[1-9][0-9])%/.test(normalized),
    failed: /上传失败|上传异常|解析失败|转码失败|发布失败|重新上传/.test(normalized),
    complete,
    progressText,
  };
}

export function isTaobaoVideoInputCandidate(attributes: {
  accept: string;
  multiple: boolean;
  nearby: string;
}) {
  const explicitVideo = /video|mp4/i.test(attributes.accept) ||
    /上传视频|添加视频|上传剧集/.test(attributes.nearby);
  const untypedBatchVideo = !attributes.accept && attributes.multiple && /视频|剧集/.test(attributes.nearby);
  return explicitVideo || untypedBatchVideo;
}

export function isTaobaoUploadReady(input: {
  uploadEvidence: boolean;
  pending: boolean;
  buttonReady: boolean;
  matchedFileCount: number;
  expectedFileCount: number;
}) {
  return input.uploadEvidence &&
    !input.pending &&
    input.buttonReady &&
    input.matchedFileCount >= input.expectedFileCount;
}

export function taobaoFatalUploadDialogReason(texts: string[]) {
  return texts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find((text) =>
      /上传失败/.test(text) &&
      (/我知道了/.test(text) || /不符合要求|宽高|分辨率|视频格式/.test(text))
    );
}

export function isTaobaoVideoResolutionFailure(reason: string) {
  return /分辨率|宽高|宽度|高度/.test(reason) &&
    /不符合|不满足|低于|小于|至少|大于|不得小于/.test(reason);
}

async function throwIfTaobaoUploadRejected(scopes: TaobaoDomScope[]) {
  for (const scope of scopes) {
    const dialogs = scope.locator([
      ".next-dialog:visible",
      ".ant-modal:visible",
      ".semi-modal:visible",
      "[role='dialog']:visible",
    ].join(", "));
    const texts = await dialogs.allInnerTexts().catch(() => [] as string[]);
    const reason = taobaoFatalUploadDialogReason(texts);
    if (reason) {
      throw new Error(`TAOBAO_DRAMA_VIDEO_UPLOAD_REJECTED: ${reason}`);
    }
  }
}

async function videoInput(scope: TaobaoDomScope): Promise<Locator> {
  const inputs = scope.locator("input[type='file']:not([disabled])");
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const attributes = await input.evaluate((element: HTMLInputElement) => ({
      accept: element.accept,
      multiple: element.multiple,
      nearby: element.parentElement?.parentElement?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));
    if (isTaobaoVideoInputCandidate(attributes)) {
      return input;
    }
  }
  throw new Error("TAOBAO_DRAMA_VIDEO_FILE_INPUT_NOT_FOUND");
}

async function batchPublishButton(scope: TaobaoDomScope) {
  return scope
    .getByRole("button", { name: /批量发布/ })
    .or(scope.locator("button").filter({ hasText: /批量发布/ }))
    .filter({ visible: true })
    .last();
}

async function findLiveTaobaoBatchScope(
  page: Page,
  fileName: string,
  timeoutMs = 60_000,
): Promise<TaobaoDomScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scopes = await liveTaobaoScopes(page);
    await throwIfTaobaoUploadRejected(scopes);
    for (const scope of scopes) {
      const matchingItems = scope
        .locator("#publish-container .batchItemWrap")
        .filter({ hasText: fileName });
      if (await matchingItems.count().catch(() => 0) > 0) return scope;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`TAOBAO_DRAMA_BATCH_ITEM_NOT_FOUND: ${fileName}`);
}

export function isTaobaoDetachedFrameError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /frame (?:was|has been) detached|execution context was destroyed|cannot find context with specified id/i
    .test(message);
}

async function runWithLiveTaobaoBatchScope<T>(
  page: Page,
  fileName: string,
  options: TaobaoDramaRuntimeOptions,
  action: (scope: TaobaoDomScope) => Promise<T>,
) {
  const maximumAttempts = 5;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const scope = await findLiveTaobaoBatchScope(page, fileName);
    try {
      return await action(scope);
    } catch (error) {
      if (!isTaobaoDetachedFrameError(error) || attempt >= maximumAttempts) throw error;
      log(
        options,
        `[taobao-drama] 上传 iframe 已刷新，正在重新定位并重试当前剧集 ` +
          `(${attempt}/${maximumAttempts - 1})`,
      );
      await page.waitForTimeout(500);
    }
  }
  throw new Error(`TAOBAO_DRAMA_BATCH_SCOPE_RETRY_EXHAUSTED: ${fileName}`);
}

async function waitForUploadComplete(
  page: Page,
  files: string[],
  options: TaobaoDramaRuntimeOptions,
  allowFailedTerminalState = false,
) {
  const timeoutMs = Math.max(1, options.episodeUploadWaitTimeoutMinutes ?? 120) * 60_000;
  let deadline = Date.now() + timeoutMs;
  let lastLine = "";
  let lastPageSignature = "";
  let uploadEvidence = false;
  let uploadScope: TaobaoDomScope = page;
  while (Date.now() < deadline) {
    deadline += await waitForTaobaoHumanVerification(page, options);
    const scopes = await liveTaobaoScopes(page);
    await throwIfTaobaoUploadRejected(scopes);
    const pageStates = await Promise.all(scopes.map(async (scope) => ({
      scope,
      url: scope.url(),
      count: await scope.locator("#publish-container .batchItemWrap").count().catch(() => 0),
    })));
    pageStates.sort((left, right) => right.count - left.count);
    const bestPage = pageStates[0];
    if (bestPage && bestPage.count > 0) uploadScope = bestPage.scope;
    const pageSignature = pageStates
      .map((state) => `${state.count}@${state.url}`)
      .join(" | ");
    if (pageSignature !== lastPageSignature) {
      log(options, `[taobao-drama] 批量上传页面探测：${pageSignature || "没有可用页面"}`);
      lastPageSignature = pageSignature;
    }

    const batchItems = await uploadScope
      .locator("#publish-container .batchItemWrap")
      .evaluateAll((items) => items.map((item) => ({
        title: item.querySelector(".batchItemTitle")?.textContent?.trim() ?? "",
        status: item.querySelector(".batchItemStatus")?.textContent?.trim() ?? "",
      })))
      .catch(() => [] as TaobaoBatchItemState[]);
    const itemSummary = summarizeTaobaoBatchItems(batchItems, files);
    const bodyText = await uploadScope.locator("body").innerText().catch(() => "");
    const summary = summarizeTaobaoUploadText(bodyText, files);
    const matchedFileCount = Math.max(itemSummary.matchedFileCount, summary.matchedFileCount);
    const completedFileCount = Math.max(itemSummary.completedFileCount, summary.completedFileCount);
    uploadEvidence ||= matchedFileCount > 0 || Boolean(summary.progressText) || summary.pending;
    const line = `${matchedFileCount}/${files.length} 文件已显示` +
      `，${completedFileCount}/${files.length} 文件完成` +
      `，${itemSummary.terminalFileCount}/${files.length} 文件已结束` +
      `${summary.progressText ? `，页面进度=${summary.progressText}` : ""}` +
      `，上传中=${summary.pending ? "是" : "否"}，完成信号=${summary.complete ? "是" : "否"}`;
    if (line !== lastLine) {
      log(options, `[taobao-drama] 剧集上传进度：${line}`);
      lastLine = line;
    }
    if (itemSummary.settled && itemSummary.failed) {
      if (allowFailedTerminalState) {
        log(
          options,
          `[taobao-drama] 本批全部 ${files.length} 集均已结束上传，` +
            `${itemSummary.failedFileNames.length} 集失败，开始统一逐集重试`,
        );
        return { scope: uploadScope, failedFileNames: itemSummary.failedFileNames };
      }
      throw new Error(
        `TAOBAO_DRAMA_VIDEO_UPLOAD_FAILED: files=${itemSummary.failedFileNames.join("|")}`,
      );
    }

    if (itemSummary.complete) {
      log(options, `[taobao-drama] ${files.length} 个剧集视频状态均为“已上传”`);
      return { scope: uploadScope, failedFileNames: [] as string[] };
    }

    const publishButton = await batchPublishButton(uploadScope);
    const buttonReady = await publishButton.isEnabled().catch(() => false);
    const ready = isTaobaoUploadReady({
      uploadEvidence,
      pending: summary.pending,
      buttonReady,
      matchedFileCount,
      expectedFileCount: files.length,
    });
    if (ready) {
      log(options, `[taobao-drama] ${files.length} 个剧集视频已全部上传完成`);
      return { scope: uploadScope, failedFileNames: [] as string[] };
    }
    await ownerPage(uploadScope).waitForTimeout(1_000);
  }
  throw new Error(`TAOBAO_DRAMA_VIDEO_UPLOAD_TIMEOUT: expected=${files.length}`);
}

async function deleteFailedTaobaoEpisode(
  scope: TaobaoDomScope,
  fileName: string,
) {
  const item = scope.locator("#publish-container .batchItemWrap").filter({
    has: scope.getByText(fileName, { exact: true }),
  }).first();
  await item.waitFor({ state: "visible", timeout: 30_000 });
  const deleteControl = item.locator(".batchItemTop > i.next-icon").last();
  await deleteControl.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
    throw new Error(`TAOBAO_DRAMA_EPISODE_DELETE_CONTROL_NOT_FOUND: file=${fileName}`);
  });
  await deleteControl.click({ timeout: 10_000 });

  const dialog = scope
    .locator(".next-dialog:visible, [role='dialog']:visible")
    .filter({ hasText: /删除|移除/ })
    .last();
  if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
    await dialog
      .getByRole("button", { name: /确定|确认|删除|移除/ })
      .filter({ visible: true })
      .last()
      .click({ timeout: 10_000 });
  }
  await item.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {
    throw new Error(`TAOBAO_DRAMA_EPISODE_DELETE_NOT_CONFIRMED: file=${fileName}`);
  });
}

async function readTaobaoEpisodeUploadFailure(scope: TaobaoDomScope, fileName: string) {
  const item = scope.locator("#publish-container .batchItemWrap").filter({
    has: scope.getByText(fileName, { exact: true }),
  }).first();
  const reasonLink = item.getByText("查看原因", { exact: true });
  if (!(await reasonLink.isVisible())) return "";
  await reasonLink.click({ timeout: 5_000 });
  const dialog = scope.locator(".next-dialog:visible, [role='dialog']:visible")
    .filter({ hasText: "上传失败" }).last();
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const reason = await dialog.innerText();
  await dialog.getByRole("button", { name: "我知道了" }).click({ timeout: 5_000 });
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  return reason;
}

export async function retryFailedTaobaoEpisodes(
  page: Page,
  files: string[],
  failedFileNames: string[],
  options: TaobaoDramaRuntimeOptions,
  convertResolutionFailure: (file: string) => Promise<string>,
) {
  const sourceByName = new Map(files.map((file) => [path.basename(file), file]));
  for (const fileName of failedFileNames) {
    let sourceFile = sourceByName.get(fileName);
    if (!sourceFile) {
      throw new Error(`TAOBAO_DRAMA_EPISODE_REUPLOAD_SOURCE_NOT_FOUND: file=${fileName}`);
    }

    let succeeded = false;
    let currentFileName = fileName;
    let converted = false;
    for (let attempt = 1; attempt <= TAOBAO_DRAMA_EPISODE_UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
      const scope = await findLiveTaobaoBatchScope(page, currentFileName);
      const reason = await readTaobaoEpisodeUploadFailure(scope, currentFileName);
      if (isTaobaoVideoResolutionFailure(reason)) {
        if (converted) {
          throw new Error(`TAOBAO_DRAMA_VIDEO_UPLOAD_REJECTED: 视频“${currentFileName}”转换后仍被淘宝拒绝：${reason}`);
        }
        log(options, `[taobao-drama] 淘宝明确提示分辨率不符，仅转换当前失败视频：${currentFileName}`, { reason });
        const replacement = await convertResolutionFailure(sourceFile);
        const fileIndex = files.indexOf(sourceFile);
        if (fileIndex < 0) throw new Error(`TAOBAO_DRAMA_EPISODE_REUPLOAD_SOURCE_NOT_FOUND: ${sourceFile}`);
        files[fileIndex] = replacement;
        sourceFile = replacement;
        converted = true;
      } else if (taobaoFatalUploadDialogReason([reason])) {
        throw new Error(`TAOBAO_DRAMA_VIDEO_UPLOAD_REJECTED: 视频“${currentFileName}”上传失败：${reason}`);
      }
      // Conversion can take time. Reacquire the live iframe, then remove only
      // the failed item; successfully uploaded episodes keep their queue slots.
      const liveScope = await findLiveTaobaoBatchScope(page, currentFileName);
      await deleteFailedTaobaoEpisode(liveScope, currentFileName);
      const input = await videoInput(liveScope);
      await input.setInputFiles([sourceFile], { timeout: 120_000 });
      currentFileName = path.basename(sourceFile);
      log(
        options,
        `[taobao-drama] 正在逐集重传 ${fileName}：` +
          `第${attempt}/${TAOBAO_DRAMA_EPISODE_UPLOAD_RETRY_ATTEMPTS}次`,
      );
      const result = await waitForUploadComplete(page, [sourceFile], options, true);
      if (result.failedFileNames.length === 0) {
        succeeded = true;
        log(options, `[taobao-drama] 逐集重传成功：${fileName}`);
        break;
      }
    }
    if (!succeeded) {
      throw new Error(
        `TAOBAO_DRAMA_EPISODE_UPLOAD_RETRIES_EXHAUSTED: file=${fileName}; ` +
          `maximum=${TAOBAO_DRAMA_EPISODE_UPLOAD_RETRY_ATTEMPTS}`,
      );
    }
  }
}

async function liveTaobaoScopes(page: Page) {
  return (await taobaoTaskPages(page))
    .flatMap((candidate) => candidate.frames());
}

export async function publishSucceeded(page: Page, urlBeforeSubmit: string) {
  if ((await taobaoTaskPages(page)).some(
    (candidate) => !candidate.isClosed() && isTaobaoBatchPublishSuccessUrl(candidate.url()),
  )) return true;
  if (
    page.url() !== urlBeforeSubmit &&
    isTaobaoCreatorSuccessNavigation(page.url(), "batch")
  ) return true;
  for (const scope of await liveTaobaoScopes(page)) {
    if (await scope
      .getByText(/批量发布成功|发布成功|提交成功|全部发布完成/)
      .filter({ visible: true })
      .first()
      .isVisible()
      .catch(() => false)) return true;
  }
  return false;
}

async function visiblePublishConfirm(page: Page, timeoutMs = 0) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const scope of await liveTaobaoScopes(page)) {
      const dialog = scope
        .locator(".next-dialog:visible, .ant-modal:visible, .semi-modal:visible, [role='dialog']:visible")
        .filter({ hasText: /发布/ })
        .last();
      if (await dialog.isVisible().catch(() => false)) return dialog;
    }
    if (Date.now() < deadline) await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return undefined;
}

async function visiblePublishFailure(page: Page) {
  for (const scope of await liveTaobaoScopes(page)) {
    const failure = await scope
      .getByText(/发布失败|提交失败/)
      .filter({ visible: true })
      .first()
      .innerText()
      .catch(() => "");
    if (failure) return failure;
  }
  return "";
}

async function clickTaobaoPublishControl(
  page: Page,
  control: Locator,
  options: TaobaoDramaRuntimeOptions,
  label: string,
) {
  await waitForTaobaoHumanVerification(page, options);
  await control.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
  log(options, `[taobao-drama] ${label}已就绪，模拟人工停留后点击`);
  await paceTaobaoForm(page, TAOBAO_PUBLISH_PRECLICK_MIN_MS, TAOBAO_PUBLISH_PRECLICK_MAX_MS);
  await waitForTaobaoHumanVerification(page, options);
  await control.hover({ timeout: 10_000 }).catch(() => undefined);
  await paceTaobaoForm(page, 800, 1_400);
  await options.onSubmitCheckpoint?.({ kind: "batch", state: "submitting" });
  try {
    await control.click({ timeout: 30_000, delay: 150 });
  } catch (error) {
    if ((await taobaoTaskPages(page)).some(
      (candidate) => !candidate.isClosed() && isTaobaoBatchPublishSuccessUrl(candidate.url()),
    )) {
      log(options, `[taobao-drama] ${label}触发工作台跳转，按发布成功继续处理`);
      return 0;
    }
    throw error;
  }
  await page.waitForTimeout(800);
  return waitForTaobaoHumanVerification(page, options);
}

async function clickBatchPublish(
  page: Page,
  batchItemFileName: string,
  options: TaobaoDramaRuntimeOptions,
) {
  let scope = await findLiveTaobaoBatchScope(page, batchItemFileName);
  const publishButton = await batchPublishButton(scope);
  await publishButton.waitFor({ state: "visible", timeout: 60_000 });
  if (!(await publishButton.isEnabled())) throw new Error("TAOBAO_DRAMA_BATCH_PUBLISH_NOT_READY");
  const urlBeforeSubmit = page.url();
  let verificationWaitMs = await clickTaobaoPublishControl(
    page,
    publishButton,
    options,
    "批量发布按钮",
  );

  let clickedAt = Date.now();
  let confirmDialog = await visiblePublishConfirm(page, 5_000);
  if (
    verificationWaitMs > 0 &&
    !confirmDialog &&
    !(await publishSucceeded(page, urlBeforeSubmit))
  ) {
    // Completing the challenge commonly rebuilds the upload iframe. Reacquire
    // both the frame and button instead of consulting the stale pre-captcha
    // Locator, otherwise the task silently waits for a success signal that can
    // never arrive.
    scope = await findLiveTaobaoBatchScope(page, batchItemFileName);
    const resumedPublishButton = await batchPublishButton(scope);
    if (await resumedPublishButton.isEnabled().catch(() => false)) {
      log(options, "[taobao-drama] 验证完成后重新定位发布页面，并重试批量发布动作");
      verificationWaitMs += await clickTaobaoPublishControl(
        page,
        resumedPublishButton,
        options,
        "批量发布按钮",
      );
      confirmDialog = await visiblePublishConfirm(page, 5_000);
    }
  }
  if (confirmDialog) {
    const confirm = confirmDialog
      .getByRole("button", { name: /^\s*(?:确认发布|确定|确认)\s*$/ })
      .filter({ visible: true })
      .last();
    verificationWaitMs += await clickTaobaoPublishControl(page, confirm, options, "确认发布按钮");
    clickedAt = Date.now();
  }
  log(
    options,
    `[taobao-drama] 已点击批量发布，进入至少10秒结算期` +
      (verificationWaitMs > 0 ? `；验证码暂停=${Math.ceil(verificationWaitMs / 1_000)}秒` : ""),
  );

  // A creator-workspace navigation is already a platform-specific success
  // signal. Once it has happened, the old upload iframe or captcha page may
  // remain in the browser context indefinitely. Do not inspect those stale
  // pages again; only keep the task page alive for the required settle period.
  let success = await publishSucceeded(page, urlBeforeSubmit);
  if (success) {
    const remaining = TAOBAO_DRAMA_MIN_SETTLE_MS - (Date.now() - clickedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    log(options, "[taobao-drama] 批量发布成功且10秒结算期完成");
    return;
  }

  let deadline = clickedAt + 60_000;
  while (Date.now() < deadline) {
    deadline += await waitForTaobaoHumanVerification(page, options);
    success ||= await publishSucceeded(page, urlBeforeSubmit);
    if (success && Date.now() - clickedAt >= TAOBAO_DRAMA_MIN_SETTLE_MS) break;
    const failure = await visiblePublishFailure(page);
    if (failure) throw new Error(`TAOBAO_DRAMA_BATCH_PUBLISH_FAILED: ${failure}`);
    await page.waitForTimeout(250);
  }
  if (!success) throw new Error("TAOBAO_DRAMA_BATCH_PUBLISH_RESULT_NOT_RECOGNIZED");
  const remaining = TAOBAO_DRAMA_MIN_SETTLE_MS - (Date.now() - clickedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  log(options, "[taobao-drama] 批量发布成功且10秒结算期完成");
}

async function prepareCurrentEpisodeTags(scope: TaobaoDomScope) {
  const page = ownerPage(scope);
  const editor = scope
    .locator("#root-container .richText-container [data-cangjie-content='true']:visible")
    .first();
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  const openSearchPanel = scope.locator(".richText-search-modal.hashTag-searchPanel:visible").first();
  if (await openSearchPanel.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  return editor;
}

async function fillCurrentEpisodeDescription(scope: TaobaoDomScope, description: string) {
  const descriptionInput = scope
    .locator("#root-container .short-title-form input[maxlength='30']:visible")
    .first();
  await descriptionInput.waitFor({ state: "visible", timeout: 30_000 });
  await descriptionInput.fill(description);
  if (await descriptionInput.inputValue() !== description) {
    throw new Error("TAOBAO_DRAMA_VIDEO_DESCRIPTION_WRITE_FAILED");
  }
}

function normalizeTaobaoTagText(value: string) {
  return value.replace(/^\s*#\s*/, "").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

async function pasteTaobaoContentTagQuery(page: Page, editor: Locator, tag: string) {
  await editor.evaluate((element) => {
    const documentKey = element.querySelector("[data-cangjie-editable='true']")?.getAttribute("data-cangjie-key");
    if (documentKey) {
      const input = element.ownerDocument.querySelector<HTMLTextAreaElement>(
        `textarea[data-cangjie-dockey="${CSS.escape(documentKey)}"]`,
      );
      if (!input) throw new Error("TAOBAO_DRAMA_CONTENT_TAG_INPUT_NOT_FOUND: 未找到淘宝内容标签编辑器的实际输入框，请检查页面是否已加载完成。");
      input.focus();
    }
  });
  await pasteTaobaoTagWithClipboard(page, tag);
}

async function readTaobaoSelectedTags(editor: Locator) {
  return (await editor.locator("[data-cangjie-void='true']").allInnerTexts())
    .map(normalizeTaobaoTagText)
    .filter(Boolean);
}

async function confirmTaobaoContentTagSelected(page: Page, panel: Locator, editor: Locator, label: string) {
  await panel.waitFor({ state: "hidden", timeout: 10_000 });
  const expected = normalizeTaobaoTagText(label);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await readTaobaoSelectedTags(editor)).includes(expected)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`TAOBAO_DRAMA_CONTENT_TAG_SELECTION_NOT_CONFIRMED: 点击内容标签“${label}”后，未确认它已添加到视频，请检查淘宝发布页的内容标签。`);
}

export function scoreTaobaoContentTagMatch(candidate: string, requested: string) {
  const actual = normalizeTaobaoTagText(candidate);
  const expected = normalizeTaobaoTagText(requested);
  if (!actual || !expected) return 0;
  if (actual === expected) return 1;
  const lengthDelta = Math.abs(actual.length - expected.length);
  if (actual.includes(expected)) return Math.max(0.62, 0.92 - lengthDelta * 0.025);
  if (expected.includes(actual) && actual.length >= 2) {
    return Math.max(0.58, 0.86 - lengthDelta * 0.025);
  }

  const remaining = [...actual];
  let commonCharacters = 0;
  for (const character of expected) {
    const index = remaining.indexOf(character);
    if (index < 0) continue;
    remaining.splice(index, 1);
    commonCharacters += 1;
  }
  const characterScore = (2 * commonCharacters) / (actual.length + expected.length);
  let prefixLength = 0;
  while (
    prefixLength < actual.length &&
    prefixLength < expected.length &&
    actual[prefixLength] === expected[prefixLength]
  ) prefixLength += 1;
  const prefixBonus = prefixLength / Math.max(actual.length, expected.length) * 0.2;
  return Math.min(0.89, characterScore * 0.8 + prefixBonus);
}

function taobaoContentTagCandidateLabel(value: string) {
  return value.trim()
    .replace(/^(?:创建|新建)(?:新)?(?:话题|标签)\s*[:：]?\s*/, "")
    .replace(/^[“「『"]([\s\S]*)[”」』"]$/, "$1");
}

async function waitForTaobaoTagSearchPanel(page: Page, panel: Locator) {
  const deadline = Date.now() + 10_000;
  while (!(await panel.isVisible()) && Date.now() < deadline) {
    await page.waitForTimeout(250);
  }
  return panel.isVisible();
}

async function openTaobaoTagSearchPanel(page: Page, panel: Locator) {
  const pending = new Set<Request>();
  let lastActivity = Date.now();
  const requested = (request: Request) => {
    const api = new URL(request.url()).searchParams.get("api")?.toLowerCase() ?? "";
    if (!api.includes(".hashtag.") && api !== "mtop.taobao.media.guang.publish.comprehension") return;
    pending.add(request);
    lastActivity = Date.now();
  };
  const finished = (request: Request) => {
    if (pending.delete(request)) lastActivity = Date.now();
  };
  page.on("request", requested);
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  try {
    await page.keyboard.type("#");
    if (!(await waitForTaobaoTagSearchPanel(page, panel))) return false;
    // Opening the panel starts tab loading and two debounced recommendation
    // requests. A late default response overwrites search results even when
    // the search API returned the exact tag. Drain initialization before paste.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const loading = await panel.locator(".next-loading-tip:visible, .next-loading-indicator:visible").count();
      if (pending.size === 0 && Date.now() - lastActivity >= 400 && loading === 0) return true;
      await page.waitForTimeout(100);
    }
    throw new Error("TAOBAO_DRAMA_CONTENT_TAG_SEARCH_NOT_READY: 淘宝内容标签面板仍在加载推荐标签，尚不能开始搜索。已保留当前输入，请等待页面加载完成后重试任务。");
  } finally {
    page.off("request", requested);
    page.off("requestfinished", finished);
    page.off("requestfailed", finished);
  }
}

export async function selectTaobaoContentTag(
  scope: TaobaoDomScope,
  editor: Locator,
  tag: string,
  _append: boolean,
  tagKind: "topic" | "genre" | "title" = "topic",
) {
  const page = ownerPage(scope);
  const expected = normalizeTaobaoTagText(tag);
  const panel = scope.locator(".richText-search-modal.hashTag-searchPanel:visible").first();
  if (
    !(await panel.isVisible().catch(() => false)) &&
    (await readTaobaoSelectedTags(editor)).includes(expected)
  ) {
    return `#${tag}`;
  }
  if (await panel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  }

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowRight");
  // The fixed first tag needs the same initialized, native-paste search as
  // later tags. Character events can leave even AI短剧 on default suggestions.
  let panelOpened = await openTaobaoTagSearchPanel(page, panel);
  await pasteTaobaoContentTagQuery(page, editor, tag);
  panelOpened = await waitForTaobaoTagSearchPanel(page, panel);
  const suggestions = new Set<string>();
  if (panelOpened) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const cards = panel.locator(".hashTag-card");
      const count = await cards.count();
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        const description = card.locator(".hashTag-card-desc");
        const rawLabel = await description.count() > 0
          ? await description.innerText().catch(() => "")
          : await card.innerText().catch(() => "");
        const label = taobaoContentTagCandidateLabel(rawLabel);
        if (label.trim()) suggestions.add(label.trim());
        if (normalizeTaobaoTagText(label) !== expected) continue;
        await card.click();
        await confirmTaobaoContentTagSelected(page, panel, editor, label);
        return label.trim();
      }
      await page.waitForTimeout(250);
    }
  }
  const inputDescription = tagKind === "title" ? "完整剧名已粘贴" : "完整内容标签已粘贴";
  const reason = suggestions.size > 0
    ? `淘宝标签搜索列表未显示完全匹配的已有或新建标签，可能仍停留在默认推荐。当前候选标签：${[...suggestions].slice(0, 8).join("、")}。`
    : !panelOpened
      ? `${inputDescription}，但标签搜索面板未打开。`
      : `${inputDescription}，但未读到可选标签或新建标签记录，可能是页面搜索未响应或结果未加载。`;
  throw new Error(
    `TAOBAO_DRAMA_CONTENT_TAG_NOT_FOUND: 填写视频内容标签失败：目标标签“#${tag}”。` +
      `${reason}已保留标签输入，请检查淘宝发布页的搜索或新建标签记录后重试任务。`,
  );
}

export async function fillTaobaoEpisodeContentTags(
  scope: TaobaoDomScope,
  title: string,
  dramaTag: string,
  options: TaobaoDramaRuntimeOptions = {},
) {
  const page = ownerPage(scope);
  const contentTags = taobaoContentTags(title, dramaTag);
  await runWithTaobaoVerificationRetry(page, options, () => prepareCurrentEpisodeTags(scope), "准备内容标签");
  for (const [tagIndex, tag] of contentTags.entries()) {
    await runWithTaobaoVerificationRetry(page, options, async () => {
      const editor = scope
        .locator("#root-container .richText-container [data-cangjie-content='true']:visible")
        .first();
      log(options, `[taobao-drama] 正在填写内容标签：#${tag}`);
      const selected = await selectTaobaoContentTag(scope, editor, tag, tagIndex > 0,
        tagIndex === 0 ? "topic" : tag === title.trim().replace(/^#+/, "") ? "title" : "genre");
      log(options, `[taobao-drama] 内容标签已选择：${selected}`);
      await paceTaobaoForm(page);
    }, `填写内容标签#${tag}`);
  }
  return contentTags.length;
}

async function selectAiCreatorDeclaration(scope: TaobaoDomScope) {
  const page = ownerPage(scope);
  const declaration = scope
    .locator("#root-container label.next-radio-wrapper:visible")
    .filter({ hasText: "含AI生成内容" })
    .first();
  await declaration.waitFor({ state: "visible", timeout: 10_000 });
  if (await declaration.getAttribute("aria-checked") !== "true") {
    await declaration.click();
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const wrapperChecked = await declaration.getAttribute("aria-checked") === "true";
    const inputChecked = await declaration.locator("input[type='radio']").isChecked().catch(() => false);
    if (wrapperChecked || inputChecked) return;
    await page.waitForTimeout(100);
  }
  throw new Error("TAOBAO_DRAMA_AI_CREATOR_DECLARATION_NOT_SELECTED");
}

async function selectedSelectText(trigger: Locator) {
  const selectedTitle = trigger.locator("em[title]").first();
  const title = await selectedTitle.count() > 0
    ? await selectedTitle.getAttribute("title", { timeout: 500 }).catch(() => "")
    : "";
  return (title || await trigger.innerText()).replace(/\s+/g, "").trim();
}

export function normalizeTaobaoDropdownText(value: string) {
  return value.replace(/\s+/g, "").trim();
}

export function taobaoDropdownOptionIndex(optionTexts: string[], expected: string) {
  const normalizedExpected = normalizeTaobaoDropdownText(expected);
  return optionTexts.findIndex(
    (text) => normalizeTaobaoDropdownText(text) === normalizedExpected,
  );
}

async function findAndClickDropdownOption(
  popup: Locator,
  label: string,
  timeoutMs = TAOBAO_DROPDOWN_SEARCH_TIMEOUT_MS,
) {
  const page = popup.page();
  const expected = normalizeTaobaoDropdownText(label);
  const deadline = Date.now() + timeoutMs;
  const seenOptions = new Set<string>();
  let searchState: TaobaoDropdownSearchState = {};
  const menu = popup.locator(".next-select-menu:visible").first();
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  await menu.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(50);

  while (Date.now() < deadline) {
    const options = popup.locator("[role='option']");
    const optionTexts = await options.evaluateAll((elements) => elements.map((element) =>
      (element.getAttribute("title") || element.textContent || "").trim()
    ));
    for (const text of optionTexts) {
      if (text) seenOptions.add(text);
    }
    const matchingIndex = taobaoDropdownOptionIndex(optionTexts, expected);
    if (matchingIndex >= 0) {
      const option = options.nth(matchingIndex);
      await option.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      await option.click({ timeout: 10_000 }).catch(async () => {
        await option.click({ force: true, timeout: 5_000 });
      });
      return { option, available: [...seenOptions] };
    }

    const beforeScroll = await menu.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    await menu.hover({ timeout: 5_000 });
    await page.mouse.wheel(
      0,
      Math.max(720, Math.floor(beforeScroll.clientHeight * 2.5)),
    );
    await page.waitForTimeout(150);

    let scroll = await menu.evaluate((element, previousScrollTop) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      return {
        moved: Math.abs(element.scrollTop - previousScrollTop) > 1,
        atEnd: element.scrollTop >= maximum - 2,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    }, beforeScroll.scrollTop);

    if (!scroll.moved && !scroll.atEnd) {
      scroll = await menu.evaluate((element) => {
        const before = element.scrollTop;
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.min(
          maximum,
          before + Math.max(720, Math.floor(element.clientHeight * 2.5)),
        );
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
        return {
          moved: Math.abs(element.scrollTop - before) > 1,
          atEnd: element.scrollTop >= maximum - 2,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        };
      });
    }

    const loading = await popup.locator(
      ".next-loading:visible, [aria-busy='true']:visible, [class*='loading']:visible",
    ).count() > 0;

    const advanced = advanceTaobaoDropdownSearchState(searchState, {
      atEnd: scroll.atEnd,
      moved: scroll.moved,
      loading,
      signature: `${scroll.scrollHeight}:${scroll.clientHeight}:${optionTexts.length}:` +
        `${normalizeTaobaoDropdownText(optionTexts[optionTexts.length - 1] ?? "")}`,
    }, Date.now());
    searchState = advanced.state;
    if (advanced.shouldStop) break;
    if (loading) await page.waitForTimeout(100);
  }

  return { option: undefined, available: [...seenOptions] };
}

async function selectDropdownOption(
  scope: TaobaoDomScope,
  trigger: Locator,
  label: string,
  errorCode: string,
) {
  const page = ownerPage(scope);
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  const expected = normalizeTaobaoDropdownText(label);
  if (await selectedSelectText(trigger) === expected) return;

  await trigger.click();
  const popup = scope
    .locator(".next-overlay-inner[aria-hidden='false']:visible")
    .filter({ has: scope.locator("[role='option']") })
    .last();
  await popup.waitFor({ state: "visible", timeout: 10_000 });
  const { option, available } = await findAndClickDropdownOption(popup, label);
  if (!option) {
    throw new Error(
      `${errorCode}_NOT_FOUND: expected=${label} available=${available.slice(0, 100).join("|")}`,
    );
  }
  await popup.waitFor({ state: "hidden", timeout: 10_000 });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const actual = await selectedSelectText(trigger);
    const inputValue = await trigger.locator("input[role='combobox']").inputValue().catch(() => "");
    if (actual === expected || normalizeTaobaoDropdownText(inputValue) === expected) {
      await page.waitForTimeout(2_000);
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`${errorCode}_SELECTION_FAILED: expected=${label}`);
}

async function selectMatchingCollectionTitle(
  scope: TaobaoDomScope,
  title: string,
) {
  const collection = scope.locator("#root-container .collection:visible").first();
  await collection.waitFor({ state: "visible", timeout: 10_000 });
  const triggers = collection.locator(".collection-main .next-select.next-select-trigger:visible");
  await selectDropdownOption(
    scope,
    triggers.first(),
    title,
    "TAOBAO_DRAMA_COLLECTION",
  );
}

async function selectMatchingCollectionEpisode(scope: TaobaoDomScope, episodeIndex: number) {
  const collection = scope.locator("#root-container .collection:visible").first();
  await collection.waitFor({ state: "visible", timeout: 10_000 });
  const episodeTrigger = collection
    .locator(".collection-main .next-select.next-select-trigger:visible")
    .nth(1);
  await episodeTrigger.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
    throw new Error(`TAOBAO_DRAMA_COLLECTION_EPISODE_TRIGGER_NOT_FOUND: episode=${episodeIndex}`);
  });
  await selectDropdownOption(
    scope,
    episodeTrigger,
    `第${episodeIndex}集`,
    "TAOBAO_DRAMA_COLLECTION_EPISODE",
  );
}

async function applyCurrentEpisodeToAll(
  scope: TaobaoDomScope,
  activeItem: Locator,
  options: TaobaoDramaRuntimeOptions,
) {
  const page = ownerPage(scope);
  const applyButton = activeItem.locator(".batchOpeation").filter({ hasText: "应用至全部" }).first();
  await applyButton.waitFor({ state: "visible", timeout: 10_000 });
  await applyButton.click();

  const dialog = scope
    .locator(".next-dialog:visible, [role='dialog']:visible")
    .filter({ hasText: /应用至全部|应用到全部|确认应用/ })
    .last();
  if (await dialog.waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false)) {
    const checkboxes = dialog.locator("input[type='checkbox']");
    const checkboxCount = await checkboxes.count();
    if (checkboxCount === 0) {
      throw new Error("TAOBAO_DRAMA_APPLY_ALL_OPTIONS_NOT_FOUND");
    }
    for (let index = 0; index < checkboxCount; index += 1) {
      const checkbox = checkboxes.nth(index);
      if (!(await checkbox.isChecked())) await checkbox.check({ force: true });
    }
    const uncheckedCount = await checkboxes.evaluateAll((items) =>
      items.filter((item) => !(item as HTMLInputElement).checked).length
    );
    if (uncheckedCount > 0) {
      throw new Error(`TAOBAO_DRAMA_APPLY_ALL_OPTIONS_NOT_SELECTED: remaining=${uncheckedCount}`);
    }

    const confirm = dialog
      .getByRole("button", { name: /确认|确定|应用至全部|应用/ })
      .filter({ visible: true })
      .last();
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    const confirmDeadline = Date.now() + 5_000;
    while (!(await confirm.isEnabled()) && Date.now() < confirmDeadline) {
      await page.waitForTimeout(100);
    }
    if (!(await confirm.isEnabled())) {
      throw new Error("TAOBAO_DRAMA_APPLY_ALL_CONFIRM_DISABLED");
    }
    await confirm.click({ timeout: 10_000 });
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  }
  await page.waitForTimeout(800);
  log(options, "[taobao-drama] 第一集完整信息已应用至全部视频");
}

async function fillEpisodeMetadata(
  page: Page,
  episodes: Awaited<ReturnType<typeof findTaobaoEpisodeVideos>>,
  metadata: TaobaoEpisodeMetadata,
  task: TaobaoBatchUploadTask,
  options: TaobaoDramaRuntimeOptions,
) {
  for (const [position, episode] of episodes.entries()) {
    const fileName = path.basename(episode.file);
    await runWithLiveTaobaoBatchScope(page, fileName, options, async (scope) => {
      const summary = metadata.episodeSummaries[episode.index - 1];
      if (!summary) throw new Error(`TAOBAO_DRAMA_EPISODE_SUMMARY_MISSING: episode=${episode.index}`);
      const description = formatTaobaoVideoDescription(episode.index, summary);
      const item = scope.locator("#publish-container .batchItemWrap").filter({
        has: scope.getByText(fileName, { exact: true }),
      }).first();

      await runWithTaobaoVerificationRetry(page, options, async () => {
        await item.waitFor({ state: "visible", timeout: 30_000 });
        await item.click();
        const activeItem = scope.locator("#publish-container .batchItemWrap-active").filter({
          has: scope.getByText(fileName, { exact: true }),
        }).first();
        await activeItem.waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
          if (isTaobaoDetachedFrameError(error)) throw error;
          throw new Error(`TAOBAO_DRAMA_BATCH_ITEM_NOT_ACTIVE: ${fileName}`);
        });
        await paceTaobaoForm(page);
      }, `选择第${episode.index}集视频`);
      log(options, `[taobao-drama] 第 ${episode.index} 集检查点：视频已选中`);

      await runWithTaobaoVerificationRetry(page, options, () =>
        fillCurrentEpisodeDescription(scope, description), `填写第${episode.index}集推荐标题`);
      await paceTaobaoForm(page);
      log(options, `[taobao-drama] 第 ${episode.index} 集检查点：视频描述已完成`);

      if (position === 0) {
        const tagCount = await fillTaobaoEpisodeContentTags(scope, task.title ?? task.originalTitle, metadata.dramaTag, options);
        log(options, `[taobao-drama] 第 ${episode.index} 集检查点：${tagCount}个内容标签已完成`);

        await runWithTaobaoVerificationRetry(
          page,
          options,
          () => selectAiCreatorDeclaration(scope),
          "选择AI创作者声明",
        );
        await paceTaobaoForm(page);
        log(options, `[taobao-drama] 第 ${episode.index} 集检查点：AI 创作者声明已完成`);

        await runWithTaobaoVerificationRetry(page, options, () =>
          selectMatchingCollectionTitle(scope, task.title ?? task.originalTitle), "选择所属合集");
        await runWithTaobaoVerificationRetry(page, options, () =>
          selectMatchingCollectionEpisode(scope, episode.index), `选择第${episode.index}集`);
        log(options, `[taobao-drama] 第 ${episode.index} 集检查点：合集和集数已完成`);

        const activeItem = scope.locator("#publish-container .batchItemWrap-active").filter({
          has: scope.getByText(fileName, { exact: true }),
        }).first();
        await runWithTaobaoVerificationRetry(page, options, () =>
          applyCurrentEpisodeToAll(scope, activeItem, options), "应用第一集信息至全部视频");
        log(
          options,
          `[taobao-drama] 已完整填写第 ${episode.index} 集，并将标签、AI声明和合集应用至全部视频`,
        );
      } else {
        await runWithTaobaoVerificationRetry(page, options, () =>
          selectMatchingCollectionEpisode(scope, episode.index), `选择第${episode.index}集`);
        log(options, `[taobao-drama] 第 ${episode.index} 集检查点：合集集数已完成`);
        log(options, `[taobao-drama] 已更新第 ${episode.index} 集描述及合集集数`);
      }
    });

  }
}

export async function uploadAndPublishTaobaoEpisodes(
  page: Page,
  task: TaobaoBatchUploadTask,
  metadata: TaobaoEpisodeMetadata,
  options: TaobaoDramaRuntimeOptions,
) {
  const { episodes, prepared } = await prepareTaobaoEpisodeVideos(task, options);
  try {
    const plan = options.collectionUploadPlan;
    let currentPlan = plan ? await refreshTaobaoCollectionUploadPlan(page.context(), plan, options) : undefined;
    const batches = planTaobaoEpisodeUploadBatches(episodes, currentPlan?.missingEpisodeNumbers);
    const selectedCount = batches.reduce((count, batch) => count + batch.length, 0);
    log(
      options,
      `[taobao-drama] 本地共 ${episodes.length} 集，本次仅上传 ${selectedCount} 集，共 ${batches.length} 个发布批次`,
    );

    const batchPage = page;
    for (const [batchIndex, batchEpisodes] of batches.entries()) {
      // Follow the pre-upload plan; delayed counters must not block later batches.
      const episodeNumbers = batchEpisodes.map((episode) => episode.index);
      const range = { start: episodeNumbers[0]!, end: episodeNumbers[episodeNumbers.length - 1]! };
      if (batchIndex > 0) {
        // The previous batch already passed success verification and its
        // 10-second settle period. Reuse the same task tab for the next batch.
        await waitForTaobaoPage(batchPage, "batch", options, { fresh: true });
      }
      await waitForTaobaoHumanVerification(batchPage, options);
      const batch = batchEpisodes.map((episode) => episode.file);
      const input = await videoInput(batchPage);
      await input.setInputFiles(batch, { timeout: 120_000 });
      log(
        options,
        `[taobao-drama] 已选择发布批次 ${batchIndex + 1}/${batches.length}：` +
          `第${range.start}-${range.end}集，共 ${batch.length} 个视频`,
      );
      await waitForTaobaoHumanVerification(batchPage, options);
      await batchPage.waitForTimeout(500);
      // Taobao internally queues up to 100 selected videos. Selecting them in small
      // follow-up batches can leave later files permanently stuck at “等待上传中”.
      const uploadResult = await waitForUploadComplete(batchPage, batch, options, true);
      if (uploadResult.failedFileNames.length > 0) {
        await retryFailedTaobaoEpisodes(
          batchPage,
          batch,
          uploadResult.failedFileNames,
          options,
          async (file) => {
            const episode = batchEpisodes.find((entry) => entry.file === file);
            if (!episode) throw new Error(`TAOBAO_DRAMA_EPISODE_REUPLOAD_SOURCE_NOT_FOUND: ${file}`);
            episode.file = await convertTaobaoEpisodeForResolutionFailure(file, prepared, options);
            return episode.file;
          },
        );
        await waitForUploadComplete(batchPage, batch, options);
      }
      await fillEpisodeMetadata(batchPage, batchEpisodes, metadata, task, options);
      const batchItemFileName = path.basename(batch[batch.length - 1] ?? batch[0] ?? "");
      const batchOptions = { ...options, onSubmitCheckpoint: (checkpoint: import("../shared/task-execution.js").TaobaoSubmitCheckpoint) =>
        options.onSubmitCheckpoint?.({ ...checkpoint, startEpisode: range.start, endEpisode: range.end, episodeNumbers, collectionId: plan?.collectionId }) };
      await runWithTaobaoVerificationRetry(
        batchPage,
        options,
        () => clickBatchPublish(batchPage, batchItemFileName, batchOptions),
        "批量发布",
        false,
      );
      await batchOptions.onSubmitCheckpoint({ kind: "batch", state: "confirmed" });
      if (currentPlan) currentPlan = applyTaobaoConfirmedSubmissions(currentPlan, episodeNumbers);
      log(
        options,
        `[taobao-drama] 发布批次 ${batchIndex + 1}/${batches.length} 已完成：第${range.start}-${range.end}集`,
      );
    }
    if (currentPlan?.missingEpisodeNumbers.length) {
      throw new Error(`TAOBAO_DRAMA_EPISODE_SUBMISSIONS_INCOMPLETE: 仍有 ${currentPlan.missingEpisodeNumbers.length} 集未确认提交，请核实发布结果。`);
    }
  } finally {
    await cleanupEpisodeUploadFiles(prepared);
  }
}
