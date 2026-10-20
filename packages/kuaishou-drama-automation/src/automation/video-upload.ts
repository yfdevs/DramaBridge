import path from "node:path";
import type { Page } from "playwright";
import {
  cleanupEpisodeUploadFiles,
  prepareEpisodeUploadFiles,
  type PreparedEpisodeUploadFiles,
} from "@dramabridge/media-assets";
import type {
  KuaishouDramaPublishVariant,
  KuaishouDramaRuntimeOptions,
  KuaishouDramaTaskConfig,
} from "../shared/types.js";
import { log } from "./browser-session.js";
import { getKuaishouDramaLocalEpisodeVideoRoot } from "../shared/local-episode-videos.js";
import { throwIfKuaishouWarningCaptured } from "./warning-guard.js";

const batchUploadPollMs = 2_000;

function normalizedFileNames(files: string[]) {
  return files.map((file) => path.basename(file));
}

async function confirmBatchUploadStartEpisode(
  page: Page,
  options: KuaishouDramaRuntimeOptions,
) {
  const dialog = page
    .locator('.ks-dialog[aria-label="请选择批量上传位置"]:visible')
    .last();
  await dialog.waitFor({ state: "visible", timeout: 30_000 });

  const startEpisodeInput = dialog.locator('input.ks-input__inner[placeholder="请输入"]').first();
  await startEpisodeInput.fill("1", { timeout: 30_000 });
  if (await startEpisodeInput.inputValue() !== "1") {
    throw new Error("KUAISHOU_DRAMA_BATCH_UPLOAD_START_EPISODE_INPUT_FAILED");
  }

  const confirm = dialog
    .locator("button.ks-button--primary")
    .filter({ hasText: /^\s*确\s*定\s*$/ })
    .last();
  await confirm.click({ timeout: 30_000 });
  await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  log(options, "[kuaishou-drama] batch upload start episode confirmed: 1");
}

