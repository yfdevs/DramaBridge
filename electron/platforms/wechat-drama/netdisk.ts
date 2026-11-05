import { registerFeishuTaskHandlers } from "../../integrations/feishu/task-handlers";
import { transferWechatRecreationVideos } from "../baidu-netdisk";

let controller: ReturnType<typeof registerFeishuTaskHandlers> | undefined;
export async function stopWechatRecreation() {
  await controller?.close();
}
export function registerWechatRecreationHandlers(
  readConfig: () => { recreationSheetName: string; recreationPollSeconds: string },
) {
  controller = registerFeishuTaskHandlers({
    platform: "wechat-drama",
    channel: "wechat-drama:recreation",
    label: "微信二创",
    resultColumn: "二创百度链接",
    includeVersions: false,
    episodeRatio: 0.6,
    plainLink: true,
    readConfig: () => {
      const config = readConfig();
      return { sheetName: config.recreationSheetName, pollSeconds: config.recreationPollSeconds };
    },
    transfer: ({ title, shareText, episodeCount, onProgress }) =>
      transferWechatRecreationVideos({ title, shareText, episodeCount, onProgress }),
  });
}
