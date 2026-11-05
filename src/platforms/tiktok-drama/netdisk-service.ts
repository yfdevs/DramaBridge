import { createFeishuTaskService } from "../feishu/task-service";
export type { FeishuRunnerState as RecreationMonitor } from "../feishu/task-types";
export const tiktokNetdiskService = createFeishuTaskService("tiktok-drama:netdisk");
