import type Database from "better-sqlite3"
import { randomUUID } from "node:crypto"

import { openAutomationDatabase } from "../database"
import {
  migrateWechatMiniProgramCatalogUploadTasks,
  selectWechatMiniProgramCatalogUploadColumns,
} from "./catalog-upload-schema"
import type {
  WechatMiniProgramCatalogEpisodeStatus,
  WechatMiniProgramCatalogUploadTask,
  WechatMiniProgramCatalogUploadTaskRow,
} from "./catalog-upload-types"

function parseEpisodeStatuses(value: string): WechatMiniProgramCatalogEpisodeStatus[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed as WechatMiniProgramCatalogEpisodeStatus[] : []
  } catch {
    return []
  }
}

function readTask(row: WechatMiniProgramCatalogUploadTaskRow): WechatMiniProgramCatalogUploadTask {
  return {
    id: row.id,
    dramaId: row.dramaId,
    wxDramaId: row.wxDramaId ?? undefined,
    dramaName: row.dramaName,
    dramaDescription: row.dramaDescription ?? undefined,
    episodeCount: row.episodeCount,
    baiduNetdiskUrl: row.baiduNetdiskUrl ?? undefined,
    hasFirstFourEpisodes: Boolean(row.hasFirstFourEpisodes),
    hasCover: Boolean(row.hasCover),
    lifecycleStatus: row.lifecycleStatus ?? undefined,
    auditStatus: row.auditStatus ?? undefined,
    expectedPublishStatus: row.expectedPublishStatus ?? undefined,
    actualPublishStatus: row.actualPublishStatus ?? undefined,
    operationStatus: row.operationStatus ?? undefined,
    state: row.state,
    targetEpisodeCount: row.targetEpisodeCount,
    uploadedEpisodeCount: row.uploadedEpisodeCount,
    episodeStatuses: parseEpisodeStatuses(row.episodeStatusesJson),
    coverStatus: row.coverStatus,
    coverMaterialId: row.coverMaterialId ?? undefined,
    coverFileName: row.coverFileName ?? undefined,
    coverError: row.coverError ?? undefined,
    workflowVersion: row.workflowVersion,
    localPath: row.localPath ?? undefined,
    error: row.error ?? undefined,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
  }
}

function writeParams(task: WechatMiniProgramCatalogUploadTask) {
  return {
    ...task,
    wxDramaId: task.wxDramaId ?? null,
    dramaDescription: task.dramaDescription ?? null,
    baiduNetdiskUrl: task.baiduNetdiskUrl ?? null,
    hasFirstFourEpisodes: task.hasFirstFourEpisodes ? 1 : 0,
    hasCover: task.hasCover ? 1 : 0,
    lifecycleStatus: task.lifecycleStatus ?? null,
    auditStatus: task.auditStatus ?? null,
    expectedPublishStatus: task.expectedPublishStatus ?? null,
    actualPublishStatus: task.actualPublishStatus ?? null,
    operationStatus: task.operationStatus ?? null,
    episodeStatusesJson: JSON.stringify(task.episodeStatuses),
    coverMaterialId: task.coverMaterialId ?? null,
    coverFileName: task.coverFileName ?? null,
    coverError: task.coverError ?? null,
    localPath: task.localPath ?? null,
    error: task.error ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
  }
}

export class WechatMiniProgramCatalogUploadTaskRepository {
  private readonly database: Database.Database
  readonly databasePath: string

  constructor() {
    const opened = openAutomationDatabase()
    this.database = opened.database
    this.databasePath = opened.databasePath
    migrateWechatMiniProgramCatalogUploadTasks(this.database)
  }

  list(): WechatMiniProgramCatalogUploadTask[] {
    const rows = this.database.prepare(`
      SELECT ${selectWechatMiniProgramCatalogUploadColumns}
      FROM wechat_miniprogram_catalog_upload_tasks
      ORDER BY drama_id DESC
    `).all() as WechatMiniProgramCatalogUploadTaskRow[]
    return rows.map(readTask)
  }

  findById(id: string): WechatMiniProgramCatalogUploadTask | null {
    const row = this.database.prepare(`
      SELECT ${selectWechatMiniProgramCatalogUploadColumns}
      FROM wechat_miniprogram_catalog_upload_tasks WHERE id=@id
    `).get({ id }) as WechatMiniProgramCatalogUploadTaskRow | undefined
    return row ? readTask(row) : null
  }

