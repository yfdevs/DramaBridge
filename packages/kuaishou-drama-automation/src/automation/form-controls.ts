import type { Locator, Page } from "playwright";

type ParsedDate = {
  year: number;
  month: number;
  day: number;
};

type RangePanelMonth = {
  index: number;
  year: number;
  month: number;
};

// Short UI settle waits after synthetic input/click events; network and upload waits stay explicit.
const fieldSettleMs = 80;
const selectOpenSettleMs = 100;
const selectChangeSettleMs = 120;
const scrollSettleMs = 80;

export function exactTextPattern(value: string) {
  return new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function escapeCssAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function monthKey(value: Pick<ParsedDate, "year" | "month">) {
  return value.year * 12 + value.month;
}

function parseDateText(value: string): ParsedDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`KUAISHOU_DRAMA_DATE_INVALID: ${value}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function normalizeDateInputValue(value: string) {
  return value.trim().slice(0, 10).replace(/\//g, "-");
}

function dateInputValueMatches(actualValue: string, expectedDateText: string) {
  return normalizeDateInputValue(actualValue) === expectedDateText;
}

async function scrollPageOrPanelDown(page: Page) {
  await page.evaluate(() => {
    const scrollableElements = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const canScroll =
          /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4;

        return (
          canScroll &&
          rect.width > 120 &&
          rect.height > 120 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          element.scrollTop < element.scrollHeight - element.clientHeight
        );
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.height * rightRect.width - leftRect.height * leftRect.width;
      });

    const target = scrollableElements[0] ?? document.scrollingElement;
    target?.scrollBy({ top: 520, behavior: "instant" });
  });
  await page.waitForTimeout(scrollSettleMs);
}

export async function scrollLocatorIntoView(page: Page, locator: Locator) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const attached = await locator
      .count()
      .then((count) => count > 0)
      .catch(() => false);

    if (attached) {
      await locator
        .first()
        .evaluate((node) => {
          const element = node as HTMLElement;
          element.scrollIntoView({ block: "center", inline: "nearest" });

          let parent = element.parentElement;
          while (parent) {
            const style = window.getComputedStyle(parent);
            const canScroll =
              /(auto|scroll)/.test(style.overflowY) &&
              parent.scrollHeight > parent.clientHeight + 4;

            if (canScroll) {
              const elementRect = element.getBoundingClientRect();
              const parentRect = parent.getBoundingClientRect();
              parent.scrollTop +=
                elementRect.top -
                parentRect.top -
                parent.clientHeight / 2 +
                elementRect.height / 2;
            }

            parent = parent.parentElement;
          }
        })
        .catch(() => undefined);
      await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);

      const inViewport = await locator
        .first()
        .evaluate((node) => {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .catch(() => false);

      if (inViewport) {
        await locator.waitFor({ state: "visible", timeout: 5_000 });
        return;
      }
    }

    await scrollPageOrPanelDown(page);
  }

  throw new Error("KUAISHOU_DRAMA_FIELD_NOT_IN_VIEWPORT");
}

export async function formItemByLabel(page: Page, labelText: string, index = 0) {
  const label = page
    .locator("label.ks-form-item__label")
    .filter({ hasText: new RegExp(`^\\s*${labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
    .nth(index);

  await label.waitFor({ state: "attached", timeout: 30_000 });
  const formItem = label.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ks-form-item ')][1]",
  );
  await formItem.waitFor({ state: "attached", timeout: 30_000 });
  return formItem;
}

async function textboxInFormItem(
  page: Page,
  labelText: string,
  placeholderText?: string,
  index = 0,
) {
  const formItem = await formItemByLabel(page, labelText, index);
  await scrollLocatorIntoView(page, formItem);

  if (placeholderText) {
    const byPlaceholder = formItem
      .locator(`input[placeholder="${escapeCssAttributeValue(placeholderText)}"], textarea[placeholder="${escapeCssAttributeValue(placeholderText)}"]`)
      .first();
    if (await byPlaceholder.count()) {
      return byPlaceholder;
    }
  }

  return formItem.locator("input:not([type='file']), textarea").first();
}

async function readTextboxValue(textbox: Locator) {
  return textbox
    .evaluate((node) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement;
      return element.value;
    })
    .catch(() => "");
}

