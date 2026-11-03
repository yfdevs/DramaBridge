import type { Locator, Page } from "playwright";

function exactTextPattern(value: string) {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

export function baiduFormItem(page: Page, label: string) {
  return page
    .locator(".cheetah-form-item")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
}

export async function fillByPlaceholder(page: Page, placeholder: string, value?: string) {
  if (value === undefined) return;
  const input = page.getByPlaceholder(placeholder, { exact: true }).first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(value);
}

export async function fillFormItem(page: Page, label: string, value?: string | number) {
  if (value === undefined) return;
  const input = baiduFormItem(page, label).locator("input, textarea").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(String(value));
}

export async function selectFormItem(page: Page, label: string, value: string) {
  const item = baiduFormItem(page, label);
  const combobox = item.locator('[role="combobox"]').first();
  const trigger = (await combobox.count()) ? combobox : item.locator(".cheetah-select").first();
  await selectDropdownOption(page, trigger, value);
}

async function dropdownTriggerValue(trigger: Locator) {
  return trigger.evaluate((element) => {
    const selectRoot = element.closest(".cheetah-select") ?? element;
    const selectionItem = selectRoot.querySelector(".cheetah-select-selection-item");
    const inputValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : "";
    return [
      inputValue,
      element.textContent,
      element.getAttribute("title"),
      selectionItem?.textContent,
      selectionItem?.getAttribute("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  });
}

async function dropdownClickTarget(trigger: Locator) {
  const selectRoot = trigger.locator(
    "xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' cheetah-select ')][1]",
  );
  if (!(await selectRoot.count())) return trigger;
  const selector = selectRoot.locator(".cheetah-select-selector").first();
  return (await selector.count()) ? selector : selectRoot.first();
}

async function findVirtualizedDropdownOption(
  page: Page,
  dropdown: Locator,
  value: string,
) {
  const option = () => dropdown
    .locator(".cheetah-select-item-option")
    .filter({ hasText: exactTextPattern(value), visible: true })
    .first();
  if (await option().isVisible().catch(() => false)) return option();

  const holder = dropdown.locator(".rc-virtual-list-holder").first();
  if (!(await holder.count())) {
    throw new Error(`BAIDU_DRAMA_DROPDOWN_OPTION_NOT_FOUND: ${value}`);
  }
  const metrics = await holder.evaluate((element) => ({
    clientHeight: element.clientHeight,
    maximumScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
  }));
  const step = Math.max(36, Math.floor(metrics.clientHeight * 0.75));
  const offsets: number[] = [];
  for (let offset = 0; offset < metrics.maximumScrollTop; offset += step) offsets.push(offset);
  offsets.push(metrics.maximumScrollTop);

  for (const scrollTop of [...new Set(offsets)]) {
    await holder.evaluate((element, nextScrollTop) => {
      element.scrollTop = nextScrollTop;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, scrollTop);
    await page.waitForTimeout(80);
    if (await option().isVisible().catch(() => false)) return option();
  }

  throw new Error(`BAIDU_DRAMA_DROPDOWN_OPTION_NOT_FOUND: ${value}`);
}

export async function selectDropdownOption(page: Page, trigger: Locator, value: string) {
  const currentValue = await dropdownTriggerValue(trigger);
  if (currentValue.trim() === value || currentValue.split(/\s+/).includes(value)) return;
  const clickTarget = await dropdownClickTarget(trigger);
  await clickTarget.waitFor({ state: "visible", timeout: 10_000 });
  if (await trigger.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => "false") !== "true") {
    await clickTarget.click({ timeout: 5_000 });
  }
  const dropdown = page.locator(".cheetah-select-dropdown:visible").last();
  await dropdown.waitFor({ state: "visible", timeout: 10_000 });
  const option = await findVirtualizedDropdownOption(page, dropdown, value);
  // A rendered virtual-list option can still be outside its scroll container.
  // Keep actionability checks enabled so layout changes are retried before clicking.
  await option.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await option.click({ timeout: 5_000 });
  await dropdown.waitFor({ state: "hidden", timeout: 5_000 });

  const selectedValue = await dropdownTriggerValue(trigger);
  if (selectedValue !== value && !selectedValue.split(/\s+/).includes(value)) {
    throw new Error(`BAIDU_DRAMA_DROPDOWN_OPTION_NOT_SELECTED: ${value}`);
  }
}

export async function selectRadio(page: Page, label: string, value: string) {
  const item = baiduFormItem(page, label);
  const radioLabel = item
    .locator(".cheetah-radio-group label, [role=\"radiogroup\"] label")
    .filter({ hasText: exactTextPattern(value) })
    .first();
  await radioLabel.waitFor({ state: "visible", timeout: 10_000 });

  const input = radioLabel.locator('input[type="radio"]').first();
  if (!(await input.count())) {
    throw new Error(`BAIDU_DRAMA_RADIO_INPUT_NOT_FOUND: ${label}=${value}`);
  }
  if (!(await input.isChecked())) {
    await radioLabel.click();
    await page.waitForTimeout(100);
  }
  if (!(await input.isChecked())) {
    await input.check({ force: true });
  }
  if (!(await input.isChecked())) {
    throw new Error(`BAIDU_DRAMA_RADIO_NOT_SELECTED: ${label}=${value}`);
  }
}

export async function fillTagValues(page: Page, label: string, values: string[]) {
  const item = baiduFormItem(page, label);
  const input = item.locator('input[role="combobox"], input').first();
  for (const value of values) {
    await input.fill(value);
    await input.press("Enter");
  }
}

export async function setCheckbox(page: Page, label: string, checked: boolean) {
  const item = baiduFormItem(page, label);
  const input = item.locator('input[type="checkbox"]').first();
  if (await input.count()) {
    if ((await input.isChecked()) !== checked) await input.setChecked(checked);
    return;
  }
  const candidate = page.getByText(label, { exact: true }).last();
  const checkbox = candidate.locator("xpath=ancestor::label[1]").locator('input[type="checkbox"]');
  if ((await checkbox.isChecked()) !== checked) await candidate.click();
}

export async function ensureCheckboxByExactText(page: Page, text: string) {
  const tip = page.getByText(text, { exact: true }).filter({ visible: true }).first();
  await tip.waitFor({ state: "visible", timeout: 10_000 });

  const labelCheckbox = tip.locator("xpath=ancestor::label[1]").locator('input[type="checkbox"]').first();
  const wrapperCheckbox = tip
    .locator("xpath=ancestor::*[contains(@class, 'checkbox')][1]")
    .locator('input[type="checkbox"]')
    .first();
  const checkbox = (await labelCheckbox.count()) ? labelCheckbox : wrapperCheckbox;
  if ((await checkbox.count()) && await checkbox.isChecked()) return;

  await tip.click();
  if (!(await checkbox.count())) return;

  const deadline = Date.now() + 2_000;
  while (!(await checkbox.isChecked().catch(() => false)) && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }
  if (!(await checkbox.isChecked().catch(() => false))) {
    throw new Error(`BAIDU_DRAMA_CHECKBOX_NOT_CHECKED: ${text}`);
  }
}

export async function uploadFormFiles(page: Page, label: string, files: string[]) {
  if (files.length === 0) return;
  const input = baiduFormItem(page, label).locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 10_000 });
  await input.setInputFiles(files);
  await page.waitForTimeout(500);
  await assertNoBaiduFormError(page, `上传${label}`);
}

function isNavigationContextDestroyed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|most likely because of a navigation|Cannot find context with specified id/i.test(message);
}

export async function assertNoBaiduFormError(page: Page, action: string) {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const errors = page.locator([
        ".cheetah-message-error:visible",
        ".cheetah-form-item-explain-error:visible",
        '[class*="message"][class*="error"]:visible',
      ].join(", "));
      const alerts = await page.locator('[role="alert"]:visible').allTextContents();
      const messages = [
        ...(await errors.allTextContents()),
        ...alerts.filter((text) => /失败|错误|不能|不可|请(?:上传|填写|输入|选择)|必填|超过|无效/.test(text)),
      ].map((text) => text.trim()).filter(Boolean);
      if (messages.length > 0) throw new Error(`BAIDU_DRAMA_FORM_ERROR: ${action}: ${messages.join("；")}`);
      return;
    } catch (error) {
      if (!isNavigationContextDestroyed(error) || attempt === maximumAttempts || page.isClosed()) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(100);
    }
  }
}

