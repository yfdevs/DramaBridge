import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(scriptDir);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(
  workspaceRoot,
  ".cache",
  "playwright-browsers",
);

const editUrl =
  "https://kdj.kuaishou.com/home/content/content-management/edit?step=0";
const cropDialogSelector =
  '.ks-dialog[aria-label="图片剪裁"]:visible,[role="dialog"][aria-label="图片剪裁"]:visible';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function ratioDifference(width, height, expectedRatio) {
  return Math.abs(width / height - expectedRatio);
}

async function requireFiles(files) {
  await Promise.all(files.map((file) => access(file)));
}

async function cancelDialog(dialog) {
  const cancel = dialog
    .locator("button,.ks-button")
    .filter({ hasText: /^\s*取\s*消\s*$/ })
    .last();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ timeout: 10_000 });
  } else {
    await dialog.locator('button[aria-label="close"]').click({ timeout: 10_000 });
  }
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
}

async function uploadAndMeasureCrop(page, input, file, expectedRatio, label, maximize) {
  await input.setInputFiles(file);
  const dialog = page.locator(cropDialogSelector).last();
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  const result = await maximize(page, dialog);
  const natural = await dialog.locator('img[alt="cropper-img"],img').first().evaluate((source) => ({
    width: source.naturalWidth,
    height: source.naturalHeight,
  }));
  const ratioError = ratioDifference(result.after.width, result.after.height, expectedRatio);
  const passed = ratioError <= 0.005 && result.coverage.covers;
  await cancelDialog(dialog);
  if (!passed) {
    throw new Error(
      `LIVE_CROP_VALIDATION_FAILED: ${label} ` +
        `ratioError=${ratioError} coverage=${JSON.stringify(result.coverage)}`,
    );
  }
  return {
    label,
    file,
    expectedRatio,
    ratioError,
    natural,
    result,
  };
}

async function main() {
  const [storageStateFile, landscapeFile, portraitFile] = process.argv.slice(2).map((value) =>
    value ? path.resolve(value) : value,
  );
  if (!storageStateFile || !landscapeFile || !portraitFile) {
    throw new Error(
      "用法：pnpm kuaishou-drama:test-covers-live -- " +
        '"D:\\path\\storage-state.json" "D:\\path\\landscape.jpg" "D:\\path\\portrait.jpg"',
    );
  }
  await requireFiles([storageStateFile, landscapeFile, portraitFile]);

  const [{ chromium }, { maximizeKuaishouImageCropArea }] = await Promise.all([
    import("playwright"),
    import("@dramabridge/kuaishou-drama-automation"),
  ]);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: storageStateFile,
    viewport: { width: 1_440, height: 900 },
  });
  const page = await context.newPage();
  const report = {
    editUrl,
    storageStateFile,
    submitted: false,
    tests: [],
  };
  try {
    await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (/login/i.test(page.url())) throw new Error("KUAISHOU_LIVE_TEST_LOGIN_REQUIRED");
    await page.getByRole("heading", { name: "短剧基础信息" }).waitFor({
      state: "visible",
      timeout: 60_000,
    });

    const pageImageInputs = page.locator('input[type="file"][accept*="image"]');
    if (await pageImageInputs.count() < 2) {
      throw new Error("KUAISHOU_LIVE_TEST_PAGE_COVER_INPUTS_MISSING");
    }
    report.tests.push(await uploadAndMeasureCrop(
      page,
      pageImageInputs.nth(0),
      landscapeFile,
      414 / 258,
      "短剧横版封面",
      maximizeKuaishouImageCropArea,
    ));

    await page.getByRole("button", { name: "批量设置", exact: true }).click({
      timeout: 30_000,
    });
    const batchDialog = page.getByRole("dialog", { name: "批量设置", exact: true });
    await batchDialog.waitFor({ state: "visible", timeout: 30_000 });
    const batchCoverInput = batchDialog.locator('input[type="file"][accept*="image"]').first();
    await batchCoverInput.waitFor({ state: "attached", timeout: 15_000 });
    report.tests.push(await uploadAndMeasureCrop(
      page,
      batchCoverInput,
      portraitFile,
      224 / 300,
      "批量单集竖版封面",
      maximizeKuaishouImageCropArea,
    ));
    await cancelDialog(batchDialog);

    console.log(`[kuaishou-cover-live-test] 通过：${JSON.stringify(report)}`);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[kuaishou-cover-live-test] 失败：${errorMessage(error)}`);
  process.exitCode = 1;
});
