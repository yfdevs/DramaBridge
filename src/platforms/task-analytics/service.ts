export type TaskAnalyticsPlatform =
  | "wechat-drama"
  | "wechat-miniprogram-drama"
  | "meituan-drama"
  | "taobao-drama"
  | "kuaishou-drama"
  | "qq-drama"
  | "tencent-huolong-drama"
  | "iqiyi-drama"
  | "baidu-drama"
  | "douyin-drama"
  | "tiktok-drama"
  | "pinduoduo-drama";

export type TaskAnalyticsDay = {
  date: string;
  succeeded: number;
  failed: number;
};

export type TaskAnalyticsResult = {
  days: TaskAnalyticsDay[];
  unavailableReason?: string;
};

export async function getTaskAnalytics(platform: TaskAnalyticsPlatform, days = 30) {
  if (!window.ipcRenderer) {
    throw new Error("任务统计仅在 Electron 应用内可用");
  }
  return window.ipcRenderer.invoke(`${platform}:analytics:get`, { days }) as Promise<TaskAnalyticsResult>;
}
