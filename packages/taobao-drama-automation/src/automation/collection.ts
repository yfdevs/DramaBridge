import type { Locator, Page } from "playwright";
import { TAOBAO_DRAMA_FIXED_FIELDS, TAOBAO_DRAMA_MIN_SETTLE_MS } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { TaobaoCollectionMetadata, TaobaoDramaRuntimeOptions } from "../shared/types.js";
import { isTaobaoCreatorSuccessNavigation } from "./browser-session.js";
import {
  runWithTaobaoVerificationRetry,
  waitForTaobaoHumanVerification,
} from "./human-verification.js";

const exactFieldContainerClasses = ["next-form-item", "ant-form-item", "semi-form-field"];
const fieldControlPredicate =
  ".//input or .//textarea or .//button or .//*[@role='combobox'] or " +
  ".//*[@role='radio'] or .//*[@role='checkbox']";
const validationSelector = ".next-form-item-help:visible, .ant-form-item-explain-error:visible, .semi-form-field-error-message:visible, [class*='formError']:visible, [class*='form-error']:visible";

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactText(value: string) {
  return new RegExp(`^\\s*${escaped(value)}\\s*$`);
}

function fieldLabelText(value: string) {
  return new RegExp(`^\\s*\\*?\\s*${escaped(value)}(?:\\s|最低|查看|创建后|请及时|$)`);
}

async function firstVisible(candidates: Locator[]) {
  for (const candidate of candidates) {
    const locator = candidate.filter({ visible: true }).first();
    if (await locator.isVisible({ timeout: 400 }).catch(() => false)) return locator;
  }
  return null;
}

async function fieldContainer(page: Page, labels: string[]) {
  for (const label of labels) {
    const labelPattern = new RegExp(`^\\s*\\*?\\s*${escaped(label)}\\s*\\*?\\s*$`);
    const text = await firstVisible([
      page.locator("label").filter({ hasText: fieldLabelText(label) }),
      page.getByText(labelPattern).last(),
    ]);
    if (!text) continue;
    const known = text.locator(`xpath=ancestor::*[${exactFieldContainerClasses
      .map((className) =>
        `contains(concat(' ', normalize-space(@class), ' '), ' ${className} ')`)
      .join(" or ")}][1]`);
    if (await known.count()) return known;
    const custom = text.locator(
      `xpath=ancestor::*[(contains(@class, 'formItem') or contains(@class, 'FormItem') or ` +
      `contains(@class, 'form-item') or contains(@class, 'form-field')) and (${fieldControlPredicate})][1]`,
    );
    if (await custom.count()) return custom;
    const nearby = text.locator("xpath=ancestor::div[.//input or .//textarea or .//button][1]");
    if (await nearby.count()) return nearby;
  }
  throw new Error(`TAOBAO_DRAMA_FIELD_NOT_FOUND: labels=${labels.join("|")}`);
}

async function fillTextField(page: Page, labels: string[], value: string) {
  const labeledInput = await firstVisible(labels.map((label) =>
    page.getByLabel(fieldLabelText(label))
  ));
  if (labeledInput) {
    await labeledInput.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await labeledInput.fill(value, { timeout: 30_000 });
    await labeledInput.press("Tab").catch(() => undefined);
    return;
  }
  const container = await fieldContainer(page, labels);
  const input = await firstVisible([
    container.locator("input:not([type='radio']):not([type='checkbox']):not([type='file'])"),
    container.locator("textarea"),
  ]);
  if (!input) throw new Error(`TAOBAO_DRAMA_TEXTBOX_NOT_FOUND: labels=${labels.join("|")}`);
  await input.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await input.fill(value, { timeout: 30_000 });
  await input.press("Tab").catch(() => undefined);
}

async function visiblePopupOption(page: Page, value: string) {
  return firstVisible([
    page.getByRole("option", { name: exactText(value) }),
    page.locator("[role='menuitem'], [role='checkbox']").filter({ hasText: exactText(value) }),
    page.locator(".next-menu-item, .ant-select-item-option, .semi-select-option")
      .filter({ hasText: exactText(value) }),
    page.locator("[class*='dialog-tag--']")
      .filter({ has: page.locator("[class*='dialog-tag-label']").filter({ hasText: exactText(value) }) }),
  ]);
}

