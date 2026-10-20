import { app, BrowserWindow, ipcMain, Menu, nativeImage } from "electron";
import { setupTitlebar, attachTitlebarToWindow } from "custom-electron-titlebar/main";
import windowStateKeeper from "electron-window-state";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { registerAppRuntimeHandlers } from "./app-runtime";
import { registerAppUpdaterHandlers } from "./app-updater";
import { registerGlobalAppConfigHandlers } from "./global-app-config";
import { getMainLogDir, logMain, registerMainProcessLogging } from "./main-logger";
import { ensureBaiduNetdiskCdpReadyOnStartup } from "./platforms/baidu-netdisk";
import {
  getGlobalRunningPlatformStatus,
  registerAllPlatformHandlers,
  stopAllPlatformRuntimes,
  stopAllPlatformServices,
} from "./platforms/registry";
import { startRuntimeAssetCleanupMonitor } from "./runtime-asset-cleanup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

registerMainProcessLogging();
logMain("info", "Application startup initiated", {
  version: app.getVersion(),
  packaged: app.isPackaged,
  appRoot: process.env.APP_ROOT,
  mainDist: MAIN_DIST,
  rendererDist: RENDERER_DIST,
  logDir: getMainLogDir(),
});

let win: BrowserWindow | null;

setupTitlebar();
ipcMain.removeAllListeners("update-window-controls");
ipcMain.on("update-window-controls", (event) => {
  event.returnValue = false;
});

function getAppIconPath() {
  return path.join(process.env.VITE_PUBLIC, "icon.png");
}

function createWindow() {
  logMain("info", "Creating main window");

  const appIcon = nativeImage.createFromPath(getAppIconPath());
  const fixedWindowSize = {
    width: 780,
    height: 620,
  };
  const mainWindowState = windowStateKeeper({
    defaultWidth: fixedWindowSize.width,
    defaultHeight: fixedWindowSize.height,
  });

  win = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: fixedWindowSize.width,
    height: fixedWindowSize.height,
    minWidth: fixedWindowSize.width,
    minHeight: fixedWindowSize.height,
    maxWidth: fixedWindowSize.width,
    maxHeight: fixedWindowSize.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "AutoDrama",
    titleBarStyle: "hidden",
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      sandbox: false,
    },
  });

  win.webContents.once("did-finish-load", () => {
    logMain("info", "Main window load completed", {
      url: win?.webContents.getURL(),
    });
  });

  win.webContents.once("dom-ready", () => {
    logMain("info", "Main window page is ready", {
      url: win?.webContents.getURL(),
    });
  });

  win.on("closed", () => {
    logMain("info", "Main window closed");
  });

  mainWindowState.manage(win);
  attachTitlebarToWindow(win);
  win.setMenu(null);

  if (VITE_DEV_SERVER_URL) {
    logMain("info", "Loading development page", { url: VITE_DEV_SERVER_URL });
    void win.loadURL(VITE_DEV_SERVER_URL).catch((error) => {
      logMain("error", "Failed to load development page", error);
    });
  } else {
    const indexPath = path.join(RENDERER_DIST, "index.html");
    logMain("info", "Loading application page", { path: indexPath });
    void win.loadFile(indexPath).catch((error) => {
      logMain("error", "Failed to load application page", error);
    });
  }
}

app.on("window-all-closed", () => {
  logMain("info", "All windows closed");

  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("before-quit", () => {
  logMain("info", "Stopping all platform services");
  stopAllPlatformRuntimes();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(() => {
  try {
    logMain("info", "Application ready");
    Menu.setApplicationMenu(null);
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

    if (process.platform === "darwin" && VITE_DEV_SERVER_URL) {
      app.dock?.setIcon(getAppIconPath());
    }

    createWindow();
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
