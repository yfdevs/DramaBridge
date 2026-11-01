import type { Locator, Page } from "playwright";
import type {
  KuaishouDramaPublishVariant,
  KuaishouDramaRuntimeOptions,
  KuaishouDramaTaskConfig,
} from "../shared/types.js";
import { exactTextPattern, scrollLocatorIntoView } from "./form-controls.js";
import { log } from "./browser-session.js";
import { maximizeKuaishouImageCropArea } from "./image-crop.js";
import { resolveKuaishouEpisodeCoverFile } from "../shared/cover-materials.js";
import { resolveUploadAssetFile } from "./upload/remote-assets.js";
import { enterKuaishouDramaVideoUploadStep } from "./video-upload-step.js";
import { uploadKuaishouDramaEpisodeVideos } from "./video-upload.js";
import {
  confirmKuaishouBatchDialog,
  confirmVisibleKuaishouPriceNotice,
} from "./batch-dialog.js";

const episodeSettleMs = 120;
const episodesPerPage = 10;

function escapeCssAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function selectEpisodeRangeBoundary(
  page: Page,
  dialog: Locator,
  selectorIndex: number,
  episode: number,
) {
  const selector = dialog.locator(".episode-range-selector .episode-selector").nth(selectorIndex);
  const trigger = selector.locator(".select-trigger").first();
  const popperId = await trigger.getAttribute("aria-describedby");
  if (!popperId) {
    throw new Error("KUAISHOU_DRAMA_EPISODE_RANGE_POPPER_ID_NOT_FOUND");
  }

  await trigger.click({ timeout: 30_000 });
  const popper = page.locator(`[id="${escapeCssAttributeValue(popperId)}"]`).first();
  await popper.waitFor({ state: "visible", timeout: 30_000 });
  const optionText = `第${episode}集`;
  const option = popper
    .locator(".ks-select-dropdown__item,[role='option']")
    .filter({ hasText: exactTextPattern(optionText) })
    .first();
  await option.waitFor({ state: "visible", timeout: 30_000 });
  await option.click({ timeout: 30_000 });
  await page.waitForTimeout(episodeSettleMs);
  const selectedText = await selector.locator("input.ks-input__inner").first().inputValue()
    .catch(() => "");
  if (selectedText !== optionText) {
    throw new Error(
      `KUAISHOU_DRAMA_EPISODE_RANGE_SELECTION_FAILED: ` +
        `${selectorIndex === 0 ? "start" : "end"}=${optionText}; actual=${selectedText || "-"}`,
    );
  }
}

async function confirmImageCropIfVisible(page: Page) {
  const cropDialog = page
    .locator('.ks-dialog[aria-label="图片剪裁"],[role="dialog"][aria-label="图片剪裁"]')
    .last();
  await cropDialog.waitFor({ state: "visible", timeout: 10_000 });
  await maximizeKuaishouImageCropArea(page, cropDialog);
  const clickDeadline = Date.now() + 10_000;
  const remainingMs = clickDeadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("KUAISHOU_DRAMA_IMAGE_CROP_CONFIRM_TIMEOUT");
  }
  const confirm = cropDialog
    .locator("button,.ks-button")
    .filter({ hasText: /^\s*(?:确\s*认|确\s*定|完\s*成|保\s*存)\s*$/ })
    .last();
  await confirm.waitFor({ state: "visible", timeout: remainingMs });
  if (Date.now() >= clickDeadline) {
    throw new Error("KUAISHOU_DRAMA_IMAGE_CROP_CONFIRM_TIMEOUT");
  }
  await confirm.evaluate((button) => (button as HTMLElement).click());
  await cropDialog.waitFor({ state: "hidden", timeout: 10_000 });
}

