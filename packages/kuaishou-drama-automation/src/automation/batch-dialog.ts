import type { Locator, Page } from "playwright";

export async function confirmVisibleKuaishouPriceNotice(page: Page) {
  const confirm = page.locator("button:visible,.ks-button:visible")
    .filter({ hasText: /^\s*我已确认\s*$/ }).first();
  if (!(await confirm.isVisible())) return false;
  await confirm.click({ timeout: 5_000 });
  await confirm.waitFor({ state: "hidden", timeout: 5_000 });
  return true;
}

export async function confirmKuaishouBatchDialog(page: Page, dialog: Locator) {
  const confirm = dialog.locator("button:visible,.ks-button:visible")
    .filter({ hasText: /^\s*确\s*认\s*$/ }).first();
  await confirm.click({ timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const noticeConfirmed = await confirmVisibleKuaishouPriceNotice(page);
    if (!(await dialog.isVisible())) return;
    if (noticeConfirmed) {
      // A price warning can require confirmation again. An ordinary async
      // close does not: clicking twice races with the disappearing dialog.
      const closed = await dialog.waitFor({ state: "hidden", timeout: 1_000 })
        .then(() => true).catch(() => false);
      if (closed) return;
      try {
        await confirm.click({ timeout: 2_000 });
      } catch (error) {
        if (!(await dialog.isVisible())) return;
        throw error;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error("KUAISHOU_DRAMA_BATCH_CONFIRM_TIMEOUT: 批量设置确认后未关闭，请检查表单或价格提示");
}
