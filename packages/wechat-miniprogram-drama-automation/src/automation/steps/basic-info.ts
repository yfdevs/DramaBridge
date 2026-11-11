import type { Locator, Page } from "playwright";
import { resolveFromRoot } from "../../shared/config.js";
import { ErrorType } from "../../shared/errors.js";
import type { Config } from "../../shared/types.js";
import {
  copyrightVerificationValues,
  dramaTypeValues,
  monetizationValues,
  auditFormPagePath,
  qualificationValues,
  selectors,
  submissionIdentityValues,
} from "../constants.js";
import { gotoMiniProgramPage } from "../portal-navigation.js";
import {
  findVisibleLabeledGroup,
  prepareUploadFiles,
  uploadInGroup,
} from "../upload/upload-helpers.js";
import { createLogger } from "../../shared/logger.js";

const formLogger = createLogger("form");

async function fillFirstMatchingField(
  page: Page,
  fieldSelector: string,
  fieldValue: string | number,
  fieldLabel: string,
): Promise<void> {
  const fieldLocator = page.locator(fieldSelector).first();
  await fieldLocator.waitFor({ state: "visible", timeout: 20000 });
  await fieldLocator.fill(String(fieldValue));
  formLogger.info("字段已填写", { field: fieldLabel });
}

async function fillLegacyFieldWhenVisible(
  page: Page,
  fieldSelector: string,
  fieldValue: string | number,
  fieldLabel: string,
): Promise<boolean> {
  const fieldLocator = page.locator(fieldSelector).first();
  if (
    (await fieldLocator.count()) === 0
    || !await fieldLocator.isVisible().catch(() => false)
  ) {
    formLogger.info("当前页面未显示旧版字段，已跳过", { field: fieldLabel });
    return false;
  }

  await fieldLocator.fill(String(fieldValue), { timeout: 15000 });
  formLogger.info("字段已填写", { field: fieldLabel });
  return true;
}

