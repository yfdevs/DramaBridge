import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";

import { logMain } from "../main-logger";

let tray: Tray | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

export function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

export function initializeSystemTray(iconPath: string) {
  if (tray) return;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("DramaBridge · 右键菜单可退出");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: showMainWindow },
    { type: "separator" },
    { label: "退出 DramaBridge", click: () => app.quit() },
  ]));
  tray.on("click", showMainWindow);
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    tray?.destroy();
    tray = undefined;
  });
}

export function attachWindowToSystemTray(window: BrowserWindow) {
  mainWindow = window;
  window.on("close", (event) => {
    if (quitting || !tray || tray.isDestroyed()) return;
    event.preventDefault();
    window.hide();
    logMain("info", "Main window hidden to system tray");
  });
  // Windows session shutdown must not be blocked by close-to-tray behavior.
  window.on("query-session-end", () => { quitting = true; });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
}
