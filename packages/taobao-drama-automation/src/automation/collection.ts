import type { Locator, Page } from "playwright";
import { TAOBAO_DRAMA_FIXED_FIELDS, TAOBAO_DRAMA_MIN_SETTLE_MS } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { TaobaoCollectionMetadata, TaobaoDramaRuntimeOptions } from "../shared/types.js";
import { isTaobaoCreatorSuccessNavigation } from "./browser-session.js";

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
      page.locator("label").filter({
        hasText: new RegExp(`^\\s*\\*?\\s*${escaped(label)}(?:\\s|查看|创建后|请及时|$)`),
      }),
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
    page.getByLabel(new RegExp(`^\\s*${escaped(label)}\\s*$`))
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
  const trigger = await firstVisible([
    container.locator("[role='combobox']"),
    container.locator(".next-select, .ant-select, .semi-select"),
    container.locator("[class*='select-trigger']"),
    container.getByText(/^\s*选择\s*$/),
    container.locator("input:not([type='hidden']):not([type='file'])"),
    container.locator("button"),
  ]);
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

async function uploadCover(page: Page, coverFile: string) {
  const container = await fieldContainer(page, ["封面", "合集封面", "短剧封面"]);
  const input = container.locator("input[type='file']:not([disabled])").first();
  if (await input.count()) {
    await input.setInputFiles(coverFile, { timeout: 60_000 });
  } else {
    const trigger = await firstVisible([
      container.getByText(/^\s*添加封面\s*$/),
      container.locator("[class*='poster']"),
      container.locator("button"),
    ]);
    if (!trigger) throw new Error("TAOBAO_DRAMA_COVER_UPLOAD_TRIGGER_NOT_FOUND");
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 });
    await trigger.click({ timeout: 15_000 });
    const chooser = await chooserPromise;
    await chooser.setFiles(coverFile, { timeout: 60_000 });
  }
  const cropDialog = page
    .locator(".next-dialog:visible, .ant-modal:visible, .semi-modal:visible, [role='dialog']:visible")
    .filter({ has: page.locator("img, canvas") })
    .last();
  if (await cropDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await cropDialog.getByRole("button", { name: /^\s*(?:确定|确认|完成|保存)\s*$/ })
      .filter({ visible: true }).last().click({ timeout: 30_000 });
    await cropDialog.waitFor({ state: "hidden", timeout: 30_000 });
  }
  const preview = container.locator("img:visible, [class*='upload-list']:visible").first();
  await preview.waitFor({ state: "visible", timeout: 60_000 }).catch(async (error) => {
    if (!await input.count() || await input.evaluate((element: HTMLInputElement) => element.files?.length ?? 0) < 1) {
      throw error;
    }
  });
}

async function validationMessages(page: Page) {
  const messages = (await page.locator(validationSelector).allInnerTexts().catch(() => []))
    .map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (await page.locator("[aria-invalid='true']:visible").count().catch(() => 0)) {
    messages.push("存在未通过校验的字段");
  }
  return [...new Set(messages)];
}

async function createSucceeded(page: Page) {
  if (isTaobaoCreatorSuccessNavigation(page.url(), "collection")) return true;
  return page.getByText(/创建成功|合集创建成功|已创建/).filter({ visible: true }).first()
    .isVisible().catch(() => false);
}

export async function fillAndCreateTaobaoCollection(
  page: Page,
  task: TaobaoCollectionMetadata,
  coverFile: string,
  options: TaobaoDramaRuntimeOptions,
) {
  log(options, "[taobao-drama] 开始填写合集必填信息", {
    title: task.title,
    shortDramaType: task.shortDramaType,
    shortDramaTags: task.shortDramaTags,
    audience: task.audience,
  });
  await fillTextField(page, ["合集标题", "合集名称", "短剧名称", "标题"], task.title);
  await selectFieldValue(page, ["合集类型"], TAOBAO_DRAMA_FIXED_FIELDS.collectionType);
  await selectFieldValue(page, ["短剧类型"], task.shortDramaType);
  await selectFieldValue(page, ["付费方式"], TAOBAO_DRAMA_FIXED_FIELDS.paymentMode);
  for (const tag of task.shortDramaTags) await selectFieldValue(page, ["短剧标签", "标签"], tag, true);
  await page.keyboard.press("Escape").catch(() => undefined);
  await selectFieldValue(page, ["是否完结", "完结状态"], TAOBAO_DRAMA_FIXED_FIELDS.completionStatus);
  await selectFieldValue(page, ["观看受众", "受众"], task.audience);
  await uploadCover(page, coverFile);
  await selectFieldValue(page, ["备案类型"], TAOBAO_DRAMA_FIXED_FIELDS.filingType);
  await selectFieldValue(page, ["制作成本"], TAOBAO_DRAMA_FIXED_FIELDS.productionCost);
  await fillTextField(page, ["制片人"], TAOBAO_DRAMA_FIXED_FIELDS.producerName);
  await fillTextField(page, ["制作机构"], TAOBAO_DRAMA_FIXED_FIELDS.productionCompany);
  await fillTextField(page, ["导演"], TAOBAO_DRAMA_FIXED_FIELDS.directorName);
  await fillTextField(page, ["编剧"], TAOBAO_DRAMA_FIXED_FIELDS.scriptwriterName);
  await fillTextField(page, ["主要演员"], TAOBAO_DRAMA_FIXED_FIELDS.mainActors);
  await fillTextField(page, ["集数"], String(task.episodeCount));
  await fillTextField(page, ["集均时长(分钟)", "集均时长（分钟）", "集均时长"], String(TAOBAO_DRAMA_FIXED_FIELDS.averageEpisodeDurationMinutes));
  if (task.summary.trim().length < 100) {
    throw new Error(`TAOBAO_DRAMA_COLLECTION_SUMMARY_TOO_SHORT: length=${task.summary.trim().length} min=100`);
  }
  await fillTextField(page, ["内容概要"], task.summary.trim().slice(0, 3_000));

  const createButton = page.getByRole("button", { name: /^\s*(?:确认创建|创建合集|创建)\s*$/ })
    .filter({ visible: true }).last();
  await createButton.waitFor({ state: "visible", timeout: 30_000 });
  await createButton.click({ timeout: 30_000 });
  let clickedAt = Date.now();
  const confirmDialog = page
    .locator(".next-dialog:visible, .ant-modal:visible, .semi-modal:visible, [role='dialog']:visible")
    .filter({ hasText: /创建/ }).last();
  if (await confirmDialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirmDialog.getByRole("button", { name: /^\s*(?:确认创建|确定|确认)\s*$/ })
      .filter({ visible: true }).last().click({ timeout: 30_000 });
    clickedAt = Date.now();
  }
  log(options, "[taobao-drama] 已点击创建合集，进入至少10秒结算期");
  let success = false;
  const deadline = clickedAt + 60_000;
  while (Date.now() < deadline) {
    const validation = await validationMessages(page);
    if (validation.length) throw new Error(`TAOBAO_DRAMA_COLLECTION_FORM_INVALID: ${validation.join("；")}`);
    success ||= await createSucceeded(page);
    if (success && Date.now() - clickedAt >= TAOBAO_DRAMA_MIN_SETTLE_MS) break;
    await page.waitForTimeout(250);
  }
  if (!success) throw new Error("TAOBAO_DRAMA_COLLECTION_CREATE_RESULT_NOT_RECOGNIZED");
  const remaining = TAOBAO_DRAMA_MIN_SETTLE_MS - (Date.now() - clickedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  log(options, "[taobao-drama] 合集创建成功且10秒结算期完成");
}
