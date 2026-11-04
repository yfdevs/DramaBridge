import type { App } from "electron";

export function initializeSingleInstance(
  app: Pick<App, "requestSingleInstanceLock" | "quit" | "on">,
  restoreWindow: () => void,
) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => restoreWindow());
  return true;
}
