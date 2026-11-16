import type { ShortplayApplyRecord } from "../app/shortplay-manage-page.js";
import type { PinduoduoUploadRecord, PinduoduoUploadRecordStage } from "./pinduoduo-upload-records-types.js";

/** Injected by the desktop platform. All durable task state lives in Feishu. */
export interface PinduoduoUploadStore {
  resolveResource(id: number): Promise<string>;
  upsertFromApprovedList(records: ShortplayApplyRecord[]): Promise<void>;
  findProcessableRecords(): Promise<PinduoduoUploadRecord[]>;
  recoverInterruptedRecords(): Promise<number>;
  deleteByPlatformApplyIds(ids: number[]): Promise<number>;
  retainIncompleteCreatedTopics(ids: number[]): Promise<number[]>;
  markDownloading(id: number): Promise<void>;
  markResourceSource(id: number, source: NonNullable<PinduoduoUploadRecord["resourceSource"]>, rows?: number[], shareText?: string): Promise<void>;
  markReady(id: number): Promise<void>;
  markUploading(id: number): Promise<void>;
  markInterrupted(id: number): Promise<void>;
  prepareUploadBatches(id: number, total: number, manifest: string): Promise<number>;
  markPublishing(id: number, batch: number): Promise<void>;
  markUploadBatchPublished(id: number, count: number): Promise<void>;
  markUploaded(id: number): Promise<void>;
  markFailed(id: number, stage: PinduoduoUploadRecordStage, message: string): Promise<void>;
  markRejected(id: number, message: string): Promise<void>;
}
