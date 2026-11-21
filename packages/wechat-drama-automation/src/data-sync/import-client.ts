import type { DarenCenterClient } from "./client.js";

/** No backend I/O, including login and source lookup, is reachable in dry runs. */
export function createWechatDataImportClient(client: DarenCenterClient, dryRun: boolean) {
  return dryRun
    ? {
        getSourceId: async (_name: string, _signal?: AbortSignal) => 0,
        importCopyrightData: async (_options: unknown) => ({
          status: 200,
          statusText: "DRY_RUN",
          body: {
            data: { totalCount: 0, successCount: 0, failCount: 0, errors: [] },
            message: "已验证，未导入",
          },
        }),
        importDramaHeatingActions: async (_options: unknown) => ({
          status: 200,
          statusText: "DRY_RUN",
          body: { data: { receivedCount: 0, savedCount: 0 }, message: "已验证，未导入" },
        }),
        ingestWeChatDramaStatistics: async (_payload: unknown, _signal?: AbortSignal) => ({
          status: 200,
          statusText: "DRY_RUN",
          body: {
            data: { receivedCount: 0, savedCount: 0, reportedTotalCount: 0 },
            message: "已验证，未导入",
          },
        }),
      }
    : client;
}
