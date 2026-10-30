import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DOMMatrix, DOMPoint, DOMRect, ImageData, Path2D } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib/dist/pdf-lib.esm.js";
import type { Locator, Page } from "playwright";
import sharp from "sharp";
import { DOUYIN_DRAMA_SERIES_TYPE } from "../shared/constants.js";
import type { DouyinDramaDropdownRecorder } from "../shared/dropdown-options.js";
import type { DouyinDramaRole } from "../shared/types.js";
import { requireDouyinRoleIntro } from "../shared/role-intro.js";

const douyinMessageErrorSelectors = [
  ".arco-message.arco-message-error[role='alert']",
  ".arco-message-error[role='alert']",
  ".arco-message-error",
];

export const DOUYIN_DRAMA_VIDEO_TOPICS = [
  "#短剧推剧",
  "#百亿剧好看计划",
  "#因为一个片段看了整部剧",
  "#漫剧",
  "#动态漫",
] as const;

async function selectDouyinVideoTopics(page: Page, drawer: Locator) {
  const addTopic = drawer.getByText("#添加话题", { exact: true }).first();
  const description = drawer.locator('[data-slate-editor="true"][contenteditable="true"]').first();
  await addTopic.waitFor({ state: "visible", timeout: 5_000 });
  await description.waitFor({ state: "visible", timeout: 5_000 });

  for (const topic of DOUYIN_DRAMA_VIDEO_TOPICS) {
    const topicName = topic.slice(1);
    await addTopic.click();
    await description.pressSequentially(topicName, { delay: 20 });

    const suggestion = page.locator(".mention-suggest-mount-dom:visible").last();
    await suggestion.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`DOUYIN_DRAMA_VIDEO_TOPIC_SUGGESTION_NOT_OPENED: ${topic}`);
    });
    const topicNameOption = suggestion
      .locator('[class*="tag-hash-view-name"]')
      .filter({ hasText: exactTextPattern(topicName) })
      .first();
    const matched = await topicNameOption.waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!matched) {
      const observed = (await suggestion
        .locator('[class*="tag-hash-view-name"]')
        .allTextContents())
        .map((value) => value.trim())
        .filter(Boolean);
      throw new Error(
        `DOUYIN_DRAMA_VIDEO_TOPIC_NOT_FOUND: ${topic}; observed=${JSON.stringify(observed)}`,
      );
    }
    await topicNameOption.click();
    await suggestion.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {
      throw new Error(`DOUYIN_DRAMA_VIDEO_TOPIC_NOT_SELECTED: ${topic}`);
    });

    const selectedText = (await description.innerText()).replace(/\s+/g, "");
    if (!selectedText.includes(topic)) {
      throw new Error(
        `DOUYIN_DRAMA_VIDEO_TOPIC_NOT_CONFIRMED: ${topic}; actual=${JSON.stringify(selectedText)}`,
      );
    }
  }
  await description.blur();
}

