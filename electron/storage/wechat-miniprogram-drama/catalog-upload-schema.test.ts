import assert from "node:assert/strict"
import test from "node:test"
import Database from "better-sqlite3"

import { migrateWechatMiniProgramCatalogUploadTasks } from "./catalog-upload-schema"

test("catalog upload migration clears legacy jobs and keeps only version 3 audit-passed dramas", () => {
  const database = new Database(":memory:")
  try {
    migrateWechatMiniProgramCatalogUploadTasks(database)
    const columns = database.prepare(
      "PRAGMA table_info(wechat_miniprogram_catalog_upload_tasks)",
    ).all() as Array<{ name: string }>
    assert.ok(columns.some((column) => column.name === "drama_description"))
    const insert = database.prepare(`
      INSERT INTO wechat_miniprogram_catalog_upload_tasks (
        id, drama_id, drama_name, episode_count, audit_status, state,
        target_episode_count, workflow_version, created_at, updated_at
      ) VALUES (
        @id, @dramaId, @dramaName, 10, @auditStatus, 'discovered',
        @targetEpisodeCount, @workflowVersion,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `)
    insert.run({ id: "approved", dramaId: 1, dramaName: "审核通过", auditStatus: 3, targetEpisodeCount: 4, workflowVersion: 3 })
    insert.run({ id: "rejected", dramaId: 2, dramaName: "审核不通过", auditStatus: 2, targetEpisodeCount: 4, workflowVersion: 3 })
    insert.run({ id: "legacy", dramaId: 3, dramaName: "旧数据", auditStatus: 3, targetEpisodeCount: 5, workflowVersion: 2 })

    migrateWechatMiniProgramCatalogUploadTasks(database)

    const rows = database.prepare(`
      SELECT id, audit_status AS auditStatus
      FROM wechat_miniprogram_catalog_upload_tasks
      ORDER BY drama_id
    `).all()
    assert.deepEqual(rows, [{ id: "approved", auditStatus: 3 }])
  } finally {
    database.close()
  }
})
