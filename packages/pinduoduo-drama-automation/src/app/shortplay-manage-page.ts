import type { BrowserContext, Locator, Page } from "playwright";
import {
  PINDUODUO_LOGIN_EXPIRED_URL,
  PINDUODUO_MCN_ORIGIN,
  PINDUODUO_SHORTPLAY_MANAGE_URL,
} from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { PinduoduoDramaLoginState, PinduoduoDramaRuntimeOptions } from "../shared/types.js";
import { pinduoduoDramaLoginStateFromUrl, saveCredentialState } from "./browser-session.js";

const LOGIN_REDIRECT_WAIT_MS = 10_000;
const LOGIN_API_WAIT_MS = 12_000;
const SHORTPLAY_TAB_SWITCH_TIMEOUT_MS = 10_000;
const SHORTPLAY_TAB_ACTIVE_TIMEOUT_MS = 3_000;
const SHORTPLAY_LIST_RESPONSE_TIMEOUT_MS = 20_000;
const SHORTPLAY_TAB_REFRESH_SETTLE_MS = 2_000;
const SHORTPLAY_ROW_SELECT_TIMEOUT_MS = 30_000;
const SHORTPLAY_ROW_CHECK_SETTLE_TIMEOUT_MS = 1_500;
const SHORTPLAY_ROW_READY_SETTLE_MS = 3_000;
const SHORTPLAY_SUBMIT_TOAST_TIMEOUT_MS = 3_000;
const SUBMITTED_SHORTPLAY_APPLY_LIST_PAGE_SIZE = 1;
const PINDUODUO_SHORTPLAY_APPLY_LIST_PATH = "/mms/gaia/topic/apply/list";
const PINDUODUO_SHORTPLAY_APPLY_LIST_URL = `${PINDUODUO_MCN_ORIGIN}${PINDUODUO_SHORTPLAY_APPLY_LIST_PATH}`;
const PINDUODUO_USER_INFO_URL = `${PINDUODUO_MCN_ORIGIN}/api/cafe/login/user_info`;
const SHORTPLAY_MANAGE_TAB_TYPES = {
  已提报短剧: 1,
  待提报短剧: 0,
} as const;

function isPinduoduoLoginRequiredPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const errorCode = "error_code" in payload ? payload.error_code : undefined;
  return errorCode === 40001 || errorCode === "40001";
}

async function waitForPinduoduoUserInfoLoginState(page: Page): Promise<PinduoduoDramaLoginState> {
  const response = await page
    .waitForResponse((nextResponse) => nextResponse.url().startsWith(PINDUODUO_USER_INFO_URL), {
      timeout: LOGIN_API_WAIT_MS,
    })
    .catch(() => undefined);

  if (!response) {
    return "unknown";
  }

  const payload = await response.json().catch(() => undefined);
  if (!response.ok() || isPinduoduoLoginRequiredPayload(payload)) {
    return "login-required";
  }

  return "logged-in";
}

async function waitForLoginStateAfterNavigation(page: Page): Promise<PinduoduoDramaLoginState> {
  let loginState = pinduoduoDramaLoginStateFromUrl(page.url());
  if (loginState === "login-required") {
    return loginState;
  }

  const apiLoginState = await waitForPinduoduoUserInfoLoginState(page);
  if (apiLoginState !== "unknown") {
    return apiLoginState;
  }

  await page
    .waitForURL((url) => pinduoduoDramaLoginStateFromUrl(url.href) === "login-required", {
      timeout: LOGIN_REDIRECT_WAIT_MS,
    })
    .catch(() => undefined);

  loginState = pinduoduoDramaLoginStateFromUrl(page.url());
  return loginState === "login-required" ? "login-required" : "unknown";
}

