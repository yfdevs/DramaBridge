import { FeishuTaskMonitorPage } from "@/pages/shared/feishu-task-monitor";
import { wechatRecreationService } from "@/platforms/wechat-drama/netdisk-service";

export function WechatRecreationTransferPage() {
  return <FeishuTaskMonitorPage service={wechatRecreationService} label="微信二创" />;
}