export async function clickBaiduNext(page: Page) {
  const button = page
    .locator("div")
    .filter({ hasText: /^\s*下一步\s*$/ })
    .locator("button")
    .last();
  await button.click();
  await page.waitForTimeout(500);
  await assertNoBaiduFormError(page, "下一步");
}

export async function confirmBaiduDramaTypeChangeIfPresent(
  page: Page,
  timeoutMs = 3_000,
) {
  const dialog = page
    .locator(".cheetah-modal-wrap:visible")
    .filter({ hasText: /变更短剧类型后需重新填写短剧信息/ })
    .last();
  const appeared = await dialog.waitFor({ state: "visible", timeout: timeoutMs }).then(
    () => true,
    () => false,
  );
  if (!appeared) return false;

  const confirm = dialog.getByRole("button", { name: "确定", exact: true }).last();
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
    throw new Error("BAIDU_DRAMA_TYPE_CHANGE_CONFIRM_NOT_CLOSED");
  });
  return true;
}

export async function confirmBaiduDramaInformation(page: Page) {
  const dialog = page
    .locator(".cheetah-modal-content:visible")
    .filter({ has: page.getByText("短剧信息确认", { exact: true }) })
    .last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const confirm = dialog.getByRole("button", { name: "确定", exact: true }).last();
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {
    throw new Error("BAIDU_DRAMA_INFORMATION_CONFIRM_NOT_CLOSED");
  });
  await assertNoBaiduFormError(page, "确认短剧信息");
}