async function waitForManualLoginAndOpenShortplayManagePage(
  page: Page,
  context: BrowserContext,
  options: PinduoduoDramaRuntimeOptions,
): Promise<void> {
  log(options, "warn", "runtime", "waiting for manual login before claiming tasks", {
    activeUrl: page.url(),
    loginExpiredUrl: PINDUODUO_LOGIN_EXPIRED_URL,
  });

  await page
    .goto(PINDUODUO_LOGIN_EXPIRED_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    .catch(() => undefined);

  while (!page.isClosed()) {
    await page.waitForURL((url) => pinduoduoDramaLoginStateFromUrl(url.href) === "logged-in", {
      timeout: 0,
    });

    log(options, "info", "runtime", "manual login detected, reopening shortplay manage page", {
      activeUrl: page.url(),
      manageUrl: PINDUODUO_SHORTPLAY_MANAGE_URL,
    });

    await page.goto(PINDUODUO_SHORTPLAY_MANAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const loginState = await waitForLoginStateAfterNavigation(page);
    if (loginState === "logged-in") {
      log(options, "info", "runtime", "manual login completed, shortplay manage page reopened", {
        activeUrl: page.url(),
        loginState,
      });
      await saveCredentialState(context, options).catch(() => undefined);
      return;
    }

    log(
      options,
      "warn",
      "runtime",
      "login is still required after reopening shortplay manage page",
      {
        activeUrl: page.url(),
        loginState,
      },
    );
  }

  throw new Error("Pinduoduo browser page was closed while waiting for manual login.");
}

export async function openShortplayManagePage(
  page: Page,
  context: BrowserContext,
  options: PinduoduoDramaRuntimeOptions,
): Promise<void> {
  log(options, "info", "runtime", "opening shortplay manage page", {
    url: PINDUODUO_SHORTPLAY_MANAGE_URL,
  });
  await page.goto(PINDUODUO_SHORTPLAY_MANAGE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const loginState = await waitForLoginStateAfterNavigation(page);
  if (loginState !== "logged-in") {
    log(options, "warn", "runtime", "login is required before opening shortplay manage page", {
      activeUrl: page.url(),
      loginExpiredUrl: PINDUODUO_LOGIN_EXPIRED_URL,
      loginState,
    });
    await waitForManualLoginAndOpenShortplayManagePage(page, context, options);
    return;
  }

  log(options, "info", "runtime", "shortplay manage page opened", {
    activeUrl: page.url(),
    loginState,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function dispatchShortplayManageTabClick(page: Page, label: string): Promise<boolean> {
  return page.evaluate((expectedLabel) => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="beast-core-tab-itemLabel"]'),
    );
    const target = candidates.find((element) => element.textContent?.trim() === expectedLabel);
    if (!target) {
      return false;
    }

    target.scrollIntoView({ block: "center", inline: "center" });
    for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    }
    target.click();
    return true;
  }, label);
}

async function waitForShortplayManageTabActive(page: Page, label: string): Promise<void> {
  await page.waitForFunction(
    (expectedLabel) => {
      function hasActiveMarker(element: Element): boolean {
        let current: Element | null = element;
        let depth = 0;
        while (current && depth < 5) {
          if (
            current.getAttribute("aria-selected") === "true" ||
            Array.from(current.classList).some((className) => className.includes("TAB_active"))
          ) {
            return true;
          }
          current = current.parentElement;
          depth += 1;
        }
        return false;
      }

      return Array.from(document.querySelectorAll('[data-testid="beast-core-tab-itemLabel"]')).some(
        (element) => element.textContent?.trim() === expectedLabel && hasActiveMarker(element),
      );
    },
    label,
    { timeout: SHORTPLAY_TAB_ACTIVE_TIMEOUT_MS },
  );
}

async function clickShortplayManageTab(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  label: string,
): Promise<void> {
  const tab = page
    .locator('[data-testid="beast-core-tab-itemLabel"]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegex(label)}\\s*$`) })
    .first();

  await tab.waitFor({
    state: "visible",
    timeout: SHORTPLAY_TAB_SWITCH_TIMEOUT_MS,
  });

  const clickStartedAt = Date.now();
  let clickedByPlaywright = false;
  await tab.scrollIntoViewIfNeeded({ timeout: SHORTPLAY_TAB_SWITCH_TIMEOUT_MS });
  await tab
    .click({ force: true, timeout: SHORTPLAY_TAB_SWITCH_TIMEOUT_MS })
    .then(() => {
      clickedByPlaywright = true;
    })
    .catch((error: unknown) => {
      log(options, "warn", "runtime", "shortplay manage tab Playwright click failed", {
        label,
        error,
      });
    });

  const clickedInPage = await dispatchShortplayManageTabClick(page, label);
  if (!clickedByPlaywright && !clickedInPage) {
    throw new Error(`Pinduoduo shortplay manage tab not found: ${label}`);
  }
  if (clickedInPage) {
    log(options, "info", "runtime", "shortplay manage tab DOM click dispatched", {
      label,
      clickedByPlaywright,
    });
  }

  await waitForShortplayManageTabActive(page, label).catch((error: unknown) => {
    log(options, "warn", "runtime", "shortplay manage tab active state was not detected", {
      label,
      error,
    });
  });
  log(options, "info", "runtime", "shortplay manage tab clicked", {
    label,
    elapsedMs: Date.now() - clickStartedAt,
  });
}

type ShortplayApplyListWaitResult = {
  containsExpectedTitle?: boolean;
  records: ShortplayApplyRecord[];
  received: boolean;
  totalCount?: number;
};

export type ShortplayApplyRecord = {
  id?: number;
  demoUrl?: string;
  episodeCount?: number;
  gmtCreate?: number;
  rejectReason?: string;
  status?: number;
  topicCreateStatus?: number;
  title: string;
};

export type ShortplaySubmittedApplyListResult = {
  page: number;
  pageSize: number;
  records: ShortplayApplyRecord[];
  totalCount?: number;
};

export function readShortplayApplyRecords(payload: unknown): ShortplayApplyRecord[] {
  if (typeof payload !== "object" || payload === null || !("result" in payload)) {
    return [];
  }

  const result = payload.result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return [];
  }

  const list = result.list;
  if (!Array.isArray(list)) {
    return [];
  }

  return list.flatMap((item): ShortplayApplyRecord[] => {
    if (typeof item !== "object" || item === null || !("title" in item)) {
      return [];
    }

    const title = item.title;
    if (typeof title !== "string" || !title.trim()) {
      return [];
    }

    return [
      {
        id: "id" in item && typeof item.id === "number" ? item.id : undefined,
        demoUrl: "demo_url" in item && typeof item.demo_url === "string" ? item.demo_url : undefined,
        episodeCount: "episode_count" in item && typeof item.episode_count === "number" ? item.episode_count : undefined,
        gmtCreate: "gmt_create" in item && typeof item.gmt_create === "number" ? item.gmt_create : undefined,
        rejectReason:
          "reject_reason" in item && typeof item.reject_reason === "string"
            ? item.reject_reason
            : undefined,
        status: "status" in item && typeof item.status === "number" ? item.status : undefined,
        topicCreateStatus:
          "topic_create_status" in item && typeof item.topic_create_status === "number"
            ? item.topic_create_status
            : undefined,
        title: title.trim(),
      },
    ];
  });
}

function shortplayApplyListPayloadTabType(payload: string | null): number | undefined {
  if (!payload) {
    return undefined;
  }

  const parsedPayload = (() => {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (
    typeof parsedPayload !== "object" ||
    parsedPayload === null ||
    !("tab_type" in parsedPayload)
  ) {
    return undefined;
  }

  const tabType = parsedPayload.tab_type;
  return typeof tabType === "number" ? tabType : undefined;
}

function shortplayApplyListContainsTitle(payload: unknown, title: string): boolean | undefined {
  if (typeof payload !== "object" || payload === null || !("result" in payload)) {
    return undefined;
  }

  const result = payload.result;
  if (typeof result !== "object" || result === null || !("list" in result)) {
    return undefined;
  }

  const list = result.list;
  if (!Array.isArray(list)) {
    return undefined;
  }

  return list.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "title" in item &&
      typeof item.title === "string" &&
      item.title.trim() === title,
  );
}

function shortplayApplyListTotalCount(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || !("result" in payload)) {
    return undefined;
  }

  const result = payload.result;
  if (typeof result !== "object" || result === null || !("total_count" in result)) {
    return undefined;
  }

  return typeof result.total_count === "number" ? result.total_count : undefined;
}

async function waitForShortplayApplyListResponse(
  page: Page,
  tabType: number,
  expectedTitle?: string,
): Promise<ShortplayApplyListWaitResult> {
  const response = await page
    .waitForResponse(
      (nextResponse) => {
        if (
          !nextResponse
            .url()
            .startsWith(`${PINDUODUO_MCN_ORIGIN}${PINDUODUO_SHORTPLAY_APPLY_LIST_PATH}`)
        ) {
          return false;
        }

        return shortplayApplyListPayloadTabType(nextResponse.request().postData()) === tabType;
      },
      { timeout: SHORTPLAY_LIST_RESPONSE_TIMEOUT_MS },
    )
    .catch(() => undefined);

  if (!response) {
    return { received: false, records: [] };
  }

  const payload = await response.json().catch(() => undefined);
  const records = readShortplayApplyRecords(payload);
  return {
    containsExpectedTitle: expectedTitle
      ? records.some((record) => record.title === expectedTitle) ||
        shortplayApplyListContainsTitle(payload, expectedTitle)
      : undefined,
    records,
    received: true,
    totalCount: shortplayApplyListTotalCount(payload),
  };
}

export async function fetchSubmittedShortplayApplyRecords(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  request: {
    page?: number;
    pageSize?: number;
  } = {},
): Promise<ShortplaySubmittedApplyListResult> {
  const pageNumber = request.page ?? 1;
  const pageSize = request.pageSize ?? SUBMITTED_SHORTPLAY_APPLY_LIST_PAGE_SIZE;
  log(options, "info", "runtime", "fetching submitted shortplay apply records by api", {
    page: pageNumber,
    pageSize,
    url: PINDUODUO_SHORTPLAY_APPLY_LIST_URL,
  });

  const result = await page.evaluate(
    async ({ requestBody, url }) => {
      const response = await fetch(url, {
        body: JSON.stringify(requestBody),
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        method: "POST",
        mode: "cors",
        referrer: "https://mcn.pinduoduo.com/home/shortplayManage",
      });
      const text = await response.text();
      let payload: unknown = text;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { message: text };
      }

      return {
        ok: response.ok,
        payload,
        status: response.status,
        statusText: response.statusText,
      };
    },
    {
      requestBody: {
        page: pageNumber,
        page_size: pageSize,
        tab_type: SHORTPLAY_MANAGE_TAB_TYPES["已提报短剧"],
      },
      url: PINDUODUO_SHORTPLAY_APPLY_LIST_URL,
    },
  );

  if (!result.ok) {
    throw new Error(
      `Pinduoduo submitted shortplay apply list failed: HTTP ${result.status} ${result.statusText}`,
    );
  }

  const records = readShortplayApplyRecords(result.payload);
  const totalCount = shortplayApplyListTotalCount(result.payload);
  log(options, "info", "runtime", "submitted shortplay apply records fetched by api", {
    page: pageNumber,
    pageSize,
    records: records.length,
    totalCount,
  });
  return {
    page: pageNumber,
    pageSize,
    records,
    totalCount,
  };
}

const APPROVED_SHORTPLAY_STATUS = 2;
const CREATED_SHORTPLAY_TOPIC_STATUS = 1;
const APPROVED_SHORTPLAY_LIST_PAGE_SIZE = 50;

export function shouldUploadApprovedShortplay(record: ShortplayApplyRecord): boolean {
  return (
    record.status === APPROVED_SHORTPLAY_STATUS &&
    record.topicCreateStatus !== CREATED_SHORTPLAY_TOPIC_STATUS
  );
}

export type ApprovedShortplayListPage = {
  createdTopicIds: number[];
  page: number;
  pageSize: number;
  rawCount: number;
  records: ShortplayApplyRecord[];
  totalCount?: number;
};

export async function fetchApprovedShortplays(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  pageNumber = 1,
): Promise<ApprovedShortplayListPage> {
  const result = await fetchSubmittedShortplayApplyRecords(page, options, {
    page: pageNumber,
    pageSize: APPROVED_SHORTPLAY_LIST_PAGE_SIZE,
  });
  const approvedRecords = result.records.filter(
    (record) => record.status === APPROVED_SHORTPLAY_STATUS,
  );
  return {
    createdTopicIds: approvedRecords.flatMap((record) =>
      record.topicCreateStatus === CREATED_SHORTPLAY_TOPIC_STATUS && record.id !== undefined
        ? [record.id]
        : [],
    ),
    page: result.page,
    pageSize: result.pageSize,
    rawCount: result.records.length,
    records: approvedRecords.filter(shouldUploadApprovedShortplay),
    totalCount: result.totalCount,
  };
}

async function clickShortplayManageTabAndWaitForList(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  label: string,
  expectedTitle?: string,
): Promise<void> {
  const tabType = SHORTPLAY_MANAGE_TAB_TYPES[label as keyof typeof SHORTPLAY_MANAGE_TAB_TYPES];
  const listResponsePromise =
    typeof tabType === "number"
      ? waitForShortplayApplyListResponse(page, tabType, expectedTitle)
      : Promise.resolve({ received: false, records: [] } satisfies ShortplayApplyListWaitResult);
  await clickShortplayManageTab(page, options, label);

  const listResponse = await listResponsePromise;
  if (!listResponse.received) {
    log(
      options,
      "warn",
      "runtime",
      "shortplay apply list response was not detected after tab click",
      {
        label,
        tabType,
        timeoutMs: SHORTPLAY_LIST_RESPONSE_TIMEOUT_MS,
      },
    );
  } else {
    log(options, "info", "runtime", "shortplay apply list response detected after tab click", {
      containsExpectedTitle: listResponse.containsExpectedTitle,
      expectedTitle,
      label,
      tabType,
      totalCount: listResponse.totalCount,
    });
  }

  await page.waitForTimeout(SHORTPLAY_TAB_REFRESH_SETTLE_MS);
}

export async function refreshShortplayManagePendingList(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  expectedTitle?: string,
): Promise<void> {
  log(options, "info", "runtime", "refreshing shortplay manage pending list by switching tabs");

  await clickShortplayManageTabAndWaitForList(page, options, "已提报短剧");
  await clickShortplayManageTabAndWaitForList(page, options, "待提报短剧", expectedTitle);

  log(options, "info", "runtime", "shortplay manage pending list refreshed");
}

export async function findSubmittedShortplayApplyRecord(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  title: string,
  filters: {
    platformApplyId?: number;
  } = {},
): Promise<ShortplayApplyRecord | null> {
  log(options, "info", "runtime", "checking submitted shortplay apply record", {
    platformApplyId: filters.platformApplyId,
    title,
  });

  const tabType = SHORTPLAY_MANAGE_TAB_TYPES["已提报短剧"];
  const listResponsePromise = waitForShortplayApplyListResponse(page, tabType, title);
  await clickShortplayManageTab(page, options, "已提报短剧");
  const listResponse = await listResponsePromise;
  const record =
    (filters.platformApplyId
      ? listResponse.records.find((nextRecord) => nextRecord.id === filters.platformApplyId)
      : undefined) ??
    listResponse.records.find((nextRecord) => nextRecord.title === title) ??
    null;

  log(options, record ? "info" : "warn", "runtime", "submitted shortplay apply record checked", {
    platformApplyId: filters.platformApplyId,
    record,
    title,
  });
  return record;
}

async function ensureShortplaySubmitAgreementChecked(page: Page): Promise<void> {
  const agreementText = page
    .locator('div[class*="CBX_textWrapper"]')
    .filter({ hasText: /^我已阅读并同意/ })
    .last();
  const checkboxWrapper = agreementText.locator("xpath=preceding-sibling::div[1]");
  const checkboxInput = checkboxWrapper.locator('input[type="checkbox"]').first();

  await agreementText.waitFor({ state: "visible", timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS });
  await checkboxInput.waitFor({ state: "attached", timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS });

  const wasAlreadyChecked = await checkboxInput.evaluate(
    (input) => input instanceof HTMLInputElement && input.checked,
  );

  if (!wasAlreadyChecked) {
    await checkboxWrapper.click({ force: true, timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS });
    await page.waitForFunction(
      (input) => input instanceof HTMLInputElement && input.checked,
      await checkboxInput.elementHandle(),
      { timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS },
    );
  }
}

function shortplaySubmitAllButton(page: Page): Locator {
  return page
    .locator('button[data-testid="beast-core-button"]')
    .filter({ hasText: /^提报全部$/ })
    .last();
}

async function waitForShortplaySubmitAllButtonEnabled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[data-testid="beast-core-button"]'),
      );
      const submitButton = buttons.find((button) => button.textContent?.trim() === "提报全部");
      return Boolean(submitButton && !submitButton.disabled);
    },
    undefined,
    { timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS },
  );
}