async function forceSetTextboxValue(textbox: Locator, value: string) {
  await textbox.evaluate((node, nextValue) => {
    const element = node as HTMLInputElement | HTMLTextAreaElement;
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

export async function fillTextboxByLabel(
  page: Page,
  labelText: string,
  value: string | number,
  placeholderText?: string,
) {
  await fillTextboxByLabelAt(page, labelText, value, placeholderText);
}

export async function fillTextboxByLabelAt(
  page: Page,
  labelText: string,
  value: string | number,
  placeholderText?: string,
  index = 0,
) {
  const nextValue = String(value);
  const textbox = await textboxInFormItem(page, labelText, placeholderText, index);

  await scrollLocatorIntoView(page, textbox);
  await textbox.click({ timeout: 30_000 });
  await textbox.fill(nextValue, { timeout: 30_000 });
  await page.waitForTimeout(fieldSettleMs);

  if ((await readTextboxValue(textbox)) === nextValue) {
    return;
  }

  await textbox.click({ timeout: 30_000 });
  await textbox.press("Control+A").catch(() => undefined);
  await page.keyboard.insertText(nextValue);
  await page.waitForTimeout(fieldSettleMs);

  if ((await readTextboxValue(textbox)) === nextValue) {
    return;
  }

  await forceSetTextboxValue(textbox, nextValue);
  await page.waitForTimeout(fieldSettleMs);

  if ((await readTextboxValue(textbox)) !== nextValue) {
    throw new Error(`KUAISHOU_DRAMA_TEXTBOX_FILL_FAILED: ${labelText}`);
  }
}

export async function fileInputByLabel(page: Page, labelText: string) {
  const formItem = await formItemByLabel(page, labelText);
  await scrollLocatorIntoView(page, formItem);
  const input = formItem.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  return input;
}

async function stableSelectRootByPopperId(page: Page, popperId: string) {
  const selectRoot = page
    .locator(`.ks-select:has(.select-trigger[aria-describedby="${escapeCssAttributeValue(popperId)}"])`)
    .first();
  await selectRoot.waitFor({ state: "attached", timeout: 30_000 });
  return selectRoot;
}

async function selectRootFromInput(page: Page, input: Locator) {
  const selectRoot = input
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ks-select ')][1]")
    .first();
  await selectRoot.waitFor({ state: "attached", timeout: 30_000 });

  const popperId = await selectRoot
    .locator(".select-trigger")
    .first()
    .getAttribute("aria-describedby")
    .catch(() => null);

  if (popperId) {
    return stableSelectRootByPopperId(page, popperId);
  }

  return selectRoot;
}

async function popperByTrigger(page: Page, trigger: Locator) {
  const popperId = await trigger.getAttribute("aria-describedby");
  if (!popperId) {
    return null;
  }

  return page.locator(`[id="${escapeCssAttributeValue(popperId)}"]`).first();
}

async function openSelectFromRoot(
  page: Page,
  selectRoot: Locator,
  options: { scrollIntoView?: boolean } = {},
) {
  if (options.scrollIntoView !== false) {
    await scrollLocatorIntoView(page, selectRoot);
  }

  const trigger = selectRoot.locator(".select-trigger").first();
  const visiblePopper = await popperByTrigger(page, trigger);
  if (visiblePopper && await visiblePopper.isVisible().catch(() => false)) {
    return visiblePopper;
  }

  await trigger.click({ timeout: 30_000 });
  const popper = await popperByTrigger(page, trigger);
  if (!popper) {
    throw new Error("KUAISHOU_DRAMA_SELECT_POPPER_ID_NOT_FOUND");
  }
  await popper.waitFor({ state: "visible", timeout: 30_000 });
  return popper;
}

async function scrollOptionIntoPopper(popper: Locator, value: string) {
  await popper.evaluate((node, targetText) => {
    const normalize = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";
    const options = Array.from(
      node.querySelectorAll<HTMLElement>(".ks-select-dropdown__item, [role='option']"),
    );
    const option = options.find((item) => normalize(item.textContent) === targetText);

    if (!option) {
      return;
    }

    let parent = option.parentElement;
    while (parent && parent !== node) {
      const style = window.getComputedStyle(parent);
      const canScroll =
        /(auto|scroll)/.test(style.overflowY) &&
        parent.scrollHeight > parent.clientHeight + 4;

      if (canScroll) {
        const optionRect = option.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        if (optionRect.top < parentRect.top) {
          parent.scrollTop -= parentRect.top - optionRect.top;
        } else if (optionRect.bottom > parentRect.bottom) {
          parent.scrollTop += optionRect.bottom - parentRect.bottom;
        }
        return;
      }

      parent = parent.parentElement;
    }
  }, value).catch(() => undefined);
}

async function optionInPopper(popper: Locator, value: string) {
  const option = popper
    .locator(".ks-select-dropdown__item, [role='option']")
    .filter({ hasText: exactTextPattern(value) })
    .first();

  if (await option.isVisible({ timeout: 1_000 }).catch(() => false)) {
    return option;
  }

  const visibleOptions = (await popper
    .locator(".ks-select-dropdown__item, [role='option']")
    .allInnerTexts()
    .catch(() => []))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  throw new Error(
    `KUAISHOU_DRAMA_SELECT_OPTION_NOT_FOUND: ${value}; options=${visibleOptions.join(",")}`,
  );
}

async function visibleOptionTexts(popper: Locator) {
  return (await popper
    .locator(".ks-select-dropdown__item, [role='option']")
    .allInnerTexts()
    .catch(() => []))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function dispatchOptionClickInPopper(popper: Locator, value: string) {
  return popper.evaluate((node, targetText) => {
    const normalize = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";
    const options = Array.from(
      node.querySelectorAll<HTMLElement>(".ks-select-dropdown__item, [role='option']"),
    );
    const option = options.find((item) => normalize(item.textContent) === targetText);

    if (!option) {
      return false;
    }

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    };
    option.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    option.dispatchEvent(new MouseEvent("mousedown", eventInit));
    option.dispatchEvent(new PointerEvent("pointerup", eventInit));
    option.dispatchEvent(new MouseEvent("mouseup", eventInit));
    option.click();
    return true;
  }, value);
}

async function clickOption(page: Page, popper: Locator, value: string) {
  await scrollOptionIntoPopper(popper, value);
  const clicked = await dispatchOptionClickInPopper(popper, value);
  if (!clicked) {
    await optionInPopper(popper, value);
    throw new Error(
      `KUAISHOU_DRAMA_SELECT_OPTION_NOT_CLICKED: ${value}; options=${(await visibleOptionTexts(popper)).join(",")}`,
    );
  }
  await page.waitForTimeout(selectChangeSettleMs);
}

async function inputByPlaceholder(page: Page, placeholderText: string) {
  const input = page.locator(`input[placeholder="${escapeCssAttributeValue(placeholderText)}"]`).first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  return input;
}

async function selectRootByPlaceholder(page: Page, placeholderText: string) {
  return selectRootFromInput(page, await inputByPlaceholder(page, placeholderText));
}

async function selectRootByOptionText(page: Page, optionText: string) {
  const popperId = await page.evaluate((targetText) => {
    const normalize = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";
    const popper = Array.from(document.querySelectorAll<HTMLElement>(".ks-select__popper"))
      .find((candidate) => (
        Array.from(candidate.querySelectorAll<HTMLElement>(".ks-select-dropdown__item"))
          .some((item) => normalize(item.textContent) === targetText)
      ));

    return popper?.id ?? null;
  }, optionText);

  if (!popperId) {
    throw new Error(`KUAISHOU_DRAMA_SELECT_ROOT_BY_OPTION_NOT_FOUND: ${optionText}`);
  }

  return stableSelectRootByPopperId(page, popperId);
}

async function selectRootByLabel(
  page: Page,
  labelText: string,
  options: { index?: number; scrollIntoView?: boolean } = {},
) {
  const formItem = await formItemByLabel(page, labelText, options.index ?? 0);
  if (options.scrollIntoView !== false) {
    await scrollLocatorIntoView(page, formItem);
  }
  const selectRoot = formItem.locator(".ks-select").first();
  await selectRoot.waitFor({ state: "attached", timeout: 30_000 });

  const popperId = await selectRoot
    .locator(".select-trigger")
    .first()
    .getAttribute("aria-describedby")
    .catch(() => null);

  if (popperId) {
    return stableSelectRootByPopperId(page, popperId);
  }

  return selectRoot;
}

export async function countFormItemsByLabel(page: Page, labelText: string) {
  return page
    .locator("label.ks-form-item__label")
    .filter({ hasText: new RegExp(`^\\s*${labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
    .count();
}

export async function clickButtonByText(page: Page, buttonText: string) {
  const button = page
    .locator("button,.ks-button,[role='button']")
    .filter({ hasText: exactTextPattern(buttonText) })
    .first();

  await button.waitFor({ state: "attached", timeout: 30_000 });
  await scrollLocatorIntoView(page, button);
  await button.click({ timeout: 30_000 });
  await page.waitForTimeout(fieldSettleMs);
}

async function selectedTagTexts(selectRoot: Locator) {
  return selectRoot.evaluate((node) => {
    const selectors = [
      ".ks-select__tags-text",
      ".ks-tag__content",
      ".ks-tag",
      ".ks-select__tags span",
    ];
    const texts = selectors.flatMap((selector) => (
      Array.from(node.querySelectorAll<HTMLElement>(selector))
        .map((element) => element.textContent ?? "")
    ));

    return Array.from(new Set(
      texts
        .map((text) => text.replace(/[×✕]/g, "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ));
  }).catch(() => []);
}

async function hasSelectedTagText(selectRoot: Locator, value: string) {
  const target = value.replace(/\s+/g, "");
  return (await selectedTagTexts(selectRoot)).some((text) => (
    text.replace(/\s+/g, "") === target ||
    text.replace(/\s+/g, "").includes(target)
  ));
}

async function hasSelectedOptionText(selectRoot: Locator, value: string) {
  return selectRoot.evaluate((node, targetText) => {
    const normalize = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";
    const trigger = node.querySelector<HTMLElement>(".select-trigger");
    const popperId = trigger?.getAttribute("aria-describedby");
    const popper = popperId ? document.getElementById(popperId) : null;
    if (!popper) {
      return false;
    }

    const option = Array.from(popper.querySelectorAll<HTMLElement>(".ks-select-dropdown__item"))
      .find((item) => normalize(item.textContent) === targetText);
    if (!option) {
      return false;
    }

    return (
      option.classList.contains("selected") ||
      option.classList.contains("is-selected") ||
      option.getAttribute("aria-selected") === "true" ||
      Boolean(option.querySelector(".ks-checkbox.is-checked")) ||
      Boolean(option.querySelector(".ks-checkbox__input.is-checked")) ||
      Boolean(option.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked)
    );
  }, value).catch(() => false);
}

async function selectedOptionTexts(selectRoot: Locator) {
  return selectRoot.evaluate((node) => {
    const normalize = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";
    const trigger = node.querySelector<HTMLElement>(".select-trigger");
    const popperId = trigger?.getAttribute("aria-describedby");
    const popper = popperId ? document.getElementById(popperId) : null;
    if (!popper) {
      return [];
    }

    return Array.from(popper.querySelectorAll<HTMLElement>(".ks-select-dropdown__item"))
      .filter((option) => (
        option.classList.contains("selected") ||
        option.classList.contains("is-selected") ||
        option.getAttribute("aria-selected") === "true" ||
        Boolean(option.querySelector(".ks-checkbox.is-checked")) ||
        Boolean(option.querySelector(".ks-checkbox__input.is-checked")) ||
        Boolean(option.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked)
      ))
      .map((option) => normalize(option.textContent))
      .filter(Boolean);
  }).catch(() => []);
}

async function clearMultiSelectTags(page: Page, selectRoot: Locator) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const removed = await selectRoot.evaluate((node) => {
      const closeButton = node.querySelector<HTMLElement>(".ks-tag__close");
      if (!closeButton) {
        return false;
      }

      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
      };
      closeButton.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      closeButton.dispatchEvent(new MouseEvent("mousedown", eventInit));
      closeButton.dispatchEvent(new PointerEvent("pointerup", eventInit));
      closeButton.dispatchEvent(new MouseEvent("mouseup", eventInit));
      closeButton.click();
      return true;
    }).catch(() => false);

    if (!removed) {
      return;
    }

    await page.waitForTimeout(fieldSettleMs);
  }
}

async function openAndFilterMultiSelectNoScroll(selectRoot: Locator, value: string) {
  return selectRoot.evaluate((node, targetText) => {
    const root = node as HTMLElement;
    const input =
      root.querySelector<HTMLInputElement>("input.ks-select__input") ??
      Array.from(root.querySelectorAll<HTMLInputElement>("input.ks-input__inner"))
        .find((candidate) => !candidate.readOnly);
    if (!input || input.disabled || input.readOnly) {
      return null;
    }

    const isVisible = (element: HTMLElement | null) => {
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    };
    const trigger = root.querySelector<HTMLElement>(".select-trigger") ?? root;
    const popperId = trigger.getAttribute("aria-describedby") ?? input.getAttribute("aria-describedby");
    const popper = popperId ? document.getElementById(popperId) : null;
    if (!isVisible(popper)) {
      trigger.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      trigger.dispatchEvent(new MouseEvent("mousedown", eventInit));
      trigger.dispatchEvent(new PointerEvent("pointerup", eventInit));
      trigger.dispatchEvent(new MouseEvent("mouseup", eventInit));
      trigger.click();
    }

    input.focus({ preventScroll: true });
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, "");
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: "",
      inputType: "deleteContentBackward",
    }));
    descriptor?.set?.call(input, targetText);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: targetText,
      inputType: "insertText",
    }));

    return popperId ?? trigger.getAttribute("aria-describedby") ?? input.getAttribute("aria-describedby");
  }, value);
}

async function dispatchVisibleOptionClickNoScroll(
  page: Page,
  value: string,
  popperId: string | null,
) {
  return page.evaluate(({ targetText, targetPopperId }) => {
    const normalize = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() ?? "";
    const isVisible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const popperById = targetPopperId ? document.getElementById(targetPopperId) : null;
    const scopes = popperById && isVisible(popperById)
      ? [popperById]
      : Array.from(document.querySelectorAll<HTMLElement>(".ks-select-dropdown, [role='listbox']"))
          .filter(isVisible);
    const searchRoot = scopes[0] ?? document.body;
    const options = Array.from(
      searchRoot.querySelectorAll<HTMLElement>(".ks-select-dropdown__item, [role='option']"),
    );
    const option = options.find((item) => normalize(item.textContent) === targetText);

    if (!option) {
      return {
        clicked: false,
        options: options.map((item) => normalize(item.textContent)).filter(Boolean),
      };
    }

    let parent = option.parentElement;
    while (parent && parent !== searchRoot) {
      const style = window.getComputedStyle(parent);
      const canScroll =
        /(auto|scroll)/.test(style.overflowY) &&
        parent.scrollHeight > parent.clientHeight + 4;

      if (canScroll) {
        const optionRect = option.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        if (optionRect.top < parentRect.top) {
          parent.scrollTop -= parentRect.top - optionRect.top;
        } else if (optionRect.bottom > parentRect.bottom) {
          parent.scrollTop += optionRect.bottom - parentRect.bottom;
        }
        break;
      }

      parent = parent.parentElement;
    }

    const eventInit = { bubbles: true, cancelable: true, view: window };
    option.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    option.dispatchEvent(new MouseEvent("mousedown", eventInit));
    option.dispatchEvent(new PointerEvent("pointerup", eventInit));
    option.dispatchEvent(new MouseEvent("mouseup", eventInit));
    option.click();
    return { clicked: true, options: [] };
  }, { targetText: value, targetPopperId: popperId });
}

async function closeMultiSelectNoScroll(selectRoot: Locator, popperId: string | null) {
  await selectRoot.evaluate((node, targetPopperId) => {
    const input =
      node.querySelector<HTMLInputElement>("input.ks-select__input") ??
      Array.from(node.querySelectorAll<HTMLInputElement>("input.ks-input__inner"))
        .find((candidate) => !candidate.readOnly);
    const eventInit = {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      code: "Escape",
    };
    input?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    input?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    input?.blur();
    document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    document.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    const popper = targetPopperId ? document.getElementById(targetPopperId) : null;
    popper?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    popper?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }, popperId).catch(() => undefined);
}

async function captureScrollSnapshot(page: Page) {
  return page.evaluate(() => {
    const scrollableElements = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 4
        );
      })
      .map((element, index) => {
        element.dataset.kuaishouDramaScrollSnapshotId = `scroll-${index}`;
        return {
          id: element.dataset.kuaishouDramaScrollSnapshotId,
          left: element.scrollLeft,
          top: element.scrollTop,
        };
      });

    return {
      windowX: window.scrollX,
      windowY: window.scrollY,
      elements: scrollableElements,
    };
  });
}

async function restoreScrollSnapshot(
  page: Page,
  scrollSnapshot: Awaited<ReturnType<typeof captureScrollSnapshot>>,
) {
  await page.evaluate((snapshot) => {
    for (const item of snapshot.elements) {
      const element = document.querySelector<HTMLElement>(
        `[data-kuaishou-drama-scroll-snapshot-id="${item.id}"]`,
      );
      if (element) {
        element.scrollLeft = item.left;
        element.scrollTop = item.top;
        delete element.dataset.kuaishouDramaScrollSnapshotId;
      }
    }
    window.scrollTo(snapshot.windowX, snapshot.windowY);
  }, scrollSnapshot).catch(() => undefined);
}

async function openSingleSelectNoScroll(selectRoot: Locator) {
  return selectRoot.evaluate((node) => {
    const root = node as HTMLElement;
    const input = root.querySelector<HTMLInputElement>("input.ks-input__inner");
    const trigger = root.querySelector<HTMLElement>(".select-trigger") ?? root;
    const popperId = trigger.getAttribute("aria-describedby") ?? input?.getAttribute("aria-describedby") ?? null;
    const popper = popperId ? document.getElementById(popperId) : null;
    const isVisible = (element: HTMLElement | null) => {
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };

    if (!isVisible(popper)) {
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
      };
      trigger.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      trigger.dispatchEvent(new MouseEvent("mousedown", eventInit));
      trigger.dispatchEvent(new PointerEvent("pointerup", eventInit));
      trigger.dispatchEvent(new MouseEvent("mouseup", eventInit));
      trigger.click();
    }

    input?.focus({ preventScroll: true });
    return popperId ?? trigger.getAttribute("aria-describedby") ?? input?.getAttribute("aria-describedby") ?? null;
  });
}

async function closeSingleSelectNoScroll(selectRoot: Locator, popperId: string | null) {
  await selectRoot.evaluate((node, targetPopperId) => {
    const input = node.querySelector<HTMLInputElement>("input.ks-input__inner");
    const eventInit = {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      code: "Escape",
    };

    input?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    input?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    input?.blur();
    document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    document.dispatchEvent(new KeyboardEvent("keyup", eventInit));

    const popper = targetPopperId ? document.getElementById(targetPopperId) : null;
    popper?.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    popper?.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }, popperId).catch(() => undefined);
}

async function readSingleSelectValue(selectRoot: Locator) {
  return selectRoot
    .locator("input.ks-input__inner")
    .first()
    .inputValue()
    .catch(() => "");
}

async function trySelectSingleNoScroll(page: Page, selectRoot: Locator, value: string) {
  const scrollSnapshot = await captureScrollSnapshot(page);
  const popperId = await openSingleSelectNoScroll(selectRoot).catch(() => null);
  await page.waitForTimeout(selectOpenSettleMs);

  const result = await dispatchVisibleOptionClickNoScroll(page, value, popperId);
  await page.waitForTimeout(selectChangeSettleMs);
  await closeSingleSelectNoScroll(selectRoot, popperId);
  await restoreScrollSnapshot(page, scrollSnapshot);

  if (!result.clicked) {
    throw new Error(
      `KUAISHOU_DRAMA_SELECT_OPTION_NOT_FOUND: ${value}; options=${result.options.join(",")}`,
    );
  }

  return (await readSingleSelectValue(selectRoot)) === value;
}

async function trySelectMultipleNoScroll(page: Page, selectRoot: Locator, value: string) {
  const scrollSnapshot = await captureScrollSnapshot(page);
  const popperId = await openAndFilterMultiSelectNoScroll(selectRoot, value).catch(() => null);
  await page.waitForTimeout(selectOpenSettleMs);

  const result = await dispatchVisibleOptionClickNoScroll(page, value, popperId);
  if (!result.clicked) {
    throw new Error(
      `KUAISHOU_DRAMA_MULTI_SELECT_OPTION_NOT_FOUND: ${value}; options=${result.options.join(",")}`,
    );
  }

  await page.waitForTimeout(selectChangeSettleMs);
  await selectRoot.evaluate((node) => {
    const input =
      node.querySelector<HTMLInputElement>("input.ks-select__input") ??
      Array.from(node.querySelectorAll<HTMLInputElement>("input.ks-input__inner"))
        .find((candidate) => !candidate.readOnly);
    if (!input) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, "");
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: "",
      inputType: "deleteContentBackward",
    }));
  }).catch(() => undefined);
  await closeMultiSelectNoScroll(selectRoot, popperId);
  await page.waitForTimeout(fieldSettleMs);
  await restoreScrollSnapshot(page, scrollSnapshot);

  return (
    await hasSelectedOptionText(selectRoot, value) ||
    await hasSelectedTagText(selectRoot, value)
  );
}

async function selectSingleFromRoot(page: Page, selectRoot: Locator, value: string) {
  const currentValue = await readSingleSelectValue(selectRoot);
  if (currentValue === value) {
    return;
  }

  if (await trySelectSingleNoScroll(page, selectRoot, value).catch(() => false)) {
    return;
  }

  const popper = await openSelectFromRoot(page, selectRoot);
  await clickOption(page, popper, value);

  if ((await readSingleSelectValue(selectRoot)) !== value) {
    throw new Error(`KUAISHOU_DRAMA_SELECT_FAILED: ${value}`);
  }
}

async function selectMultipleFromRoot(page: Page, selectRoot: Locator, values: string[]) {
  await clearMultiSelectTags(page, selectRoot);

  for (const value of values) {
    if (!await trySelectMultipleNoScroll(page, selectRoot, value)) {
      throw new Error(`KUAISHOU_DRAMA_MULTI_SELECT_FAILED: ${value}`);
    }
  }

  await selectRoot.evaluate((node) => {
    const input = node.querySelector<HTMLInputElement>("input.ks-input__inner");
    input?.blur();
    node.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      code: "Escape",
    }));
    node.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      code: "Escape",
    }));
  }).catch(() => undefined);
  await page.waitForTimeout(fieldSettleMs);

  const selectedTexts = [
    ...await selectedOptionTexts(selectRoot),
    ...await selectedTagTexts(selectRoot),
  ];
  for (const value of values) {
    const target = value.replace(/\s+/g, "");
    if (!selectedTexts.some((text) => text.replace(/\s+/g, "").includes(target))) {
      throw new Error(`KUAISHOU_DRAMA_MULTI_SELECT_FAILED: ${value}`);
    }
  }
}

export async function selectSingleByPlaceholder(
  page: Page,
  placeholderText: string,
  value: string,
) {
  await selectSingleFromRoot(page, await selectRootByPlaceholder(page, placeholderText), value);
}

export async function selectMultipleByPlaceholder(
  page: Page,
  placeholderText: string,
  values: string[],
) {
  const selectRoot = await selectRootByPlaceholder(page, placeholderText)
    .catch(() => selectRootByOptionText(page, values[0]));
  await selectMultipleFromRoot(page, selectRoot, values);
}

export async function selectSingleByLabel(page: Page, labelText: string, value: string) {
  await selectSingleByLabelAt(page, labelText, value);
}

export async function selectSingleByLabelAt(
  page: Page,
  labelText: string,
  value: string,
  index = 0,
) {
  await selectSingleFromRoot(page, await selectRootByLabel(page, labelText, { index }), value);
}

export async function selectMultipleByLabel(page: Page, labelText: string, values: string[]) {
  await selectMultipleFromRoot(
    page,
    await selectRootByLabel(page, labelText, { scrollIntoView: false }),
    values,
  );
}

export async function selectRadioByLabel(page: Page, labelText: string, value: string) {
  const formItem = await formItemByLabel(page, labelText);
  await scrollLocatorIntoView(page, formItem);
  const radio = formItem.locator(".ks-radio").filter({ hasText: exactTextPattern(value) }).first();
  await radio.waitFor({ state: "visible", timeout: 30_000 });

  const classes = await radio.getAttribute("class").catch(() => "");
  if (classes?.includes("is-checked")) {
    return;
  }

  await radio.click({ force: true, timeout: 30_000 });
  await page.waitForTimeout(fieldSettleMs);
}

async function readDatePanelMonth(popper: Locator): Promise<Pick<ParsedDate, "year" | "month">> {
  const headerTexts = await popper
    .locator(".ks-date-picker__header-label")
    .allInnerTexts()
    .catch(() => []);
  const yearText = headerTexts.find((text) => /\d{4}\s*年/.test(text));
  const monthText = headerTexts.find((text) => /\d{1,2}\s*月/.test(text));
  const year = /(\d{4})\s*年/.exec(yearText ?? "")?.[1];
  const month = /(\d{1,2})\s*月/.exec(monthText ?? "")?.[1];

  if (!year || !month) {
    throw new Error("KUAISHOU_DRAMA_DATE_PANEL_MONTH_NOT_FOUND");
  }

  return {
    year: Number(year),
    month: Number(month),
  };
}

async function navigateDatePickerToMonth(page: Page, popper: Locator, target: ParsedDate) {
  const targetMonth = monthKey(target);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readDatePanelMonth(popper);
    const currentMonth = monthKey(current);
    if (currentMonth === targetMonth) {
      return;
    }

    if (targetMonth < currentMonth) {
      await popper
        .locator(".ks-date-picker__prev-btn.sys-icon-mini-arrow-left")
        .first()
        .click({ timeout: 10_000 });
    } else {
      await popper
        .locator(".ks-date-picker__next-btn.sys-icon-mini-arrow-right")
        .first()
        .click({ timeout: 10_000 });
    }
    await page.waitForTimeout(fieldSettleMs);
  }

  throw new Error(`KUAISHOU_DRAMA_DATE_MONTH_NAVIGATION_FAILED: ${target.year}-${target.month}`);
}

async function clickDateInDatePicker(popper: Locator, target: ParsedDate) {
  const cell = popper
    .locator("td.available:not(.prev-month):not(.next-month)")
    .filter({ hasText: exactTextPattern(String(target.day)) })
    .first();

  await cell.waitFor({ state: "visible", timeout: 30_000 });
  await cell.click({ timeout: 30_000 });
}

async function forceSetSingleDate(input: Locator, dateText: string) {
  await input.evaluate((node, value) => {
    const element = node as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: "insertText",
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));

    let parent = element.parentElement;
    for (let depth = 0; depth < 5 && parent; depth += 1) {
      parent.dispatchEvent(new Event("input", { bubbles: true }));
      parent.dispatchEvent(new Event("change", { bubbles: true }));
      parent = parent.parentElement;
    }
  }, dateText);
}

async function singleDateInputByLabel(page: Page, labelText: string, index = 0) {
  const formItem = await formItemByLabel(page, labelText, index);
  const input = formItem.locator("input.ks-input__inner").first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  return input;
}

export async function setSingleDateByLabel(
  page: Page,
  labelText: string,
  dateText: string,
) {
  await setSingleDateByLabelAt(page, labelText, dateText);
}

export async function setSingleDateByLabelAt(
  page: Page,
  labelText: string,
  dateText: string,
  index = 0,
) {
  const target = parseDateText(dateText);
  const input = await singleDateInputByLabel(page, labelText, index);

  await scrollLocatorIntoView(page, input);
  if (dateInputValueMatches(await input.inputValue().catch(() => ""), dateText)) {
    return;
  }

  const popperId = await input.getAttribute("aria-describedby").catch(() => null);
  if (popperId) {
    await input.click({ force: true, timeout: 30_000 });
    const popper = page.locator(`[id="${escapeCssAttributeValue(popperId)}"]`).first();
    const opened = await popper.waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);

    if (opened) {
      await navigateDatePickerToMonth(page, popper, target);
      await clickDateInDatePicker(popper, target);
      await page.waitForTimeout(fieldSettleMs);

      const confirmButton = popper
        .locator(".ks-picker-panel__link-btn")
        .filter({ hasText: exactTextPattern("确定") })
        .first();
      if (await confirmButton.isVisible().catch(() => false)) {
        await confirmButton.click({ timeout: 10_000 });
      }

      await popper.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(fieldSettleMs);
      if (dateInputValueMatches(await input.inputValue().catch(() => ""), dateText)) {
        return;
      }
    }
  }

  await forceSetSingleDate(input, dateText);
  await page.waitForTimeout(fieldSettleMs);

  if (!dateInputValueMatches(await input.inputValue().catch(() => ""), dateText)) {
    throw new Error(`KUAISHOU_DRAMA_SINGLE_DATE_FILL_FAILED: ${labelText}`);
  }
}

async function readRangePanelMonths(popper: Locator): Promise<RangePanelMonth[]> {
  return popper
    .locator(".ks-date-range-picker__content")
    .evaluateAll((panels) => panels.flatMap((panel, index) => {
      const headerText = (panel.querySelector(".ks-date-range-picker__header div")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const match = /(\d{4})\s*年\s*(\d{1,2})月/.exec(headerText);
      if (!match) return [];
      return [{
        index,
        year: Number(match[1]),
        month: Number(match[2]),
      }];
    }));
}

async function navigateRangePickerToMonth(page: Page, popper: Locator, target: ParsedDate) {
  const targetMonth = monthKey(target);

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const panelMonths = await readRangePanelMonths(popper);
    if (panelMonths.length === 0) {
      throw new Error("KUAISHOU_DRAMA_DATE_RANGE_PANEL_MONTH_NOT_FOUND");
    }

    const firstMonth = panelMonths[0];
    const lastMonth = panelMonths[panelMonths.length - 1];
    if (targetMonth >= monthKey(firstMonth) && targetMonth <= monthKey(lastMonth)) {
      return;
    }

    if (targetMonth < monthKey(firstMonth)) {
      await popper
        .locator(".ks-date-range-picker__content.is-left .sys-icon-mini-arrow-left")
        .first()
        .click({ timeout: 10_000 });
    } else {
      await popper
        .locator(".ks-date-range-picker__content.is-right .sys-icon-mini-arrow-right")
        .first()
        .click({ timeout: 10_000 });
    }
    await page.waitForTimeout(fieldSettleMs);
  }

  throw new Error(`KUAISHOU_DRAMA_DATE_RANGE_MONTH_NAVIGATION_FAILED: ${target.year}-${target.month}`);
}

async function clickDateInRangePicker(popper: Locator, target: ParsedDate) {
  const panelMonths = await readRangePanelMonths(popper);
  const panelIndex = panelMonths.find((month) => monthKey(month) === monthKey(target))?.index;
  if (panelIndex === undefined) {
    throw new Error(`KUAISHOU_DRAMA_DATE_RANGE_MONTH_NOT_VISIBLE: ${target.year}-${target.month}`);
  }

  const panel = popper.locator(".ks-date-range-picker__content").nth(panelIndex);
  const cell = panel
    .locator("td.available:not(.prev-month):not(.next-month)")
    .filter({ hasText: exactTextPattern(String(target.day)) })
    .first();

  await cell.waitFor({ state: "visible", timeout: 30_000 });
  await cell.click({ timeout: 30_000 });
}

async function forceSetDateRange(editor: Locator, startDate: string, endDate: string) {
  await editor.evaluate((node, value) => {
    const inputs = Array.from(node.querySelectorAll<HTMLInputElement>("input.ks-range-input"));
    if (inputs.length < 2) return;

    inputs[0].value = value.startDate;
    inputs[1].value = value.endDate;
    for (const input of inputs) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, { startDate, endDate });
}

export async function setDateRangeByLabel(
  page: Page,
  labelText: string,
  startDateText: string,
  endDateText: string,
) {
  const startDate = parseDateText(startDateText);
  const endDate = parseDateText(endDateText);
  const formItem = await formItemByLabel(page, labelText);
  const editor = formItem.locator(".ks-date-editor").first();

  await scrollLocatorIntoView(page, editor);
  const popperId = await editor.getAttribute("aria-describedby");
  if (!popperId) {
    throw new Error("KUAISHOU_DRAMA_DATE_RANGE_POPPER_ID_NOT_FOUND");
  }

  await editor.click({ force: true, timeout: 30_000 });
  const popper = page.locator(`[id="${popperId}"]`).first();
  await popper.waitFor({ state: "visible", timeout: 30_000 });

  await navigateRangePickerToMonth(page, popper, startDate);
  await clickDateInRangePicker(popper, startDate);
  await page.waitForTimeout(200);
  await navigateRangePickerToMonth(page, popper, endDate);
  await clickDateInRangePicker(popper, endDate);
  await popper.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(200);

  const values = await editor
    .locator("input.ks-range-input")
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    .catch(() => []);
  if (values[0] === startDateText && values[1] === endDateText) {
    return;
  }

  await forceSetDateRange(editor, startDateText, endDateText);
}

export async function selectYearByLabel(page: Page, labelText: string, year: number) {
  const formItem = await formItemByLabel(page, labelText);
  const input = formItem.locator("input.ks-input__inner").first();
  const yearText = String(year);

  await scrollLocatorIntoView(page, input);
  if ((await input.inputValue().catch(() => "")) === yearText) {
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await input.inputValue() === yearText) return;
    // Re-read the association after each render. Do not force a click through
    // an overlay or keep waiting on an obsolete/hidden year panel.
    await input.click({ timeout: 10_000 });
    const popperId = await input.getAttribute("aria-describedby");
    if (!popperId) {
      if (attempt < 2) { await page.waitForTimeout(fieldSettleMs); continue; }
      throw new Error("KUAISHOU_DRAMA_YEAR_POPPER_ID_NOT_FOUND");
    }
    const popper = page.locator(`[id="${escapeCssAttributeValue(popperId)}"]`).first();
    const opened = await popper.waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true).catch(() => false);
    if (!opened) continue;
    const yearCell = popper.locator("td,.ks-select-dropdown__item,[role='option']")
      .filter({ hasText: exactTextPattern(yearText) }).first();
    await yearCell.click({ timeout: 10_000 });
    await page.waitForFunction(({ id, expected }) => {
      const panel = document.getElementById(id);
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("input"))
        .find(node => node.getAttribute("aria-describedby") === id);
      return input?.value === expected || !panel;
    }, { id: popperId, expected: yearText }, { timeout: 3_000 }).catch(() => undefined);
    if (await input.inputValue() === yearText) return;
  }
  throw new Error(`KUAISHOU_DRAMA_YEAR_SELECTION_FAILED: expected=${yearText} actual=${await input.inputValue()}`);
}