function exactTextPattern(value: string) {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

export function sanitizeDouyinDescriptionText(value: string) {
  return value
    .replace(/[:：]/gu, "，")
    .replace(/[,]/gu, "，")
    .replace(/[.;；]/gu, (character) => character === "." ? "。" : "；")
    .replace(/[?？]/gu, "？")
    .replace(/[!！]/gu, "！")
    .replace(/[“”"]/gu, (character) => character === "”" ? "”" : "“")
    .replace(/[(（]/gu, "（")
    .replace(/[)）]/gu, "）")
    .replace(/[—–_]/gu, "—")
    .replace(/\s+/gu, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9，。；“”？、—《》！（）\-·]/gu, "")
    .slice(0, 200);
}

export function douyinFormItem(page: Page, label: string) {
  return page
    .locator(".arco-form-item:visible")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
}

export async function installDouyinPageMessageCapture(page: Page) {
  const selectorsJson = JSON.stringify(douyinMessageErrorSelectors);
  await page.evaluate(`(() => {
    const selectors = ${selectorsJson};
    const state = window;
    state.__douyinDramaCapturedPageMessages ??= [];
    if (state.__douyinDramaPageMessageCaptureInstalled) return;
    state.__douyinDramaPageMessageCaptureInstalled = true;

    const selector = selectors.join(",");
    const captureElement = (element) => {
      if (!(element instanceof HTMLElement) || !element.matches(selector)) return;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) {
        return;
      }
      const message = element.textContent?.replace(/\\s+/g, " ").trim();
      if (message && !state.__douyinDramaCapturedPageMessages?.includes(message)) {
        state.__douyinDramaCapturedPageMessages?.push(message);
      }
    };
    const captureNode = (node) => {
      if (node instanceof Element) {
        captureElement(node);
        node.querySelectorAll(selector).forEach(captureElement);
      } else if (node.parentElement) {
        captureElement(node.parentElement);
      }
    };

    document.querySelectorAll(selector).forEach(captureElement);
    state.__douyinDramaPageMessageObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        captureNode(mutation.target);
        mutation.addedNodes.forEach(captureNode);
      });
    });
    state.__douyinDramaPageMessageObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
      characterData: true,
      childList: true,
      subtree: true,
    });
  })()`);
}

async function capturedDouyinPageMessageTexts(page: Page) {
  return page.evaluate(() => {
    const state = window as typeof window & {
      __douyinDramaCapturedPageMessages?: string[];
    };
    const messages = [...(state.__douyinDramaCapturedPageMessages ?? [])];
    state.__douyinDramaCapturedPageMessages = [];
    return messages;
  }).catch(() => [] as string[]);
}

export async function fillInputById(page: Page, id: string, value?: string | number) {
  if (value === undefined) return;
  const input = page.locator(`#${id}`).first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(String(value));
}

export async function fillStableInputById(
  page: Page,
  id: string,
  value: string | number,
  timeoutMs = 30_000,
) {
  const expected = String(value);
  const input = page.locator(`#${id}`).first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  const deadline = Date.now() + timeoutMs;
  let stablePasses = 0;
  while (Date.now() < deadline) {
    if (!await input.isEnabled().catch(() => false)) {
      stablePasses = 0;
      await page.waitForTimeout(500);
      continue;
    }
    if (await input.inputValue() !== expected) await input.fill(expected);
    await page.waitForTimeout(500);
    if (await input.inputValue() === expected) stablePasses += 1;
    else stablePasses = 0;
    // Keep the fixed value stable long enough for delayed OCR updates to finish.
    if (stablePasses >= 6) return;
  }
  throw new Error(
    `DOUYIN_DRAMA_INPUT_VALUE_NOT_STABLE: #${id} expected=${expected} ` +
      `actual=${await input.inputValue().catch(() => "")}`,
  );
}

export function normalizeDouyinPublishDateTime(value: string) {
  const trimmed = value.trim();
  const localParts = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/u,
  );
  if (localParts) {
    return `${localParts[1]}-${localParts[2]}-${localParts[3]} ` +
      `${localParts[4]}:${localParts[5]}:${localParts[6] ?? "00"}`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_INVALID: ${JSON.stringify(value)}`);
  }
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(parsed).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function resolveDouyinScheduledPublishDateTime(value: string, now = new Date()) {
  const configured = normalizeDouyinPublishDateTime(value);
  const target = douyinPublishDateTimeParts(configured);
  let targetTime = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    Number(target.hour) - 8,
    Number(target.minute),
    Number(target.second),
  );
  const oneDayMs = 24 * 60 * 60 * 1_000;
  const minimumScheduledTime = now.getTime() + 72 * 60 * 60 * 1_000;
  if (targetTime < minimumScheduledTime) {
    const daysToAdvance = Math.ceil((minimumScheduledTime - targetTime) / oneDayMs);
    targetTime += daysToAdvance * oneDayMs;
  }
  return normalizeDouyinPublishDateTime(new Date(targetTime).toISOString());
}

function douyinPublishDateTimeParts(value: string) {
  const matched = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u,
  );
  if (!matched) throw new Error(`DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_INVALID: ${JSON.stringify(value)}`);
  return {
    day: Number(matched[3]),
    hour: matched[4],
    minute: matched[5],
    month: Number(matched[2]),
    second: matched[6],
    year: Number(matched[1]),
  };
}

function arcoDatePickerPopup(page: Page) {
  return page
    .locator(".arco-picker-container:visible:not(.arco-picker-panel-only)")
    .last();
}

async function clickArcoPickerControl(popup: Locator, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  const panelHandle = await popup.elementHandle();
  if (!panelHandle) throw new Error("DOUYIN_DRAMA_DATE_PICKER_NOT_FOUND");
  try {
    const adjustment = bounds && await panelHandle.evaluate((element, target) => {
      const x = target.x + target.width / 2;
      const y = target.y + target.height / 2;
      const blocker = document.elementFromPoint(x, y);
      const header = blocker?.closest("header");
      if (!header || element.contains(blocker) || header.contains(element)) return null;

      // In short browser windows Arco opens upward underneath the fixed site
      // header. Move only the open panel so real pointer clicks reach its cells.
      const panel = element.getBoundingClientRect();
      const top = header.getBoundingClientRect().bottom + 8;
      if (top + target.height > window.innerHeight - 8) {
        throw new Error("DOUYIN_DRAMA_DATE_PICKER_OCCLUDED: 日期面板被页头遮挡，当前窗口高度不足，请增大窗口后重试");
      }
      // Prefer fitting the entire panel; on very short screens at least keep
      // the control being clicked below the header and inside the viewport.
      const offset = Math.max(
        top - target.y,
        Math.min(top - panel.top, window.innerHeight - 8 - panel.bottom),
      );
      const original = {
        value: element.style.getPropertyValue("translate"),
        priority: element.style.getPropertyPriority("translate"),
      };
      // Preserve any existing translation instead of replacing platform styles.
      const translated = getComputedStyle(element).translate;
      const parts = translated === "none" ? ["0px", "0px"] : translated.split(/\s+/u);
      element.style.setProperty("translate", `${parts[0]} calc(${parts[1] ?? "0px"} + ${offset}px)`, "important");
      return original;
    }, bounds);
    try {
      await control.click({ timeout: 5_000 });
    } finally {
      if (adjustment) {
        // Confirming can hide the popup, so restore through the retained handle
        // rather than resolving the :visible locator again.
        await panelHandle.evaluate((element, original) => {
          if (original.value) element.style.setProperty("translate", original.value, original.priority);
          else element.style.removeProperty("translate");
        }, adjustment);
      }
    }
  } finally {
    await panelHandle.dispose();
  }
}

async function readArcoPickerYearMonth(popup: Locator) {
  const labels = (await popup.locator(".arco-picker-header-label").allTextContents())
    .map((text) => text.replace(/\s+/g, "").trim());
  const year = Number(labels.find((text) => text.endsWith('年'))?.replace(/\D/gu, ""));
  const month = Number(labels.find((text) => text.endsWith('月'))?.replace(/\D/gu, ""));
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new Error(
      `DOUYIN_DRAMA_SCHEDULED_PUBLISH_CALENDAR_HEADER_INVALID: ${JSON.stringify(labels)}`,
    );
  }
  return { month, year };
}

async function selectArcoPublishDate(
  page: Page,
  popup: Locator,
  target: ReturnType<typeof douyinPublishDateTimeParts>,
) {
  const selectDateButton = popup.locator(".arco-picker-btn-select-date:visible").first();
  if (await selectDateButton.count()) await clickArcoPickerControl(popup, selectDateButton);

  for (let navigationCount = 0; navigationCount < 120; navigationCount += 1) {
    const current = await readArcoPickerYearMonth(popup);
    const monthDelta = (target.year - current.year) * 12 + target.month - current.month;
    if (monthDelta === 0) break;
    const headerIcons = popup.locator(".arco-picker-header > .arco-picker-header-icon:visible");
    if (await headerIcons.count() < 4) {
      throw new Error("DOUYIN_DRAMA_SCHEDULED_PUBLISH_CALENDAR_NAVIGATION_NOT_FOUND");
    }
    // Arco header order: previous year, previous month, next month, next year.
    await clickArcoPickerControl(popup, headerIcons.nth(monthDelta > 0 ? 2 : 1));
    await page.waitForTimeout(80);
  }

  const current = await readArcoPickerYearMonth(popup);
  if (current.year !== target.year || current.month !== target.month) {
    throw new Error(
      `DOUYIN_DRAMA_SCHEDULED_PUBLISH_CALENDAR_NAVIGATION_FAILED: `
        + `expected=${target.year}-${String(target.month).padStart(2, "0")}; `
        + `actual=${current.year}-${String(current.month).padStart(2, "0")}`,
    );
  }

  const dateCell = popup
    .locator(".arco-picker-cell-in-view:visible")
    .filter({ hasText: exactTextPattern(String(target.day)) })
    .first();
  await dateCell.waitFor({ state: "visible", timeout: 5_000 });
  // The platform recalculates disabled dates asynchronously after navigating
  // between months. Give a valid +72-hour date time to become selectable.
  const enabledDeadline = Date.now() + 3_000;
  let cellClass = await dateCell.getAttribute("class") ?? "";
  while (/arco-picker-cell-disabled/u.test(cellClass) && Date.now() < enabledDeadline) {
    await page.waitForTimeout(100);
    cellClass = await dateCell.getAttribute("class") ?? "";
  }
  if (/arco-picker-cell-disabled/u.test(cellClass)) {
    throw new Error(
      `DOUYIN_DRAMA_SCHEDULED_PUBLISH_DATE_DISABLED: `
        + `${target.year}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}`,
    );
  }
  await clickArcoPickerControl(popup, dateCell.locator(".arco-picker-date"));
}

async function selectArcoPublishTime(
  popup: Locator,
  target: ReturnType<typeof douyinPublishDateTimeParts>,
) {
  const selectTimeButton = popup.locator(".arco-picker-btn-select-time:visible").first();
  await selectTimeButton.waitFor({ state: "visible", timeout: 5_000 });
  await clickArcoPickerControl(popup, selectTimeButton);

  const lists = popup.locator(".arco-timepicker-list:visible");
  const listCount = await lists.count();
  if (listCount < 2) {
    throw new Error(`DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_PANEL_INVALID: columns=${listCount}`);
  }
  const values = [target.hour, target.minute, target.second];
  for (let index = 0; index < Math.min(listCount, values.length); index += 1) {
    const cell = lists
      .nth(index)
      .locator(".arco-timepicker-cell:visible")
      .filter({ hasText: exactTextPattern(values[index]) })
      .first();
    await cell.waitFor({ state: "visible", timeout: 5_000 });
    // Arco updates disabled time cells asynchronously after a date is selected.
    // Wait briefly so a stale class does not reject an otherwise valid time.
    const enabledDeadline = Date.now() + 3_000;
    let cellClass = await cell.getAttribute("class") ?? "";
    while (/arco-timepicker-cell-disabled/u.test(cellClass) && Date.now() < enabledDeadline) {
      await cell.page().waitForTimeout(100);
      cellClass = await cell.getAttribute("class") ?? "";
    }
    if (/arco-timepicker-cell-disabled/u.test(cellClass)) {
      throw new Error(
        `DOUYIN_DRAMA_SCHEDULED_PUBLISH_TIME_DISABLED: column=${index}; value=${values[index]}`,
      );
    }
    await clickArcoPickerControl(popup, cell);
  }
}

async function fillDouyinDateTimePicker(
  page: Page,
  input: Locator,
  value: string,
  fieldCode: "SCHEDULED_PUBLISH" | "COMPLETION_PROMISE",
) {
  const expected = normalizeDouyinPublishDateTime(value);
  const target = douyinPublishDateTimeParts(expected);
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.click();
  const popup = arcoDatePickerPopup(page);
  await popup.waitFor({ state: "visible", timeout: 5_000 });
  await selectArcoPublishDate(page, popup, target);
  await selectArcoPublishTime(popup, target);

  const confirm = popup.locator(".arco-picker-btn-confirm:visible").first();
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  const confirmDeadline = Date.now() + 5_000;
  while (!await confirm.isEnabled().catch(() => false) && Date.now() < confirmDeadline) {
    await page.waitForTimeout(100);
  }
  if (!await confirm.isEnabled().catch(() => false)) {
    throw new Error(`DOUYIN_DRAMA_${fieldCode}_CONFIRM_DISABLED`);
  }
  await clickArcoPickerControl(popup, confirm);
  await popup.waitFor({ state: "hidden", timeout: 5_000 });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const actual = (await input.inputValue()).trim();
    // The shortdramas page stores and displays this Arco DatePicker only to
    // the minute, while the task contract may contain any seconds value.
    // Seconds are intentionally ignored when confirming the browser value.
    const minutePrecisionExpected = expected.slice(0, 16);
    if (actual === expected || actual === minutePrecisionExpected) return expected;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `DOUYIN_DRAMA_${fieldCode}_TIME_NOT_CONFIRMED: expected=${expected}; ` +
      `actual=${JSON.stringify(await input.inputValue().catch(() => ""))}`,
  );
}

export function fillDouyinPublishDateTime(page: Page, value: string, now = new Date()) {
  return fillDouyinDateTimePicker(
    page,
    page.locator("#hong_guo_app_publish_time input").first(),
    resolveDouyinScheduledPublishDateTime(value, now),
    "SCHEDULED_PUBLISH",
  );
}

export async function fillNearestDouyinCompletionPromiseDateTime(page: Page) {
  const input = page.locator([
    "#complete_promise_time input",
    'input[placeholder="请选择更新完成时间"]',
    "#complete_promise_time_input",
  ].join(", ")).filter({ visible: true }).first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.click();

  const popup = arcoDatePickerPopup(page);
  await popup.waitFor({ state: "visible", timeout: 5_000 });
  const nearestDate = popup
    .locator(".arco-picker-cell-in-view:visible:not(.arco-picker-cell-disabled)")
    .first();
  await nearestDate.waitFor({ state: "visible", timeout: 5_000 });
  await clickArcoPickerControl(popup, nearestDate.locator(".arco-picker-date"));

  const selectTimeButton = popup.locator(".arco-picker-btn-select-time:visible").first();
  await selectTimeButton.waitFor({ state: "visible", timeout: 5_000 });
  await clickArcoPickerControl(popup, selectTimeButton);
  const lists = popup.locator(".arco-timepicker-list:visible");
  const listCount = await lists.count();
  if (listCount < 2) {
    throw new Error(`DOUYIN_DRAMA_COMPLETION_PROMISE_TIME_PANEL_INVALID: columns=${listCount}`);
  }
  for (let index = 0; index < listCount; index += 1) {
    const nearestValue = lists
      .nth(index)
      .locator(".arco-timepicker-cell:visible:not(.arco-timepicker-cell-disabled)")
      .first();
    await nearestValue.waitFor({ state: "visible", timeout: 5_000 });
    await clickArcoPickerControl(popup, nearestValue);
  }

  const confirm = popup.locator(".arco-picker-btn-confirm:visible").first();
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  const confirmDeadline = Date.now() + 5_000;
  while (!await confirm.isEnabled().catch(() => false) && Date.now() < confirmDeadline) {
    await page.waitForTimeout(100);
  }
  if (!await confirm.isEnabled().catch(() => false)) {
    throw new Error("DOUYIN_DRAMA_COMPLETION_PROMISE_CONFIRM_DISABLED");
  }
  await clickArcoPickerControl(popup, confirm);
  await popup.waitFor({ state: "hidden", timeout: 5_000 });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const actual = (await input.inputValue()).trim();
    if (actual) return normalizeDouyinPublishDateTime(actual);
    await page.waitForTimeout(200);
  }
  throw new Error("DOUYIN_DRAMA_COMPLETION_PROMISE_TIME_NOT_CONFIRMED");
}

export async function selectDouyinChargeEpisodes(
  page: Page,
  firstPaidEpisode: number,
  episodeCount: number,
) {
  if (!Number.isSafeInteger(firstPaidEpisode) || firstPaidEpisode < 2) {
    throw new Error(`DOUYIN_DRAMA_PAID_EPISODE_START_INVALID: ${firstPaidEpisode}`);
  }
  if (!Number.isSafeInteger(episodeCount) || episodeCount < firstPaidEpisode) {
    throw new Error(
      `DOUYIN_DRAMA_PAID_EPISODE_RANGE_INVALID: start=${firstPaidEpisode}; total=${episodeCount}`,
    );
  }

  const item = douyinFormItem(page, "售卖集数");
  await item.waitFor({ state: "visible", timeout: 10_000 });
  const expandText = item.getByText("展开", { exact: true }).filter({ visible: true }).first();
  if (await expandText.isVisible().catch(() => false)) {
    const expandControl = expandText.locator(
      "xpath=ancestor::*[self::button or self::div][contains(@class, 'expand-')][1]",
    );
    const trigger = await expandControl.count() > 0 ? expandControl : expandText;
    await trigger.click();
    await expandText.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {
      throw new Error("DOUYIN_DRAMA_PAID_EPISODES_EXPAND_NOT_CONFIRMED");
    });
  }
  for (let episode = firstPaidEpisode; episode <= episodeCount; episode += 1) {
    const option = item
      .locator("div:visible")
      .filter({ hasText: exactTextPattern(String(episode)) })
      .last();
    await option.waitFor({ state: "visible", timeout: 5_000 });
    const classes = await option.getAttribute("class") ?? "";
    if (/disabled/u.test(classes)) {
      throw new Error(`DOUYIN_DRAMA_PAID_EPISODE_DISABLED: ${episode}`);
    }
    const selected = await option.getAttribute("aria-selected") === "true"
      || /(?:^|[-_])(active|checked|selected)(?:[-_]|$)/iu.test(classes);
    if (!selected) await option.click();
  }
}

export async function fillFormItem(page: Page, label: string, value?: string | number) {
  if (value === undefined) return;
  const input = douyinFormItem(page, label).locator("input, textarea").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(String(value));
}

async function restoredFormSnapshot(page: Page) {
  const title = await page.locator("#book_name_input").first().inputValue().catch(() => "");
  const uploadedFileCount = await page.locator(".arco-upload-list-item:visible").count();
  return { title: title.trim(), uploadedFileCount };
}

export async function dismissDouyinGuideIfPresent(page: Page, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let dismissed = false;
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const mask = page.locator(".guide-popup-content-mask:visible").first();
    if (!await mask.isVisible().catch(() => false)) return dismissed;

    const guideButton = page
      .locator('[class*="guide-popup"]:visible')
      .getByRole("button", { name: /^(?:我知道了|知道了|跳过|关闭|完成)$/ })
      .filter({ visible: true })
      .last();
    const fallbackButton = page
      .getByRole("button", { name: /^(?:我知道了|知道了|跳过引导)$/ })
      .filter({ visible: true })
      .last();
    const button = await guideButton.count() > 0 ? guideButton : fallbackButton;
    if (await button.count() === 0) {
      throw new Error("DOUYIN_DRAMA_GUIDE_DISMISS_BUTTON_NOT_FOUND");
    }

    await button.click({ timeout: Math.max(1_000, deadline - Date.now()) });
    dismissed = true;
    await mask.waitFor({ state: "hidden", timeout: 1_500 }).catch(() => undefined);
  }

  if (await page.locator(".guide-popup-content-mask:visible").count() > 0) {
    throw new Error("DOUYIN_DRAMA_GUIDE_NOT_DISMISSED");
  }
  return dismissed;
}

export async function resetRestoredDouyinFormIfPresent(page: Page, timeoutMs = 8_000) {
  await dismissDouyinGuideIfPresent(page, Math.min(timeoutMs, 5_000));
  const restoredMessage = page
    .locator(".arco-message:visible, [role='alert']:visible")
    .filter({ hasText: "已同步上次填写内容" })
    .first();
  const appeared = await restoredMessage.waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    const snapshot = await restoredFormSnapshot(page);
    if (snapshot.title || snapshot.uploadedFileCount > 0) {
      throw new Error(
        `DOUYIN_DRAMA_STALE_FORM_RESET_REQUIRED: 页面存在上次填写内容但未找到重置按钮；` +
          `title=${JSON.stringify(snapshot.title)} uploads=${snapshot.uploadedFileCount}`,
      );
    }
    return false;
  }

  const resetButton = restoredMessage
    .getByRole("button", { name: "点此重置为空", exact: true })
    .first();
  await resetButton.waitFor({ state: "visible", timeout: 5_000 });
  await resetButton.click();

  const confirmDialog = page
    .locator("[role='dialog']:visible, .arco-modal:visible")
    .filter({ hasText: /重置|清空/ })
    .last();
  const needsConfirmation = await confirmDialog.waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (needsConfirmation) {
    const confirmButton = confirmDialog
      .getByRole("button", { name: /确定|确认|继续/ })
      .filter({ visible: true })
      .last();
    await confirmButton.waitFor({ state: "visible", timeout: 5_000 });
    await confirmButton.click();
    await confirmDialog.waitFor({ state: "hidden", timeout: 15_000 });
  }

  const deadline = Date.now() + 30_000;
  let blankPasses = 0;
  while (Date.now() < deadline) {
    const snapshot = await restoredFormSnapshot(page);
    const noticeHidden = !await restoredMessage.isVisible().catch(() => false);
    if (!snapshot.title && snapshot.uploadedFileCount === 0 && noticeHidden) blankPasses += 1;
    else blankPasses = 0;
    if (blankPasses >= 3) return true;
    await page.waitForTimeout(500);
  }
  const snapshot = await restoredFormSnapshot(page);
  throw new Error(
    `DOUYIN_DRAMA_STALE_FORM_RESET_NOT_CONFIRMED: ` +
      `title=${JSON.stringify(snapshot.title)} uploads=${snapshot.uploadedFileCount}`,
  );
}

export async function selectRadio(page: Page, label: string, value: string) {
  const item = douyinFormItem(page, label);
  const text = item.getByText(value, { exact: true }).filter({ visible: true }).first();
  await text.waitFor({ state: "visible", timeout: 10_000 });
  const labelRoot = text.locator("xpath=ancestor::label[1]");
  const radioRoot = text.locator("xpath=ancestor::*[contains(@class, 'radio')][1]");
  const input = (await labelRoot.count())
    ? labelRoot.locator('input[type="radio"]').first()
    : radioRoot.locator('input[type="radio"]').first();
  if ((await input.count()) && await input.isChecked().catch(() => false)) return;
  await text.click();
  if ((await input.count()) && !(await input.isChecked().catch(() => false))) {
    await input.check({ force: true });
  }
  if ((await input.count()) && !(await input.isChecked().catch(() => false))) {
    throw new Error(`DOUYIN_DRAMA_RADIO_NOT_SELECTED: ${label}=${value}`);
  }
}

export async function selectVisibleRadio(page: Page, value: string) {
  const text = page.getByText(value, { exact: true }).filter({ visible: true }).last();
  await text.waitFor({ state: "visible", timeout: 10_000 });
  await text.click();
}

function dropdownOptions(page: Page) {
  return page.locator([
    ".arco-select-popup:visible [role='option']",
    ".arco-select-popup:visible .arco-select-option",
    ".arco-select-dropdown:visible [role='option']",
    ".arco-select-dropdown:visible .arco-select-option",
    "[role='listbox']:visible [role='option']",
  ].join(", "));
}

export const DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS = 20_000;
const emptyDropdownPattern = /暂无数据|暂无选项|没有可选|无可用(?:账号|选项)|未查询到/;

function visibleDropdownSurfaces(page: Page) {
  return page.locator([
    ".arco-select-popup:visible",
    ".arco-select-dropdown:visible",
    "[role='listbox']:visible",
  ].join(", "));
}

async function closeVisibleDropdowns(page: Page, field: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await visibleDropdownSurfaces(page).count() === 0) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  throw new Error(`DOUYIN_DRAMA_DROPDOWN_NOT_CLOSED: ${field}`);
}

function compactDropdownText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

async function dropdownDisplayValues(trigger: Locator) {
  const formItem = trigger.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' arco-form-item ')][1]",
  );
  const [triggerTexts, formItemTexts, inputValues, accessibleValues] = await Promise.all([
    trigger.allTextContents().catch(() => [] as string[]),
    formItem.allTextContents().catch(() => [] as string[]),
    trigger.locator("input").evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value).filter(Boolean)
    ).catch(() => [] as string[]),
    trigger.locator("[title], [aria-label], [aria-valuetext]")
      .evaluateAll((elements) => elements.flatMap((element) => [
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("aria-valuetext"),
      ].filter((item): item is string => Boolean(item))))
      .catch(() => [] as string[]),
  ]);
  return {
    display: [...triggerTexts, ...formItemTexts, ...accessibleValues]
      .map(compactDropdownText)
      .filter(Boolean),
    inputs: inputValues.map(compactDropdownText).filter(Boolean),
  };
}

function dropdownValuesInclude(values: string[], value: string) {
  const expected = compactDropdownText(value);
  const stableToken = expected.split(" ")[0] ?? expected;
  return values.some((candidate) => candidate.includes(expected)
    || (stableToken.length >= 2 && candidate.includes(stableToken)));
}

async function confirmDropdownSelection(
  page: Page,
  trigger: Locator,
  option: Locator,
  field: string,
  value: string,
) {
  const expected = compactDropdownText(value);
  const stableToken = expected.split(" ")[0] ?? expected;
  const deadline = Date.now() + DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS;
  let closedSettledPasses = 0;
  while (Date.now() < deadline) {
    const [values, optionEvidence, visibleSurfaceCount] = await Promise.all([
      dropdownDisplayValues(trigger),
      option.evaluateAll((elements) => {
        const element = elements[0] as HTMLElement | undefined;
        if (!element) return { present: false, selected: false, visible: false };
        const input = element.querySelector<HTMLInputElement>(
          'input[type="checkbox"], input[type="radio"]',
        );
        const state = [
          element.getAttribute("aria-selected"),
          element.getAttribute("aria-checked"),
          element.className,
        ].join(" ");
        return {
          present: true,
          selected: /\btrue\b|option-selected|option-checked/u.test(state)
            || Boolean(input?.checked),
          visible: Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        };
      }).catch(() => ({ present: false, selected: false, visible: false })),
      visibleDropdownSurfaces(page).count(),
    ]);
    const dropdownClosed = visibleSurfaceCount === 0;
    if (
      dropdownValuesInclude(values.display, expected)
      || (dropdownClosed && dropdownValuesInclude(values.inputs, stableToken))
      || optionEvidence.selected
    ) return;
    const clickedOptionGone = !optionEvidence.present || !optionEvidence.visible;
    closedSettledPasses = dropdownClosed && clickedOptionGone ? closedSettledPasses + 1 : 0;
    if (closedSettledPasses >= 2) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`DOUYIN_DRAMA_DROPDOWN_SELECTION_NOT_CONFIRMED: ${field}=${value}`);
}

function dropdownEmptyError(field: string, observed: string[] = []) {
  if (field === "publishAccount") {
    return new Error(
      `DOUYIN_DRAMA_PUBLISH_ACCOUNT_OPTIONS_EMPTY: 发布账号没有可选项；` +
        `observed=${JSON.stringify(observed)}`,
    );
  }
  return new Error(`DOUYIN_DRAMA_DROPDOWN_EMPTY: ${field}; observed=${JSON.stringify(observed)}`);
}

async function waitForDropdownOptions(
  page: Page,
  options: Locator,
  field: string,
) {
  const deadline = Date.now() + DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS;
  let emptySince = 0;
  let lastObserved: string[] = [];
  while (Date.now() < deadline) {
    if (await options.count() > 0) return;
    lastObserved = (await visibleDropdownSurfaces(page).allTextContents())
      .map(compactDropdownText)
      .filter(Boolean);
    const explicitlyEmpty = lastObserved.some((value) => emptyDropdownPattern.test(value));
    if (explicitlyEmpty) {
      emptySince ||= Date.now();
      if (Date.now() - emptySince >= 600) throw dropdownEmptyError(field, lastObserved);
    } else {
      emptySince = 0;
    }
    await page.waitForTimeout(200);
  }
  throw dropdownEmptyError(field, lastObserved);
}

async function openDropdown(page: Page, trigger: Locator, field = "dropdown") {
  await closeVisibleDropdowns(page, "打开下拉前清理残留弹层");
  await trigger.waitFor({ state: "visible", timeout: DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS });
  await trigger.click();
  const options = dropdownOptions(page);
  await waitForDropdownOptions(page, options, field);
  return options;
}

async function observedOptions(options: Locator) {
  return [...new Set(
    (await options.allTextContents())
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  )];
}

async function waitForObservedDropdownOptions(
  page: Page,
  options: Locator,
  predicate: (values: string[]) => boolean,
) {
  const deadline = Date.now() + DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS;
  while (true) {
    const observed = await observedOptions(options);
    if (predicate(observed)) return observed;
    if (Date.now() >= deadline) return observed;
    await page.waitForTimeout(200);
  }
}

async function selectDropdownValuesFromTrigger(
  page: Page,
  trigger: Locator,
  field: string,
  values: string[],
  recorder: DouyinDramaDropdownRecorder,
) {
  for (const value of values) {
    const currentValues = await dropdownDisplayValues(trigger);
    if (dropdownValuesInclude([...currentValues.display, ...currentValues.inputs], value)) {
      await closeVisibleDropdowns(page, field);
      continue;
    }
    const options = await openDropdown(page, trigger);
    const option = options
      .filter({ hasText: exactTextPattern(value), visible: true })
      .first();
    const found = await option
      .waitFor({ state: "visible", timeout: DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    const observed = await observedOptions(options);
    await recorder.record(field, observed);
    if (!found) {
      throw new Error(
        `DOUYIN_DRAMA_DROPDOWN_OPTION_NOT_FOUND: ${field}=${value}; ` +
          `observed=${JSON.stringify(observed)}`,
      );
    }
    await option.click();
    await confirmDropdownSelection(page, trigger, option, field, value);
    await closeVisibleDropdowns(page, field);
  }
}

export async function selectDropdownValues(
  page: Page,
  label: string,
  values: string[],
  recorder: DouyinDramaDropdownRecorder,
) {
  if (values.length === 0) return;
  const item = douyinFormItem(page, label);
  const trigger = item.locator("[role='combobox'], .arco-select").first();
  await selectDropdownValuesFromTrigger(page, trigger, label, values, recorder);
}

export async function selectDropdownByPlaceholder(
  page: Page,
  placeholder: string,
  field: string,
  value: string,
  recorder: DouyinDramaDropdownRecorder,
) {
  const input = page.getByPlaceholder(placeholder, { exact: true }).filter({ visible: true }).first();
  const selectRoot = input.locator(
    "xpath=ancestor::*[@role='combobox' or contains(@class, 'arco-select')][1]",
  );
  const trigger = (await selectRoot.count()) ? selectRoot : input;
  await selectDropdownValuesFromTrigger(page, trigger, field, [value], recorder);
}

export async function selectRequiredDropdownByStableId(
  page: Page,
  placeholder: string,
  field: string,
  stableId: string,
  recorder: DouyinDramaDropdownRecorder,
  retryOptions: { attempts?: number; delayMs?: number; loadTimeoutMs?: number } = {},
) {
  const input = page.getByPlaceholder(placeholder, { exact: true }).filter({ visible: true }).first();
  const selectRoot = input.locator(
    "xpath=ancestor::*[@role='combobox' or contains(@class, 'arco-select')][1]",
  );
  const trigger = (await selectRoot.count()) ? selectRoot : input;
  const currentValues = await dropdownDisplayValues(trigger);
  if (dropdownValuesInclude([...currentValues.display, ...currentValues.inputs], stableId)) {
    await closeVisibleDropdowns(page, field);
    return currentValues.display.find((value) => value.includes(stableId)) ?? stableId;
  }

  const attempts = Math.max(1, retryOptions.attempts ?? 2);
  const delayMs = Math.max(0, retryOptions.delayMs ?? 1_500);
  const loadTimeoutMs = Math.max(1, retryOptions.loadTimeoutMs ?? DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS);
  const stableIdPattern = new RegExp(
    `^\\s*${stableId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`,
  );
  let lastObserved: string[] = [];
  let requestedContract = stableId;
  let availableContracts: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const options = await openDropdown(page, trigger);
    const option = options.filter({ hasText: stableIdPattern, visible: true }).first();
    const found = await option
      .waitFor({ state: "visible", timeout: loadTimeoutMs })
      .then(() => true)
      .catch(() => false);
    lastObserved = await observedOptions(options);
    await recorder.record(field, lastObserved);
    if (!found) {
      // Cleanup must not replace the confirmed contract failure.
      await closeVisibleDropdowns(page, field).catch(() => undefined);
      throw new Error(
        `DOUYIN_DRAMA_REQUIRED_CONTRACT_NOT_FOUND: contractId=${stableId}; ` +
          `observed=${JSON.stringify(lastObserved)}`,
      );
    }

    requestedContract = compactDropdownText(await option.textContent()) || stableId;
    const disabled = await option.evaluate((element) =>
      element.getAttribute("aria-disabled") === "true"
        || element.classList.contains("arco-select-option-disabled")
    );
    if (!disabled) {
      await option.click();
      await confirmDropdownSelection(page, trigger, option, field, stableId);
      await closeVisibleDropdowns(page, field);
      return requestedContract;
    }

    availableContracts = await options.evaluateAll((elements) => elements
      .filter((element) => (
        element.getAttribute("aria-disabled") !== "true"
        && !element.classList.contains("arco-select-option-disabled")
      ))
      .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean));
    const closed = await closeVisibleDropdowns(page, field)
      .then(() => true, () => false);
    if (!closed) break;
    if (attempt < attempts && delayMs > 0) await page.waitForTimeout(delayMs);
  }

  throw new Error(
    `DOUYIN_DRAMA_REQUIRED_CONTRACT_DISABLED: contractId=${stableId}; `
      + `requested=${JSON.stringify(requestedContract)}; `
      + `available=${JSON.stringify([...new Set(availableContracts)])}; `
      + `observed=${JSON.stringify(lastObserved)}`,
  );
}

function contractNameWithoutId(value: string) {
  return compactDropdownText(value).replace(/^CT\d+\s*/u, "");
}

export async function selectRequiredDropdownByContractName(
  page: Page,
  placeholder: string,
  field: string,
  contractName: string,
  recorder: DouyinDramaDropdownRecorder,
) {
  const expectedName = contractNameWithoutId(contractName);
  const input = page.getByPlaceholder(placeholder, { exact: true }).filter({ visible: true }).first();
  const selectRoot = input.locator(
    "xpath=ancestor::*[@role='combobox' or contains(@class, 'arco-select')][1]",
  );
  const trigger = (await selectRoot.count()) ? selectRoot : input;
  const currentValues = await dropdownDisplayValues(trigger);
  if (
    [...currentValues.display, ...currentValues.inputs]
      .some((value) => contractNameWithoutId(value) === expectedName)
  ) {
    await closeVisibleDropdowns(page, field);
    return expectedName;
  }

  const options = await openDropdown(page, trigger);
  const observed = await waitForObservedDropdownOptions(
    page,
    options,
    (values) => values.some((value) => contractNameWithoutId(value) === expectedName),
  );
  await recorder.record(field, observed);
  const candidates = await options.evaluateAll((elements, expected) =>
    elements.map((element, index) => {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const normalizedName = text.replace(/^CT\d+\s*/u, "");
      return {
        index,
        text,
        matches: normalizedName === expected,
        disabled: element.getAttribute("aria-disabled") === "true"
          || element.classList.contains("arco-select-option-disabled"),
      };
    }), expectedName);
  const candidate = candidates.find((item) => item.matches && !item.disabled);
  if (!candidate) {
    const matchingDisabled = candidates.some((item) => item.matches && item.disabled);
    throw new Error(
      `${matchingDisabled
        ? "DOUYIN_DRAMA_REQUIRED_CONTRACT_DISABLED"
        : "DOUYIN_DRAMA_REQUIRED_CONTRACT_NOT_FOUND"}: contractName=${expectedName}; ` +
        `observed=${JSON.stringify(observed)}`,
    );
  }
  const option = options.nth(candidate.index);
  await option.click();
  await confirmDropdownSelection(page, trigger, option, field, candidate.text);
  await closeVisibleDropdowns(page, field);
  return candidate.text;
}

export async function selectSearchableDropdownByPlaceholder(
  page: Page,
  placeholder: string,
  field: string,
  value: string,
  recorder: DouyinDramaDropdownRecorder,
) {
  const input = page.getByPlaceholder(placeholder, { exact: true }).filter({ visible: true }).first();
  const selectRoot = input.locator(
    "xpath=ancestor::*[@role='combobox' or contains(@class, 'arco-select')][1]",
  );
  const trigger = await selectRoot.count() ? selectRoot : input;
  await closeVisibleDropdowns(page, field);
  await input.waitFor({ state: "visible", timeout: 10_000 });
  const currentValues = await dropdownDisplayValues(trigger);
  if (dropdownValuesInclude([...currentValues.display, ...currentValues.inputs], value)) return;
  await input.click();
  await input.fill(value);
  const options = dropdownOptions(page);
  await waitForDropdownOptions(page, options, field);
  const expected = compactDropdownText(value);
  const observed = await waitForObservedDropdownOptions(
    page,
    options,
    (values) => values.some((candidate) => compactDropdownText(candidate) === expected)
      || values.some((candidate) => compactDropdownText(candidate).includes(expected))
      || values.some((candidate) => emptyDropdownPattern.test(candidate)),
  );
  await recorder.record(field, observed);
  if (observed.every((candidate) => emptyDropdownPattern.test(compactDropdownText(candidate)))) {
    throw dropdownEmptyError(field, observed);
  }
  const matchedOptionText = observed.find((candidate) => compactDropdownText(candidate) === expected)
    ?? observed.find((candidate) => compactDropdownText(candidate).includes(expected));
  if (!matchedOptionText) {
    throw new Error(
      `DOUYIN_DRAMA_DROPDOWN_OPTION_NOT_FOUND: ${field}=${value}; ` +
        `observed=${JSON.stringify(observed)}`,
    );
  }
  const option = options.filter({
    hasText: exactTextPattern(matchedOptionText),
    visible: true,
  }).first();
  await option.waitFor({ state: "visible", timeout: DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS });
  await option.click();
  await confirmDropdownSelection(page, trigger, option, field, value);
  await closeVisibleDropdowns(page, field);
}

export async function selectFirstDropdownByPlaceholder(
  page: Page,
  placeholder: string,
  field: string,
  recorder: DouyinDramaDropdownRecorder,
) {
  const input = page.getByPlaceholder(placeholder, { exact: true }).filter({ visible: true }).first();
  const selectRoot = input.locator(
    "xpath=ancestor::*[@role='combobox' or contains(@class, 'arco-select')][1]",
  );
  const trigger = (await selectRoot.count()) ? selectRoot : input;
  const options = await openDropdown(page, trigger, field);
  const observed = await waitForObservedDropdownOptions(
    page,
    options,
    (values) => values.some((value) => !/请选择|暂无|无数据|加载中|正在加载/.test(value))
      || values.some((value) => emptyDropdownPattern.test(value)),
  );
  await recorder.record(field, observed);
  const selected = observed.find((value) => !/请选择|暂无|无数据|加载中|正在加载/.test(value));
  if (!selected) {
    throw dropdownEmptyError(field, observed);
  }
  const option = options.filter({ hasText: exactTextPattern(selected), visible: true }).first();
  await option.click();
  await confirmDropdownSelection(page, trigger, option, field, selected);
  await closeVisibleDropdowns(page, field);
  return selected;
}

async function waitForUploadSettlement(
  page: Page,
  item: Locator,
  label: string,
  timeoutMs = 120_000,
  expectedFileCount = 1,
  expectedFiles: string[] = [],
) {
  const deadline = Date.now() + timeoutMs;
  const stalledAt100TimeoutMs = Math.min(15_000, Math.max(750, Math.floor(timeoutMs / 4)));
  let stablePasses = 0;
  let stalledAt100Since = 0;
  let stalledAt100Signature = "";
  let lastObservedFileNames: string[] = [];
  let lastObservedStatuses: string[] = [];
  let lastObservedFileCount = 0;
  let lastCompletedFileCount = 0;
  let lastBoundValueCount = 0;
  let lastExpectedGlobalFileCount = 0;
  const expectedFileNames = expectedFiles.map((file) => path.basename(file));
  while (Date.now() < deadline) {
    await assertNoDouyinFormError(page, `上传${label}`);
    const transientUploadMessages = page.locator([
      ".arco-form-message:visible",
      ".arco-message:visible",
      "[role='alert']:visible",
    ].join(", ")).filter({ hasText: /资源上传中请等待|上传中.*请等待|正在上传/ });
    const uploadLists = item.locator(".arco-upload-list");
    const cloudUploadItems = item.locator(".uploaded_list_item");
    const [
      itemText,
      transientMessageCount,
      localBusyCount,
      uploadListCount,
      cloudUploadItemCount,
      cloudCompletedCount,
      arcoUploadItemCount,
      observedFileNames,
      observedStatuses,
      boundValues,
    ] = await Promise.all([
      item.innerText().catch(() => ""),
      transientUploadMessages.count(),
      item.locator(
        "[role='progressbar'], .arco-progress, .arco-upload-list-item-uploading, [class*='uploading']",
      ).count(),
      uploadLists.count(),
      cloudUploadItems.count(),
      item.locator(".uploaded_list_item:has(.file-status-text-success)").count(),
      item.locator(".arco-upload-list-item").count(),
      item.locator(".uploaded_list_item .file-name").allTextContents(),
      item.locator(".uploaded_list_item .file-status-text").allTextContents(),
      item.locator("input:not([type='file']), textarea").evaluateAll((elements) =>
        elements
          .map((element) => (element as HTMLInputElement).value?.trim() ?? "")
          .filter(Boolean)),
    ]);
    const text = itemText.replace(/\s+/g, " ").trim();
    lastObservedFileNames = observedFileNames.map((value) => value.trim()).filter(Boolean);
    lastObservedStatuses = observedStatuses
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    lastBoundValueCount = boundValues.length;
    let expectedGlobalFileCount = 0;
    let expectedGlobalCompletedCount = 0;
    if (expectedFileNames.length > 0) {
      const globalUploadItems = page.locator(".uploaded_list_item, .arco-upload-list-item");
      for (const fileName of expectedFileNames) {
        const matching = globalUploadItems.filter({
          has: page.locator(".file-name, [title]").filter({ hasText: exactTextPattern(fileName) }),
        });
        if (await matching.count() === 0) continue;
        expectedGlobalFileCount += 1;
        const matchingText = (await matching.first().innerText().catch(() => ""))
          .replace(/\s+/gu, " ")
          .trim();
        const matchingBusy = /上传中|处理中|等待上传|解析中|进度/u.test(matchingText)
          || await matching.first().locator(
            "[role='progressbar'], .arco-progress, .arco-upload-list-item-uploading, [class*='uploading']",
          ).count() > 0;
        const matchingFailed = /上传失败|处理失败|转码失败|上传异常/u.test(matchingText)
          || await matching.first().locator(".file-status-text-error, .arco-upload-list-item-error").count() > 0;
        if (!matchingBusy && !matchingFailed) expectedGlobalCompletedCount += 1;
      }
    }
    lastExpectedGlobalFileCount = expectedGlobalFileCount;
    lastObservedFileCount = Math.max(
      cloudUploadItemCount || arcoUploadItemCount,
      expectedGlobalFileCount,
      boundValues.length,
    );
    lastCompletedFileCount = cloudUploadItemCount > 0
      ? cloudCompletedCount
      : arcoUploadItemCount;
    lastCompletedFileCount = Math.max(
      lastCompletedFileCount,
      expectedGlobalCompletedCount,
      boundValues.length,
    );
    const stalledAt100Indices = lastObservedStatuses
      .map((status, index) => (/上传中\s*100\s*%/u.test(status) ? index : -1))
      .filter((index) => index >= 0);
    const stalledAt100CompleteSet = cloudUploadItemCount >= expectedFileCount
      && cloudCompletedCount + stalledAt100Indices.length >= expectedFileCount
      && stalledAt100Indices.length > 0;
    if (stalledAt100CompleteSet) {
      const signature = stalledAt100Indices.join(",");
      if (signature !== stalledAt100Signature) {
        stalledAt100Signature = signature;
        stalledAt100Since = Date.now();
      } else if (Date.now() - stalledAt100Since >= stalledAt100TimeoutMs) {
        throw new DouyinUploadStalledAt100Error({
          completedFileCount: cloudCompletedCount,
          expectedFileCount,
          fileNames: lastObservedFileNames,
          label,
          stalledIndices: stalledAt100Indices,
          statuses: lastObservedStatuses,
        });
      }
    } else {
      stalledAt100Signature = "";
      stalledAt100Since = 0;
    }
    const explicitSuccess = lastCompletedFileCount >= expectedFileCount;
    const localBusy = /上传中|处理中|等待上传|解析中|进度/.test(text) || localBusyCount > 0;
    // Arco's global toast can outlive the upload that created it. Once this
    // field shows the expected successful file count, that stale toast must
    // not keep every following upload waiting for seconds (or until timeout).
    const busy = localBusy || (!explicitSuccess && transientMessageCount > 0);
    const uploadResultVisible = uploadListCount === 0 ||
      lastCompletedFileCount >= expectedFileCount;
    if (!busy && uploadResultVisible) stablePasses += 1;
    else stablePasses = 0;
    if (stablePasses >= 2) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `DOUYIN_DRAMA_UPLOAD_NOT_CONFIRMED: ${label}; expected=${expectedFileCount}; ` +
      `actual=${lastObservedFileCount}; completed=${lastCompletedFileCount}; ` +
      `files=${JSON.stringify(lastObservedFileNames)}; statuses=${JSON.stringify(lastObservedStatuses)}; ` +
      `boundValues=${lastBoundValueCount}; matchedGlobalFiles=${lastExpectedGlobalFileCount}`,
  );
}

class DouyinUploadStalledAt100Error extends Error {
  readonly stalledIndices: number[];

  constructor(details: {
    completedFileCount: number;
    expectedFileCount: number;
    fileNames: string[];
    label: string;
    stalledIndices: number[];
    statuses: string[];
  }) {
    super(
      `DOUYIN_DRAMA_UPLOAD_STALLED_AT_100: ${details.label}; expected=${details.expectedFileCount}; `
        + `completed=${details.completedFileCount}; stalled=${JSON.stringify(details.stalledIndices)}; `
        + `files=${JSON.stringify(details.fileNames)}; statuses=${JSON.stringify(details.statuses)}`,
    );
    this.name = "DouyinUploadStalledAt100Error";
    this.stalledIndices = details.stalledIndices;
  }
}

async function chooseCloudUploadFiles(
  page: Page,
  control: Locator,
  label: string,
  files: string[],
  timeoutMs: number,
) {
  const trigger = control.locator(".file-picker-box:visible").first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  const chooserTimeoutMs = Math.min(timeoutMs, 15_000);
  const item = control.locator("xpath=ancestor::*[contains(@class, 'arco-form-item')][1]");
  const openChooser = () => Promise.all([
    page.waitForEvent("filechooser", { timeout: chooserTimeoutMs }),
    trigger.click({ timeout: chooserTimeoutMs }),
  ]).then(([chooser]) => chooser).catch((error: unknown) => {
    throw new Error(
      `DOUYIN_DRAMA_FILE_CHOOSER_NOT_OPENED: ${label}; ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const firstChooser = await openChooser();
  if (files.length <= 1 || firstChooser.isMultiple()) {
    await firstChooser.setFiles(files, { timeout: timeoutMs });
    return;
  }

  // Some cloud upload components support multiple list entries but expose a
  // single-file chooser. Add every converted PDF page through a fresh chooser.
  for (const [index, file] of files.entries()) {
    const beforeCount = await item.locator(".uploaded_list_item, .arco-upload-list-item").count();
    const chooser = index === 0 ? firstChooser : await openChooser();
    await chooser.setFiles([file], { timeout: timeoutMs });
    const deadline = Date.now() + Math.min(timeoutMs, 15_000);
    while (Date.now() < deadline) {
      const currentCount = await item.locator(".uploaded_list_item, .arco-upload-list-item").count();
      if (currentCount > beforeCount) break;
      await page.waitForTimeout(100);
    }
    const currentCount = await item.locator(".uploaded_list_item, .arco-upload-list-item").count();
    if (currentCount <= beforeCount) {
      throw new Error(
        `DOUYIN_DRAMA_UPLOAD_FILE_NOT_ADDED: ${label}; file=${JSON.stringify(path.basename(file))}`,
      );
    }
  }
}

async function deleteStalledCloudUploadItems(
  page: Page,
  item: Locator,
  label: string,
  stalledIndices: number[],
) {
  for (const index of [...stalledIndices].sort((left, right) => right - left)) {
    const beforeCount = await item.locator(".uploaded_list_item").count();
    const uploadItem = item.locator(".uploaded_list_item").nth(index);
    const deleteButton = uploadItem
      .locator("button:has(.serial-icon-general_delete), .uploaded_list_item-ops button")
      .filter({ visible: true })
      .first();
    await deleteButton.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`DOUYIN_DRAMA_UPLOAD_STALLED_DELETE_NOT_FOUND: ${label}; index=${index}`);
    });
    await deleteButton.click();
    const dialog = page
      .locator("[role='dialog']:visible, .arco-modal:visible")
      .filter({ hasText: /删除图片后不可恢复|删除图片/u })
      .last();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const confirm = dialog.getByRole("button", { name: "确定", exact: true }).last();
    await confirm.click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const deleteDeadline = Date.now() + 10_000;
    while (Date.now() < deleteDeadline) {
      if (await item.locator(".uploaded_list_item").count() < beforeCount) break;
      await page.waitForTimeout(100);
    }
    if (await item.locator(".uploaded_list_item").count() >= beforeCount) {
      throw new Error(`DOUYIN_DRAMA_UPLOAD_STALLED_DELETE_NOT_CONFIRMED: ${label}; index=${index}`);
    }
  }
}

