import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wechatDramaPackageRoot = path.join(root, "packages", "wechat-drama-automation");
const browserPath = path.join(root, ".cache", "playwright-browsers");
const wechatDramaRequire = createRequire(path.join(wechatDramaPackageRoot, "package.json"));
let playwrightPackageJson;

try {
  playwrightPackageJson = wechatDramaRequire.resolve("playwright/package.json");
} catch (error) {
  throw new Error(
    "Cannot resolve playwright from packages/wechat-drama-automation. Run `pnpm install` from the repository root first.",
    { cause: error },
  );
}

const playwrightCli = path.join(path.dirname(playwrightPackageJson), "cli.js");
const playwrightCorePackageJson = wechatDramaRequire.resolve("playwright-core/package.json");
const playwrightCoreRoot = path.dirname(playwrightCorePackageJson);
const browsers = JSON.parse(readFileSync(path.join(playwrightCoreRoot, "browsers.json"), "utf8"));
const chromium = browsers.browsers?.find((browser) => browser.name === "chromium");
if (!chromium?.revision) throw new Error("Cannot resolve the Playwright Chromium revision.");
const installedBrowserDirectory = path.join(browserPath, `chromium-${chromium.revision}`);
// Resolve the real executable layout from this installed Playwright version,
// including the Apple Silicon Chrome for Testing app bundle.
process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
const installedBrowserExecutable = wechatDramaRequire("playwright").chromium.executablePath();

mkdirSync(browserPath, { recursive: true });

if (
  existsSync(path.join(installedBrowserDirectory, "INSTALLATION_COMPLETE"))
  && existsSync(installedBrowserExecutable)
) {
  console.log(`Playwright Chromium ${chromium.revision} is already installed.`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserPath,
  },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