async function fieldTrigger(container: Locator) {
  return firstVisible([
    container.locator("[role='combobox']"),
    container.locator(".next-select, .ant-select, .semi-select"),
    container.locator("[class*='select-trigger']"),
    container.getByText(/^\s*选择\s*$/),
    container.locator("input:not([type='hidden']):not([type='file'])"),
    container.locator("button"),
  ]);
}

async function selectFieldValue(page: Page, labels: string[], value: string, multi = false) {
  const container = await fieldContainer(page, labels);
  const nativeControl = await firstVisible([
    container.getByRole("radio", { name: exactText(value) }),
    container.getByRole("checkbox", { name: exactText(value) }),
  ]);
  if (nativeControl) {
    if (!await nativeControl.isChecked().catch(() => false)) await nativeControl.click({ timeout: 15_000 });
    return;
  }
  const trigger = await fieldTrigger(container);
  if (!trigger) {
    const inlineControl = await firstVisible([
      container.locator("[role='radio'], [role='checkbox'], label, button").filter({ hasText: exactText(value) }),
      container.getByText(exactText(value)),
    ]);
    if (!inlineControl) throw new Error(`TAOBAO_DRAMA_SELECT_NOT_FOUND: labels=${labels.join("|")}`);
    await inlineControl.click({ timeout: 15_000 });
    return;
  }
  if (multi) {
    const selected = await firstVisible([
      container.locator("[aria-selected='true'], [data-selected='true'], [class*='selected'], [class*='selection-item'], [class*='tag']")
        .filter({ hasText: exactText(value) }),
    ]);
    if (selected) return;
    const alreadyOpenOption = await visiblePopupOption(page, value);
    if (alreadyOpenOption) {
      await alreadyOpenOption.click({ timeout: 15_000 });
      return;
    }
  }
  await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await trigger.click({ timeout: 15_000 });
  const option = await visiblePopupOption(page, value);
  if (!option) throw new Error(`TAOBAO_DRAMA_SELECT_OPTION_NOT_FOUND: labels=${labels.join("|")} value=${value}`);
  await option.waitFor({ state: "visible", timeout: 15_000 });
  await option.click({ timeout: 15_000 });
  if (!multi) await page.keyboard.press("Escape").catch(() => undefined);
}

export async function selectTaobaoDramaCollectionTags(page: Page, values: string[]) {
  const labels = ["短剧标签", "标签"];
  const container = await fieldContainer(page, labels);
  const pending: string[] = [];
  for (const value of [...new Set(values)]) {
    const selected = await firstVisible([
      container.locator("[aria-selected='true'], [data-selected='true'], [class*='selected'], [class*='selection-item'], [class*='tag']")
        .filter({ hasText: exactText(value) }),
    ]);
    if (!selected) pending.push(value);
  }
  if (!pending.length) return;

  const trigger = await fieldTrigger(container);
  if (!trigger) throw new Error(`TAOBAO_DRAMA_SELECT_NOT_FOUND: labels=${labels.join("|")}`);
  await trigger.scrollIntoViewIfNeeded({ timeout: 10_000 });
  await trigger.click({ timeout: 15_000 });

  // The current Taobao picker is mounted asynchronously after the trigger click.
  // Waiting for the requested label also keeps the legacy dropdown fallback fast.
  await page.getByText(exactText(pending[0]!)).filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);

  const dialog = await firstVisible([
    page.locator(".next-dialog:visible, .ant-modal:visible, .semi-modal:visible, [role='dialog']:visible")
      .filter({ has: page.locator("[class*='dialog-group-title']") }),
    page.locator("[class*='dialog-content']:visible").locator("xpath=.."),
  ]);
  if (!dialog) {
    for (const value of pending) {
      const option = await visiblePopupOption(page, value);
      if (!option) throw new Error(`TAOBAO_DRAMA_SELECT_OPTION_NOT_FOUND: labels=${labels.join("|")} value=${value}`);
      await option.click({ timeout: 15_000 });
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return;
  }

  for (const value of pending) {
    const label = dialog.locator("[class*='dialog-tag-label']").filter({ hasText: exactText(value) }).first();
    if (!await label.isVisible({ timeout: 2_000 }).catch(() => false)) {
      throw new Error(`TAOBAO_DRAMA_SELECT_OPTION_NOT_FOUND: labels=${labels.join("|")} value=${value}`);
    }
    const tag = label.locator("xpath=ancestor::*[contains(@class, 'dialog-tag--')][1]");
    await (await tag.count() ? tag : label).click({ timeout: 15_000 });
  }

  const confirm = await firstVisible([
    dialog.getByRole("button", { name: /^\s*(?:确定|确认|完成|保存)\s*$/ }),
    dialog.locator("button[class*='dialog-confirm-btn']"),
  ]);
  if (!confirm) throw new Error("TAOBAO_DRAMA_TAG_DIALOG_CONFIRM_NOT_FOUND");
  await confirm.click({ timeout: 15_000 });
  await dialog.waitFor({ state: "hidden", timeout: 15_000 });
}