async function confirmImageCropDialogIfPresent(page: Page, label: string) {
  const cropDialog = page
    .locator("[role='dialog']:visible, .arco-modal:visible")
    .filter({ hasText: /裁剪|调整封面|编辑图片/ })
    .last();
  const appeared = await cropDialog.waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  const confirm = cropDialog
    .getByRole("button", { name: /确定|完成|保存/ })
    .filter({ visible: true })
    .last();
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  await confirm.click();
  await cropDialog.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {
    throw new Error(`DOUYIN_DRAMA_COVER_CROP_NOT_CONFIRMED: ${label}`);
  });
}

export async function readDouyinUploadPdfPageCount(file: string) {
  const document = await PDFDocument.load(await readFile(file), { ignoreEncryption: true });
  const pageCount = document.getPageCount();
  if (pageCount < 1) {
    throw new Error(`DOUYIN_DRAMA_PDF_EMPTY: file=${file}`);
  }
  return pageCount;
}

let pdfConverterPromise: Promise<typeof import("pdf-to-img")> | undefined;
const requireBuiltinModule = createRequire(import.meta.url);

function installPdfRuntimeGlobals() {
  const runtime = globalThis as unknown as Record<string, unknown>;
  const runtimeProcess = process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
  };
  runtimeProcess.getBuiltinModule ??= (id) => requireBuiltinModule(id);
  runtime.DOMMatrix ??= DOMMatrix;
  runtime.DOMPoint ??= DOMPoint;
  runtime.DOMRect ??= DOMRect;
  runtime.ImageData ??= ImageData;
  runtime.Path2D ??= Path2D;
}

