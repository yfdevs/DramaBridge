export type WeixinChannelsSyncMode =
  | "assistant"
  | "assistant-json"
  | "promote"
  | "promote-standard";
export type WeixinChannelsDatePreset =
  | "previous-day"
  | "today"
  | "last-7-days"
  | "month-to-date"
  | "previous-month"
  | "custom";

export type KuaishouDatePreset = WeixinChannelsDatePreset;

export interface WeixinChannelsCustomDateRange {
  endDate: string;
  startDate: string;
}

export type KuaishouCustomDateRange = WeixinChannelsCustomDateRange;

export interface KuaishouSettings {
  customDateRange?: KuaishouCustomDateRange;
  datePreset: KuaishouDatePreset;
  downloadDirectory?: string;
}

export interface WeixinChannelsSettings {
  assistantCustomDateRange?: WeixinChannelsCustomDateRange;
  assistantDatePreset: WeixinChannelsDatePreset;
  assistantUseTestImportSource: boolean;
  downloadDirectory?: string;
  promoteStandardCustomDateRange?: WeixinChannelsCustomDateRange;
  promoteStandardDatePreset: WeixinChannelsDatePreset;
  promoteCustomDateRange?: WeixinChannelsCustomDateRange;
  promoteDatePreset: WeixinChannelsDatePreset;
}

export interface WeixinChannelsSyncEvent {
  dryRun?: boolean;
  accountName?: string;
  failureReason?: string;
  fetchedCount?: number;
  filename?: string;
  filePath?: string;
  message: string;
  mode?: WeixinChannelsSyncMode;
  result?: unknown;
  sourceId?: number;
  taskName?: string;
  taskType?: string;
  targetDate?: string;
  timestamp?: string;
  totalCount?: number;
  type:
    | "account-failed"
    | "downloaded"
    | "error"
    | "imported"
    | "logged-in"
    | "signed-out"
    | "started"
    | "stopped"
    | "waiting-for-scan";
  uniqId?: string;
}
