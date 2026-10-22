import type { ExternalApiConfig } from "../global-app-config";
import { readExternalApiConfig } from "../global-app-config";
import { logMain } from "../main-logger";
import { createBaiduNetdiskHttpApi } from "../platforms/baidu-netdisk/http-api";
import { LocalApiServer } from "./http-server";

const baiduNetdiskApi = createBaiduNetdiskHttpApi();
const server = new LocalApiServer(baiduNetdiskApi.handler);
let startupError: string | undefined;

export async function configureLocalApi(config: ExternalApiConfig) {
  try {
    if (config.enabled) baiduNetdiskApi.initialize();
    await server.configure({
      enabled: config.enabled,
      port: Number(config.port),
    });
    startupError = undefined;
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    throw error;
  }
  logMain("info", config.enabled ? "Local API started" : "Local API stopped", server.status());
}

export const getLocalApiStatus = () => ({
  ...server.status(),
  error: server.status().error ?? startupError,
});

export async function initializeLocalApi() {
  try {
    await configureLocalApi(readExternalApiConfig());
  } catch (error) {
    logMain("error", "Local API startup failed", error);
  }
}

export async function stopLocalApi() {
  await server.close();
  baiduNetdiskApi.close();
}