async function clickStartBatchUpload(
  page: Page,
  options: KuaishouDramaRuntimeOptions,
) {
  const drawerFooter = page.locator(".drawer-footer:visible").last();
  await drawerFooter.waitFor({ state: "visible", timeout: 30_000 });
  const startUpload = drawerFooter
    .locator("button.ks-button--primary")
    .filter({ hasText: /^\s*开始上传\s*$/ })
    .last();
  await startUpload.waitFor({ state: "visible", timeout: 30_000 });
  await startUpload.click({ timeout: 30_000 });

  const transitionDeadline = Date.now() + 30_000;
  while (Date.now() < transitionDeadline) {
    const uploading = drawerFooter
      .locator("button.ks-button--primary.is-loading")
      .filter({ hasText: /^\s*上传中\s*$/ })
      .last();
    const completed = drawerFooter
      .locator("button.ks-button--primary:not([disabled])")
      .filter({ hasText: /^\s*确\s*定\s*$/ })
      .last();
    if (
      await uploading.isVisible().catch(() => false) ||
      await completed.isVisible().catch(() => false)
    ) {
      log(options, "[kuaishou-drama] batch episode upload started");
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("KUAISHOU_DRAMA_VIDEO_UPLOAD_DID_NOT_START");
}

async function waitForBatchUploadComplete(
  page: Page,
  options: KuaishouDramaRuntimeOptions,
) {
  const drawerFooter = page.locator(".drawer-footer:visible").last();
  const timeoutMinutes = Math.max(1, options.videoUploadTimeoutMinutes ?? 120);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastStatus = "";
  log(options, `[kuaishou-drama] waiting for batch upload: timeout=${timeoutMinutes} minutes`);

  while (Date.now() < deadline) {
    await throwIfKuaishouWarningCaptured(page, options);

    const errorMessages = await page
      .locator(".ks-message--error:visible,.ks-form-item__error:visible,.err-tips:visible")
      .allInnerTexts()
      .catch(() => []);
    const normalizedErrors = Array.from(new Set(
      errorMessages.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean),
    ));
    if (normalizedErrors.length) {
      throw new Error(`KUAISHOU_DRAMA_VIDEO_UPLOAD_FAILED: ${normalizedErrors.join(" | ")}`);
    }

    if (!await drawerFooter.isVisible().catch(() => false)) {
      throw new Error("KUAISHOU_DRAMA_VIDEO_UPLOAD_DRAWER_CLOSED_BEFORE_CONFIRM");
    }

    const confirm = drawerFooter
      .locator("button.ks-button--primary:not([disabled])")
      .filter({ hasText: /^\s*确\s*定\s*$/ })
      .last();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click({ timeout: 30_000 });
      await drawerFooter.waitFor({ state: "hidden", timeout: 30_000 });
      log(options, "[kuaishou-drama] batch episode upload completed and drawer confirmed");
      return;
    }

    const status = (await drawerFooter.innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (/上传失败|上传异常|失败/.test(status)) {
      throw new Error(`KUAISHOU_DRAMA_VIDEO_UPLOAD_FAILED: ${status}`);
    }
    if (status && status !== lastStatus) {
      lastStatus = status;
      log(options, `[kuaishou-drama] batch episode upload status: ${status}`);
    }

    await page.waitForTimeout(batchUploadPollMs);
  }

  throw new Error(
    `KUAISHOU_DRAMA_VIDEO_UPLOAD_TIMEOUT: timeoutMinutes=${timeoutMinutes} ` +
      `status=${lastStatus || "unknown"}`,
  );
}

async function submitKuaishouDramaForReview(
  page: Page,
  options: KuaishouDramaRuntimeOptions,
) {
  const postSubmitSettleMs = 10_000;
  const submitVerificationTimeoutMs = 90_000;
  const footer = page.locator(".handle-footer:visible").last();
  await footer.waitFor({ state: "visible", timeout: 60_000 });
  const submit = footer
    .locator("button.ks-button--primary")
    .filter({ hasText: /^\s*提交审核\s*$/ })
    .last();
  await submit.waitFor({ state: "visible", timeout: 30_000 });
  await submit.scrollIntoViewIfNeeded();
  const submittedAt = Date.now();
  await submit.click({ timeout: 30_000 });
  log(
    options,
    `[kuaishou-drama] submit for review clicked; waiting ${postSubmitSettleMs}ms ` +
      "before the page may be closed",
  );
  let verified = false;
  while (Date.now() - submittedAt < submitVerificationTimeoutMs) {
    await throwIfKuaishouWarningCaptured(page, options);
    const currentUrl = new URL(page.url());
    const returnedToManagement = currentUrl.origin === "https://kdj.kuaishou.com" &&
      currentUrl.pathname.startsWith("/home/content/content-management") &&
      currentUrl.pathname !== "/home/content/content-management/edit";
    const successMessage = await page.locator(
      '.ks-message--success:visible, .ks-result--success:visible',
    ).filter({ hasText: /提交成功|提交审核成功|已提交审核|提交审核已完成/ }).first()
      .isVisible().catch(() => false);
    verified ||= returnedToManagement || successMessage;
    if (verified && Date.now() - submittedAt >= postSubmitSettleMs) {
      log(options, `[kuaishou-drama] submit success verified after ${Date.now() - submittedAt}ms: ${page.url()}`);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`KUAISHOU_DRAMA_SUBMIT_SUCCESS_NOT_VERIFIED: url=${page.url()}`);
}

export async function uploadKuaishouDramaEpisodeVideos(
  page: Page,
  task: KuaishouDramaTaskConfig,
  variant: KuaishouDramaPublishVariant,
  resourceName: string,
  options: KuaishouDramaRuntimeOptions,
) {
  const uploadRootDir = options.assetDownloadDir?.trim();
  if (!uploadRootDir) {
    throw new Error("KUAISHOU_DRAMA_EPISODE_UPLOAD_ASSET_DIR_REQUIRED");
  }

  let prepared: PreparedEpisodeUploadFiles | null = null;
  try {
    prepared = await prepareEpisodeUploadFiles({
      localEpisodeVideoRoot: getKuaishouDramaLocalEpisodeVideoRoot(options),
      resourceName,
      uploadRootDir,
      uploadBaseName: variant.title,
    });
    if (prepared.files.length !== task.episodeCount) {
      throw new Error(
        `KUAISHOU_DRAMA_EPISODE_UPLOAD_FILE_COUNT_INVALID: ` +
          `actual=${prepared.files.length} expected=${task.episodeCount}`,
      );
    }

    const expectedNames = normalizedFileNames(prepared.files);
    const expectedLastName = expectedNames[expectedNames.length - 1];
    log(
      options,
      `[kuaishou-drama] prepared episode videos: variant=${variant.kind} ` +
        `count=${prepared.files.length} first=${expectedNames[0]} ` +
        `last=${expectedLastName}`,
    );

    const input = page.locator('input#batch-upload[type="file"][multiple]').first();
    await input.waitFor({ state: "attached", timeout: 60_000 });
    await input.setInputFiles(prepared.files, { timeout: 20 * 60_000 });

    const selectedNames = await input.evaluate((node) => (
      Array.from((node as HTMLInputElement).files ?? []).map((file) => file.name)
    ));
    if (
      selectedNames.length !== expectedNames.length ||
      selectedNames.some((name, index) => name !== expectedNames[index])
    ) {
      const selectedLastName = selectedNames[selectedNames.length - 1];
      throw new Error(
        `KUAISHOU_DRAMA_BATCH_UPLOAD_SELECTION_INVALID: ` +
          `actual=${selectedNames.length} expected=${expectedNames.length} ` +
          `first=${selectedNames[0] ?? "-"} last=${selectedLastName ?? "-"}`,
      );
    }

    log(
      options,
      `[kuaishou-drama] batch episode videos selected: variant=${variant.kind} ` +
        `count=${selectedNames.length}`,
    );
    await confirmBatchUploadStartEpisode(page, options);
    await clickStartBatchUpload(page, options);
    await waitForBatchUploadComplete(page, options);
    await submitKuaishouDramaForReview(page, options);
  } finally {
    if (prepared) {
      await cleanupEpisodeUploadFiles(prepared);
    }
  }
}
