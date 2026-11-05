import { FeishuTaskMonitorPage } from "@/pages/shared/feishu-task-monitor";
import { kuaishouRecreationService } from "@/platforms/kuaishou-drama/recreation-service";

export function KuaishouRecreationPage() {
  return <FeishuTaskMonitorPage service={kuaishouRecreationService} label="快手二创" />;
}