async function loadPdfConverter() {
  installPdfRuntimeGlobals();
  pdfConverterPromise ??= import("pdf-to-img");
  return pdfConverterPromise;
}

async function renderPdfPagesForImageUpload(
  label: string,
  file: string,
  maximumPages?: number,
) {
  const sourceStat = await stat(file);
  const pageCount = await readDouyinUploadPdfPageCount(file);
  const renderedPageCount = Math.min(pageCount, maximumPages ?? pageCount);
  const outputPrefix = path.join(
    path.dirname(file),
    `${path.basename(file, path.extname(file))}-upload-v3`,
  );
  const outputs = Array.from(
    { length: renderedPageCount },
    (_, index) => `${outputPrefix}-page-${index + 1}.jpg`,
  );
  const outputStats = await Promise.all(outputs.map((output) => stat(output).catch(() => undefined)));
  if (outputStats.every((outputStat) =>
    outputStat?.isFile() && outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs)) {
    return outputs;
  }

  try {
    const { pdf } = await loadPdfConverter();
    const document = await pdf(file, { scale: 2 });
    for (let pageIndex = 0; pageIndex < renderedPageCount; pageIndex += 1) {
      const output = outputs[pageIndex]!;
      const cached = outputStats[pageIndex];
      if (cached?.isFile() && cached.size > 0 && cached.mtimeMs >= sourceStat.mtimeMs) continue;
      const renderedPage = await document.getPage(pageIndex + 1);
      await sharp(renderedPage)
        .flatten({ background: "white" })
        .jpeg({ quality: 94, mozjpeg: true })
        .toFile(output);
    }
  } catch (error) {
    throw Object.assign(new Error(
      `DOUYIN_DRAMA_PDF_IMAGE_CONVERSION_FAILED: ${label}; file=${file}; ` +
        `${error instanceof Error ? error.message : String(error)}`,
    ), { cause: error });
  }
  for (const output of outputs) {
    const converted = await stat(output).catch(() => undefined);
    if (!converted?.isFile() || converted.size <= 0 || converted.size > 10 * 1024 * 1024) {
      throw new Error(
        `DOUYIN_DRAMA_CONVERTED_IMAGE_INVALID: ${label}; file=${output}; size=${converted?.size ?? 0}`,
      );
    }
  }
  return outputs;
}