function sanitizeDramaText(value: string, label: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[–—]+/g, "—")
    .replace(/[!！、;；"“”#@&()（）+/*。.?？%]+/g, "，")
    .replace(/,/g, "，")
    .replace(/[^A-Za-z0-9\u3400-\u9FFF\uF900-\uFAFF，—《》\-·:：]+/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/^，+|，+$/g, "");

  if (!sanitized) {
    throw new Error(`data.playlet.${label} is empty after removing unsupported characters.`);
  }
  if (sanitized !== value) {
    formLogger.warn("字段包含不支持字符，已自动清理", { field: label, value: sanitized });
  }
  return sanitized;
}

function createDramaNameValidationError(message: string): Error {
  return Object.assign(new Error(`[drama-name-validation-failed] ${message}`), {
    errorType: ErrorType.Validation,
  });
}

function validateDramaName(value: string): string {
  if (!value) {
    throw createDramaNameValidationError("data.playlet.name is required.");
  }
  if (/\s/.test(value)) {
    throw createDramaNameValidationError("data.playlet.name must not contain spaces.");
  }

  const edgeUnsupportedPattern = /^[！、；“”#@&（）+/*，。？%]|[！、；“”#@&（）+/*，。？%]$/u;
  if (edgeUnsupportedPattern.test(value)) {
    throw createDramaNameValidationError(
      "data.playlet.name starts or ends with unsupported characters: ！、；“”#@&（）+/*，。？%",
    );
  }

  const middleText = value.slice(1, -1);
  if (/[、；“”#@&（）+/*。？%]/u.test(middleText)) {
    throw createDramaNameValidationError(
      "data.playlet.name contains unsupported middle characters: 、；“”#@&（）+/*。？%",
    );
  }

  return value;
}

async function selectCheckboxOrRadioLocator(
  hiddenInput: Locator,
  inputLabel: string,
): Promise<void> {
  if ((await hiddenInput.count()) === 0) {
    formLogger.warn("未找到字段，已跳过", { field: inputLabel });
    return;
  }

  const visibleIcon = hiddenInput.locator("xpath=following-sibling::i[1]").first();
  try {
    if ((await visibleIcon.count()) > 0 && (await visibleIcon.isVisible())) {
      await visibleIcon.click({ timeout: 15000 });
    } else {
      await hiddenInput.check({ force: true, timeout: 15000 });
    }
  } catch (error) {
    await hiddenInput.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    formLogger.warn("字段已使用兼容方式选中", { field: inputLabel, message });
  }
  formLogger.info("选项已选择", { field: inputLabel });
}

async function fillFieldInsideLabeledGroup(
  page: Page,
  labelPrefix: string,
  fieldValue: string | number,
  _groupKey: string,
  fieldLabel = labelPrefix,
): Promise<boolean> {
  const group = await findVisibleLabeledGroup(page, labelPrefix, "input, textarea");
  if (!group) return false;

  const inputOrTextarea = group
    .locator("input:not([type]), input[type='text'], input[type='number'], textarea")
    .first();
  if ((await inputOrTextarea.count()) === 0) {
    formLogger.warn("未找到字段，已跳过", { field: fieldLabel });
    return false;
  }

  await inputOrTextarea.fill(String(fieldValue), { timeout: 15000 });
  formLogger.info("字段已填写", { field: fieldLabel });
  return true;
}

async function fillInGroupByPlaceholder(
  page: Page,
  groupLabelPrefix: string,
  _key: string,
  placeholder: string,
  fieldValue: string | number,
  label: string,
): Promise<boolean> {
  const group = await findVisibleLabeledGroup(
    page,
    groupLabelPrefix,
    `input[placeholder="${placeholder}"]`,
  );
  if (!group) return false;

  const inputWithPlaceholder = group.locator(`input[placeholder="${placeholder}"]`).first();
  await inputWithPlaceholder.fill(String(fieldValue), { timeout: 15000 });
  formLogger.info("字段已填写", { field: label });
  return true;
}

const serviceAgreementText = "微信小程序微短剧剧目审核服务使用须知";

function createBasicInfoValidationError(message: string): Error {
  return Object.assign(new Error(`[basic-info-validation-failed] ${message}`), {
    errorType: ErrorType.Validation,
  });
}

function findServiceAgreementCheckbox(page: Page): Locator {
  return page
    .locator("label.weui-desktop-form__check-label")
    .filter({ hasText: serviceAgreementText })
    .filter({ has: page.locator('input[type="checkbox"]') })
    .locator('input[type="checkbox"]')
    .first();
}

async function acceptServiceAgreement(page: Page): Promise<void> {
  const checkbox = findServiceAgreementCheckbox(page);
  if ((await checkbox.count()) === 0) {
    throw createBasicInfoValidationError(`未找到《${serviceAgreementText}》复选框`);
  }

  if (!await checkbox.isChecked().catch(() => false)) {
    const icon = checkbox.locator("xpath=following-sibling::i[1]").first();
    await icon.scrollIntoViewIfNeeded().catch(() => undefined);
    if ((await icon.count()) > 0 && await icon.isVisible().catch(() => false)) {
      await icon.click({ force: true, timeout: 15000 }).catch(() => undefined);
    }
  }

  if (!await checkbox.isChecked().catch(() => false)) {
    await checkbox.check({ force: true, timeout: 15000 }).catch(() => undefined);
  }

  if (!await checkbox.isChecked().catch(() => false)) {
    await checkbox.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.click();
      if (input.checked) return;
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  await page.waitForTimeout(300);
  if (!await checkbox.isChecked().catch(() => false)) {
    throw createBasicInfoValidationError(`无法勾选《${serviceAgreementText}》`);
  }
  formLogger.info("选项状态已确认", { field: "服务须知同意", checked: true });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findVisibleFormGroup(
  page: Page,
  labelPrefix: string,
  expectedSelector: string,
): Promise<Locator | null> {
  const groups = page.locator(".weui-desktop-form__control-group:visible");
  const labels = page.locator("label.weui-desktop-form__label");
  const buildCandidates = (pattern: RegExp) => groups
    .filter({ has: labels.filter({ hasText: pattern }) })
    .filter({ has: page.locator(expectedSelector) });
  const escapedLabel = escapeRegex(labelPrefix);
  const exact = buildCandidates(new RegExp(`^\\s*${escapedLabel}\\s*$`));
  if (await exact.count()) return exact.first();
  const startsWith = buildCandidates(new RegExp(`^\\s*${escapedLabel}`));
  return await startsWith.count() ? startsWith.first() : null;
}

async function selectRadioByLabel<Value extends string>(
  page: Page,
  labelPrefix: string,
  values: Record<Value, string>,
  value: Value,
  required: boolean,
): Promise<boolean> {
  const radioGroup = await findVisibleFormGroup(page, labelPrefix, 'input[type="radio"]');
  if (!radioGroup) {
    if (required) {
      throw new Error(`[form-control-not-found] 未找到必填选项组：${labelPrefix}`);
    }
    formLogger.info("当前页面未显示旧版选项，已跳过", { field: labelPrefix, value });
    return false;
  }

  const target = radioGroup.locator(`input[type="radio"][value="${values[value]}"]`).first();
  if ((await target.count()) === 0) {
    throw new Error(`[form-option-not-found] ${labelPrefix} 不支持选项：${value}`);
  }
  await selectCheckboxOrRadioLocator(target, `${labelPrefix}: ${value}`);
  return true;
}

async function waitForCheckboxState(
  checkbox: Locator,
  expected: boolean,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await checkbox.isChecked().catch(() => !expected)) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return (await checkbox.isChecked().catch(() => !expected)) === expected;
}

function createAiContentSwitchError(enabled: boolean): Error {
  return Object.assign(
    new Error(`[ai-content-switch-failed] 无法将AI内容声明切换为${enabled ? "开启" : "关闭"}状态`),
    { errorType: ErrorType.Browser },
  );
}

export async function setAiContentDeclaration(page: Page, enabled: boolean): Promise<void> {
  const group = await findVisibleFormGroup(page, "AI内容声明", 'input[type="checkbox"]');
  if (!group) {
    throw new Error("[form-control-not-found] 未找到必填选项：AI内容声明");
  }
  const checkbox = group.locator('input[type="checkbox"]').first();
  if ((await checkbox.isChecked().catch(() => !enabled)) !== enabled) {
    const visibleSwitch = group.locator(".weui-desktop-switch__box:visible").first();
    if (await visibleSwitch.count()) {
      await visibleSwitch.scrollIntoViewIfNeeded().catch(() => undefined);
      await visibleSwitch.click({ timeout: 15000 }).catch((error) => {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        formLogger.warn("可见开关点击失败，准备使用兼容方式", { field: "AI内容声明", message });
      });
    }
  }

  if (!await waitForCheckboxState(checkbox, enabled)) {
    await checkbox.evaluate((element, checked) => {
      const input = element as HTMLInputElement;
      if (input.checked !== checked) input.click();
      if (input.checked === checked) return;
      input.checked = checked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, enabled);
  }

  if (!await waitForCheckboxState(checkbox, enabled)) {
    throw createAiContentSwitchError(enabled);
  }
  formLogger.info("选项状态已确认", {
    field: "AI内容声明",
    checked: enabled,
    source: "payloadJson.aiContent",
  });
}

async function uploadMaterial(
  page: Page,
  labelPrefixes: string | string[],
  filePaths: Array<string | undefined>,
  label = Array.isArray(labelPrefixes) ? labelPrefixes[0] : labelPrefixes,
  remoteDirectoryName?: string,
): Promise<void> {
  const prefixes = Array.isArray(labelPrefixes) ? labelPrefixes : [labelPrefixes];
  formLogger.info("素材上传计划已生成", { field: label, fileCount: filePaths.filter(Boolean).length });
  if (!filePaths.some(Boolean)) return;
  await uploadByAnyLabelPrefix(page, prefixes, filePaths, label, remoteDirectoryName);
}

async function uploadByAnyLabelPrefix(
  page: Page,
  labelPrefixes: string[],
  filePaths: Array<string | undefined>,
  label: string,
  remoteDirectoryName?: string,
): Promise<void> {
  if (!filePaths.some(Boolean)) return;

  for (const labelPrefix of labelPrefixes) {
    const uploadGroup = await findVisibleLabeledGroup(page, labelPrefix, 'input[type="file"]');
    if (!uploadGroup) continue;
    await uploadInGroup(uploadGroup, filePaths, label, resolveFromRoot, remoteDirectoryName);
    return;
  }

  throw new Error(
    `[upload-failed] ${label}: control group not found: ${labelPrefixes.join(" / ")}`,
  );
}

// 根据表单左侧的中文标签找到对应的表单组，再直接给该组中的 input[type=file] 设置文件
async function uploadByLabeledGroupFileInput(
  page: Page,
  labelPrefixes: string | string[],
  filePaths: Array<string | undefined>,
  label = Array.isArray(labelPrefixes) ? labelPrefixes[0] : labelPrefixes,
  remoteDirectoryName?: string,
  uiTimeout = 60000,
): Promise<void> {
  const files = await prepareUploadFiles(filePaths, resolveFromRoot, remoteDirectoryName);
  if (!files.length) {
    formLogger.warn("没有可用文件，已跳过", { field: label });
    return;
  }

  const prefixes = Array.isArray(labelPrefixes) ? labelPrefixes : [labelPrefixes];
  for (const prefix of prefixes) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactGroup = page
      .locator(".weui-desktop-form__control-group")
      .filter({ has: page.locator('input[type="file"]') })
      .filter({
        has: page
          .locator("label.weui-desktop-form__label")
          .filter({ hasText: new RegExp(`^\\s*${escapedPrefix}\\s*$`) }),
      })
      .first();
    if (await exactGroup.count()) {
      await uploadInGroup(
        exactGroup,
        files,
        label,
        (filePath) => filePath,
        remoteDirectoryName,
        uiTimeout,
      );
      return;
    }
  }

  for (const prefix of prefixes) {
    const fuzzyGroup = page
      .locator(".weui-desktop-form__control-group")
      .filter({ has: page.locator('input[type="file"]') })
      .filter({
        has: page.locator("label.weui-desktop-form__label").filter({ hasText: prefix }),
      })
      .first();
    if (await fuzzyGroup.count()) {
      await uploadInGroup(
        fuzzyGroup,
        files,
        label,
        (filePath) => filePath,
        remoteDirectoryName,
        uiTimeout,
      );
      return;
    }
  }

  for (const prefix of prefixes) {
    const textMatchedGroup = page
      .locator(".weui-desktop-form__control-group")
      .filter({ has: page.locator('input[type="file"]') })
      .filter({ hasText: prefix })
      .first();
    if (await textMatchedGroup.count()) {
      await uploadInGroup(
        textMatchedGroup,
        files,
        label,
        (filePath) => filePath,
        remoteDirectoryName,
        uiTimeout,
      );
      return;
    }
  }

  throw new Error(`[upload-failed] ${label}: input[type=file] group not found`);
}

async function fillProducerName(page: Page, value: string): Promise<void> {
  const textbox = page
    .getByPlaceholder("请填写待提审剧目的制作方主体名称", { exact: true })
    .first();
  if ((await textbox.count()) > 0 && await textbox.isVisible().catch(() => false)) {
    await textbox.fill(value, { timeout: 15000 });
    formLogger.info("字段已填写", { field: "制作方名称" });
    return;
  }

  await page
    .locator(selectors.producerName)
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => undefined);
  if ((await page.locator(selectors.producerName).count()) > 0) {
    await fillFirstMatchingField(page, selectors.producerName, value, "制作方名称");
  } else {
    throw new Error("[form-control-not-found] 未找到必填字段：制作方名称");
  }
}

async function fillProductionCost(page: Page, value: number): Promise<void> {
  const textbox = page
    .getByRole("textbox", {
      name: "请填写剧目制作成本，该金额需与《成本配置比例情况报告》内容一致",
    })
    .first();
  if ((await textbox.count()) > 0) {
    await textbox.fill(String(value), { timeout: 15000 });
    formLogger.info("字段已填写", { field: "剧目制作成本" });
    return;
  }

  await fillFieldInsideLabeledGroup(page, "剧目制作成本", value, "production-cost", "剧目制作成本");
}

interface VisibleTextCollection {
  texts: string[];
  visibleCount: number;
}

async function readLocatorText(locator: Locator): Promise<string> {
  const text = await locator.innerText().catch(() => "");
  const fallbackText = text || (await locator.textContent().catch(() => "")) || "";
  return fallbackText.replace(/\s+/g, " ").trim();
}

async function collectVisibleTexts(locator: Locator): Promise<VisibleTextCollection> {
  const texts: string[] = [];
  let visibleCount = 0;
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    visibleCount += 1;
    const text = await readLocatorText(item);
    if (text) texts.push(text);
  }
  return {
    texts: Array.from(new Set(texts)),
    visibleCount,
  };
}

async function collectBasicInfoValidationErrors(page: Page): Promise<string[]> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const topTips = await collectVisibleTexts(page.locator(".weui-toptips__inner"));
    const fieldWarnings = await collectVisibleTexts(page.locator(".weui-desktop-form__msg_warn"));
    const errors = [
      ...topTips.texts.map((text) => `顶部提示：${text}`),
      ...fieldWarnings.texts.map((text) => `表单提示：${text}`),
    ];

    if (errors.length > 0) return errors;
    if (topTips.visibleCount + fieldWarnings.visibleCount === 0) return [];

    await page.waitForTimeout(300);
  }

  return [];
}