async function cancelImageCropIfVisible(page: Page) {
  const cropDialog = page
    .locator('.ks-dialog[aria-label="图片剪裁"]:visible,[role="dialog"][aria-label="图片剪裁"]:visible')
    .last();
  if (!await cropDialog.isVisible().catch(() => false)) return;

  const cancel = cropDialog
    .locator("button,.ks-button")
    .filter({ hasText: /^\s*取\s*消\s*$/ })
    .last();
  await cancel.evaluate((button) => (button as HTMLElement).click()).catch(async () => {
    await cropDialog.locator('button[aria-label="close"]').evaluate((button) => {
      (button as HTMLElement).click();
    });
  });
  const closed = await cropDialog.waitFor({ state: "hidden", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    await cropDialog.locator('button[aria-label="close"]').evaluate((button) => {
      (button as HTMLElement).click();
    });
    await cropDialog.waitFor({ state: "hidden", timeout: 5_000 });
  }
}

async function openBatchDialog(page: Page) {
  await page.getByRole("button", { name: "批量设置", exact: true }).click({ timeout: 30_000 });
  const dialog = page.getByRole("dialog", { name: "批量设置", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  return dialog;
}

async function confirmBatchDialog(page: Page, dialog: Locator) {
  await confirmKuaishouBatchDialog(page, dialog);
  await page.waitForTimeout(episodeSettleMs);
}

async function setBatchRange(
  page: Page,
  dialog: Locator,
  startEpisode: number,
  endEpisode: number,
) {
  await selectEpisodeRangeBoundary(page, dialog, 0, startEpisode);
  await selectEpisodeRangeBoundary(page, dialog, 1, endEpisode);
}

async function selectBatchEpisodePrice(
  page: Page,
  dialog: Locator,
  price: KuaishouDramaPublishVariant["episodePriceRanges"][number]["price"],
) {
  let radio = dialog.getByRole("radio", { name: price, exact: true });
  if (!(await radio.count())) {
    const value = price === "免费" ? "true" : "false";
    radio = dialog
      .locator(`input.ks-radio__original[value="${value}"]`)
      .locator("xpath=ancestor::label[@role='radio'][1]")
      .first();
  }
  await radio.click({ timeout: 30_000 });
  await confirmVisibleKuaishouPriceNotice(page);
}

async function setBatchEpisodeCover(
  page: Page,
  dialog: Locator,
  coverPath: string,
) {
  const coverFormItem = dialog
    .locator("label.ks-form-item__label")
    .filter({ hasText: exactTextPattern("单集封面") })
    .locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ks-form-item ')][1]",
    )
    .first();
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const input = dialog.locator('input[type="file"]').first();
      await input.setInputFiles(coverPath, { timeout: 120_000 });
      await confirmImageCropIfVisible(page);
      await coverFormItem.locator("img").first().waitFor({ state: "visible", timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      await cancelImageCropIfVisible(page);
      if (attempt < 3) await page.waitForTimeout(300);
    }
  }
  throw new Error(
    `KUAISHOU_DRAMA_EPISODE_CROP_RETRY_EXHAUSTED: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function batchSetEpisodeMetadata(
  page: Page,
  variant: KuaishouDramaPublishVariant,
  range: KuaishouDramaPublishVariant["episodePriceRanges"][number],
  coverPath: string,
) {
  const dialog = await openBatchDialog(page);
  await setBatchRange(page, dialog, range.startEpisode, range.endEpisode);
  const titleInput = dialog.locator('input[placeholder="请输入单集标题"]').first();
  await titleInput.fill(variant.title, { timeout: 30_000 });
  await setBatchEpisodeCover(page, dialog, coverPath);
  await selectBatchEpisodePrice(page, dialog, range.price);
  await confirmBatchDialog(page, dialog);
}

async function batchSetEpisodePrice(
  page: Page,
  range: KuaishouDramaPublishVariant["episodePriceRanges"][number],
  title: string,
  coverPath: string,
) {
  const dialog = await openBatchDialog(page);
  await setBatchRange(page, dialog, range.startEpisode, range.endEpisode);
  await dialog.locator('input[placeholder="请输入单集标题"]').first()
    .fill(title, { timeout: 30_000 });
  await setBatchEpisodeCover(page, dialog, coverPath);
  await selectBatchEpisodePrice(page, dialog, range.price);
  await confirmBatchDialog(page, dialog);
}

async function ensureEpisodeSlots(
  page: Page,
  episodeCount: number,
  options: KuaishouDramaRuntimeOptions,
) {
  // A new Kuaishou edit form already contains episode 1. The add dialog asks
  // only for the number of additional slots, e.g. a 40-episode drama enters 39.
  const missingCount = episodeCount - 1;
  if (missingCount === 0) return;

  const addButton = page.locator(".create-button").filter({ hasText: "添加单集信息" }).first();
  await scrollLocatorIntoView(page, addButton);
  await addButton.click({ timeout: 30_000 });

  const dialog = page
    .locator('.ks-message-box.create-episode[aria-label="添加单集信息"]:visible')
    .last();
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  log(options, `[kuaishou-drama] add-episode dialog visible: missing=${missingCount}`);
  const countInput = dialog.locator(".ks-message-box__input input.ks-input__inner").first();
  await countInput.waitFor({ state: "visible", timeout: 30_000 });
  const countText = String(missingCount);
  await countInput.fill(countText, { timeout: 30_000 });
  if ((await countInput.inputValue()) !== countText) {
    await countInput.click({ timeout: 30_000 });
    await countInput.press("ControlOrMeta+A");
    await countInput.pressSequentially(countText, { delay: 50 });
  }
  const actualInputValue = await countInput.inputValue();
  if (actualInputValue !== countText) {
    throw new Error(
      `KUAISHOU_DRAMA_EPISODE_COUNT_INPUT_FAILED: actual=${actualInputValue} expected=${countText}`,
    );
  }
  log(options, `[kuaishou-drama] add-episode count entered: ${countText}`);
  const confirmButton = dialog
    .locator("button.ks-button--primary:visible")
    .filter({ hasText: /^\s*确定\s*$/ })
    .last();
  await confirmButton.click({ timeout: 30_000 });
  log(options, "[kuaishou-drama] add-episode confirm clicked");
  const dialogClosed = await dialog
    .waitFor({ state: "hidden", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!dialogClosed) {
    const validationMessage = await dialog
      .locator(".ks-message-box__errormsg")
      .innerText()
      .catch(() => "");
    throw new Error(
      `KUAISHOU_DRAMA_EPISODE_DIALOG_NOT_CLOSED: value=${countText} ` +
        `message=${validationMessage.trim() || "-"}`,
    );
  }
  const expectedPageCount = Math.ceil(episodeCount / episodesPerPage);
  if (expectedPageCount > 1) {
    await page.locator("ul.set-list > li,.set-list > li")
      .nth(expectedPageCount - 1)
      .waitFor({ state: "visible", timeout: 60_000 });
  } else {
    await page.waitForFunction(
      (expectedCount) => document.querySelectorAll("form.episode").length === expectedCount,
      episodeCount,
      { timeout: 60_000 },
    );
  }
  log(options, `[kuaishou-drama] episode slots created: ${episodeCount}`);
}

async function agreeAndContinue(page: Page, options: KuaishouDramaRuntimeOptions) {
  const agreement = page.locator(".agreement-content").first();
  await scrollLocatorIntoView(page, agreement);
  const checked = await agreement.evaluate((node) => {
    const input = node.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const label = node.querySelector<HTMLElement>("label.ks-checkbox");
    const checkboxInput = node.querySelector<HTMLElement>(".ks-checkbox__input");
    if (!input || !label) return false;

    if (!input.checked && checkboxInput?.getAttribute("aria-checked") !== "true") {
      const eventInit = { bubbles: true, cancelable: true, view: window };
      label.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      label.dispatchEvent(new MouseEvent("mousedown", eventInit));
      label.dispatchEvent(new PointerEvent("pointerup", eventInit));
      label.dispatchEvent(new MouseEvent("mouseup", eventInit));
      label.click();
    }
    return input.checked || checkboxInput?.getAttribute("aria-checked") === "true";
  });
  await page.waitForTimeout(episodeSettleMs);
  const agreementChecked = checked || await agreement.evaluate((node) => {
    const input = node.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const checkboxInput = node.querySelector<HTMLElement>(".ks-checkbox__input");
    return Boolean(input?.checked || checkboxInput?.getAttribute("aria-checked") === "true");
  });
  if (!agreementChecked) {
    throw new Error("KUAISHOU_DRAMA_AGREEMENT_CHECK_FAILED");
  }
  log(options, "[kuaishou-drama] paid drama service agreement accepted");

  await enterKuaishouDramaVideoUploadStep(page, options);
}

export async function fillKuaishouDramaSaleAndEpisodes(
  page: Page,
  task: KuaishouDramaTaskConfig,
  variant: KuaishouDramaPublishVariant,
  resourceName: string,
  options: KuaishouDramaRuntimeOptions,
) {
  log(options, `[kuaishou-drama] selecting sale mode: ${variant.saleMode}`);
  const saleMode = page
    .locator(".skit-sale-type")
    .getByRole("radio", { name: new RegExp(`^${variant.saleMode}`) });
  await saleMode.click({ timeout: 30_000 });
  await page.waitForTimeout(episodeSettleMs);

  if (variant.fullDramaPriceYuan !== undefined) {
    const expectedPrice = String(variant.fullDramaPriceYuan);
    const priceInput = page
      .locator('.price-input-val[placeholder="请输入金额"]:visible')
      .first();
    await priceInput.waitFor({ state: "visible", timeout: 30_000 });
    await priceInput.click({ timeout: 30_000 });
    await priceInput.press("ControlOrMeta+A");
    await priceInput.pressSequentially(expectedPrice, { delay: 50 });
    await priceInput.evaluate((node, nextValue) => {
      const input = node as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      );
      if (descriptor?.set) {
        descriptor.set.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.defaultValue = nextValue;
      input.setAttribute("value", nextValue);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: nextValue,
        inputType: "insertText",
      }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, expectedPrice);
    await page.waitForTimeout(episodeSettleMs);
    await priceInput.blur();
    await page.waitForTimeout(episodeSettleMs);
    const priceState = await priceInput.evaluate((node, nextValue) => {
      const input = node as HTMLInputElement;
      input.defaultValue = nextValue;
      input.setAttribute("value", nextValue);
      return {
        value: input.value,
        defaultValue: input.defaultValue,
        valueAttribute: input.getAttribute("value"),
      };
    }, expectedPrice);
    if (
      Number(priceState.value) !== variant.fullDramaPriceYuan ||
      Number(priceState.defaultValue) !== variant.fullDramaPriceYuan ||
      Number(priceState.valueAttribute) !== variant.fullDramaPriceYuan
    ) {
      throw new Error(
        `KUAISHOU_DRAMA_FULL_PRICE_INPUT_FAILED: ` +
          `value=${priceState.value} defaultValue=${priceState.defaultValue} ` +
          `attribute=${priceState.valueAttribute} expected=${expectedPrice}`,
      );
    }
    log(
      options,
      `[kuaishou-drama] full drama price entered: value=${priceState.value} ` +
        `attribute=${priceState.valueAttribute}`,
    );
  }

  log(options, `[kuaishou-drama] creating ${task.episodeCount} episode slots: ${variant.kind}`);
  await ensureEpisodeSlots(page, task.episodeCount, options);
  const freeRange = variant.episodePriceRanges.find((range) => range.price === "免费");
  if (!freeRange) {
    throw new Error(`KUAISHOU_DRAMA_FREE_EPISODE_RANGE_NOT_FOUND: ${variant.kind}`);
  }
  const coverFile = resolveKuaishouEpisodeCoverFile(task, variant.kind);
  const episodeCoverPath = await resolveUploadAssetFile(
    coverFile,
    options,
    `${task.title}-${variant.kind}-episode-cover`,
    `${variant.kind} episode cover`,
  );
  // Kuaishou rejects a batch range whose start and end are the same. Ad-unlock
  // has only episode 1 free, so initialize all episodes as free and then let
  // the second batch override episodes 2..N to ad unlock.
  const initialFreeRange = freeRange.startEpisode === freeRange.endEpisode && task.episodeCount > 1
    ? { ...freeRange, endEpisode: task.episodeCount }
    : freeRange;
  log(
    options,
    `[kuaishou-drama] batch free episodes: ${variant.kind} ` +
      `${initialFreeRange.startEpisode}-${initialFreeRange.endEpisode}`,
  );
  await batchSetEpisodeMetadata(page, variant, initialFreeRange, episodeCoverPath);
  for (const range of variant.episodePriceRanges.filter((item) => item.price !== "免费")) {
    log(
      options,
      `[kuaishou-drama] batch episode price: ${variant.kind} ` +
        `${range.startEpisode}-${range.endEpisode}=${range.price}`,
    );
    await batchSetEpisodePrice(page, range, variant.title, episodeCoverPath);
  }

  if (variant.fullDramaPriceYuan !== undefined) {
    const expectedPrice = String(variant.fullDramaPriceYuan);
    const priceInput = page
      .locator('.price-input-val[placeholder="请输入金额"]:visible')
      .first();
    await priceInput.waitFor({ state: "visible", timeout: 30_000 });
    await priceInput.evaluate((node, nextValue) => {
      const input = node as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      );
      if (descriptor?.set) {
        descriptor.set.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.defaultValue = nextValue;
      input.setAttribute("value", nextValue);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: nextValue,
        inputType: "insertText",
      }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, expectedPrice);
    await page.waitForTimeout(episodeSettleMs);
    const priceState = await priceInput.evaluate((node) => {
      const input = node as HTMLInputElement;
      return {
        value: input.value,
        defaultValue: input.defaultValue,
        valueAttribute: input.getAttribute("value"),
      };
    });
    if (
      Number(priceState.value) !== variant.fullDramaPriceYuan ||
      Number(priceState.defaultValue) !== variant.fullDramaPriceYuan ||
      Number(priceState.valueAttribute) !== variant.fullDramaPriceYuan
    ) {
      throw new Error(
        `KUAISHOU_DRAMA_FULL_PRICE_INPUT_FAILED_BEFORE_CONTINUE: ` +
          `value=${priceState.value} defaultValue=${priceState.defaultValue} ` +
          `attribute=${priceState.valueAttribute} expected=${expectedPrice}`,
      );
    }
    log(
      options,
      `[kuaishou-drama] full drama price re-synced before continue: ` +
        `value=${priceState.value} attribute=${priceState.valueAttribute}`,
    );
  }
  await agreeAndContinue(page, options);
  await uploadKuaishouDramaEpisodeVideos(page, task, variant, resourceName, options);
}
