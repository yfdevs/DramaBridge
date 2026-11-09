import { app } from "electron";
import path from "node:path";
import { readStorageDiskStatus } from "./core/storage-disk";
import { getGlobalMaterialDirectory } from "./global-app-config";

import { trpcIpc as ipcMain } from "./ipc";
import { openMainLogDir } from "./main-logger";
import {
  getGlobalBrowserInstanceCount,
  getGlobalRunningPlatformStatus,
  getPlatformRuntimeSummary,
  openPlatformLogDir,
  type PlatformId,
} from "./platforms/registry";
import { readMemoryStatus } from "./platforms/shared";

let registered = false;

export function registerAppRuntimeHandlers() {
  if (registered) return;
  registered = true;

  ipcMain.handle("app:runtime:status", async () => {
    const runningPlatformStatus = getGlobalRunningPlatformStatus();
    const materialDirectory = getGlobalMaterialDirectory();
    const [storageDrive, memory] = await Promise.all([
      process.platform !== "win32" && !path.isAbsolute(materialDirectory) && path.win32.isAbsolute(materialDirectory)
        ? null
        : readStorageDiskStatus(materialDirectory),
      readMemoryStatus(),
    ]);

    return {
      pid: process.pid,
      browserInstanceCount: getGlobalBrowserInstanceCount(),
      runningPlatformCount: runningPlatformStatus.running,
      totalPlatformCount: runningPlatformStatus.total,
      disk: {
        storageDrive,
      },
      memory,
    };
  });

  ipcMain.handle("app:platform:runtime", (_event, platformId: PlatformId) => ({
    appVersion: app.getVersion(),
    platform: getPlatformRuntimeSummary(platformId),
  }));

  ipcMain.handle("app:platform:open-logs", (_event, platformId: PlatformId) =>
    openPlatformLogDir(platformId),
  );

  ipcMain.handle("app:logs:open-main", () => openMainLogDir());
}
