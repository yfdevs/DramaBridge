import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Playwright may be imported by another platform before the boot boundary sets
// its environment. Resolve the pinned binary explicitly rather than depending
// on Playwright's module-initialization-time registry directory.
export function resolveDataSyncBrowserExecutable(browsersPath: string): string {
  const require = createRequire(import.meta.url);
  const playwrightRequire = createRequire(require.resolve("playwright/package.json"));
  const manifestPath = path.join(
    path.dirname(playwrightRequire.resolve("playwright-core/package.json")),
    "browsers.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    browsers: Array<{ name: string; revision: string }>;
  };
  const chromium = manifest.browsers.find((browser) => browser.name === "chromium");
  if (!chromium) throw new Error("当前 Playwright 未声明 Chromium 版本");
  const relative =
    process.platform === "win32"
      ? "chrome-win64/chrome.exe"
      : process.platform === "darwin"
        ? "chrome-mac/Chromium.app/Contents/MacOS/Chromium"
        : "chrome-linux64/chrome";
  const candidates = [
    relative,
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ];
  const directory = path.join(browsersPath, `chromium-${chromium.revision}`);
  const executable = candidates
    .map((file) => path.join(directory, file))
    .find((file) => existsSync(file));
  if (!executable)
    throw new Error(
      `找不到数据同步所需的 Chromium ${chromium.revision}，请检查应用浏览器资源：${directory}`,
    );
  return executable;
}