async function mergePdfPagesForSingleImageUpload(
  label: string,
  pdfFile: string,
  pageImages: string[],
) {
  if (pageImages.length === 1) return pageImages[0]!;
  const sourceStat = await stat(pdfFile);
  const output = path.join(
    path.dirname(pdfFile),
    `${path.basename(pdfFile, path.extname(pdfFile))}-upload-v4-all-pages.jpg`,
  );
  const cached = await stat(output).catch(() => undefined);
  if (cached?.isFile() && cached.size > 0 && cached.mtimeMs >= sourceStat.mtimeMs) return output;

  try {
    const metadata = await Promise.all(pageImages.map((image) => sharp(image).metadata()));
    const width = Math.max(...metadata.map((item) => item.width ?? 0));
    const height = metadata.reduce((total, item) => total + (item.height ?? 0), 0);
    if (width <= 0 || height <= 0) {
      throw new Error(`invalid merged dimensions: width=${width}; height=${height}`);
    }
    let top = 0;
    const layers = pageImages.map((image, index) => {
      const layer = { input: image, left: 0, top };
      top += metadata[index]?.height ?? 0;
      return layer;
    });
    await sharp({
      create: { width, height, channels: 3, background: "white" },
      limitInputPixels: false,
    })
      .composite(layers)
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(output);
  } catch (error) {
    throw Object.assign(new Error(
      `DOUYIN_DRAMA_PDF_PAGE_MERGE_FAILED: ${label}; file=${pdfFile}; ` +
        `${error instanceof Error ? error.message : String(error)}`,
    ), { cause: error });
  }
  const converted = await stat(output).catch(() => undefined);
  if (!converted?.isFile() || converted.size <= 0 || converted.size > 10 * 1024 * 1024) {
    throw new Error(
      `DOUYIN_DRAMA_CONVERTED_IMAGE_INVALID: ${label}; file=${output}; size=${converted?.size ?? 0}`,
    );
  }
  return output;
}

