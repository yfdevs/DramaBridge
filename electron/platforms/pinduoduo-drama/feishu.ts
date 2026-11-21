import { z } from "zod";
import type { FeishuTables, TableSnapshot } from "@dramabridge/feishu";
import type { PinduoduoUploadStore } from "@dramabridge/pinduoduo-drama-automation";
import { PINDUODUO_DEFAULT_SOURCE_TABLE_URL } from "../../../src/platforms/pinduoduo-drama/defaults";
import { PinduoduoSourceTable, PINDUODUO_FULL_SOURCE_URL } from "./source-table";

export const PINDUODUO_ACCOUNT_SHEET = "拼多多账号实例";
export const PINDUODUO_TASK_SHEET = "拼多多传剧任务";
const META_COLUMN = "运行数据（程序维护）";
const TASK_HEADERS = ["剧名", "集数", "发布账号", "百度网盘链接", "状态", "上传进度", "失败原因", "更新时间"];
const statusLabels: Record<string, string> = {
  PENDING: "待处理", DOWNLOADING: "下载中", READY: "待上传", UPLOADING: "上传中",
  UPLOADED: "已发布", FAILED: "失败", REJECTED: "平台拒绝",
};

export type PinduoduoFeishuAccount = { name: string; creatorName: string; phone: string; enabled: boolean };
export function selectPinduoduoAccounts(accounts: PinduoduoFeishuAccount[], selectedIds: unknown) {
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("请勾选需要启动的拼多多账号");
  const ids = new Set<string>(selectedIds);
  if ([...ids].some(id => !accounts.some(account => account.phone === id))) throw new Error("账号已变更，请刷新账号列表后重新勾选");
  return accounts.filter(account => ids.has(account.phone));
}
function columns(table: TableSnapshot, names: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of names) {
    const indices = table.headers.flatMap((header, i) => header.trim() === name ? [i] : []);
    if (indices.length !== 1) throw new Error(`“${table.sheet.title}”需要唯一的“${name}”列`);
    result[name] = indices[0]!;
  }
  return result;
}

export function readPinduoduoAccounts(table: TableSnapshot): PinduoduoFeishuAccount[] {
  const c = columns(table, ["账号名称", "主播名称", "是否启用", "手机号"]);
  const names = new Set<string>(), phones = new Set<string>();
  return table.rows.filter(row => row.values[c["账号名称"]]?.trim()).map(row => {
    const value = (name: string) => row.values[c[name]]?.trim() ?? "";
    const name = value("账号名称"), phone = value("手机号"), creatorName = value("主播名称");
    if (!/^1\d{10}$/.test(phone) || !creatorName) throw new Error(`账号“${name}”需要有效手机号和主播名称`);
    if (names.has(name) || phones.has(phone)) throw new Error("拼多多账号名称和手机号不能重复");
    names.add(name); phones.add(phone);
    const enabledText = value("是否启用");
    if (!["是", "否", "true", "false", "1", "0", ""].includes(enabledText.toLowerCase())) throw new Error(`账号“${name}”的“是否启用”请填写是或否`);
    return { name, creatorName, phone, enabled: ["是", "true", "1"].includes(enabledText.toLowerCase()) };
  });
}

const recordSchema = z.object({
  platformApplyId: z.number().int().positive().safe(), title: z.string().min(1), accountProfileName: z.string().min(1),
  attempts: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["PENDING", "DOWNLOADING", "READY", "UPLOADING", "UPLOADED", "FAILED", "REJECTED"]),
  episodeCount: z.number().int().positive().optional(), gmtCreate: z.number().optional(), demoUrl: z.string().optional(),
  stage: z.enum(["DOWNLOAD", "OPEN_PAGE", "UPLOAD", "VERIFY", "BIND", "PUBLISH"]).optional(),
  errorMessage: z.string().optional(), lastAttemptAt: z.string().optional(), uploadedAt: z.string().optional(),
  resourceSource: z.enum(["FEISHU", "LEGACY_XLSX_ORIGINAL", "PINDUODUO_LIST"]).optional(), resourceSourceRows: z.array(z.number()).optional(),
  totalBatchCount: z.number().int().nonnegative().optional(), uploadedBatchCount: z.number().int().nonnegative().optional(),
});
const metaSchema = z.object({
  version: z.literal(1), record: recordSchema, manifest: z.string().optional(),
  pendingPublishBatch: z.number().int().positive().optional(),
  confirmedRequired: z.boolean().optional(),
  sourceTableUrl: z.string().optional(), sourceRow: z.number().int().positive().optional(),
});
type Meta = z.infer<typeof metaSchema>;
type TaskRow = { number: number; values: string[]; meta?: Meta };

