export type PinduoduoUploadRecordStatus =
  | "PENDING"
  | "DOWNLOADING"
  | "READY"
  | "UPLOADING"
  | "UPLOADED"
  | "FAILED"
  | "REJECTED";

export type PinduoduoUploadRecordStage =
  | "DOWNLOAD"
  | "OPEN_PAGE"
  | "UPLOAD"
  | "VERIFY"
  | "BIND"
  | "PUBLISH";

export type PinduoduoUploadRecordResourceSource =
  | "LEGACY_XLSX_ORIGINAL"
  | "PINDUODUO_LIST";

export type PinduoduoUploadRecord = {
  accountProfileName?: string;
  attempts: number;
  createdAt: string;
  demoUrl?: string;
  episodeCount?: number;
  gmtCreate?: number;
  errorMessage?: string;
  lastAttemptAt?: string;
  platformApplyId: number;
  rawJson?: string;
  resourceSource?: PinduoduoUploadRecordResourceSource;
  resourceSourceRows?: number[];
  stage?: PinduoduoUploadRecordStage;
  status: PinduoduoUploadRecordStatus;
  title: string;
  totalBatchCount?: number;
  updatedAt: string;
  uploadedBatchCount?: number;
  uploadedAt?: string;
};

export type PinduoduoUploadRecordRow = Omit<
  PinduoduoUploadRecord,
  | "accountProfileName"
  | "demoUrl"
  | "episodeCount"
  | "gmtCreate"
  | "errorMessage"
  | "lastAttemptAt"
  | "rawJson"
  | "resourceSource"
  | "resourceSourceRows"
  | "stage"
  | "totalBatchCount"
  | "uploadedAt"
  | "uploadedBatchCount"
> & {
  accountProfileName: string | null;
  demoUrl: string | null;
  episodeCount: number | null;
  gmtCreate: number | null;
  errorMessage: string | null;
  lastAttemptAt: string | null;
  rawJson: string | null;
  resourceSource: PinduoduoUploadRecordResourceSource | null;
  resourceSourceRows: string | null;
  stage: PinduoduoUploadRecordStage | null;
  totalBatchCount: number | null;
  uploadedAt: string | null;
  uploadedBatchCount: number | null;
};
