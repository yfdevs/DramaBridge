import { app, BrowserWindow, Menu } from "electron";

import { registerAppRuntimeHandlers } from "./app-runtime";
import { registerAppUpdaterHandlers } from "./app-updater";
import { initializeAppEnvironment } from "./core/app-environment";
import { registerGracefulShutdown } from "./core/graceful-shutdown";
import {
  appIconPath,
  createMainWindow,
  initializeMainWindowIntegration,
} from "./core/main-window";
import { registerGlobalAppConfigHandlers } from "./global-app-config";
import { initializeTrpcIpc } from "./ipc";
import { getMainLogDir, logMain, registerMainProcessLogging } from "./main-logger";
import { ensureBaiduNetdiskCdpReadyOnStartup } from "./platforms/baidu-netdisk";
import {
  getGlobalRunningPlatformStatus,
  registerAllPlatformHandlers,
  stopAllPlatformServices,
} from "./platforms/registry";
import { startRuntimeAssetCleanupMonitor } from "./runtime-asset-cleanup";

const environment = initializeAppEnvironment(import.meta.url);

registerMainProcessLogging();
logMain("info", "Application startup initiated", {
  version: app.getVersion(),
  packaged: app.isPackaged,
  appRoot: environment.appRoot,
  mainDist: environment.mainDist,
  rendererDist: environment.rendererDist,
  logDir: getMainLogDir(),
});

initializeMainWindowIntegration();
registerGracefulShutdown(stopAllPlatformServices);

app.on("window-all-closed", () => {
  logMain("info", "All windows closed");
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow(environment);
});

void app.whenReady().then(() => {
  try {
    logMain("info", "Application ready");
    Menu.setApplicationMenu(null);
    initializeTrpcIpc();
    registerAppRuntimeHandlers();
    registerGlobalAppConfigHandlers({
      getRunningPlatformCount: () => getGlobalRunningPlatformStatus().running,
    });
    registerAllPlatformHandlers();
    startRuntimeAssetCleanupMonitor();
    registerAppUpdaterHandlers({
      getRunningPlatformCount: () => getGlobalRunningPlatformStatus().running,
      stopAllPlatformServices,
    });
    ensureBaiduNetdiskCdpReadyInBackground();

    if (process.platform === "darwin" && environment.devServerUrl) {
      app.dock?.setIcon(appIconPath(environment));
    }
    createMainWindow(environment);
  } catch (error) {
    logMain("error", "Application startup failed", error);
    throw error;
  }
});

function ensureBaiduNetdiskCdpReadyInBackground() {
  void (async () => {
    try {
      logMain("info", "Checking Baidu Netdisk connection");
      const result = await ensureBaiduNetdiskCdpReadyOnStartup();
      logMain("info", "Baidu Netdisk connection check completed", {
        action: result.action,
        ready: result.status.ready,
        appRunning: result.status.appRunning,
        cdpRunning: result.status.cdpRunning,
        port: result.status.port,
        message: result.status.message,
      });
    } catch (error) {
      logMain("error", "Baidu Netdisk connection check failed", error);
    }
  })();
}
