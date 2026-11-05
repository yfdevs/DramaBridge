import type Database from "better-sqlite3";
import type { RecreationTask } from "../../src/platforms/kuaishou-drama/recreation-types";

export class KuaishouFeishuRepository {
  constructor(private database: Database.Database) {
    database.exec(
      "CREATE TABLE IF NOT EXISTS kuaishou_feishu_checkpoints (source_key TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  get(key: string): RecreationTask | undefined {
    const row = this.database
      .prepare("SELECT data FROM kuaishou_feishu_checkpoints WHERE source_key = ?")
      .get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  save(task: RecreationTask) {
    task.updatedAt = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO kuaishou_feishu_checkpoints (source_key, data) VALUES (?, ?) ON CONFLICT(source_key) DO UPDATE SET data=excluded.data",
      )
      .run(task.id, JSON.stringify(task));
  }
}
