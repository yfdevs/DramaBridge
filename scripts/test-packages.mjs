import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error("Run this script with pnpm test:packages.");

const args = [
  // Browser tests use short timing windows; avoid competing browser suites across packages.
  "--workspace-concurrency=1",
  "--filter",
  "./packages/*-automation",
  "--filter",
  "@dramabridge/automation-logging",
  "--filter",
  "@dramabridge/media-assets",
  "--if-present",
  "test",
  ...process.argv.slice(2),
];
const nativePackageManager = /\.exe$/i.test(packageManager);
const result = spawnSync(
  nativePackageManager ? packageManager : process.execPath,
  nativePackageManager ? args : [packageManager, ...args],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".cache", "playwright-browsers"),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
