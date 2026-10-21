import type { BrowserContext, Page } from "playwright";
import { QQ_DRAMA_ADD_URL } from "../shared/constants.js";
import { log } from "../shared/logger.js";
import type { ClaimedQqDramaTask, QqDramaRuntimeOptions } from "../shared/types.js";
import {
  qqDramaLoginStateFromUrl,
  saveCredentialState,
  waitForLoginIfNeeded,
} from "./browser-session.js";
import { fillBasicInfoStep } from "./steps/basic-info.js";
import { confirmAndSubmitStep } from "./steps/confirm.js";
import { uploadEpisodeVideosStep } from "./steps/episodes.js";
import {
  installQqPageMessageCapture,
  qqPageMessageErrorLocator,
} from "./steps/form-controls.js";

export function qqDramaAddPageRecoveryAction(pageText: string) {
  const normalized = pageText.replace(/\s+/g, " ").trim();
  return normalized.includes("漫剧提交成功") && normalized.includes("继续添加")
    ? "continue-adding" as const
    : undefined;
}

export async function openQqDramaAddPage(
  page: Page,
  context: BrowserContext,
  options: QqDramaRuntimeOptions,
) {
  async function gotoAddPage() {
    await page.goto(QQ_DRAMA_ADD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  async function waitForBasicInfoPageReady() {
    let deadline = Date.now() + 60_000;
    let successPageRecoveryAttempts = 0;
    const titleInput = page
      .locator("input[placeholder*='审核通过后不支持修改'],input[placeholder*='作品名称']")
      .filter({ visible: true })
      .first();

    while (Date.now() < deadline) {
      if (await titleInput.count() > 0) return;

      if (qqDramaLoginStateFromUrl(page.url()) === "login-required") {
        await waitForLoginIfNeeded(page, context, options);
        await gotoAddPage();
        deadline = Date.now() + 60_000;
        continue;
      }

      const pageText = await page.locator("body").innerText().catch(() => "");
      if (qqDramaAddPageRecoveryAction(pageText) === "continue-adding") {
        const continueAddingButton = page
          .getByRole("button", { name: "继续添加", exact: true })
          .filter({ visible: true })
          .or(page.getByText("继续添加", { exact: true }).filter({ visible: true }))
          .first();
        if (await continueAddingButton.count() > 0) {
          successPageRecoveryAttempts += 1;
          if (successPageRecoveryAttempts > 3) {
            throw new Error(
              "QQ_DRAMA_SUCCESS_PAGE_RECOVERY_FAILED: 多次点击继续添加后仍停留在提交成功页。",
            );
          }
          log(
            options,
            `[qq-drama] stale submission success page detected; clicking continue adding `
              + `(attempt=${successPageRecoveryAttempts})`,
          );
          await continueAddingButton.click({ timeout: 10_000 });
          await page.waitForTimeout(800);
          deadline = Date.now() + 60_000;
          continue;
        }
      }

      await page.waitForTimeout(500);
    }

    const pageText = (await page.locator("body").innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    throw new Error(
      `QQ_DRAMA_BASIC_INFO_NOT_READY: 等待作品名称输入框显示超时；url=${page.url()}; pageText=${pageText || "空"}`,
    );
  }

  await gotoAddPage();
  if (await waitForLoginIfNeeded(page, context, options)) {
    await gotoAddPage();
  }
  await waitForBasicInfoPageReady();

  await saveCredentialState(context, options).catch(() => undefined);
}

export function isQqFinishUploadTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("QQ_DRAMA_PAGE_MESSAGE")
    && /finish\s*upload/i.test(message)
    && /(?:timeout|timed\s*out|context deadline exceeded)/i.test(message);
}

export async function runQqDramaPublishTask(
  page: Page,
  context: BrowserContext,
  task: ClaimedQqDramaTask,
  options: QqDramaRuntimeOptions,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let submissionStarted = false;
    try {
      log(options, `[qq-drama] opening add page for accountTaskId=${task.accountTaskId}`);
      await openQqDramaAddPage(page, context, options);
      await installQqPageMessageCapture(page);

      const messageErrors = qqPageMessageErrorLocator(page);
      await page.addLocatorHandler(
        messageErrors,
        async (messages) => {
          const texts = [
            ...new Set(
              (await messages.allInnerTexts())
                .map((text) => text.replace(/\s+/g, " ").trim())
                .filter(Boolean),
            ),
          ];
          throw new Error(`QQ_DRAMA_PAGE_MESSAGE: ${texts.join("；") || "QQ 页面出现错误提示"}`);
        },
        { noWaitAfter: true },
      );

      try {
        log(options, `[qq-drama] start basic info step: accountTaskId=${task.accountTaskId}`);
        await fillBasicInfoStep(page, task, options);

        log(options, `[qq-drama] start episode upload step: accountTaskId=${task.accountTaskId}`);
        await uploadEpisodeVideosStep(page, task, options);

        log(options, `[qq-drama] start confirm step: accountTaskId=${task.accountTaskId}`);
        submissionStarted = true;
        await confirmAndSubmitStep(page, task, options);

        await saveCredentialState(context, options).catch(() => undefined);
      } finally {
        await page.removeLocatorHandler(messageErrors).catch(() => undefined);
      }
      return;
    } catch (error) {
      if (attempt > 0 || submissionStarted || !isQqFinishUploadTimeout(error)) throw error;

      log(
        options,
        `[qq-drama] finishupload timed out; refreshing page and restarting task `
          + `(retry=1/1, accountTaskId=${task.accountTaskId}): ${String(error)}`,
      );
      // The failed attempt has removed its locator handler before refreshing.
      // Reload clears the form and captured page messages; the next attempt starts from basic info.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    }
  }
}
