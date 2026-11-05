import { registerFeishuTaskHandlers } from "../../integrations/feishu/task-handlers";
import { transferTiktokDramaNetdiskVideos } from "../baidu-netdisk";

let controller: ReturnType<typeof registerFeishuTaskHandlers> | undefined;
export async function stopTiktokNetdiskTransfer() {
  await controller?.close();
}
export function registerTiktokNetdiskHandlers(
  readConfig: () => { netdiskSheetName: string; netdiskPollSeconds: string },
) {
  controller = registerFeishuTaskHandlers({
    platform: "tiktok-drama",
    channel: "tiktok-drama:netdisk",
    label: "TikTok 转存",
    resultColumn: "单层文件夹链接",
    includeVersions: false,
    episodeRatio: 1,
    plainLink: true,
    readConfig: () => {
      const config = readConfig();
      return { sheetName: config.netdiskSheetName, pollSeconds: config.netdiskPollSeconds };
    },
    transfer: ({ title, shareText, episodeCount, onProgress }) =>
      transferTiktokDramaNetdiskVideos({ title, shareText, episodeCount, onProgress }),
  });
}