async function assertNoBasicInfoValidationErrors(page: Page): Promise<void> {
  const errors = await collectBasicInfoValidationErrors(page);
  if (errors.length === 0) return;

  const message = `[basic-info-validation-failed] ${errors.join("；")}`;
  formLogger.error("表单校验失败", { errorMessage: message });
  throw new Error(message);
}

async function submitBasicInfoAndWaitForEpisodeSelection(
  page: Page,
  button: Locator,
): Promise<void> {
  const searchInput = page.getByPlaceholder("搜索文件名").first();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await searchInput.isVisible().catch(() => false)) {
      formLogger.info("已进入剧集文件选取步骤", { attempt: attempt - 1, maxAttempts });
      return;
    }
    await acceptServiceAgreement(page);
    await button.click({ timeout: 30000 });
    const enteredEpisodeSelection = await searchInput.waitFor({
      state: "visible",
      timeout: 15000,
    }).then(() => true, () => false);
    if (enteredEpisodeSelection) {
      formLogger.info("已进入剧集文件选取步骤", { attempt, maxAttempts });
      return;
    }

    const errors = await collectBasicInfoValidationErrors(page);
    if (errors.length > 0 && !errors.some((error) => error.includes(serviceAgreementText))) {
      await assertNoBasicInfoValidationErrors(page);
    }
    if (attempt < maxAttempts) {
      formLogger.warn("点击下一步后仍停留在剧目信息页，准备重试", {
        attempt,
        maxAttempts,
        errors: errors.join("；") || undefined,
      });
      await page.waitForTimeout(500);
    }
  }

  const errors = await collectBasicInfoValidationErrors(page);
  if (errors.length > 0) await assertNoBasicInfoValidationErrors(page);
  throw new Error(
    `[step-transition-failed] 点击“下一步”${maxAttempts} 次后仍未进入“剧集文件选取”步骤`,
  );
}

