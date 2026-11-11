import type Database from "better-sqlite3"
import { randomUUID } from "node:crypto"

import { openAutomationDatabase } from "../database"
import {
  migrateWechatMiniProgramDirectUploadTasks,
  selectWechatMiniProgramDirectUploadTaskColumns,
} from "./direct-upload-schema"
import type {
  WechatMiniProgramDirectUploadTask,
  WechatMiniProgramDirectUploadTaskRow,
  WechatMiniProgramDirectUploadTaskState,
} from "./direct-upload-types"

function readTask(row: WechatMiniProgramDirectUploadTaskRow): WechatMiniProgramDirectUploadTask {
  let episodeIndexes: number[] | undefined
  if (row.episodeIndexesJson) {
    try {
      const parsed = JSON.parse(row.episodeIndexesJson) as unknown
      if (Array.isArray(parsed)) {
        episodeIndexes = parsed.filter(
          (value): value is number => Number.isInteger(value) && Number(value) > 0,
        )
      }
    } catch {
      episodeIndexes = undefined
    }
  }

  return {
    id: row.id,
    queueOrder: row.queueOrder,
    dramaName: row.dramaName,
    shareText: row.shareText,
    shareKey: row.shareKey,
    state: row.state,
    inferredEpisodeCount: row.inferredEpisodeCount ?? undefined,
    episodeIndexes,
    localPath: row.localPath ?? undefined,
    uploadCompletedCount: row.uploadCompletedCount,
    uploadTotalCount: row.uploadTotalCount,
    uploadAccountLabel: row.uploadAccountLabel ?? undefined,
    error: row.error ?? undefined,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
  }
}

function writeParams(task: WechatMiniProgramDirectUploadTask) {
  return {
    ...task,
    inferredEpisodeCount: task.inferredEpisodeCount ?? null,
    episodeIndexesJson: task.episodeIndexes ? JSON.stringify(task.episodeIndexes) : null,
    localPath: task.localPath ?? null,
    uploadAccountLabel: task.uploadAccountLabel ?? null,
    error: task.error ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
  }
}

export class WechatMiniProgramDirectUploadTaskRepository {
  private readonly database: Database.Database
  readonly databasePath: string

  constructor() {
    const opened = openAutomationDatabase()
    this.database = opened.database
    this.databasePath = opened.databasePath
    migrateWechatMiniProgramDirectUploadTasks(this.database)
  }

  list(): WechatMiniProgramDirectUploadTask[] {
    const rows = this.database.prepare(`
      SELECT ${selectWechatMiniProgramDirectUploadTaskColumns}
      FROM wechat_miniprogram_direct_upload_tasks
      ORDER BY queue_order ASC
    `).all() as WechatMiniProgramDirectUploadTaskRow[]
    return rows.map(readTask)
  }

  findById(id: string): WechatMiniProgramDirectUploadTask | null {
    const row = this.database.prepare(`
      SELECT ${selectWechatMiniProgramDirectUploadTaskColumns}
      FROM wechat_miniprogram_direct_upload_tasks
      WHERE id=@id
    `).get({ id }) as WechatMiniProgramDirectUploadTaskRow | undefined
    return row ? readTask(row) : null
  }

  findNextQueued(): WechatMiniProgramDirectUploadTask | null {
    const row = this.database.prepare(`
      SELECT ${selectWechatMiniProgramDirectUploadTaskColumns}
      FROM wechat_miniprogram_direct_upload_tasks
      WHERE state='queued'
      ORDER BY queue_order ASC
      LIMIT 1
    `).get() as WechatMiniProgramDirectUploadTaskRow | undefined
    return row ? readTask(row) : null
  }

  create(input: {
    dramaName: string
    shareText: string
    shareKey: string
  }): WechatMiniProgramDirectUploadTask {
    const now = new Date().toISOString()
    const queueOrderRow = this.database.prepare(`
      SELECT COALESCE(MAX(queue_order), 0) + 1 AS nextQueueOrder
      FROM wechat_miniprogram_direct_upload_tasks
    `).get() as { nextQueueOrder: number } | undefined
    const queueOrder = Number(queueOrderRow?.nextQueueOrder ?? 1)
    const task: WechatMiniProgramDirectUploadTask = {
      id: randomUUID(),
      queueOrder,
      dramaName: input.dramaName,
      shareText: input.shareText,
      shareKey: input.shareKey,
      state: "queued",
      uploadCompletedCount: 0,
      uploadTotalCount: 0,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.insertOrReplace(task)
    return task
  }

  update(
    id: string,
    patch: Partial<Omit<WechatMiniProgramDirectUploadTask, "id" | "createdAt">>,
  ): WechatMiniProgramDirectUploadTask {
    const current = this.findById(id)
    if (!current) throw new Error(`直传任务不存在：${id}`)
    const task: WechatMiniProgramDirectUploadTask = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.insertOrReplace(task)
    return task
  }

  retry(id: string): WechatMiniProgramDirectUploadTask {
    const current = this.findById(id)
    if (!current) throw new Error(`直传任务不存在：${id}`)
    if (!["failed", "interrupted"].includes(current.state)) {
      throw new Error("只有失败或中断的任务可以重试")
    }
    return this.update(id, {
      state: "queued",
      error: undefined,
      retryCount: current.retryCount + 1,
      uploadCompletedCount: 0,
      finishedAt: undefined,
      startedAt: undefined,
    })
  }

  delete(id: string): void {
    this.database.prepare(
      "DELETE FROM wechat_miniprogram_direct_upload_tasks WHERE id=@id",
    ).run({ id })
  }

  recoverInterrupted(): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE wechat_miniprogram_direct_upload_tasks
      SET state='interrupted',
          error='应用上次退出时任务尚未完成，请确认后重试',
          updated_at=@now,
          finished_at=@now
      WHERE state IN ('inspecting', 'downloading', 'waiting-login', 'uploading')
    `).run({ now })
    return result.changes
  }

  private insertOrReplace(task: WechatMiniProgramDirectUploadTask): void {
    this.database.prepare(`
      INSERT INTO wechat_miniprogram_direct_upload_tasks (
        id, queue_order, drama_name, share_text, share_key, state,
        inferred_episode_count, episode_indexes_json, local_path,
        upload_completed_count, upload_total_count, upload_account_label,
        error, retry_count, created_at, updated_at, started_at, finished_at
      ) VALUES (
        @id, @queueOrder, @dramaName, @shareText, @shareKey, @state,
        @inferredEpisodeCount, @episodeIndexesJson, @localPath,
        @uploadCompletedCount, @uploadTotalCount, @uploadAccountLabel,
        @error, @retryCount, @createdAt, @updatedAt, @startedAt, @finishedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        queue_order=excluded.queue_order,
        drama_name=excluded.drama_name,
        share_text=excluded.share_text,
        share_key=excluded.share_key,
        state=excluded.state,
        inferred_episode_count=excluded.inferred_episode_count,
        episode_indexes_json=excluded.episode_indexes_json,
        local_path=excluded.local_path,
        upload_completed_count=excluded.upload_completed_count,
        upload_total_count=excluded.upload_total_count,
        upload_account_label=excluded.upload_account_label,
        error=excluded.error,
        retry_count=excluded.retry_count,
        updated_at=excluded.updated_at,
        started_at=excluded.started_at,
        finished_at=excluded.finished_at
    `).run(writeParams(task))
  }
}

export type { WechatMiniProgramDirectUploadTaskState }