async function prepareUploadFiles(label: string, files: string[]) {
  if (label !== "成本配置情况" && label !== "不侵权承诺函") return files;
  const sourceFiles = label === "成本配置情况" ? files.slice(0, 1) : files;
  const prepared = await Promise.all(sourceFiles.map(async (file) => {
    if (path.extname(file).toLowerCase() !== ".pdf") return [file];
    const pages = await renderPdfPagesForImageUpload(
      label,
      file,
      label === "成本配置情况" ? 1 : undefined,
    );
    if (label === "成本配置情况") return pages;
    return [await mergePdfPagesForSingleImageUpload(label, file, pages)];
  }));
  return prepared.flat();
}

export async function uploadFormFiles(
  page: Page,
  label: string,
  files: string[],
  timeoutMs = 120_000,
  controlId?: string,
) {
  if (files.length === 0) return;
  const preparedFiles = await prepareUploadFiles(label, files);
  const control = controlId
    ? page.locator(`#${controlId}`).first()
    : undefined;
  if (control) await control.waitFor({ state: "attached", timeout: 10_000 });
  const item = control
    ? control.locator("xpath=ancestor::*[contains(@class, 'arco-form-item')][1]")
    : douyinFormItem(page, label);
  if (!control) {
    const visible = await item.waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) throw new Error(`DOUYIN_DRAMA_UPLOAD_CONTROL_NOT_FOUND: ${label}`);
  }
  if (control) {
    // NovelCloudFileUploadItem renders multiple hidden inputs. Assigning files
    // to either input directly does not reliably enter its cloud-upload queue.
    // Drive the visible drop zone and use the chooser opened by the component,
    // which is the same path as a user selecting files in the browser dialog.
    await chooseCloudUploadFiles(page, control, label, preparedFiles, timeoutMs);
  } else {
    const input = item.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 10_000 });
    await input.setInputFiles(preparedFiles, { timeout: timeoutMs });
  }
  if (/封面/.test(label)) await confirmImageCropDialogIfPresent(page, label);
  try {
    await waitForUploadSettlement(
      page,
      item,
      label,
      timeoutMs,
      preparedFiles.length,
      preparedFiles,
    );
  } catch (error) {
    if (!control || !(error instanceof DouyinUploadStalledAt100Error)) throw error;

    const retryFiles = error.stalledIndices.map((index) => preparedFiles[index]).filter(Boolean);
    if (retryFiles.length !== error.stalledIndices.length) throw error;
    await deleteStalledCloudUploadItems(page, item, label, error.stalledIndices);

    let expectedCompletedCount = await item
      .locator(".uploaded_list_item:has(.file-status-text-success)")
      .count();
    for (const retryFile of retryFiles) {
      let lastError: unknown = error;
      let recovered = false;
      for (let retryAttempt = 1; retryAttempt <= 5; retryAttempt += 1) {
        await chooseCloudUploadFiles(page, control, label, [retryFile], timeoutMs);
        try {
          await waitForUploadSettlement(
            page,
            item,
            label,
            timeoutMs,
            expectedCompletedCount + 1,
            preparedFiles,
          );
          expectedCompletedCount += 1;
          recovered = true;
          break;
        } catch (retryError) {
          lastError = retryError;
          if (!(retryError instanceof DouyinUploadStalledAt100Error)) throw retryError;
          await deleteStalledCloudUploadItems(page, item, label, retryError.stalledIndices);
        }
      }
      if (!recovered) {
        throw Object.assign(new Error(
          `DOUYIN_DRAMA_UPLOAD_NOT_CONFIRMED: ${label}; stalledAt100Retries=5; `
            + `file=${JSON.stringify(retryFile)}; lastError=${lastError instanceof Error ? lastError.message : String(lastError)}`,
        ), { cause: lastError });
      }
    }
    await waitForUploadSettlement(
      page,
      item,
      label,
      timeoutMs,
      preparedFiles.length,
      preparedFiles,
    );
  }
}

