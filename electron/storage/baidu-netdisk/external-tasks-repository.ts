import type Database from "better-sqlite3";
import type {
  ExternalDownloadTask,
  ExternalDownloadTaskStore,
} from "../../platforms/baidu-netdisk/external-downloads";

export class BaiduNetdiskExternalTasksRepository implements ExternalDownloadTaskStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS baidu_netdisk_external_tasks (
      task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL, task_json TEXT NOT NULL
    )`);
  }
  list() {
    return (
      this.database
        .prepare("SELECT task_json FROM baidu_netdisk_external_tasks ORDER BY updated_at DESC")
        .all() as { task_json: string }[]
    ).map((row) => JSON.parse(row.task_json) as ExternalDownloadTask);
  }
  get(taskId: string) {
    const row = this.database
      .prepare("SELECT task_json FROM baidu_netdisk_external_tasks WHERE task_id=?")
      .get(taskId) as { task_json: string } | undefined;
    return row ? (JSON.parse(row.task_json) as ExternalDownloadTask) : undefined;
  }
  findRequest(requestId: string) {
    const row = this.database
      .prepare("SELECT task_json FROM baidu_netdisk_external_tasks WHERE request_id=?")
      .get(requestId) as { task_json: string } | undefined;
    return row ? (JSON.parse(row.task_json) as ExternalDownloadTask) : undefined;
  }
  save(task: ExternalDownloadTask) {
    this.database
      .prepare(`INSERT INTO baidu_netdisk_external_tasks VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET updated_at=excluded.updated_at, task_json=excluded.task_json`)
      .run(task.taskId, task.request.requestId, task.updatedAt, JSON.stringify(task));
  }
}