async function getShortplaySubmitToastMessage(page: Page): Promise<string | null> {
  const toast = page
    .locator(
      [
        'div[data-testid="beast-core-toast"] div[class*="TST_noticeWarn"]',
        'div[data-testid="beast-core-toast"] div[class*="TST_noticeError"]',
      ].join(", "),
    )
    .last();

  const visibleToast = await toast
    .waitFor({ state: "visible", timeout: SHORTPLAY_SUBMIT_TOAST_TIMEOUT_MS })
    .then(() => toast)
    .catch(() => null);

  if (!visibleToast) {
    return null;
  }

  return visibleToast
    .locator('div[class*="TST_noticeContent"]')
    .last()
    .textContent({ timeout: SHORTPLAY_SUBMIT_TOAST_TIMEOUT_MS })
    .then((text) => text?.trim() || null)
    .catch(() => null);
}

export async function submitSelectedShortplaysForAudit(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
): Promise<void> {
  log(options, "info", "runtime", "submitting selected shortplays for audit");

  await ensureShortplaySubmitAgreementChecked(page);
  await waitForShortplaySubmitAllButtonEnabled(page);
  const submitButton = shortplaySubmitAllButton(page);
  await page.waitForTimeout(SHORTPLAY_TAB_REFRESH_SETTLE_MS);
  await submitButton.click({ timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS });
  const toastMessage = await getShortplaySubmitToastMessage(page);
  if (toastMessage) {
    log(options, "error", "runtime", "pinduoduo shortplay submit failed with platform toast", {
      toastMessage,
    });
    throw new Error(`Pinduoduo shortplay submit failed: ${toastMessage}`);
  }
  await page.waitForTimeout(SHORTPLAY_TAB_REFRESH_SETTLE_MS);

  log(options, "info", "runtime", "selected shortplays submitted for audit");
}