/** One coordinator serializes writes from every browser in this application. */
export class PinduoduoFeishuTables {
  private queue: Promise<unknown> = Promise.resolve();
  private source: PinduoduoSourceTable;
  constructor(private tables: FeishuTables, private url: string, sourceUrl = PINDUODUO_DEFAULT_SOURCE_TABLE_URL) {
    this.source = new PinduoduoSourceTable(tables, sourceUrl);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async accounts() { return readPinduoduoAccounts(await this.tables.read(this.url, PINDUODUO_ACCOUNT_SHEET)); }
  async available(account: PinduoduoFeishuAccount) {
    const current = (await this.accounts()).find(item => item.phone === account.phone);
    if (!current || current.name !== account.name || current.creatorName !== account.creatorName) throw new Error(`账号“${account.name}”已被修改，请停止并重新启动服务`);
    return true;
  }
  private async snapshot() {
    let table = await this.tables.read(this.url, PINDUODUO_TASK_SHEET);
    columns(table, TASK_HEADERS);
    if (!table.headers.includes(META_COLUMN)) {
      // Only use a genuinely empty column; never overwrite someone else's data.
      const column = Array.from({ length: table.sheet.grid_properties.column_count }, (_, i) => i)
        .find(i => i >= 8 && !table.headers[i] && !table.rows.some(row => row.values[i]));
      if (column === undefined) throw new Error("拼多多任务表需要一列空白列保存云端运行数据");
      await this.tables.writeCells(table, 1, [{ column, value: META_COLUMN }]);
      await this.tables.hideColumn(table, column);
      table = await this.tables.read(this.url, PINDUODUO_TASK_SHEET);
    }
    const c = columns(table, [...TASK_HEADERS, META_COLUMN]);
    const rows: TaskRow[] = table.rows.filter(row => row.values.some(Boolean)).map(row => {
      const raw = row.values[c[META_COLUMN]];
      let meta: Meta | undefined;
      if (raw) {
        try { meta = metaSchema.parse(JSON.parse(raw)); }
        catch { throw new Error(`飞书任务第${row.number}行运行数据损坏，已停止处理，不能自动重置`); }
        if (row.values[c["发布账号"]] !== meta.record.accountProfileName || row.values[c["剧名"]] !== meta.record.title) throw new Error(`飞书第${row.number}行账号或剧名被修改，请恢复后再运行`);
      }
      return { ...row, meta };
    });
    return { table, c, rows };
  }
  async prepare() { await Promise.all([this.source.read(), this.serial(async () => { await this.accounts(); await this.snapshot(); })]); }
  private cells(c: Record<string, number>, meta: Meta) {
    const r = meta.record;
    const progress = Math.min((r.uploadedBatchCount ?? 0) * 50, r.episodeCount ?? 0);
    const values: Record<string, string> = {
      "剧名": r.title, "集数": String(r.episodeCount ?? ""), "发布账号": r.accountProfileName,
      "百度网盘链接": r.demoUrl ?? "", "状态": meta.confirmedRequired ? "待人工确认" : statusLabels[r.status]!,
      "上传进度": `${progress}/${r.episodeCount ?? "?"}`, "失败原因": r.errorMessage ?? "",
      "更新时间": new Date(r.updatedAt).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }),
      [META_COLUMN]: JSON.stringify(meta),
    };
    return Object.entries(values).map(([key, value]) => ({ column: c[key]!, value }));
  }
  private async write(table: TableSnapshot, row: number, c: Record<string, number>, meta: Meta) {
    await this.tables.ensureRows(table, row);
    await this.tables.writeCells(table, row, this.cells(c, meta));
  }
  async list() {
    const { rows } = await this.snapshot();
    return rows.flatMap(row => row.meta ? [{ ...row.meta.record, ...(row.meta.confirmedRequired ? { status: "CONFIRM_REQUIRED" } : {}) }] : []);
  }
  async resetFailed(account?: string, id?: number) {
    return this.serial(async () => {
      const { table, c, rows } = await this.snapshot(); let reset = 0;
      for (const row of rows) {
        const meta = row.meta;
        // Older clients made a bare 1080P rejection terminal before per-episode repair existed.
        const legacyResolutionRejection = meta?.record.status === "REJECTED" &&
          /^第\s*\d+\/\d+\s*批视频上传失败[：:]\s*视频分辨率不能低于1080P\s*$/i.test(meta.record.errorMessage ?? "");
        if (!meta || meta.confirmedRequired || meta.pendingPublishBatch || (meta.record.status !== "FAILED" && !legacyResolutionRejection)) continue;
        if (account && meta.record.accountProfileName !== account || id !== undefined && meta.record.platformApplyId !== id) continue;
        Object.assign(meta.record, { status: "PENDING", attempts: 0, stage: undefined, errorMessage: undefined, updatedAt: new Date().toISOString() });
        await this.write(table, row.number, c, meta); reset++;
      }
      return reset;
    });
  }
  async confirmPublication(account: string, id: number, published: boolean) {
    return this.serial(async () => {
      const { table, c, rows } = await this.snapshot();
      const matches = rows.filter(row => row.meta?.record.accountProfileName === account && row.meta.record.platformApplyId === id);
      if (matches.length !== 1) throw new Error("待确认任务不存在或重复");
      const row = matches[0]!, meta = row.meta!;
      if (!meta.confirmedRequired || !meta.pendingPublishBatch) throw new Error("该任务没有待确认的发布批次");
      if (published) meta.record.uploadedBatchCount = meta.pendingPublishBatch;
      meta.pendingPublishBatch = undefined; meta.confirmedRequired = false;
      const completed = (meta.record.uploadedBatchCount ?? 0) >= (meta.record.totalBatchCount ?? Infinity);
      meta.record.status = completed ? "UPLOADED" : "PENDING";
      if (completed) meta.record.uploadedAt = new Date().toISOString();
      meta.record.attempts = 0; meta.record.errorMessage = undefined; meta.record.stage = undefined;
      meta.record.updatedAt = new Date().toISOString();
      await this.write(table, row.number, c, meta);
    });
  }
  forAccount(account: PinduoduoFeishuAccount): PinduoduoUploadStore {
    const update = async (id: number, change: (meta: Meta) => void) => this.serial(async () => {
      const { table, c, rows } = await this.snapshot();
      const matches = rows.filter(row => row.meta?.record.accountProfileName === account.name && row.meta.record.platformApplyId === id);
      if (matches.length !== 1) throw new Error(`飞书任务“${account.name}/${id}”不存在或重复，已停止回写`);
      const row = matches[0]!, meta = row.meta!;
      // Visible edits can pause retries, but must not fabricate completed checkpoints.
      const label = row.values[c["状态"]];
      if (label === "待处理" && meta.record.status === "FAILED" && !meta.confirmedRequired) meta.record.attempts = 0;
      change(meta); meta.record.updatedAt = new Date().toISOString();
      await this.write(table, row.number, c, meta);
    });
    const records = async () => {
      const { rows, c } = await this.snapshot();
      return rows.filter(row => row.meta?.record.accountProfileName === account.name).map(row => {
        const meta = row.meta!;
        const label = row.values[c["状态"]];
        return { meta, label };
      });
    };
    return {
      resolveResource: async id => {
        const matches = (await records()).filter(({ meta }) => meta.record.platformApplyId === id);
        if (matches.length !== 1) throw new Error(`飞书任务“${account.name}/${id}”不存在或重复`);
        try {
          const resource = await this.source.resolve(matches[0]!.meta.record.title);
          // A successful write is required before downloading can begin.
          await update(id, meta => {
            meta.record.demoUrl = resource.shareText; meta.record.resourceSource = "FEISHU";
            meta.record.resourceSourceRows = [resource.number];
            meta.sourceTableUrl = resource.sourceUrl ?? this.source.url; meta.sourceRow = resource.number;
          });
          return resource.shareText;
        } catch (error) {
          await update(id, meta => {
            meta.record.demoUrl = undefined; meta.record.resourceSource = "FEISHU";
            meta.record.status = "FAILED"; meta.record.stage = "DOWNLOAD";
            meta.record.errorMessage = error instanceof Error ? error.message : String(error);
          });
          throw error;
        }
      },
      upsertFromApprovedList: async approved => this.serial(async () => {
        if (!approved.length) return;
        const { table, c, rows } = await this.snapshot();
        const byId = new Map<number, TaskRow[]>(), byTitle = new Map<string, TaskRow[]>(), manual = new Map<string, TaskRow[]>();
        const append = <K>(index: Map<K, TaskRow[]>, key: K, row: TaskRow) => index.set(key, [...(index.get(key) ?? []), row]);
        for (const row of rows) {
          if (row.meta?.record.accountProfileName === account.name) {
            append(byId, row.meta.record.platformApplyId, row);
            append(byTitle, row.meta.record.title, row);
          } else if (!row.meta && row.values[c["发布账号"]] === account.name) append(manual, row.values[c["剧名"]], row);
        }
        let nextRow = Math.max(1, ...rows.map(row => row.number)) + 1;
        const changes: { row: number; cells: { column: number; value: string }[] }[] = [];
        for (const item of approved) {
          if (item.id === undefined) continue;
          const idMatches = byId.get(item.id) ?? [], manualMatches = manual.get(item.title) ?? [];
          const sameTitle = (byTitle.get(item.title) ?? []).filter(row => row.meta!.record.platformApplyId !== item.id);
          if (idMatches.length > 1 || manualMatches.length > 1 || sameTitle.length) throw new Error(`“${account.name}/${item.title}”存在重复或同名申报，无法自动匹配`);
          const row = idMatches[0] ?? manualMatches[0];
          const previousMeta = row?.meta ? JSON.stringify(row.meta) : undefined;
          if (row?.meta && row.meta.record.title !== item.title) throw new Error(`平台申报“${item.id}”的剧名已变化，请人工核对飞书记录`);
          if (row && !row.meta && !["", "待处理", "失败"].includes(row.values[c["状态"]] ?? "")) continue;
          const time = new Date().toISOString();
          const meta: Meta = row?.meta ?? { version: 1, record: { platformApplyId: item.id, title: item.title, accountProfileName: account.name, attempts: 0, status: "PENDING", createdAt: time, updatedAt: time } };
          const r = meta.record;
          r.gmtCreate = item.gmtCreate;
          // Platform demoUrl is a five-episode preview, never a video source.
          if (meta.sourceTableUrl !== this.source.url && meta.sourceTableUrl !== PINDUODUO_FULL_SOURCE_URL) {
            r.demoUrl = undefined; r.resourceSource = "FEISHU"; meta.sourceRow = undefined;
          }
          r.episodeCount = item.episodeCount;
          const number = row?.number ?? nextRow++;
          // Do not overwrite status while synchronizing an existing task.
          const cells = !row?.meta ? this.cells(c, meta) : [
            { column: c[META_COLUMN], value: JSON.stringify(meta) },
            { column: c["集数"], value: String(r.episodeCount ?? "") },
            { column: c["百度网盘链接"], value: r.demoUrl ?? "" },
          ];
          const changed = !row?.meta ? cells : cells.filter(cell => cell.column === c[META_COLUMN]
            ? previousMeta !== JSON.stringify(meta)
            : (row?.values[cell.column] ?? "") !== cell.value);
          if (changed.length) changes.push({ row: number, cells: changed });
          if (!row?.meta) {
            const next = row ?? { number, values: [], meta };
            next.meta = meta;
            for (const cell of cells) next.values[cell.column] = cell.value;
            append(byId, item.id, next); append(byTitle, item.title, next);
            manual.delete(item.title);
          }
        }
        if (changes.length) {
          await this.tables.ensureRows(table, Math.max(...changes.map(change => change.row)));
          await this.tables.writeRows(table, changes);
        }
      }),
      findProcessableRecords: async () => (await records()).filter(({ meta, label }) => !meta.confirmedRequired && !meta.pendingPublishBatch &&
        ((meta.record.status === "PENDING" && label === "待处理") || (meta.record.status === "FAILED" && (label === "待处理" || label === "失败" && meta.record.attempts < 3))))
        .map(({ meta, label }) => ({ ...meta.record, ...(label === "待处理" && meta.record.status === "FAILED" ? { attempts: 0 } : {}) })),
      recoverInterruptedRecords: async () => {
        let count = 0;
        for (const { meta } of await records()) {
          if (!["DOWNLOADING", "READY", "UPLOADING"].includes(meta.record.status)) continue;
          await update(meta.record.platformApplyId, next => {
            next.record.status = "FAILED";
            next.confirmedRequired = !!next.pendingPublishBatch;
            next.record.errorMessage = next.pendingPublishBatch ? "上次发布结果不明，请核对平台后人工处理，禁止自动重传" : "上次任务中断，将在本轮重试";
            if (!next.confirmedRequired) { next.record.status = "PENDING"; next.record.attempts = Math.max(0, next.record.attempts - 1); }
          }); count++;
        }
        return count;
      },
      // Preserve cloud history instead of deleting records once a platform topic exists.
      deleteByPlatformApplyIds: async () => 0,
      retainIncompleteCreatedTopics: async ids => (await records()).filter(({ meta }) => ids.includes(meta.record.platformApplyId) &&
        (meta.record.uploadedBatchCount ?? 0) < (meta.record.totalBatchCount ?? 0)).map(({ meta }) => meta.record.platformApplyId),
      markDownloading: async id => {
        await this.available(account);
        await update(id, meta => { meta.record.status = "DOWNLOADING"; meta.record.attempts++; meta.record.lastAttemptAt = new Date().toISOString(); meta.record.errorMessage = undefined; });
      },
      markResourceSource: (id, source, sourceRows, shareText) => update(id, meta => { meta.record.resourceSource = source; meta.record.resourceSourceRows = sourceRows; if (shareText) meta.record.demoUrl = shareText; }),
      markReady: id => update(id, meta => { meta.record.status = "READY"; }),
      markUploading: id => update(id, meta => { meta.record.status = "UPLOADING"; }),
      markInterrupted: id => update(id, meta => {
        meta.record.status = meta.pendingPublishBatch ? "FAILED" : "PENDING";
        meta.confirmedRequired = !!meta.pendingPublishBatch;
        meta.record.errorMessage = meta.pendingPublishBatch ? "发布时服务停止，请核对平台结果后人工处理" : undefined;
      }),
      prepareUploadBatches: async (id, total, manifest) => {
        let completed = 0;
        await update(id, meta => {
          completed = meta.record.uploadedBatchCount ?? 0;
          if (completed && (meta.manifest !== manifest || meta.record.totalBatchCount !== total)) throw new Error("本地素材或批次已变化，不能继续断点上传，请人工核对");
          meta.manifest = manifest; meta.record.totalBatchCount = total;
        }); return completed;
      },
      markPublishing: async (id, batch) => {
        await this.available(account);
        await update(id, meta => { if (meta.pendingPublishBatch || meta.confirmedRequired) throw new Error("上次发布结果待人工确认"); meta.pendingPublishBatch = batch; meta.record.stage = "PUBLISH"; });
      },
      markUploadBatchPublished: (id, count) => update(id, meta => { meta.record.uploadedBatchCount = count; meta.pendingPublishBatch = undefined; meta.confirmedRequired = false; }),
      markUploaded: id => update(id, meta => { meta.record.status = "UPLOADED"; meta.record.uploadedAt = new Date().toISOString(); meta.record.errorMessage = undefined; }),
      markFailed: (id, stage, message) => update(id, meta => { meta.record.status = "FAILED"; meta.record.stage = stage; meta.record.errorMessage = message; meta.confirmedRequired = !!meta.pendingPublishBatch; }),
      markRejected: (id, message) => update(id, meta => { meta.record.status = "REJECTED"; meta.record.stage = "VERIFY"; meta.record.errorMessage = message; }),
    };
  }
}
