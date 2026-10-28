import { withPage } from "./cdp.js";
import type { CdpTarget } from "../domain/types.js";

export const baiduNativeDownloaderProbeExpression = `(() => {
  try {
    const downloader = require("@electron/remote").app.$downloader;
    return {
      ready: typeof downloader?.addDownloadTask === "function"
        && typeof downloader?.getDownloadTasks === "function",
    };
  } catch (error) {
    return { ready: false, error: String(error?.message || error) };
  }
})()`;

export async function assertBaiduNativeDownloaderReady(target: CdpTarget) {
  const state = await withPage(target, (page) => page.evaluate<{
    ready: boolean;
    error?: string;
  }>(baiduNativeDownloaderProbeExpression));
  if (!state.ready) {
    throw new Error(
      "[BAIDU_NETDISK_CLIENT_RESTART_REQUIRED] 百度网盘客户端下载组件不可用，" +
      "可能在更新后仍使用旧进程。请在百度网盘服务页重启为 CDP 模式，再重启对应平台服务。" +
      (state.error ? ` 原因：${state.error}` : ""),
    );
  }
}
