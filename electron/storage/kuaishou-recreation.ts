import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  RecreationInput,
  RecreationTask,
} from "../../src/platforms/kuaishou-drama/recreation-types";

export class KuaishouRecreationRepository {
  constructor(private database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS kuaishou_recreation_tasks (
      id TEXT PRIMARY KEY, title_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL
    )`);
    for (const task of this.list()) {
      if (!["queued", "completed", "failed", "interrupted"].includes(task.state)) {
        this.save({ ...task, state: "interrupted", message: "上次运行中断，请重试继续" });
      }
    }
  }
  list(): RecreationTask[] {
    return (
      this.database
        .prepare("SELECT data FROM kuaishou_recreation_tasks ORDER BY rowid DESC")
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  save(task: RecreationTask) {
    task.updatedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE kuaishou_recreation_tasks SET data = ? WHERE id = ?")
      .run(JSON.stringify(task), task.id);
  }
  nextQueued(): RecreationTask | undefined {
    const row = this.database.prepare("SELECT data FROM kuaishou_recreation_tasks WHERE json_extract(data, '$.state') = 'queued' ORDER BY rowid LIMIT 1")
      .get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  import(inputs: RecreationInput[]) {
    this.database.transaction(() => {
      const insert = this.database.prepare(
        "INSERT INTO kuaishou_recreation_tasks (id, title_key, data) VALUES (?, ?, ?)",
      );
      for (const input of inputs) {
        const key = input.originalTitle.normalize("NFKC").toLowerCase();
        if (
          this.database
            .prepare("SELECT id FROM kuaishou_recreation_tasks WHERE title_key = ?")
            .get(key)
        )
          throw new Error(`原剧名重复：${input.originalTitle}。整批未导入，请移除重复行。`);
        const now = new Date().toISOString();
        const task: RecreationTask = {
          ...input,
          id: randomUUID(),
          downloadCount: Math.ceil(input.episodeCount * 0.6),
          state: "queued",
          results: [input.originalTitle, ...input.versions].map((title) => ({ title })),
          createdAt: now,
          updatedAt: now,
        };
        insert.run(task.id, key, JSON.stringify(task));
      }
    })();
  }
  delete(id: string) {
    this.database.prepare("DELETE FROM kuaishou_recreation_tasks WHERE id = ?").run(id);
  }
}