  findByDramaId(dramaId: number): WechatMiniProgramCatalogUploadTask | null {
    const row = this.database.prepare(`
      SELECT ${selectWechatMiniProgramCatalogUploadColumns}
      FROM wechat_miniprogram_catalog_upload_tasks WHERE drama_id=@dramaId
    `).get({ dramaId }) as WechatMiniProgramCatalogUploadTaskRow | undefined
    return row ? readTask(row) : null
  }

  upsertDiscovered(input: {
    dramaId: number
    wxDramaId?: number
    dramaName: string
    dramaDescription?: string
    episodeCount: number
    baiduNetdiskUrl?: string
    hasFirstFourEpisodes: boolean
    hasCover: boolean
    lifecycleStatus?: string
    auditStatus?: number
    expectedPublishStatus?: string
    actualPublishStatus?: string
    operationStatus?: string
    targetEpisodeCount: number
  }): WechatMiniProgramCatalogUploadTask {
    const current = this.findByDramaId(input.dramaId)
    if (current) {
      const sourceAvailable = Boolean(input.baiduNetdiskUrl?.trim())
      const episodeStatuses = input.hasFirstFourEpisodes
        ? Array.from({ length: input.targetEpisodeCount }, (_, index) => {
            const existing = current.episodeStatuses.find((status) => status.episodeNo === index + 1)
            return existing ?? { episodeNo: index + 1, state: "existing" as const }
          })
        : current.episodeStatuses.filter((status) => status.episodeNo <= input.targetEpisodeCount)
      const uploadedEpisodeCount = episodeStatuses.filter(
        (status) => status.state === "uploaded" || status.state === "existing",
      ).length
      const coverComplete = input.hasCover
        || current.coverStatus === "uploaded"
        || current.coverStatus === "existing"
      const complete = uploadedEpisodeCount >= input.targetEpisodeCount && coverComplete
      return this.update(current.id, {
        wxDramaId: input.wxDramaId,
        dramaName: input.dramaName,
        dramaDescription: input.dramaDescription,
        episodeCount: input.episodeCount,
        baiduNetdiskUrl: input.baiduNetdiskUrl,
        hasFirstFourEpisodes: input.hasFirstFourEpisodes,
        hasCover: input.hasCover || coverComplete,
        lifecycleStatus: input.lifecycleStatus,
        auditStatus: input.auditStatus,
        expectedPublishStatus: input.expectedPublishStatus,
        actualPublishStatus: input.actualPublishStatus,
        operationStatus: input.operationStatus,
        targetEpisodeCount: input.targetEpisodeCount,
        state: complete ? "completed" : sourceAvailable ? "discovered" : "missing-source",
        episodeStatuses,
        uploadedEpisodeCount,
        coverStatus: coverComplete ? (current.coverStatus === "uploaded" ? "uploaded" : "existing") : "pending",
        error: complete || sourceAvailable ? undefined : "剧列表未提供百度网盘链接。",
      })
    }
    const now = new Date().toISOString()
    const task: WechatMiniProgramCatalogUploadTask = {
      id: randomUUID(),
      ...input,
      state: input.hasFirstFourEpisodes && input.hasCover
        ? "completed"
        : input.baiduNetdiskUrl?.trim() ? "discovered" : "missing-source",
      uploadedEpisodeCount: input.hasFirstFourEpisodes ? input.targetEpisodeCount : 0,
      episodeStatuses: input.hasFirstFourEpisodes
        ? Array.from({ length: input.targetEpisodeCount }, (_, index) => ({
            episodeNo: index + 1,
            state: "existing" as const,
          }))
        : [],
      coverStatus: input.hasCover ? "existing" : "pending",
      workflowVersion: 3,
      retryCount: 0,
      error: input.baiduNetdiskUrl?.trim()
        || (input.hasFirstFourEpisodes && input.hasCover)
        ? undefined
        : "剧列表未提供百度网盘链接。",
      createdAt: now,
      updatedAt: now,
    }
    this.insertOrReplace(task)
    return task
  }

  upsertDiscoveredBatch(inputs: Parameters<this["upsertDiscovered"]>[0][]) {
    const transaction = this.database.transaction(() => inputs.map((input) => this.upsertDiscovered(input)))
    return transaction()
  }

