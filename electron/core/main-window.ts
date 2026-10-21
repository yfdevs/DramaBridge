import { BrowserWindow, nativeImage } from "electron";
import { attachTitlebarToWindow, setupTitlebar } from "custom-electron-titlebar/main";
import windowStateKeeper from "electron-window-state";
import path from "node:path";

import { trpcIpc } from "../ipc";
import { logMain } from "../main-logger";
import type { AppEnvironment } from "./app-environment";

const minimumWindowSize = { width: 900, height: 620 };

export function initializeMainWindowIntegration() {
  setupTitlebar();
  trpcIpc.removeHandler("update-window-controls");
  trpcIpc.handle("update-window-controls", () => false);
}

export function appIconPath(environment: AppEnvironment) {
  return path.join(environment.publicDir, "icon.png");
}

export function createMainWindow(environment: AppEnvironment) {
  logMain("info", "Creating main window");
  const state = windowStateKeeper({
    defaultWidth: minimumWindowSize.width,
    defaultHeight: minimumWindowSize.height,
  });
  const window = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: Math.max(state.width, minimumWindowSize.width),
    height: Math.max(state.height, minimumWindowSize.height),
    minWidth: minimumWindowSize.width,
    minHeight: minimumWindowSize.height,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    title: "DramaBridge",
    titleBarStyle: "hidden",
    icon: nativeImage.createFromPath(appIconPath(environment)),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(environment.mainDist, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  state.manage(window);
  attachTitlebarToWindow(window);
  // The titlebar library resets minimum dimensions when attaching to a window.
  window.setMinimumSize(minimumWindowSize.width, minimumWindowSize.height);
  window.setMenu(null);

  window.webContents.once("did-finish-load", () => {
    logMain("info", "Main window load completed", { url: window.webContents.getURL() });
  });
  window.webContents.once("dom-ready", () => {
    logMain("info", "Main window page is ready", { url: window.webContents.getURL() });
  });
  window.on("closed", () => logMain("info", "Main window closed"));

  if (environment.devServerUrl) {
    logMain("info", "Loading development page", { url: environment.devServerUrl });
    void window.loadURL(environment.devServerUrl).catch((error) => {
      logMain("error", "Failed to load development page", error);
    });
  } else {
    const indexPath = path.join(environment.rendererDist, "index.html");
    logMain("info", "Loading application page", { path: indexPath });
    void window.loadFile(indexPath).catch((error) => {
      logMain("error", "Failed to load application page", error);
    });
  }

  return window;
}
