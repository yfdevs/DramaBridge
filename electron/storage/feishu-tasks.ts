import type Database from "better-sqlite3";
import type { RecreationTask } from "../../src/platforms/feishu/task-types";

export class FeishuTaskRepository {
  constructor(
    private database: Database.Database,
    private platform: string,
  ) {
    database.exec(
      "CREATE TABLE IF NOT EXISTS feishu_task_checkpoints (platform TEXT NOT NULL, source_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(platform, source_key))",
    );
  }
  get(key: string): RecreationTask | undefined {
    const row = this.database
      .prepare("SELECT data FROM feishu_task_checkpoints WHERE platform = ? AND source_key = ?")
      .get(this.platform, key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  save(task: RecreationTask) {
    task.updatedAt = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO feishu_task_checkpoints (platform, source_key, data) VALUES (?, ?, ?) ON CONFLICT(platform, source_key) DO UPDATE SET data=excluded.data",
      )
      .run(this.platform, task.id, JSON.stringify(task));
  }
}