export function hasInvalidDouyinEpisodeDuration(text: string) {
  const matched = text.match(/时长[：:]\s*(\d{1,2}):(\d{2}):(\d{2})/u);
  if (!matched) return false;
  const minutes = Number(matched[2]);
  const seconds = Number(matched[3]);
  // Douyin occasionally renders an exact minute as 00:00:60. Treat that as a
  // valid 60-second duration instead of deleting an otherwise successful upload.
  return minutes >= 60 || seconds > 60;
}

export function hasTooShortDouyinEpisodeDuration(text: string) {
  const matched = text.match(/时长[：:]\s*(\d{1,2}):(\d{2}):(\d{2})/u);
  if (!matched || hasInvalidDouyinEpisodeDuration(text)) return false;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  const seconds = Number(matched[3]);
  return hours * 3_600 + minutes * 60 + seconds < 30;
}

export async function reuploadFailedDouyinEpisodeAfterDelete(
  panel: Locator,
  uploadInput: Locator,
  sourceFiles: string[],
  maximumReuploadAttempts: number,
  reuploadAttemptsByFile: Map<string, number>,
) {
  const failedItems = panel.locator(".uploaded_list_item");
  for (let index = 0; index < await failedItems.count(); index += 1) {
    const item = failedItems.nth(index);
    const itemText = await item.innerText().catch(() => "");
    const failed = await item
      .locator(".file-status-text-error")
      .filter({ hasText: /上传失败|处理失败|转码失败|上传异常/u })
      .count() > 0;
    const invalidDuration = hasInvalidDouyinEpisodeDuration(itemText);
    const tooShort = hasTooShortDouyinEpisodeDuration(itemText);
    if (!failed && !invalidDuration && !tooShort) continue;

    const fileName = (await item.locator(".file-name").first().textContent().catch(() => ""))
      ?.replace(/\s+/gu, " ")
      .trim() || `第${index + 1}个视频`;
    if (tooShort) {
      const duration = itemText.match(/时长[：:]\s*(\d{1,2}:\d{2}:\d{2})/u)?.[1] ?? "未知";
      throw new Error(
        `DOUYIN_DRAMA_EPISODE_DURATION_TOO_SHORT: file=${JSON.stringify(fileName)}; ` +
          `duration=${duration}; minimumSeconds=30`,
      );
    }
    const sourceFile = sourceFiles.find((file) => path.basename(file) === fileName)
      ?? sourceFiles[index];
    if (!sourceFile) {
      throw new Error(
        `DOUYIN_DRAMA_EPISODE_UPLOAD_REUPLOAD_SOURCE_NOT_FOUND: ` +
          `file=${JSON.stringify(fileName)}; index=${index}`,
      );
    }
    const completedAttempts = reuploadAttemptsByFile.get(fileName) ?? 0;
    if (completedAttempts >= maximumReuploadAttempts) {
      throw new Error(
        `DOUYIN_DRAMA_EPISODE_UPLOAD_REUPLOADS_EXHAUSTED: file=${JSON.stringify(fileName)}; ` +
          `reuploadAttempts=${completedAttempts}; maximum=${maximumReuploadAttempts}`,
      );
    }

    const deleteButton = item
      .locator(".uploaded_list_item-ops button:has(.serial-icon-general_delete)")
      .filter({ visible: true })
      .first();
    await deleteButton.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {
      throw new Error(
        `DOUYIN_DRAMA_EPISODE_UPLOAD_DELETE_BUTTON_NOT_FOUND: file=${JSON.stringify(fileName)}`,
      );
    });
    const page = panel.page();
    await deleteButton.click();
    const confirmDialog = page.locator(".arco-modal:visible, [role='dialog']:visible")
      .filter({ hasText: /删除|移除/u })
      .last();
    if (await confirmDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await confirmDialog
        .getByRole("button", { name: /确定|确认|删除|移除/u })
        .filter({ visible: true })
        .last()
        .click();
    }
    const deletedItem = panel.locator(".uploaded_list_item").filter({
      has: panel.locator(".file-name").filter({ hasText: exactTextPattern(fileName) }),
    });
    await deletedItem.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {
      throw new Error(
        `DOUYIN_DRAMA_EPISODE_UPLOAD_DELETE_NOT_CONFIRMED: file=${JSON.stringify(fileName)}`,
      );
    });
    await uploadInput.setInputFiles([sourceFile], { timeout: 120_000 });
    const attempt = completedAttempts + 1;
    reuploadAttemptsByFile.set(fileName, attempt);
    return [{ attempt, fileName }];
  }
  return [];
}

export async function fillDouyinEpisodeBatchEdit(
  page: Page,
  options: {
    coverFile: string;
    episodeCount: number;
    title: string;
  },
) {
  if (!Number.isSafeInteger(options.episodeCount) || options.episodeCount < 1) {
    throw new Error(`DOUYIN_DRAMA_BATCH_EDIT_EPISODE_COUNT_INVALID: ${options.episodeCount}`);
  }
  if (!options.coverFile.trim()) throw new Error("DOUYIN_DRAMA_BATCH_EDIT_COVER_REQUIRED");

  const batchEditButton = page
    .locator(".header-right-opt-btn:visible")
    .filter({ hasText: exactTextPattern("批量编辑") })
    .last();
  await batchEditButton.waitFor({ state: "visible", timeout: 15_000 });
  await batchEditButton.click();

  const drawer = page
    .locator(".arco-drawer-inner:visible")
    .filter({ has: page.getByText("批量编辑", { exact: true }) })
    .last();
  await drawer.waitFor({ state: "visible", timeout: 15_000 });

  const startInput = drawer.locator("#item_start_input").first();
  const endInput = drawer.locator("#item_end_input").first();
  const titleInput = drawer.locator("#item_title_input").first();
  await startInput.fill("1");
  await endInput.fill(String(options.episodeCount));
  await titleInput.fill(options.title);
  await titleInput.blur();

  await selectDouyinVideoTopics(page, drawer);

  const sameCover = drawer.locator("label").filter({
    hasText: exactTextPattern("相同封面"),
  }).first();
  const sameCoverRadio = sameCover.locator('input[type="radio"]').first();
  if (!await sameCoverRadio.isChecked()) await sameCover.click();

  const coverControl = drawer.locator("#thumb_url_input").first();
  const coverInput = coverControl.locator('input[type="file"]').first();
  await coverInput.waitFor({ state: "attached", timeout: 10_000 });
  await coverInput.setInputFiles(options.coverFile, { timeout: 120_000 });
  await confirmImageCropDialogIfPresent(page, "批量编辑视频封面");
  const coverItem = coverControl.locator("xpath=ancestor::*[contains(@class, 'arco-form-item')][1]");
  await coverItem
    .locator(".arco-upload-list-item, .uploaded_list_item")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await waitForUploadSettlement(page, coverItem, "批量编辑视频封面", 120_000, 1);

  await assertNoDouyinFormError(page, "批量编辑剧集");
  const confirm = drawer.getByRole("button", { name: "确认", exact: true }).last();
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  await confirm.click();
  await drawer.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {
    throw new Error("DOUYIN_DRAMA_BATCH_EDIT_NOT_CONFIRMED");
  });
  await assertNoDouyinFormError(page, "确认批量编辑剧集");
}