type CoverSlotState = {
  ready: boolean;
  hasImageBox: boolean;
  hasPlaceholder: boolean;
  previewBackgroundImage: string;
  previewImageSource: string;
};

export type BaiduCoverUploadReceipt = {
  slot: Locator;
  file: string;
};

async function coverSlotState(slot: Locator): Promise<CoverSlotState> {
  return slot.evaluate((root) => {
    const imageBox = root.querySelector(".bjh-image-box");
    const preview = root.querySelector(
      '.bjh-image-box .cover-uploader-view-image [role="image"], .bjh-image-box [role="image"]',
    );
    const previewImage = root.querySelector<HTMLImageElement>(".bjh-image-box img[src]");
    const previewBackgroundImage = preview ? getComputedStyle(preview).backgroundImage : "";
    const previewImageSource = previewImage?.currentSrc || previewImage?.src || "";
    const hasPreview = /url\(["']?.+["']?\)/i.test(previewBackgroundImage)
      || /^(?:blob:|data:image\/|https?:\/\/)/i.test(previewImageSource);
    return {
      ready: Boolean(imageBox && hasPreview),
      hasImageBox: Boolean(imageBox),
      hasPlaceholder: Boolean(root.querySelector(".container .placehold")),
      previewBackgroundImage,
      previewImageSource,
    };
  });
}

async function waitForCoverSlotReady(
  page: Page,
  slot: Locator,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let current = await coverSlotState(slot);
  while (!current.ready && Date.now() < deadline) {
    await page.waitForTimeout(250);
    await assertNoBaiduFormError(page, "回填短剧封面");
    current = await coverSlotState(slot);
  }
  return current;
}

async function currentBaiduCoverDialog(page: Page) {
  const modalWrap = page.locator(".cheetah-modal-wrap:visible").last();
  if (await modalWrap.isVisible().catch(() => false)) return modalWrap;
  const roleDialog = page.locator('[role="dialog"]:visible').last();
  if (await roleDialog.isVisible().catch(() => false)) return roleDialog;
  return page.locator(".cheetah-modal-content:visible").last();
}

async function activateBaiduLocalCoverPanel(page: Page, dialog: Locator) {
  const localImageTab = dialog.getByText("本地图片", { exact: true }).last();
  if (!(await localImageTab.isVisible().catch(() => false))) return;
  const selected = await localImageTab.evaluate((element) => {
    const target = element.closest('[role="tab"], .cheetah-tabs-tab') ?? element;
    return target.getAttribute("aria-selected") === "true"
      || /(?:^|\s)(?:active|selected|cheetah-tabs-tab-active)(?:\s|$)/i.test(target.className);
  }).catch(() => false);
  if (!selected) {
    await localImageTab.click();
    await page.waitForTimeout(300);
  }
}

async function activeBaiduCoverFileInput(dialog: Locator) {
  const inputs = dialog.locator('input[type="file"]');
  const candidates = await inputs.evaluateAll((elements) =>
    elements
      .map((element, index) => {
        const input = element as HTMLInputElement;
        const accept = input.accept.toLowerCase();
        const acceptsImage =
          !accept || /image\//.test(accept) || /\.(?:jpe?g|png|webp|bmp)/.test(accept);
        let activePanel = true;
        let parent = input.parentElement;
        while (parent && !parent.matches('[role="dialog"], .cheetah-modal-wrap')) {
          const style = getComputedStyle(parent);
          if (
            parent.hidden
            || parent.getAttribute("aria-hidden") === "true"
            || style.display === "none"
            || style.visibility === "hidden"
          ) {
            activePanel = false;
            break;
          }
          parent = parent.parentElement;
        }
        return {
          index,
          score: (activePanel ? 100 : 0) + (acceptsImage ? 20 : 0) + (!input.disabled ? 10 : 0),
          usable: activePanel && acceptsImage && !input.disabled,
        };
      })
      .filter((candidate) => candidate.usable)
      .sort((left, right) => right.score - left.score || right.index - left.index),
  );
  const selected = candidates[0];
  if (!selected) throw new Error("BAIDU_DRAMA_COVER_FILE_INPUT_NOT_FOUND");
  return inputs.nth(selected.index);
}

async function baiduCoverFileInputDetails(dialog: Locator) {
  return dialog.locator('input[type="file"]').evaluateAll((elements) =>
    elements.map((element) => {
      const input = element as HTMLInputElement;
      return {
        accept: input.accept,
        disabled: input.disabled,
        files: input.files?.length ?? 0,
        parentHidden: Boolean(input.parentElement && (
          input.parentElement.hidden
          || input.parentElement.getAttribute("aria-hidden") === "true"
          || getComputedStyle(input.parentElement).display === "none"
        )),
      };
    }),
  ).catch(() => []);
}

async function closeBaiduCoverDialog(page: Page) {
  const dialog = await currentBaiduCoverDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape").catch(() => undefined);
  if (await dialog.isVisible().catch(() => false)) {
    const closeButton = dialog
      .locator(
        '.cheetah-modal-close, button[aria-label="Close"], button[aria-label="关闭"], [class*="modal-close"]',
      )
      .last();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click().catch(() => undefined);
    }
  }
  await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
}

async function uploadCoverSlotAttempt(page: Page, slot: Locator, file: string) {
  await slot.click();
  const dialog = await currentBaiduCoverDialog(page);
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await activateBaiduLocalCoverPanel(page, dialog);
  await dialog.locator('input[type="file"]').first().waitFor({ state: "attached", timeout: 10_000 });
  const input = await activeBaiduCoverFileInput(dialog);
  await input.waitFor({ state: "attached", timeout: 10_000 });
  await input.setInputFiles(file);
  // The Baidu upload component consumes the change event and may immediately clear or
  // replace the file input so the same file can be selected again. Reading files.length
  // here therefore produces a false zero even though the uploader accepted the file.
  // Treat the upload result and enabled confirm button below as the authoritative signal.

  const confirm = dialog.getByRole("button", { name: "确认", exact: true }).last();
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  const confirmDeadline = Date.now() + 60_000;
  while (!(await confirm.isEnabled().catch(() => false))) {
    const dialogText = await dialog.innerText().catch(() => "");
    const normalizedDialogText = dialogText.replace(/\s+/g, " ").trim();
    const transientFailure = normalizedDialogText.match(/(?:上传失败|上传出错|网络异常)/)?.[0];
    if (transientFailure) {
      throw new Error(
        `BAIDU_DRAMA_COVER_UPLOAD_TRANSIENT_FAILURE: file=${file} reason=${transientFailure} ` +
          `dialog=${JSON.stringify(normalizedDialogText.slice(0, 300))}`,
      );
    }
    const rejection = normalizedDialogText.match(
      /(?:图片格式不支持|不支持的图片格式|图片过大|图片尺寸不符)/,
    )?.[0];
    if (rejection) {
      throw new Error(
        `BAIDU_DRAMA_COVER_UPLOAD_REJECTED: file=${file} reason=${rejection} ` +
          `dialog=${JSON.stringify(normalizedDialogText.slice(0, 300))}`,
      );
    }
    if (Date.now() >= confirmDeadline) {
      const inputs = await baiduCoverFileInputDetails(dialog);
      throw new Error(
        `BAIDU_DRAMA_COVER_CONFIRM_NOT_READY: file=${file} ` +
          `dialog=${JSON.stringify(normalizedDialogText.slice(0, 300))} ` +
          `inputs=${JSON.stringify(inputs).slice(0, 500)}`,
      );
    }
    await page.waitForTimeout(500);
    await assertNoBaiduFormError(page, "上传短剧封面");
  }
  await assertNoBaiduFormError(page, "上传短剧封面");
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {
    throw new Error(`BAIDU_DRAMA_COVER_CONFIRM_NOT_CLOSED: file=${file}`);
  });
  await assertNoBaiduFormError(page, "处理短剧封面");
}

