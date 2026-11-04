import { httpClient } from "./http-client.js";
import { getWechatVideoRuntimeSettings } from "../shared/runtime-settings.js";
import { createLogger } from "../shared/logger.js";

export type WechatTaskReport = {
  accountTaskId: number; workerId: string; attemptCount: number;
  rpaStatus: string; [key: string]: unknown;
};
export type WechatPendingReport = { baseUrl: string; payload: WechatTaskReport };
export type WechatReportStore = {
  load: () => WechatPendingReport[];
  save: (reports: WechatPendingReport[]) => void;
};
let store: WechatReportStore | undefined;
let memory: WechatPendingReport[] = [];
let flushing: Promise<void> | undefined;
const logger = createLogger("task-report");
const key = (item: WechatPendingReport) => JSON.stringify([item.baseUrl, item.payload.accountTaskId, item.payload.workerId, item.payload.attemptCount]);
export function configureWechatReportStore(value?: WechatReportStore) { store = value; }
const load = () => store?.load() ?? memory;
function save(items: WechatPendingReport[]) { if (store) store.save(items); else memory = items; }

export async function flushWechatTaskReports() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const entry of load()) {
      if (entry.baseUrl !== getWechatVideoRuntimeSettings().apiBaseUrl) continue;
      try {
        const response = await httpClient.post<{ code?: number; msg?: string }>("/dramaAiRpa/rpa/report", entry.payload);
        if (response.code !== 0) throw new Error(response.msg || "微信任务结果回写失败");
        save(load().filter(item => key(item) !== key(entry)));
      } catch (error) {
        logger.warn("任务结果已保存，等待重试回写；不会重复发布或改写执行结果", { accountTaskId: entry.payload.accountTaskId, error });
      }
    }
  })().finally(() => { flushing = undefined; });
  return flushing;
}

export async function queueWechatTaskReport(payload: WechatTaskReport) {
  if (!payload.workerId || !Number.isInteger(payload.attemptCount) || payload.attemptCount < 1) {
    throw new Error("WECHAT_DRAMA_REPORT_IDENTITY_REQUIRED");
  }
  const entry = { baseUrl: getWechatVideoRuntimeSettings().apiBaseUrl, payload };
  save([...load().filter(item => key(item) !== key(entry)), entry]);
  await flushWechatTaskReports();
}
