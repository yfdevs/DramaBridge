import { app } from "electron";

import { logMain } from "../main-logger";

const shutdownTimeoutMs = 15_000;

async function withShutdownDeadline(stopServices: () => Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopServices(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Platform shutdown exceeded ${shutdownTimeoutMs}ms`)),
          shutdownTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function registerGracefulShutdown(stopServices: () => Promise<unknown>) {
  let shutdownStarted = false;
  let shutdownComplete = false;

  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;

    logMain("info", "Stopping all platform services");
    void withShutdownDeadline(stopServices)
      .catch((error) => logMain("error", "Platform shutdown did not complete cleanly", error))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });
}
