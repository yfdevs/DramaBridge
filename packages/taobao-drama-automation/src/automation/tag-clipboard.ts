import type { Page } from "playwright";
import { errorLog } from "../shared/logger.js";

type ClipboardSnapshot = Array<Array<{ type: string; bytes: number[] }>>;
let clipboardQueue = Promise.resolve();

/** Native paste is required by Cangjie. Serialize accounts sharing the OS clipboard. */
export async function pasteTaobaoTagWithClipboard(page: Page, text: string) {
  const previous = clipboardQueue;
  let release!: () => void;
  clipboardQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let snapshot: ClipboardSnapshot | undefined;
  let changed = false;
  let granted = false;
  try {
    const url = new URL(page.url());
    if (!["creator.guanghe.taobao.com", "creator.tiancheng.taobao.com"].includes(url.hostname)) {
      throw new Error("当前主页面不是淘宝创作者页面，无法执行原生粘贴");
    }
    await page.bringToFront();
    // The embedded upload frame forbids the Clipboard API. Read/write through
    // the creator top-level document; Ctrl+V still targets the focused textarea.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: url.origin });
    granted = true;
    snapshot = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const saved = await Promise.all(items.map((item) => Promise.all(item.types.map(async (type) => ({
        type, bytes: Array.from(new Uint8Array(await (await item.getType(type)).arrayBuffer())),
      })))));
      return saved.filter((item) => item.length > 0);
    });
    await page.evaluate(async (value) => navigator.clipboard.writeText(value), text);
    changed = true;
    await page.keyboard.press("Control+V");
  } catch (error) {
    throw Object.assign(new Error("TAOBAO_DRAMA_CONTENT_TAG_PASTE_FAILED: 无法将完整内容标签原生粘贴到淘宝标签输入框，请检查浏览器焦点和剪贴板权限。"), { cause: error });
  } finally {
    try {
      if (changed && snapshot) {
        await page.evaluate(async ({ saved, inserted }) => {
          const current = await navigator.clipboard.read();
          // Preserve a new copy made by the user while the operation was running.
          if (current.some((item) => item.types.some((type) => type !== "text/plain")) ||
              await navigator.clipboard.readText() !== inserted) return;
          if (saved.length === 0) {
            await navigator.clipboard.writeText("");
          } else {
            await navigator.clipboard.write(saved.map((item) => new ClipboardItem(Object.fromEntries(
              item.map(({ type, bytes }) => [type, new Blob([new Uint8Array(bytes)], { type })]),
            ))));
          }
        }, { saved: snapshot, inserted: text }).catch((error: unknown) => {
          errorLog({}, "[taobao-drama] 原生标签粘贴后恢复剪贴板失败", { error });
        });
      }
    } finally {
      if (granted) await page.context().clearPermissions().catch(() => undefined);
      release();
    }
  }
}
