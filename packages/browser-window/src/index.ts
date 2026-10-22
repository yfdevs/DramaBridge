import { chromium, type BrowserContext, type Page } from "playwright";

type LaunchOptions = Parameters<typeof chromium.launchPersistentContext>[1];

/** All platform browser windows use two thirds of their monitor's work area. */
export async function launchPlatformBrowserContext(
  userDataDir: string,
  options: LaunchOptions = {},
): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...options,
    ...(options.headless === false ? { viewport: null } : {}),
  });
  // Playwright defaults to headless. Background checks need no native window.
  if (options.headless !== false) return context;

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const bounds = await page.evaluate(() => {
      // Chromium exposes monitor offsets in CSS pixels, matching CDP bounds
      // even on scaled displays or monitors to the left of the primary one.
      const screen = window.screen as Screen & { availLeft: number; availTop: number };
      return {
        left: screen.availLeft,
        top: screen.availTop,
        width: Math.round((screen.availWidth * 2) / 3),
        height: Math.round((screen.availHeight * 3) / 4),
      };
    });
    const windows = new Map<number, Promise<void>>();

    const applyBounds = async (target: Page) => {
      const session = await context.newCDPSession(target);
      try {
        const { windowId } = await session.send("Browser.getWindowForTarget");
        let pending = windows.get(windowId);
        if (!pending) {
          pending = (async () => {
            // A profile may restore a maximized/minimized window. Chromium
            // requires restoring it before setting position and dimensions.
            await session.send("Browser.setWindowBounds", {
              windowId,
              bounds: { windowState: "normal" },
            });
            await session.send("Browser.setWindowBounds", { windowId, bounds });
          })();
          windows.set(windowId, pending);
        }
        await pending;
      } finally {
        await session.detach().catch(() => undefined);
      }
    };

    // Popups can create additional native windows. Tabs in an existing window
    // share its windowId and do not need another resize.
    context.on("page", (target) => {
      void applyBounds(target).catch((error: unknown) => {
        if (!target.isClosed())
          console.warn("[browser-window] 无法设置浏览器窗口大小和位置", error);
      });
    });
    await Promise.all(context.pages().map(applyBounds));
    return context;
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}
