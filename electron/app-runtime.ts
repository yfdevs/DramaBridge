import { app } from "electron";

import { trpcIpc as ipcMain } from "./ipc";
import { openMainLogDir } from "./main-logger";
import {
  getGlobalBrowserInstanceCount,
  getGlobalRunningPlatformStatus,
  getPlatformRuntimeSummary,
  openPlatformLogDir,
  type PlatformId,
} from "./platforms/registry";
import { readDriveStatus, readMemoryStatus } from "./platforms/shared";

let registered = false;

export function registerAppRuntimeHandlers() {
  if (registered) return;
  registered = true;

  ipcMain.handle("app:runtime:status", async () => {
    const runningPlatformStatus = getGlobalRunningPlatformStatus();
    const [dDrive, memory] = await Promise.all([
      readDriveStatus("D:"),
      readMemoryStatus(),
    ]);

    return {
      pid: process.pid,
      browserInstanceCount: getGlobalBrowserInstanceCount(),
      runningPlatformCount: runningPlatformStatus.running,
      totalPlatformCount: runningPlatformStatus.total,
      disk: {
        dDrive,
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