export async function uploadTaobaoCollectionCover(page: Page, coverFile: string) {
  const container = await fieldContainer(page, ["封面", "合集封面", "短剧封面"]);
  const directInput = container.locator("input[type='file']:not([disabled])").first();
  let mediaDialog: Locator | null = null;
  if (await directInput.count()) {
    await directInput.setInputFiles(coverFile, { timeout: 60_000 });
  } else {
    const trigger = await firstVisible([
      container.getByText(/^\s*添加封面\s*$/),
      container.locator("[class*='poster']"),
      container.locator("button"),
    ]);
    if (!trigger) throw new Error("TAOBAO_DRAMA_COVER_UPLOAD_TRIGGER_NOT_FOUND");
    await trigger.click({ timeout: 15_000 });

    mediaDialog = page
      .locator(".next-dialog, .ant-modal, .semi-modal, [role='dialog']")
      .filter({ has: page.getByRole("button", { name: /^\s*上传新图片\s*$/ }) })
      .last();
    await mediaDialog.waitFor({ state: "visible", timeout: 30_000 });

    const uploadInput = mediaDialog.locator("input[type='file']:not([disabled])").first();
    await uploadInput.waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
    if (await uploadInput.count()) {
      // Taobao's image-space button delegates to this hidden input. Setting it
      // directly is reliable and does not emit a Playwright filechooser event.
      await uploadInput.setInputFiles(coverFile, { timeout: 60_000 });
    } else {
      const uploadButton = mediaDialog.getByRole("button", { name: /^\s*上传新图片\s*$/ }).last();
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 });
      await uploadButton.click({ timeout: 15_000 });
      const chooser = await chooserPromise;
      await chooser.setFiles(coverFile, { timeout: 60_000 });
    }
  }

  const cropDialog = page
    .locator(".next-dialog, .ant-modal, .semi-modal, [role='dialog']")
    .filter({ has: page.getByText(/^\s*裁剪图片\s*$/) })
    .last();
  const cropAppeared = await cropDialog.waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true, () => false);
  if (cropAppeared) {
    await cropDialog.locator("canvas, img").first().waitFor({ state: "visible", timeout: 30_000 });
    await cropDialog.getByRole("button", { name: /^\s*(?:确定|完成|保存)\s*$/ })
      .filter({ visible: true }).last().click({ timeout: 60_000 });
    await cropDialog.waitFor({ state: "hidden", timeout: 60_000 });
  } else if (mediaDialog) {
    throw new Error("TAOBAO_DRAMA_COVER_CROP_DIALOG_NOT_FOUND");
  }

  // Cropping uploads the file into image space. Some Taobao revisions then
  // require a second confirmation to apply the selected image to the form.
  if (mediaDialog && await mediaDialog.isVisible().catch(() => false)) {
    const applyButton = mediaDialog.getByRole("button", { name: /^\s*(?:确认|确定)\s*$/ })
      .filter({ visible: true }).last();
    await applyButton.waitFor({ state: "visible", timeout: 60_000 });
    await applyButton.click({ timeout: 60_000 });
    await mediaDialog.waitFor({ state: "hidden", timeout: 60_000 });
  }

  const preview = container.locator("img:visible, [class*='upload-list']:visible").first();
  await preview.waitFor({ state: "visible", timeout: 60_000 }).catch(async (error) => {
    if (!await directInput.count() || await directInput.evaluate((element: HTMLInputElement) => element.files?.length ?? 0) < 1) {
      throw error;
    }
  });
}

