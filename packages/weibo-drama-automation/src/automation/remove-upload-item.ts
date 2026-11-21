import type { Locator, Page } from "playwright";

/** Vue keeps a removed upload item in the DOM until its leave animation ends. */
export async function removeWeiboUploadItem(
  page: Page,
  item: Locator,
  remove: () => Promise<unknown>,
) {
  const element = await item.elementHandle();
  if (!element) throw new Error("WEIBO_DRAMA_UPLOAD_ITEM_MISSING: 待删除的上传项不存在");
  try {
    await remove();
    // Track the original node, not .first()/.last(), which can resolve to the next item.
    await page.waitForFunction((node) => !node.isConnected, element, { timeout: 10_000 });
  } finally {
    await element.dispose();
  }
}