  deleteByDramaIds(dramaIds: number[]): number {
    const uniqueDramaIds = [...new Set(dramaIds)]
    if (uniqueDramaIds.length === 0) return 0
    const statement = this.database.prepare(`
      DELETE FROM wechat_miniprogram_catalog_upload_tasks WHERE drama_id=@dramaId
    `)
    const transaction = this.database.transaction(() => uniqueDramaIds.reduce(
      (deletedCount, dramaId) => deletedCount + statement.run({ dramaId }).changes,
      0,
    ))
    return transaction()
  }

  update(
    id: string,
    patch: Partial<Omit<WechatMiniProgramCatalogUploadTask, "id" | "createdAt">>,
  ): WechatMiniProgramCatalogUploadTask {
    const current = this.findById(id)
    if (!current) throw new Error(`前四集与封面上传记录不存在：${id}`)
    const task = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    }
    this.insertOrReplace(task)
    return task
  }

  retry(id: string): WechatMiniProgramCatalogUploadTask {
    const current = this.findById(id)
    if (!current) throw new Error(`前四集与封面上传记录不存在：${id}`)
    if (!current.baiduNetdiskUrl?.trim()) throw new Error("当前剧目没有百度网盘链接，无法重试。")
    return this.update(id, {
      state: "discovered",
      error: undefined,
      retryCount: current.retryCount + 1,
      finishedAt: undefined,
    })
  }

  recoverInterrupted(): void {
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE wechat_miniprogram_catalog_upload_tasks
      SET state='interrupted', error='应用上次退出时任务尚未完成，请重新开始队列。',
          updated_at=@now, finished_at=@now
      WHERE state IN ('downloading', 'uploading')
    `).run({ now })
  }

  private insertOrReplace(task: WechatMiniProgramCatalogUploadTask): void {
    this.database.prepare(`
      INSERT INTO wechat_miniprogram_catalog_upload_tasks (
        id, drama_id, wx_drama_id, drama_name, drama_description, episode_count, baidu_netdisk_url,
        has_first_four_episodes, has_cover, lifecycle_status, audit_status,
        expected_publish_status, actual_publish_status, operation_status,
        state, target_episode_count, uploaded_episode_count, episode_statuses_json,
        cover_status, cover_material_id, cover_file_name, cover_error, workflow_version,
        local_path, error, retry_count, created_at, updated_at, started_at, finished_at
      ) VALUES (
        @id, @dramaId, @wxDramaId, @dramaName, @dramaDescription, @episodeCount, @baiduNetdiskUrl,
        @hasFirstFourEpisodes, @hasCover, @lifecycleStatus, @auditStatus,
        @expectedPublishStatus, @actualPublishStatus, @operationStatus,
        @state, @targetEpisodeCount, @uploadedEpisodeCount, @episodeStatusesJson,
        @coverStatus, @coverMaterialId, @coverFileName, @coverError, @workflowVersion,
        @localPath, @error, @retryCount, @createdAt, @updatedAt, @startedAt, @finishedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        wx_drama_id=excluded.wx_drama_id, drama_name=excluded.drama_name,
        drama_description=excluded.drama_description,
        episode_count=excluded.episode_count, baidu_netdisk_url=excluded.baidu_netdisk_url,
        has_first_four_episodes=excluded.has_first_four_episodes,
        has_cover=excluded.has_cover,
        lifecycle_status=excluded.lifecycle_status, audit_status=excluded.audit_status,
        expected_publish_status=excluded.expected_publish_status,
        actual_publish_status=excluded.actual_publish_status,
        operation_status=excluded.operation_status,
        state=excluded.state, target_episode_count=excluded.target_episode_count,
        uploaded_episode_count=excluded.uploaded_episode_count,
        episode_statuses_json=excluded.episode_statuses_json,
        cover_status=excluded.cover_status, cover_material_id=excluded.cover_material_id,
        cover_file_name=excluded.cover_file_name, cover_error=excluded.cover_error,
        workflow_version=excluded.workflow_version, local_path=excluded.local_path,
        error=excluded.error, retry_count=excluded.retry_count, updated_at=excluded.updated_at,
        started_at=excluded.started_at, finished_at=excluded.finished_at
    `).run(writeParams(task))
  }
}