export async function fillBasicInfoStep(page: Page, playletConfig: Config): Promise<void> {
  const { playlet } = playletConfig;
  const dramaName = validateDramaName(playlet.name);
  const dramaSummary = sanitizeDramaText(playlet.summary, "summary");
  const remoteAssetDirectoryName = dramaName;
  const contractRemoteAssetDirectoryName = `${dramaName}-contract`;

  await gotoMiniProgramPage(page, auditFormPagePath);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  for (let step = 0; step < 3; step += 1) {
    if (await page.locator(selectors.dramaName).first().isVisible().catch(() => false)) break;

    const previousButton = page.getByRole("button", { name: "上一步", exact: true }).first();
    if (!await previousButton.isVisible().catch(() => false)) break;
    await previousButton.click({ timeout: 15000 });
    await page.waitForTimeout(300);
  }
  const button = page.getByRole("button", { name: "下一步" }).first();
  await button.waitFor({ state: "visible", timeout: 30000 });

  await fillFirstMatchingField(page, selectors.dramaName, dramaName, "剧目名称");
  await fillFirstMatchingField(page, selectors.summary, dramaSummary, "剧目简介");
  await fillFirstMatchingField(page, selectors.episodeCount, playlet.episodeCount, "总集数");
  await fillLegacyFieldWhenVisible(
    page,
    selectors.previewEpisodeCount,
    playlet.previewEpisodeCount ?? 1,
    "试看集数",
  );
  if (playlet.recommendation) {
    await fillFirstMatchingField(page, selectors.recommendation, playlet.recommendation, "推荐语");
  }

  const dramaType = playlet.dramaType ?? "数字真人";
  await selectRadioByLabel(page, "剧目类型", dramaTypeValues, dramaType, true);
  const monetization = playlet.monetization ?? "IAA广告变现";
  await selectRadioByLabel(page, "变现类型", monetizationValues, monetization, false);

  const aiContent = playlet.aiContent ?? true;
  await setAiContentDeclaration(page, aiContent);
  if (aiContent) {
    await page
      .getByText(/^\s*AI\s*制作证明\s*$/i)
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await uploadByLabeledGroupFileInput(
      page,
      ["AI制作证明", "AI 制作证明"],
      playlet.aiProductionProofFiles ?? [],
      "AI制作证明",
      remoteAssetDirectoryName,
    );
  }

  await uploadByLabeledGroupFileInput(
    page,
    ["剧目海报"],
    [playlet.posters.main],
    "剧目海报",
    remoteAssetDirectoryName,
    60000,
  );
  await uploadByLabeledGroupFileInput(
    page,
    ["推广海报"],
    [playlet.posters.promotion],
    "推广海报",
    remoteAssetDirectoryName,
    60000,
  );

  await selectRadioByLabel(
    page,
    "提审身份",
    submissionIdentityValues,
    playlet.submissionIdentity,
    true,
  );
  await fillProducerName(page, playlet.producerName);

  await selectRadioByLabel(
    page,
    "版权验证方式",
    copyrightVerificationValues,
    playlet.copyright.verificationMethod ?? "基于版权证明材料",
    true,
  );

  await uploadByLabeledGroupFileInput(
    page,
    ["剧目制作证明材料"], // 表单标签名称，支持一个名称或多个兼容名称
    playlet.copyright.productionProofFiles ?? [],
    "剧目制作证明材料", // 用于日志和错误提示，不参与页面元素匹配
    contractRemoteAssetDirectoryName,
  );
  await uploadByLabeledGroupFileInput(
    page,
    ["版权采买&播出授权证明材料", "版权采买及播出授权证明材料", "版权授权证明材料"],
    playlet.copyright.licenseProofFiles ?? [],
    "版权采买&播出授权证明材料",
    contractRemoteAssetDirectoryName,
  );

  const qualificationType = playlet.qualification.type ?? "其他微短剧";
  await selectRadioByLabel(
    page,
    "剧目资质",
    qualificationValues,
    qualificationType,
    true,
  );

  if (playlet.qualification.licenseOrRecordNumber) {
    const filled = await fillInGroupByPlaceholder(
      page,
      "剧目资质",
      "qualification-number",
      "请填写网络剧片发行许可证号或16位备案号",
      playlet.qualification.licenseOrRecordNumber,
      "资质编号",
    );
    if (!filled) {
      await page
        .locator(selectors.qualificationNumber)
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => undefined);
      await fillFirstMatchingField(
        page,
        selectors.qualificationNumber,
        playlet.qualification.licenseOrRecordNumber,
        "资质编号",
      );
    }
  }

  await uploadMaterial(
    page,
    ["剧目资质证明材料", "剧目资质", "资质证明材料"],
    playlet.qualification.proofFiles ?? [],
    "剧目资质证明材料",
    remoteAssetDirectoryName,
  );
  if (playlet.productionCost) {
    await fillProductionCost(page, playlet.productionCost.amountWan);
    formLogger.info(
      "准备上传剧目制作成本证明",
      { fileCount: (playlet.productionCost.proofFiles ?? []).filter(Boolean).length },
    );
    await uploadByLabeledGroupFileInput(
      page,
      [
        "剧目制作成本证明材料",
        "剧目制作成本证明文件",
        "成本配置比例情况报告",
        "成本证明",
        "剧目制作成本（单位：万元）",
        "剧目制作成本",
      ],
      playlet.productionCost.proofFiles ?? [],
      "剧目制作成本证明材料",
      remoteAssetDirectoryName,
    );
  }
  await uploadMaterial(
    page,
    "其他材料",
    playlet.otherMaterials ?? [],
    "其他材料",
    remoteAssetDirectoryName,
  );

  await submitBasicInfoAndWaitForEpisodeSelection(page, button);
}
