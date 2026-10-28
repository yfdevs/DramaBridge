import type { Locator, Page } from "playwright";
import { resolveFromRoot, validateWechatProductionCostProofFiles } from "../../shared/config.js";
import { ErrorType } from "../../shared/errors.js";
import type { Config } from "../../shared/types.js";
import {
  dramaTypeValues,
  monetizationValues,
  postUrl,
  qualificationValues,
  selectors,
  submissionIdentityValues,
  formGroup,
  rootSelector,
} from "../constants.js";
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

async function selectCheckboxOrRadio(
  page: Page,
  inputSelector: string,
  inputLabel: string,
): Promise<void> {
  const hiddenInput = page.locator(inputSelector).first();
  if ((await hiddenInput.count()) === 0) {
    formLogger.warn("未找到字段，已跳过", { field: inputLabel, selector: inputSelector });
    return;
  }

  const visibleIcon = page.locator(`${inputSelector} + i`).first();
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

async function clickExactText(page: Page, text: string, label: string): Promise<boolean> {
  const locator = page.getByText(text, { exact: true }).first();
  if ((await locator.count()) === 0) return false;
  await locator.click({ timeout: 15000 });
  formLogger.info("选项已选择", { field: label, value: text });
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
  const group = page
    .locator(`${rootSelector}:visible .weui-desktop-form__control-group:visible`)
    .filter({ hasText: /AI\s*内容声明/i })
    .filter({ has: page.locator('input[type="checkbox"]') })
    .first();
  if (!await group.count()) {
    throw new Error("[form-control-not-found] 未找到必填选项：AI内容声明");
  }
  const checkbox = group.locator('input[type="checkbox"]').first();
  if ((await checkbox.isChecked().catch(() => !enabled)) !== enabled) {
    const visibleSwitch = group.locator(".weui-desktop-switch__box:visible").first();
    if (await visibleSwitch.count()) {
      await visibleSwitch.scrollIntoViewIfNeeded().catch(() => undefined);
      await visibleSwitch.click({ timeout: 15000 }).catch((error) => {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        formLogger.warn("可见开关点击失败，准备使用兼容方式", {
          field: "AI内容声明",
          message,
        });
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

async function checkRadioByLabel<Value extends string>(
  page: Page,
  labelPrefix: string,
  _key: string,
  values: Record<Value, string>,
  value: Value,
): Promise<void> {
  const radioGroup = await findVisibleLabeledGroup(page, labelPrefix, 'input[type="radio"]');
  if (!radioGroup) {
    formLogger.warn("未找到选项组，已跳过", { field: labelPrefix });
    return;
  }

  await selectCheckboxOrRadioLocator(
    radioGroup.locator(`input[type="radio"][value="${values[value]}"]`).first(),
    `${labelPrefix}: ${value}`,
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
  required = false,
): Promise<void> {
  const files = await prepareUploadFiles(filePaths, resolveFromRoot, remoteDirectoryName);
  if (required && (files.length === 0 || files.length !== filePaths.length)) {
    throw new Error(`[upload-file-invalid] ${label}: 必传文件不存在或不可用，请检查后端返回的文件地址。`);
  }
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
  const textbox = page.getByRole("textbox", { name: "请填写待提审剧目的制作方主体名称" }).first();
  if ((await textbox.count()) > 0) {
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
    formLogger.warn("未找到字段，已跳过", { field: "制作方名称", selector: selectors.producerName });
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

export async function fillBasicInfoStep(page: Page, playletConfig: Config): Promise<void> {
  const { playlet } = playletConfig;
  const costProofFiles = validateWechatProductionCostProofFiles(playlet.productionCost);
  const dramaName = validateDramaName(playlet.name);
  const dramaSummary = sanitizeDramaText(playlet.summary, "summary");
  const remoteAssetDirectoryName = dramaName;

  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  const button = page.getByRole("button", { name: "下一步" }).first();
  await button.waitFor({ state: "visible", timeout: 30000 });

  await fillFirstMatchingField(page, selectors.dramaName, dramaName, "剧目名称");
  await fillFirstMatchingField(page, selectors.summary, dramaSummary, "剧目简介");
  await fillFirstMatchingField(page, selectors.episodeCount, playlet.episodeCount, "总集数");
  await fillFirstMatchingField(
    page,
    selectors.previewEpisodeCount,
    playlet.previewEpisodeCount ?? 1,
    "试看集数",
  );
  if (playlet.recommendation) {
    await fillFirstMatchingField(page, selectors.recommendation, playlet.recommendation, "推荐语");
  }

  const dramaType = playlet.dramaType ?? "数字真人";
  if (!(await clickExactText(page, dramaType, "剧目类型"))) {
    await selectCheckboxOrRadio(
      page,
      `${formGroup(7)} input[type="radio"][value="${dramaTypeValues[dramaType]}"]`,
      `剧目类型: ${dramaType}`,
    );
  }
  const monetization = playlet.monetization ?? "IAA广告变现";
  await selectCheckboxOrRadio(
    page,
    `${formGroup(5)} input[type="radio"][value="${monetizationValues[monetization]}"]`,
    `变现类型: ${monetization}`,
  );

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
      60000,
      true,
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

  if (!(await clickExactText(page, playlet.submissionIdentity, "提审身份"))) {
    await checkRadioByLabel(
      page,
      "提审身份",
      "submission-identity",
      submissionIdentityValues,
      playlet.submissionIdentity,
    );
  }
  await fillProducerName(page, playlet.producerName);

  await uploadByLabeledGroupFileInput(
    page,
    ["剧目制作证明材料"], // 表单标签名称，支持一个名称或多个兼容名称
    playlet.copyright.productionProofFiles ?? [],
    "剧目制作证明材料", // 用于日志和错误提示，不参与页面元素匹配
    undefined,
    60000,
    true,
  );
  const qualificationType = playlet.qualification?.type ?? "其他微短剧";
  if (!(await clickExactText(page, qualificationType, "剧目资质"))) {
    await checkRadioByLabel(
      page,
      "剧目资质",
      "qualification",
      qualificationValues,
      qualificationType,
    );
  }

  if (playlet.qualification?.licenseOrRecordNumber) {
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

  if (playlet.productionCost) {
    await fillProductionCost(page, playlet.productionCost.amountWan);
    formLogger.info(
      "准备上传剧目制作成本证明",
      { fileCount: costProofFiles.length },
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
      costProofFiles,
      "剧目制作成本证明材料",
      remoteAssetDirectoryName,
      60000,
      true,
    );
  }

  await selectCheckboxOrRadio(page, selectors.agreement, "服务须知同意");
  await page.waitForTimeout(2000);
  await button.click();
  await page.waitForTimeout(1000);
  await assertNoBasicInfoValidationErrors(page);
}
