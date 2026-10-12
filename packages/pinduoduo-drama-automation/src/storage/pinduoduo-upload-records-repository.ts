import type Database from "better-sqlite3";
import type { PinduoduoDramaRuntimeOptions } from "../shared/types.js";
import type { ShortplayApplyRecord } from "../app/shortplay-manage-page.js";
import { migratePinduoduoUploadRecords } from "./pinduoduo-upload-records-schema.js";
import type {
  PinduoduoUploadRecord,
  PinduoduoUploadRecordRow,
  PinduoduoUploadRecordStage,
} from "./pinduoduo-upload-records-types.js";
import { openAutomationDatabase } from "./database.js";
import { nullsToUndefined } from "./record-utils.js";

function nowIso(): string {
  return new Date().toISOString();
}

const pinduoduoUploadRecordSelect = `
  platform_apply_id AS platformApplyId,
  title,
  episode_count AS episodeCount,
  gmt_create AS gmtCreate,
  demo_url AS demoUrl,
  status,
  stage,
  error_message AS errorMessage,
  attempts,
  raw_json AS rawJson,
  resource_source AS resourceSource,
  resource_source_rows AS resourceSourceRows,
  account_profile_name AS accountProfileName,
  uploaded_batch_count AS uploadedBatchCount,
  total_batch_count AS totalBatchCount,
  uploaded_at AS uploadedAt,
  last_attempt_at AS lastAttemptAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function readUploadRecord(row: PinduoduoUploadRecordRow): PinduoduoUploadRecord {
  const result = nullsToUndefined(row);
  return {
    ...result,
    resourceSourceRows: row.resourceSourceRows
      ? JSON.parse(row.resourceSourceRows) as number[]
      : undefined,
  };
}

export type PinduoduoCreatedTopicRepair = {
  resetToPending: boolean;
  totalBatchCount: number;
  uploadedBatchCount: number;
};

export function createdTopicRepairState(
  record: PinduoduoUploadRecord,
): PinduoduoCreatedTopicRepair | undefined {
  const recordedTotal = record.totalBatchCount;
  const recordedCompleted = record.uploadedBatchCount ?? 0;

  if (recordedTotal !== undefined && recordedCompleted < recordedTotal) {
    return {
      resetToPending: record.status === "UPLOADED",
      totalBatchCount: recordedTotal,
      uploadedBatchCount: recordedCompleted,
    };
  }

  return undefined;
}

export class PinduoduoUploadRecordsRepository {
  private readonly database: Database.Database;

  constructor(private readonly options: PinduoduoDramaRuntimeOptions) {
    this.database = openAutomationDatabase(options);
    migratePinduoduoUploadRecords(this.database);
  }

  close(): void {
    this.database.close();
  }

  upsertFromApprovedList(records: ShortplayApplyRecord[]): void {
    const timestamp = nowIso();
    const statement = this.database.prepare(
      `
      INSERT INTO pinduoduo_approved_upload_records (
        platform_apply_id,
        title,
        episode_count,
        gmt_create,
        demo_url,
        status,
        attempts,
        raw_json,
        account_profile_name,
        created_at,
        updated_at
      ) VALUES (
        @platformApplyId,
        @title,
        @episodeCount,
        @gmtCreate,
        @demoUrl,
        'PENDING',
        0,
        @rawJson,
        @accountProfileName,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(platform_apply_id) DO UPDATE SET
        title=excluded.title,
        episode_count=excluded.episode_count,
        gmt_create=excluded.gmt_create,
        demo_url=excluded.demo_url,
        raw_json=excluded.raw_json,
        updated_at=excluded.updated_at
    `,
    );

    for (const record of records) {
      if (record.id === undefined) continue;
      statement.run({
        accountProfileName: this.options.accountProfileName ?? null,
        createdAt: timestamp,
        demoUrl: record.demoUrl ?? null,
        episodeCount: record.episodeCount ?? null,
        gmtCreate: record.gmtCreate ?? null,
        platformApplyId: record.id,
        rawJson: JSON.stringify(record),
        title: record.title,
        updatedAt: timestamp,
      });
    }
  }

  findProcessableRecords(maxAttempts = 3): PinduoduoUploadRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT ${pinduoduoUploadRecordSelect}
        FROM pinduoduo_approved_upload_records
        WHERE status='PENDING'
          OR (status='FAILED' AND attempts < @maxAttempts)
        ORDER BY updated_at ASC
      `,
      )
      .all({ maxAttempts }) as PinduoduoUploadRecordRow[];

    return rows.map(readUploadRecord);
  }

  recoverInterruptedRecords(): number {
    const timestamp = nowIso();
    return this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET
          status='PENDING',
          stage=NULL,
          error_message=NULL,
          attempts=MAX(attempts-1, 0),
          updated_at=@updatedAt
        WHERE
          status IN ('DOWNLOADING', 'READY', 'UPLOADING')
          OR (
            status='FAILED'
            AND error_message LIKE '%Target page, context or browser has been closed%'
          )
      `,
      )
      .run({ updatedAt: timestamp }).changes;
  }

  deleteByPlatformApplyIds(platformApplyIds: number[]): number {
    const uniqueIds = [...new Set(platformApplyIds)];
    if (uniqueIds.length === 0) return 0;

    const placeholders = uniqueIds.map(() => "?").join(", ");
    return this.database
      .prepare(
        `
        DELETE FROM pinduoduo_approved_upload_records
        WHERE platform_apply_id IN (${placeholders})
      `,
      )
      .run(...uniqueIds).changes;
  }

  retainIncompleteCreatedTopics(platformApplyIds: number[]): number[] {
    const uniqueIds = [...new Set(platformApplyIds)];
    if (uniqueIds.length === 0) return [];

    const select = this.database.prepare(`
      SELECT ${pinduoduoUploadRecordSelect}
      FROM pinduoduo_approved_upload_records
      WHERE platform_apply_id=?
    `);
    const update = this.database.prepare(`
      UPDATE pinduoduo_approved_upload_records
      SET
        status=CASE WHEN @resetToPending=1 THEN 'PENDING' ELSE status END,
        stage=CASE WHEN @resetToPending=1 THEN NULL ELSE stage END,
        error_message=CASE WHEN @resetToPending=1 THEN NULL ELSE error_message END,
        uploaded_batch_count=@uploadedBatchCount,
        total_batch_count=@totalBatchCount,
        updated_at=@updatedAt
      WHERE platform_apply_id=@platformApplyId
    `);
    const retained: number[] = [];

    for (const platformApplyId of uniqueIds) {
      const row = select.get(platformApplyId) as PinduoduoUploadRecordRow | undefined;
      if (!row) continue;
      const record = readUploadRecord(row);
      const repair = createdTopicRepairState(record);
      if (!repair) continue;
      update.run({
        platformApplyId,
        resetToPending: repair.resetToPending ? 1 : 0,
        totalBatchCount: repair.totalBatchCount,
        uploadedBatchCount: repair.uploadedBatchCount,
        updatedAt: nowIso(),
      });
      retained.push(platformApplyId);
    }

    return retained;
  }

  markDownloading(platformApplyId: number): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET
          status='DOWNLOADING',
          attempts=attempts+1,
          stage=NULL,
          error_message=NULL,
          last_attempt_at=@lastAttemptAt,
          updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        lastAttemptAt: timestamp,
        platformApplyId,
        updatedAt: timestamp,
      });
  }

  markResourceSource(
    platformApplyId: number,
    resourceSource: NonNullable<PinduoduoUploadRecord["resourceSource"]>,
    resourceSourceRows?: number[],
  ): void {
    this.database.prepare(`
      UPDATE pinduoduo_approved_upload_records
      SET
        resource_source=@resourceSource,
        resource_source_rows=@resourceSourceRows,
        updated_at=@updatedAt
      WHERE platform_apply_id=@platformApplyId
    `).run({
      platformApplyId,
      resourceSource,
      resourceSourceRows: resourceSourceRows ? JSON.stringify(resourceSourceRows) : null,
      updatedAt: nowIso(),
    });
  }

  markReady(platformApplyId: number): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET status='READY', updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        platformApplyId,
        updatedAt: timestamp,
      });
  }

  markUploading(platformApplyId: number): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET status='UPLOADING', updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        platformApplyId,
        updatedAt: timestamp,
      });
  }

  markInterrupted(platformApplyId: number): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET
          status='PENDING',
          stage=NULL,
          error_message=NULL,
          attempts=MAX(attempts-1, 0),
          updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        platformApplyId,
        updatedAt: timestamp,
      });
  }

  prepareUploadBatches(platformApplyId: number, totalBatchCount: number): number {
    const current = this.database.prepare(`
      SELECT
        uploaded_batch_count AS uploadedBatchCount,
        total_batch_count AS totalBatchCount
      FROM pinduoduo_approved_upload_records
      WHERE platform_apply_id=@platformApplyId
    `).get({ platformApplyId }) as {
      uploadedBatchCount: number | null;
      totalBatchCount: number | null;
    } | undefined;

    if (current?.totalBatchCount === totalBatchCount) {
      return Math.min(current.uploadedBatchCount ?? 0, totalBatchCount);
    }

    this.database.prepare(`
      UPDATE pinduoduo_approved_upload_records
      SET
        uploaded_batch_count=0,
        total_batch_count=@totalBatchCount,
        updated_at=@updatedAt
      WHERE platform_apply_id=@platformApplyId
    `).run({ platformApplyId, totalBatchCount, updatedAt: nowIso() });
    return 0;
  }

  markUploadBatchPublished(platformApplyId: number, completedBatchCount: number): void {
    this.database.prepare(`
      UPDATE pinduoduo_approved_upload_records
      SET
        uploaded_batch_count=MAX(uploaded_batch_count, @completedBatchCount),
        updated_at=@updatedAt
      WHERE platform_apply_id=@platformApplyId
    `).run({ completedBatchCount, platformApplyId, updatedAt: nowIso() });
  }

  markUploaded(platformApplyId: number): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET
          status='UPLOADED',
          stage=NULL,
          error_message=NULL,
          uploaded_batch_count=COALESCE(total_batch_count, uploaded_batch_count),
          uploaded_at=@uploadedAt,
          updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        platformApplyId,
        updatedAt: timestamp,
        uploadedAt: timestamp,
      });
  }

  markFailed(
    platformApplyId: number,
    stage: PinduoduoUploadRecordStage,
    errorMessage: string,
  ): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET
          status='FAILED',
          stage=@stage,
          error_message=@errorMessage,
          updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        errorMessage,
        platformApplyId,
        stage,
        updatedAt: timestamp,
      });
  }

  markRejected(platformApplyId: number, errorMessage: string): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        UPDATE pinduoduo_approved_upload_records
        SET
          status='REJECTED',
          stage='VERIFY',
          error_message=@errorMessage,
          updated_at=@updatedAt
        WHERE platform_apply_id=@platformApplyId
      `,
      )
      .run({
        errorMessage,
        platformApplyId,
        updatedAt: timestamp,
      });
  }
}