type ShortplayRowCheckboxState = {
  checked: boolean;
  found: boolean;
  hasCheckbox: boolean;
};

function shortplayTitleCellLocator(page: Page, title: string): Locator {
  return page
    .locator('td[data-testid="beast-core-table-td"]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegex(title)}\\s*$`) })
    .first();
}

function shortplayCheckCellLocator(page: Page, title: string): Locator {
  return shortplayTitleCellLocator(page, title).locator("xpath=preceding-sibling::td[1]");
}

async function waitForShortplayTitleCell(page: Page, title: string): Promise<void> {
  await shortplayTitleCellLocator(page, title).waitFor({
    state: "visible",
    timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS,
  });
}

async function waitForShortplayRowReadyBeforeSelect(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  title: string,
): Promise<void> {
  const startedAt = Date.now();
  await waitForShortplayTitleCell(page, title);

  log(options, "info", "runtime", "shortplay manage row title found, waiting before selecting", {
    settleMs: SHORTPLAY_ROW_READY_SETTLE_MS,
    title,
  });

  await page.waitForTimeout(SHORTPLAY_ROW_READY_SETTLE_MS);
  await waitForShortplayTitleCell(page, title);

  log(options, "info", "runtime", "shortplay manage row is ready for selecting", {
    elapsedMs: Date.now() - startedAt,
    title,
  });
}

async function readShortplayRowCheckboxState(
  page: Page,
  title: string,
): Promise<ShortplayRowCheckboxState> {
  return page.evaluate((expectedTitle) => {
    const titleCell = Array.from(
      document.querySelectorAll<HTMLElement>('td[data-testid="beast-core-table-td"]'),
    ).find((element) => element.textContent?.trim() === expectedTitle);
    const checkCell = titleCell?.previousElementSibling;
    if (!(checkCell instanceof HTMLElement)) {
      return {
        checked: false,
        found: false,
        hasCheckbox: false,
      };
    }

    const checkboxLabel = checkCell.querySelector<HTMLElement>(
      '[data-testid="beast-core-checkbox"]',
    );
    const input = checkCell.querySelector<HTMLInputElement>('input[type="checkbox"]');
    return {
      checked: checkboxLabel?.dataset.checked === "true" || input?.checked === true,
      found: true,
      hasCheckbox: Boolean(checkboxLabel ?? input),
    };
  }, title);
}

async function waitForShortplayRowChecked(
  page: Page,
  title: string,
  timeout = SHORTPLAY_ROW_CHECK_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  return page
    .waitForFunction(
      (expectedTitle) => {
        const titleCell = Array.from(
          document.querySelectorAll<HTMLElement>('td[data-testid="beast-core-table-td"]'),
        ).find((element) => element.textContent?.trim() === expectedTitle);
        const checkCell = titleCell?.previousElementSibling;
        if (!(checkCell instanceof HTMLElement)) {
          return false;
        }

        const checkboxLabel = checkCell.querySelector<HTMLElement>(
          '[data-testid="beast-core-checkbox"]',
        );
        const input = checkCell.querySelector<HTMLInputElement>('input[type="checkbox"]');
        return checkboxLabel?.dataset.checked === "true" || input?.checked === true;
      },
      title,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

async function clickShortplayRowCheckboxLocator(
  page: Page,
  title: string,
  target: Locator,
  actionName: string,
  attempts: string[],
): Promise<boolean> {
  attempts.push(actionName);
  await target.click({ force: true, timeout: 3_000 });
  return waitForShortplayRowChecked(page, title);
}

async function setShortplayRowCheckboxLocator(
  page: Page,
  title: string,
  target: Locator,
  attempts: string[],
): Promise<boolean> {
  attempts.push("input.setChecked");
  await target.setChecked(true, { force: true, timeout: 3_000 });
  return waitForShortplayRowChecked(page, title);
}

async function clickShortplayRowCheckboxCenter(
  page: Page,
  title: string,
  checkCell: Locator,
  attempts: string[],
): Promise<boolean> {
  attempts.push("checkbox-cell.mouse");
  const box = await checkCell.boundingBox({ timeout: 3_000 });
  if (!box) {
    return false;
  }

  await page.mouse.click(box.x + Math.min(24, box.width / 2), box.y + box.height / 2);
  return waitForShortplayRowChecked(page, title);
}

async function selectShortplayRowCheckbox(
  page: Page,
  title: string,
): Promise<{
  attempts: string[];
  checkedBeforeClick: boolean;
  checkedAfterClick: boolean;
  found: boolean;
  hasCheckbox: boolean;
}> {
  const attempts: string[] = [];
  const checkCell = shortplayCheckCellLocator(page, title);
  await checkCell.waitFor({ state: "attached", timeout: SHORTPLAY_ROW_SELECT_TIMEOUT_MS });

  const beforeState = await readShortplayRowCheckboxState(page, title);
  if (!beforeState.found || !beforeState.hasCheckbox || beforeState.checked) {
    return {
      attempts,
      checkedAfterClick: beforeState.checked,
      checkedBeforeClick: beforeState.checked,
      found: beforeState.found,
      hasCheckbox: beforeState.hasCheckbox,
    };
  }

  const targets: Array<[string, Locator]> = [
    [
      "checkbox-checkIcon.click",
      checkCell.locator('[data-testid="beast-core-checkbox-checkIcon"]').first(),
    ],
    ["checkbox-label.click", checkCell.locator('[data-testid="beast-core-checkbox"]').first()],
    ["input.click", checkCell.locator('input[type="checkbox"]').first()],
  ];

  for (const [actionName, target] of targets) {
    const checked = await clickShortplayRowCheckboxLocator(
      page,
      title,
      target,
      actionName,
      attempts,
    ).catch(() => false);
    if (checked) {
      return {
        attempts,
        checkedAfterClick: true,
        checkedBeforeClick: false,
        found: true,
        hasCheckbox: true,
      };
    }
  }

  const checkedBySetChecked = await setShortplayRowCheckboxLocator(
    page,
    title,
    checkCell.locator('input[type="checkbox"]').first(),
    attempts,
  ).catch(() => false);
  if (checkedBySetChecked) {
    return {
      attempts,
      checkedAfterClick: true,
      checkedBeforeClick: false,
      found: true,
      hasCheckbox: true,
    };
  }

  const checkedByCellCenter = await clickShortplayRowCheckboxCenter(
    page,
    title,
    checkCell,
    attempts,
  ).catch(() => false);
  const afterState = await readShortplayRowCheckboxState(page, title);
  return {
    attempts,
    checkedAfterClick: checkedByCellCenter || afterState.checked,
    checkedBeforeClick: false,
    found: afterState.found,
    hasCheckbox: afterState.hasCheckbox,
  };
}

export async function selectShortplayManageRowByTitle(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  title: string,
): Promise<boolean> {
  log(options, "info", "runtime", "checking shortplay manage row before selecting", {
    title,
  });

  await waitForShortplayRowReadyBeforeSelect(page, options, title);
  const result = await selectShortplayRowCheckbox(page, title);
  if (!result.found) {
    log(options, "warn", "runtime", "shortplay manage row title was not found", {
      title,
    });
    return false;
  }

  if (!result.hasCheckbox) {
    log(options, "warn", "runtime", "shortplay manage row checkbox was not found", {
      title,
    });
    return false;
  }

  if (!result.checkedAfterClick) {
    throw new Error(`Pinduoduo shortplay manage row checkbox was not checked: ${title}`);
  }

  log(options, "info", "runtime", "shortplay manage row selected", {
    checkedAfterClick: result.checkedAfterClick,
    checkedBeforeClick: result.checkedBeforeClick,
    clickAttempts: result.attempts,
    title,
  });
  return true;
}
