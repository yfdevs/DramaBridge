import type Database from "better-sqlite3";
import type { TaobaoExecutionRecord, TaobaoExecutionStore } from "@dramabridge/taobao-drama-automation";

function scope(url: string) { return url.trim().replace(/\/+$/, ""); }

export class TaobaoExecutionRepository implements TaobaoExecutionStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS taobao_drama_executions (
        id TEXT PRIMARY KEY, api_base_url TEXT NOT NULL, account_id TEXT NOT NULL,
        task_id INTEGER NOT NULL, phase TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS taobao_drama_execution_scope ON taobao_drama_executions(api_base_url, account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS taobao_drama_execution_active ON taobao_drama_executions(api_base_url, account_id, task_id)
        WHERE phase NOT IN ('reported', 'claim-rejected', 'released');
    `);
    // A successful save must be durable before a claim or submit is sent.
    database.pragma("synchronous = FULL");
  }

  save(record: TaobaoExecutionRecord) {
    this.database.prepare(`INSERT INTO taobao_drama_executions(id, api_base_url, account_id, task_id, phase, record_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, record_json=excluded.record_json`).run(
      record.id, scope(record.apiBaseUrl), record.accountId, record.taskId, record.phase, JSON.stringify(record),
    );
  }

  recoverInterrupted() {
    const rows = this.database.prepare("SELECT record_json FROM taobao_drama_executions WHERE phase IN ('claiming', 'claimed', 'executing')")
      .all() as Array<{ record_json: string }>;
    this.database.transaction(() => {
      for (const row of rows) {
        const record = JSON.parse(row.record_json) as TaobaoExecutionRecord;
        if (record.ownerProcessId && record.ownerProcessId !== process.pid) {
          try { process.kill(record.ownerProcessId, 0); continue; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
        }
        this.save({ ...record, phase: "review-required", updatedAt: new Date().toISOString(),
          errorMessage: "上次运行在领取或上传过程中中断，结果待核实。已暂停该任务，请先在淘宝和后台确认处理结果。" });
      }
    })();
  }

  get(id: string): TaobaoExecutionRecord | undefined {
    const row = this.database.prepare("SELECT record_json FROM taobao_drama_executions WHERE id=?").get(id) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : undefined;
  }

  list(apiBaseUrl: string, accountId?: string): TaobaoExecutionRecord[] {
    const rows = accountId === undefined
      ? this.database.prepare("SELECT record_json FROM taobao_drama_executions WHERE api_base_url=? ORDER BY rowid").all(scope(apiBaseUrl))
      : this.database.prepare("SELECT record_json FROM taobao_drama_executions WHERE api_base_url=? AND account_id=? ORDER BY rowid").all(scope(apiBaseUrl), accountId);
    return (rows as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json));
  }
}
