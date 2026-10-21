import { safeFileName } from "@dramabridge/file-utils";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { log } from "../shared/logger.js";
import type { ClaimedPinduoduoDramaTask, PinduoduoDramaRuntimeOptions } from "../shared/types.js";

const CONTRACT_DOWNLOAD_TIMEOUT_MS = 120_000;
const CONTRACT_UPLOAD_INPUT_TIMEOUT_MS = 30_000;
const CONTRACT_REQUIRED_FILE_COUNT = 2;
const CONTRACT_UPLOAD_INPUT_SELECTOR =
  'input[data-testid="beast-core-upload-input"][type="file"][accept=".pdf"]';

type ContractAsset = {
  fileName: string;
  label: string;
  url: string;
};

function safeFileNamePart(value: string): string {
  return safeFileName(value, { fallback: "未命名短剧", replacement: " " });
}

function contractDownloadDir(options: PinduoduoDramaRuntimeOptions): string {
  if (options.accountDir) {
    return join(options.accountDir, "upload-assets", "contracts");
  }

  if (options.userDataDir) {
    return join(dirname(options.userDataDir), "upload-assets", "contracts");
  }

  throw new Error("PINDUODUO_CONTRACT_UPLOAD_DIR_REQUIRED");
}

function taskContractAssets(task: ClaimedPinduoduoDramaTask): ContractAsset[] {
  const title = safeFileNamePart(task.playlet.title);
  const assets: ContractAsset[] = [];

  if (task.playlet.productionProofFileUrl) {
    assets.push({
      fileName: `${title}-制作合同.pdf`,
      label: "制作合同",
      url: task.playlet.productionProofFileUrl,
    });
  }

  if (task.playlet.licenseProofFileUrl) {
    assets.push({
      fileName: `${title}-授权合同.pdf`,
      label: "授权合同",
      url: task.playlet.licenseProofFileUrl,
    });
  }

  return assets;
}

async function downloadContractAsset(
  asset: ContractAsset,
  options: PinduoduoDramaRuntimeOptions,
): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CONTRACT_DOWNLOAD_TIMEOUT_MS);
  const target = join(contractDownloadDir(options), asset.fileName);

  try {
    const response = await fetch(asset.url, {
      redirect: "follow",
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${asset.url}`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    log(options, "info", "runtime", "pinduoduo contract file downloaded", {
      filePath: target,
      label: asset.label,
      url: asset.url,
    });
    return target;
  } catch (error) {
    if (abortController.signal.aborted) {
      throw Object.assign(
        new Error(`Pinduoduo contract download timed out after ${CONTRACT_DOWNLOAD_TIMEOUT_MS}ms`),
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForUploadedContractPreviews(
  page: Page,
  filePaths: string[],
  options: PinduoduoDramaRuntimeOptions,
): Promise<void> {
  const expectedCount = filePaths.length;
  const fileNames = filePaths
    .map((filePath) => {
      const parts = filePath.split(/[\\/]/);
      return parts[parts.length - 1];
    })
    .filter(Boolean);

  await page.waitForFunction(
    (count) => {
      const completedPreviews = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[data-testid="beast-core-upload-preview"]'),
      ).filter((anchor) => {
        const href = anchor.getAttribute("href")?.trim();
        const text = anchor.textContent?.trim() ?? "";
        const successIcon = anchor.querySelector(
          '[data-testid="beast-core-icon-check-circle_filled"]',
        );

        return Boolean(href && text.toLowerCase().includes(".pdf") && successIcon);
      });

      return completedPreviews.length >= count;
    },
    expectedCount,
    { timeout: CONTRACT_UPLOAD_INPUT_TIMEOUT_MS },
  );

  const previews = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[data-testid="beast-core-upload-preview"]'),
    )
      .map((anchor) => {
        const href = anchor.getAttribute("href")?.trim() ?? null;
        const text = anchor.textContent?.trim() ?? null;
        const completed = Boolean(
          href &&
            (text ?? "").toLowerCase().includes(".pdf") &&
            anchor.querySelector(
              '[data-testid="beast-core-icon-check-circle_filled"]',
            ),
        );
        return {
          completed,
          href,
          text,
        };
      })
      .filter((preview) => preview.completed),
  );

  log(options, "info", "runtime", "pinduoduo contract upload previews completed in ui", {
    expectedCount,
    files: fileNames,
    previews,
  });
}

export async function uploadPinduoduoContractFiles(
  page: Page,
  options: PinduoduoDramaRuntimeOptions,
  task: ClaimedPinduoduoDramaTask,
): Promise<void> {
  const assets = taskContractAssets(task);
  if (assets.length !== CONTRACT_REQUIRED_FILE_COUNT) {
    log(options, "error", "runtime", "pinduoduo contract upload missing required contract urls", {
      accountTaskId: task.accountTaskId,
      contractCount: assets.length,
      dramaId: task.dramaId,
      requiredContractCount: CONTRACT_REQUIRED_FILE_COUNT,
      title: task.playlet.title,
    });
    throw new Error(
      `Pinduoduo contract upload requires ${CONTRACT_REQUIRED_FILE_COUNT} PDF files, got ${assets.length}`,
    );
  }

  const filePaths = await Promise.all(assets.map((asset) => downloadContractAsset(asset, options)));
  const uploadInput = page.locator(CONTRACT_UPLOAD_INPUT_SELECTOR).first();
  await uploadInput.waitFor({ state: "attached", timeout: CONTRACT_UPLOAD_INPUT_TIMEOUT_MS });
  await uploadInput.setInputFiles(filePaths, { timeout: CONTRACT_UPLOAD_INPUT_TIMEOUT_MS });
  await waitForUploadedContractPreviews(page, filePaths, options);

  log(options, "info", "runtime", "pinduoduo contract files uploaded", {
    accountTaskId: task.accountTaskId,
    dramaId: task.dramaId,
    files: filePaths,
    title: task.playlet.title,
  });
}