export async function fillDouyinSeriesDialog(
  page: Page,
  data: { coverFile: string; summary: string; title: string },
) {
  const dialog = page
    .locator(".series-add-modal:visible, [role='dialog']:visible, .arco-modal:visible")
    .filter({ has: page.getByText("添加系列剧信息", { exact: true }) })
    .last();
  const dialogAlreadyOpen = await dialog.waitFor({ state: "visible", timeout: 1_000 })
    .then(() => true)
    .catch(() => false);
  if (!dialogAlreadyOpen) {
    const addButton = page
      .getByRole("button", { name: "点击添加系列剧信息", exact: true })
      .filter({ visible: true })
      .first();
    await addButton.waitFor({ state: "visible", timeout: 30_000 });
    await addButton.click();
  }
  await dialog.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error("DOUYIN_DRAMA_SERIES_DIALOG_NOT_OPENED");
  });

  const seriesName = dialog.locator([
    "#series_drama_book_name_input",
    "#series_drama_book_name input:not([disabled])",
    "input[placeholder='请输入系列剧名']:not([disabled])",
  ].join(", ")).filter({ visible: true }).first();
  const summary = dialog.locator([
    "#series_abstract_input",
    "#series_abstract textarea:not([disabled])",
    "textarea[placeholder='请输入系列剧简介']:not([disabled])",
  ].join(", ")).filter({ visible: true }).first();
  const coverControl = dialog.locator("#series_drama_thumb_url_input").first();
  const coverInput = coverControl.locator('input[type="file"]').first();
  const typeRadio = dialog.locator("#series_drama_type input[type='radio'][value='1']").first();
  await Promise.all([
    seriesName.waitFor({ state: "visible", timeout: 30_000 }),
    summary.waitFor({ state: "visible", timeout: 30_000 }),
    coverInput.waitFor({ state: "attached", timeout: 30_000 }),
    typeRadio.waitFor({ state: "attached", timeout: 30_000 }),
  ]).catch(() => {
    throw new Error("DOUYIN_DRAMA_SERIES_DIALOG_FIELDS_NOT_READY");
  });

  const fillStableValue = async (input: Locator, expected: string, errorCode: string) => {
    const deadline = Date.now() + 30_000;
    let stablePasses = 0;
    while (Date.now() < deadline) {
      if (await input.isEnabled().catch(() => false)) {
        if (await input.inputValue().catch(() => "") !== expected) {
          await input.fill(expected).catch(() => undefined);
        }
        await page.waitForTimeout(300);
        if (await input.inputValue().catch(() => "") === expected) stablePasses += 1;
        else stablePasses = 0;
        if (stablePasses >= 2) return;
      } else {
        stablePasses = 0;
        await page.waitForTimeout(300);
      }
    }
    throw new Error(
      `${errorCode}: expected=${JSON.stringify(expected)}; `
        + `actual=${JSON.stringify(await input.inputValue().catch(() => ""))}`,
    );
  };
  const selectSeriesType = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await typeRadio.isChecked().catch(() => false)) return;
      const typeLabel = dialog.getByText(DOUYIN_DRAMA_SERIES_TYPE, { exact: true })
        .filter({ visible: true })
        .first();
      await typeLabel.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
    throw new Error("DOUYIN_DRAMA_SERIES_TYPE_NOT_SELECTED");
  };

  await fillStableValue(seriesName, data.title, "DOUYIN_DRAMA_SERIES_NAME_NOT_FILLED");
  await selectSeriesType();

  const coverItem = coverControl
    .locator("xpath=ancestor::*[contains(@class, 'arco-form-item')][1]");
  await coverInput.setInputFiles(data.coverFile, { timeout: 120_000 });
  await confirmImageCropDialogIfPresent(page, "系列剧封面");
  await waitForUploadSettlement(page, coverItem, "系列剧封面", 120_000, 1, [data.coverFile]);

  const seriesSummary = data.summary.slice(0, 200);
  await fillStableValue(summary, seriesSummary, "DOUYIN_DRAMA_SERIES_SUMMARY_NOT_FILLED");

  // The dialog fetches and binds upload metadata asynchronously. A late React
  // render can replace the form controls, so verify every business field once
  // more after the upload has fully settled.
  await fillStableValue(seriesName, data.title, "DOUYIN_DRAMA_SERIES_NAME_NOT_FILLED");
  await selectSeriesType();
  await fillStableValue(summary, seriesSummary, "DOUYIN_DRAMA_SERIES_SUMMARY_NOT_FILLED");
  await assertNoDouyinFormError(page, "填写系列剧信息");

  const confirm = dialog
    .getByRole("button", { name: "确定", exact: true })
    .filter({ visible: true })
    .last();
  await confirm.waitFor({ state: "visible", timeout: 30_000 });
  const confirmDeadline = Date.now() + 30_000;
  while (!await confirm.isEnabled().catch(() => false)) {
    if (Date.now() >= confirmDeadline) {
      throw new Error("DOUYIN_DRAMA_SERIES_CONFIRM_NOT_ENABLED");
    }
    await page.waitForTimeout(300);
  }
  await confirm.click();
  await dialog.waitFor({ state: "hidden", timeout: 60_000 }).catch(async () => {
    await assertNoDouyinFormError(page, "确认系列剧信息");
    throw new Error("DOUYIN_DRAMA_SERIES_DIALOG_NOT_CONFIRMED");
  });
  await assertNoDouyinFormError(page, "填写系列剧信息");
}

async function fillRoleDialogField(dialog: Locator, labels: string[], value?: string) {
  if (!value) return false;
  for (const label of labels) {
    const item = dialog
      .locator(".arco-form-item")
      .filter({ has: dialog.getByText(label, { exact: true }) })
      .first();
    if (await item.count()) {
      const input = item.locator("input, textarea").first();
      if (await input.count()) {
        await input.fill(value);
        return true;
      }
    }
  }
  return false;
}

export async function fillDouyinRoleNameWithoutSuggestion(
  page: Page,
  dialog: Locator,
  roleName: string,
) {
  const roleNameInput = dialog.locator([
    "#role input:not([disabled])",
    "input[placeholder='请输入角色姓名']:not([disabled])",
    "input[placeholder='请输入角色名称']:not([disabled])",
  ].join(", ")).filter({ visible: true }).first();
  await roleNameInput.waitFor({ state: "visible", timeout: 10_000 });
  await roleNameInput.fill(roleName);

  // 姓名允许直接创建。点击弹窗标题使输入框失焦，不按 Tab、不点击联想项，
  // 避免浏览器把当前高亮的搜索结果提交成已有角色。
  const dialogTitle = dialog.locator(".arco-modal-title").first();
  if (await dialogTitle.isVisible().catch(() => false)) {
    await dialogTitle.click();
  } else {
    await roleNameInput.blur();
  }

  const suggestionPopup = page.locator([
    ".arco-auto-complete-popup:visible",
    ".arco-trigger-popup:visible",
    ".arco-dropdown:visible",
    "[role='listbox']:visible",
  ].join(", ")).last();
  if (await suggestionPopup.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await suggestionPopup.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => undefined);
  }

  if (!(await dialog.isVisible().catch(() => false))) {
    throw new Error(`DOUYIN_DRAMA_ROLE_DIALOG_CLOSED_WHILE_WRITING_NAME: ${roleName}`);
  }
  if ((await roleNameInput.inputValue()).trim() !== roleName.trim()) {
    throw new Error(`DOUYIN_DRAMA_ROLE_NAME_WRITE_FAILED: ${roleName}`);
  }
}

export async function addDouyinRole(page: Page, role: DouyinDramaRole) {
  const roleIntro = requireDouyinRoleIntro(role.name, role.intro);
  const addButton = page
    .getByRole("button", { name: /添加角色弹窗|至少添加2个角色/ })
    .filter({ visible: true })
    .first();
  await addButton.waitFor({ state: "visible", timeout: 10_000 });
  await addButton.click();
  const dialog = page.locator("[role='dialog']:visible, .arco-modal:visible").last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  await fillDouyinRoleNameWithoutSuggestion(page, dialog, role.name);

  await fillRoleDialogField(
    dialog,
    ["演员姓名", "演员", "配音演员"],
    role.actorName,
  );
  const roleType = role.roleType ?? "配角";
  const roleTypeTrigger = dialog.locator("#role_type_input, [role='combobox']").first();
  await roleTypeTrigger.waitFor({ state: "visible", timeout: DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS });
  await roleTypeTrigger.click();
  const roleTypeOption = page
    .locator(".arco-select-popup:visible [role='option'], .arco-select-popup:visible .arco-select-option")
    .filter({ hasText: exactTextPattern(roleType), visible: true })
    .first();
  await roleTypeOption.waitFor({ state: "visible", timeout: DOUYIN_DROPDOWN_LOAD_TIMEOUT_MS });
  await roleTypeOption.click();

  const intro = dialog.locator("#role_intro_input, textarea").first();
  await intro.waitFor({ state: "visible", timeout: 10_000 });
  await intro.fill(roleIntro);

  if (!role.photoFile) throw new Error(`DOUYIN_DRAMA_ROLE_PHOTO_REQUIRED: ${role.name}`);
  const photoInput = dialog.locator([
    "#role_photo_url_input input[type='file']",
    "#role_photo_url input[type='file']",
    ".role-photo-url-item input[type='file']",
    "input[type='file'][accept*='.png']",
  ].join(", ")).first();
  await photoInput.waitFor({ state: "attached", timeout: 10_000 });
  const rolePhotoItem = photoInput.locator(
    "xpath=ancestor::*[contains(@class, 'role-photo-url-item')][1]",
  );
  const photoItem = await rolePhotoItem.count() ? rolePhotoItem : dialog;
  await photoInput.setInputFiles(role.photoFile, { timeout: 120_000 });
  await confirmImageCropDialogIfPresent(page, "角色照片");
  await waitForUploadSettlement(page, photoItem, "角色照片");

  const uploadedPhoto = dialog.locator([
    ".role-photo-url-item .arco-upload-list-item",
    ".role-photo-url-item .arco-upload-list-picture-card",
    ".role-photo-url-item .arco-upload-list img",
  ].join(", ")).first();
  const rolePhotoUri = dialog.locator("#role_photo_uri_input").first();
  const uploadDeadline = Date.now() + 120_000;
  let photoUploadConfirmed = false;
  while (Date.now() < uploadDeadline) {
    await assertNoDouyinFormError(page, `上传角色照片=${role.name}`);
    const previewVisible = await uploadedPhoto.isVisible().catch(() => false);
    const uri = await rolePhotoUri.inputValue().catch(() => "");
    if (previewVisible || uri.trim()) {
      photoUploadConfirmed = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!photoUploadConfirmed) {
    throw new Error(`DOUYIN_DRAMA_ROLE_PHOTO_UPLOAD_NOT_CONFIRMED: ${role.name}`);
  }

  const confirm = dialog
    .getByRole("button", { name: "确定", exact: true })
    .filter({ visible: true })
    .last();
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  await confirm.click();
  const closed = await dialog.waitFor({ state: "hidden", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    await assertNoDouyinFormError(page, `添加角色=${role.name}`);
    throw new Error(`DOUYIN_DRAMA_ROLE_DIALOG_NOT_CONFIRMED: 点击确定后角色弹窗仍未关闭：${role.name}`);
  }
}

export async function assertNoDouyinFormError(page: Page, action: string) {
  const errors = page.locator([
    ".arco-message-error:visible",
    ".arco-message-warning:visible",
    ".arco-form-message:visible",
    ".arco-alert-error:visible",
    "[class*='form-error']:visible",
  ].join(", "));
  // Do not inspect every role=alert surface. The publish-configuration page
  // contains a persistent informational Arco alert whose copy says settings
  // are "不可修改"; treating that advisory text as validation blocks the
  // workflow immediately after the video step has already succeeded.
  const messages = [
    ...await capturedDouyinPageMessageTexts(page),
    ...await errors.allTextContents(),
  ]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((text) => !isTransientDouyinUploadMessage(text));
  if (messages.length > 0) {
    throw new Error(`DOUYIN_DRAMA_FORM_ERROR: ${action}: ${[...new Set(messages)].join("；")}`);
  }
}

export function isTransientDouyinUploadMessage(message: string) {
  return /资源上传中请等待|上传中.*请等待|正在上传/.test(message.replace(/\s+/g, " ").trim());
}

export async function clickDouyinNext(page: Page) {
  const button = page
    .getByRole("button", { name: "下一步", exact: true })
    .filter({ visible: true })
    .last();
  await button.waitFor({ state: "visible", timeout: 10_000 });
  await button.click();
  await page.waitForTimeout(800);
  await assertNoDouyinFormError(page, "下一步");
}
