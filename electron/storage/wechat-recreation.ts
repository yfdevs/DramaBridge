import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openAutomationDatabase } from './database';
import type { NetdiskDramaInput, NetdiskDramaQuery, NetdiskDramaRecord } from '../../src/platforms/wechat-drama/netdisk-types';

export class WechatRecreationRepository {
  private database: Database.Database;
  constructor(database?: Database.Database) {
    this.database = database ?? openAutomationDatabase().database;
    this.database.exec(`CREATE TABLE IF NOT EXISTS wechat_recreation_imports (id TEXT PRIMARY KEY, template BLOB);
    CREATE TABLE IF NOT EXISTS wechat_recreation_dramas (
      id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, imported_at TEXT NOT NULL,
      source_file TEXT NOT NULL, data TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
      target_path TEXT NOT NULL DEFAULT '', completed_at TEXT
    ); CREATE INDEX IF NOT EXISTS wechat_recreation_imported ON wechat_recreation_dramas(imported_at);
    CREATE INDEX IF NOT EXISTS wechat_recreation_status ON wechat_recreation_dramas(status);`);
    const columns = this.database.pragma('table_info(wechat_recreation_dramas)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'generated_link')) this.database.exec("ALTER TABLE wechat_recreation_dramas ADD COLUMN generated_link TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === 'progress')) this.database.exec("ALTER TABLE wechat_recreation_dramas ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(column => column.name === 'progress_stage')) this.database.exec("ALTER TABLE wechat_recreation_dramas ADD COLUMN progress_stage TEXT NOT NULL DEFAULT ''");
    this.database.prepare("UPDATE wechat_recreation_dramas SET status='failed', error='上次转存中断，请重试以核验云端已有文件' WHERE status='running'").run();
  }
  close() { this.database.close(); }
  import(records: NetdiskDramaInput[], sourceFile: string, template?: Buffer) {
    const batchId = randomUUID(), importedAt = new Date().toISOString();
    const insert = this.database.prepare('INSERT INTO wechat_recreation_dramas(batch_id,imported_at,source_file,data,title) VALUES (?,?,?,?,?)');
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO wechat_recreation_imports(id,template) VALUES (?,?)').run(batchId, template ?? null);
      for (const row of records) insert.run(batchId, importedAt, sourceFile, JSON.stringify(row), row.title);
    })();
    return { batchId, importedAt, count: records.length };
  }
  private map(row: any): NetdiskDramaRecord {
    return { ...JSON.parse(row.data), id: row.id, batchId: row.batch_id, importedAt: row.imported_at,
      generatedLink: row.generated_link,
      progress: row.status === 'succeeded' ? JSON.parse(row.data).episodeCount : row.progress, progressStage: row.progress_stage,
      sourceFile: row.source_file, status: row.status, error: row.error, targetPath: row.target_path, completedAt: row.completed_at };
  }
  get(id: number) {
    const row = this.database.prepare('SELECT * FROM wechat_recreation_dramas WHERE id=?').get(id);
    return row ? this.map(row) : undefined;
  }
  delete(id: number) {
    const record = this.get(id);
    if (!record) throw new Error('剧目记录不存在');
    if (record.status === 'running') throw new Error('正在转存的剧目不能删除');
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM wechat_recreation_dramas WHERE id=?').run(id);
      this.database.prepare('DELETE FROM wechat_recreation_imports WHERE id=? AND NOT EXISTS (SELECT 1 FROM wechat_recreation_dramas WHERE batch_id=?)').run(record.batchId, record.batchId);
    })();
  }
  template(batchId: string): Buffer | undefined {
    return (this.database.prepare('SELECT template FROM wechat_recreation_imports WHERE id=?').get(batchId) as { template?: Buffer } | undefined)?.template;
  }
  list(query: NetdiskDramaQuery, all = false) {
    const where: string[] = []; const params: (string | number)[] = [];
    if (query.search) { where.push('instr(title,?)>0'); params.push(query.search); }
    if (query.from) { where.push('imported_at>=?'); params.push(new Date(query.from + 'T00:00:00').toISOString()); }
    if (query.to) { where.push('imported_at<?'); const end = new Date(query.to + 'T00:00:00'); end.setDate(end.getDate() + 1); params.push(end.toISOString()); }
    if (query.status) { where.push('status=?'); params.push(query.status); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (this.database.prepare('SELECT count(*) AS total FROM wechat_recreation_dramas' + clause).get(...params) as { total: number }).total;
    const page = Math.max(1, Math.floor(query.page || 1));
    const records = this.database.prepare('SELECT * FROM wechat_recreation_dramas' + clause + ' ORDER BY imported_at DESC,id ASC' + (all ? '' : ' LIMIT 50 OFFSET ?')).all(...params, ...(all ? [] : [(page - 1) * 50])).map(row => this.map(row));
    return { total, records };
  }
  setShareLink(id: number, link: string) {
    this.database.prepare('UPDATE wechat_recreation_dramas SET generated_link=? WHERE id=?').run(link, id);
  }
  setProgress(id: number, completed: number, stage: string) {
    this.database.prepare("UPDATE wechat_recreation_dramas SET progress=?,progress_stage=? WHERE id=? AND status='running'").run(completed, stage, id);
  }
  update(id: number, status: NetdiskDramaRecord['status'], error = '', targetPath = '') {
    this.database.prepare('UPDATE wechat_recreation_dramas SET status=?,error=?,target_path=?,completed_at=? WHERE id=?')
      .run(status, error, targetPath, status === 'succeeded' ? new Date().toISOString() : null, id);
  }
}