export async function uploadTaobaoCostConfigMaterial(page: Page, file: string) {
  if (!file.trim()) {
    throw new Error("TAOBAO_DRAMA_COST_MATERIAL_REQUIRED: productionCost.proofFiles 不能为空");
  }
  await page.getByText(/^\s*成本配置材料\s*$/).first()
    .waitFor({ state: "visible", timeout: 30_000 });
  const container = await fieldContainer(page, ["成本配置材料", "成本合同"]);
  const input = container.locator("input[type='file']:not([disabled])").first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  await input.setInputFiles(file, { timeout: 60_000 });
  const uploadedFileCount = await input.evaluate(
    (element: HTMLInputElement) => element.files?.length ?? 0,
  );
  if (uploadedFileCount < 1) {
    throw new Error("TAOBAO_DRAMA_COST_MATERIAL_UPLOAD_NOT_ACCEPTED: 淘宝未接收成本配置材料图片");
  }
  const uploadedPreview = container
    .locator("img:visible, [class*='upload-list']:visible, [class*='file-item']:visible")
    .first();
  await uploadedPreview.waitFor({ state: "visible", timeout: 60_000 });
  await container.locator(".next-loading:visible, [class*='uploading']:visible")
    .first().waitFor({ state: "hidden", timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

async function validationMessages(page: Page) {
  const messages = (await page.locator(validationSelector).allInnerTexts().catch(() => []))
    .map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (await page.locator("[aria-invalid='true']:visible").count().catch(() => 0)) {
    messages.push("存在未通过校验的字段");
  }
  return [...new Set(messages)];
}

export function isTaobaoCollectionCreateSuccessSignal(state: {
  navigated: boolean;
  successMessageVisible: boolean;
  createButtonVisible: boolean;
  settlePeriodComplete: boolean;
}) {
  return state.navigated || state.successMessageVisible ||
    (state.settlePeriodComplete && !state.createButtonVisible);
}

export function shouldRetryTaobaoCollectionCreate(state: {
  success: boolean;
  alreadyRetried: boolean;
  settlePeriodComplete: boolean;
  createButtonVisible: boolean;
  createButtonEnabled: boolean;
}) {
  return !state.success && !state.alreadyRetried && state.settlePeriodComplete &&
    state.createButtonVisible && state.createButtonEnabled;
}

async function createSucceeded(page: Page, createButton: Locator, clickedAt: number) {
  return isTaobaoCollectionCreateSuccessSignal({
    navigated: isTaobaoCreatorSuccessNavigation(page.url(), "collection"),
    successMessageVisible: await page.getByText(/创建成功|合集创建成功|已创建/)
      .filter({ visible: true }).first().isVisible().catch(() => false),
    createButtonVisible: await createButton.isVisible().catch(() => false),
    settlePeriodComplete: Date.now() - clickedAt >= TAOBAO_DRAMA_MIN_SETTLE_MS,
  });
}

export async function fillAndCreateTaobaoCollection(
  page: Page,
  task: TaobaoCollectionMetadata,
  coverFile: string,
  costConfigImage: string,
  options: TaobaoDramaRuntimeOptions,
) {
  log(options, "[taobao-drama] 开始填写合集必填信息", {
    title: task.title,
    shortDramaType: task.shortDramaType,
    shortDramaTags: task.shortDramaTags,
    audience: task.audience,
  });
  const runStep = <T>(
    label: string,
    action: () => Promise<T>,
    retryAfterSuccessfulVerification = true,
  ) => runWithTaobaoVerificationRetry(
    page,
    options,
    action,
    label,
    retryAfterSuccessfulVerification,
  );
  await runStep("填写合集标题", () =>
    fillTextField(page, ["合集标题", "合集名称", "短剧名称", "标题"], task.title));
  await runStep("选择合集类型", () =>
    selectFieldValue(page, ["合集类型"], TAOBAO_DRAMA_FIXED_FIELDS.collectionType));
  await runStep("选择短剧类型", () => selectFieldValue(page, ["短剧类型"], task.shortDramaType));
  await runStep("选择付费方式", () =>
    selectFieldValue(page, ["付费方式"], TAOBAO_DRAMA_FIXED_FIELDS.paymentMode));
  await runStep("选择短剧标签", () => selectTaobaoDramaCollectionTags(page, task.shortDramaTags));
  await runStep("选择完结状态", () =>
    selectFieldValue(page, ["是否完结", "完结状态"], TAOBAO_DRAMA_FIXED_FIELDS.completionStatus));
  await runStep("选择观看受众", () => selectFieldValue(page, ["观看受众", "受众"], task.audience));
  await runStep("上传合集封面", () => uploadTaobaoCollectionCover(page, coverFile));
  await runStep("选择备案类型", () =>
    selectFieldValue(page, ["备案类型"], TAOBAO_DRAMA_FIXED_FIELDS.filingType));
  await runStep("填写制作机构", () =>
    fillTextField(page, ["制作机构"], TAOBAO_DRAMA_FIXED_FIELDS.productionCompany));
  await runStep("填写制片人", () =>
    fillTextField(page, ["制片人"], TAOBAO_DRAMA_FIXED_FIELDS.producerName));
  await runStep("填写导演", () =>
    fillTextField(page, ["导演"], TAOBAO_DRAMA_FIXED_FIELDS.directorName));
  await runStep("填写编剧", () =>
    fillTextField(page, ["编剧"], TAOBAO_DRAMA_FIXED_FIELDS.scriptwriterName));
  await runStep("填写主要演员", () =>
    fillTextField(page, ["主要演员"], TAOBAO_DRAMA_FIXED_FIELDS.mainActors));
  await runStep("填写集数", () => fillTextField(page, ["集数"], String(task.episodeCount)));
  await runStep("填写集均时长", () =>
    fillTextField(
      page,
      ["集均时长(分钟)", "集均时长（分钟）", "集均时长"],
      String(TAOBAO_DRAMA_FIXED_FIELDS.averageEpisodeDurationMinutes),
    ));
  if (task.summary.trim().length < 100) {
    throw new Error(`TAOBAO_DRAMA_COLLECTION_SUMMARY_TOO_SHORT: length=${task.summary.trim().length} min=100`);
  }
  await runStep("填写内容概要", () =>
    fillTextField(page, ["内容概要"], task.summary.trim().slice(0, 3_000)));
  await runStep("上传成本配置材料", () => uploadTaobaoCostConfigMaterial(page, costConfigImage));

  const createButton = page.getByRole("button", { name: /^\s*(?:确认创建|创建合集|创建)\s*$/ })
    .filter({ visible: true }).last();
  await createButton.waitFor({ state: "visible", timeout: 30_000 });
  const confirmDialog = page
    .locator(".next-dialog:visible, .ant-modal:visible, .semi-modal:visible, [role='dialog']:visible")
    .filter({ hasText: /创建/ }).last();
  const clickCreate = async () => {
    await createButton.click({ timeout: 30_000 });
    let submittedAt = Date.now();
    if (await confirmDialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirmDialog.getByRole("button", { name: /^\s*(?:确认创建|确定|确认)\s*$/ })
        .filter({ visible: true }).last().click({ timeout: 30_000 });
      submittedAt = Date.now();
    }
    return submittedAt;
  };
  let clickedAt = await runStep("创建合集", clickCreate, false);
  log(options, "[taobao-drama] 已点击创建合集，进入至少10秒结算期");
  let success = false;
  let retriedCreate = false;
  let deadline = clickedAt + 60_000;
  while (Date.now() < deadline) {
    deadline += await waitForTaobaoHumanVerification(page, options);
    const validation = await validationMessages(page);
    if (validation.length) throw new Error(`TAOBAO_DRAMA_COLLECTION_FORM_INVALID: ${validation.join("；")}`);
    success ||= await createSucceeded(page, createButton, clickedAt);
    if (success && Date.now() - clickedAt >= TAOBAO_DRAMA_MIN_SETTLE_MS) break;
    const settlePeriodComplete = Date.now() - clickedAt >= TAOBAO_DRAMA_MIN_SETTLE_MS;
    if (shouldRetryTaobaoCollectionCreate({
      success,
      alreadyRetried: retriedCreate,
      settlePeriodComplete,
      createButtonVisible: await createButton.isVisible().catch(() => false),
      createButtonEnabled: await createButton.isEnabled().catch(() => false),
    })) {
      retriedCreate = true;
      clickedAt = await runStep("再次确认创建合集", clickCreate, false);
      deadline = clickedAt + 60_000;
      log(options, "[taobao-drama] 创建按钮仍可用，已补点一次并重新进入结算期");
      continue;
    }
    await page.waitForTimeout(250);
  }
  if (!success) throw new Error("TAOBAO_DRAMA_COLLECTION_CREATE_RESULT_NOT_RECOGNIZED");
  const remaining = TAOBAO_DRAMA_MIN_SETTLE_MS - (Date.now() - clickedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  log(options, "[taobao-drama] 合集创建成功且10秒结算期完成");
}
