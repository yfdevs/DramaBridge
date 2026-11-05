import { FeishuTaskMonitorPage } from "@/pages/shared/feishu-task-monitor";
import { tiktokNetdiskService } from "@/platforms/tiktok-drama/netdisk-service";

export function TiktokNetdiskTransferPage() {
  return <FeishuTaskMonitorPage service={tiktokNetdiskService} label="TikTok 转存" />;
}