export async function uploadCoverSlot(
  page: Page,
  slot: Locator,
  file: string,
  options: {
    label?: string;
    maxAttempts?: number;
    onRetry?: (message: string) => void;
  } = {},
): Promise<BaiduCoverUploadReceipt> {
  const initialState = await coverSlotState(slot);
  if (initialState.ready) return { slot, file };

  const maximumAttempts = Math.max(1, options.maxAttempts ?? 3);
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await uploadCoverSlotAttempt(page, slot, file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        /BAIDU_DRAMA_COVER_(?:CONFIRM_NOT_(?:READY|CLOSED)|FILE_(?:INPUT_NOT_FOUND|NOT_SELECTED)|UPLOAD_TRANSIENT_FAILURE)/.test(
          message,
        );
      if (!retryable || attempt === maximumAttempts) throw error;
      options.onRetry?.(
        `封面上传未完成，准备重新打开上传弹窗：槽位=${options.label ?? "未知"} ` +
          `attempt=${attempt + 1}/${maximumAttempts}`,
      );
      await closeBaiduCoverDialog(page);
      await page.waitForTimeout(1_000);
      continue;
    }
    const state = await waitForCoverSlotReady(page, slot, 15_000);
    if (state.ready) return { slot, file };
    if (attempt === maximumAttempts) {
      throw new Error(
        `BAIDU_DRAMA_COVER_SLOT_NOT_READY: file=${file} attempt=${attempt} ` +
          `slot=${options.label ?? "未知"} state=${JSON.stringify(state)}`,
      );
    }
    options.onRetry?.(
      `封面未回填，准备重试：槽位=${options.label ?? "未知"} ` +
        `attempt=${attempt + 1}/${maximumAttempts} state=${JSON.stringify(state)}`,
    );
  }
  throw new Error(`BAIDU_DRAMA_COVER_SLOT_NOT_READY: file=${file}`);
}

export async function assertBaiduCoverUploadReceipt(
  page: Page,
  receipt: BaiduCoverUploadReceipt,
) {
  const state = await waitForCoverSlotReady(page, receipt.slot, 5_000);
  if (!state.ready) {
    throw new Error(
      `BAIDU_DRAMA_COVER_SLOT_LOST: file=${receipt.file} ` +
        `state=${JSON.stringify(state)}`,
    );
  }
}
