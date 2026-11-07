import { createHash } from "node:crypto";
import type { FeishuTables, TableSnapshot } from "@dramabridge/feishu";
import type {
  RecreationInput,
  RecreationTask,
  FeishuRunnerState,
} from "../../../src/platforms/feishu/task-types";
import { normalizeRecreationTitle, validateRecreationInput } from "./task-validation";

export type TaskTableOptions = {
  resultColumn?: string;
  includeVersions?: boolean;
  episodeRatio?: number;
  label?: string;
  plainLink?: boolean;
};

export function tableColumns(table: TableSnapshot, options: TaskTableOptions = {}) {
  const resultColumn = options.resultColumn ?? "二创百度链接";
  const headers = table.headers.map((value) => value.trim());
  for (const name of ["剧名", "集数", "原百度链接", resultColumn, "备注"]) {
    if (headers.filter((header) => header === name).length !== 1)
      throw new Error(`${options.label ?? "任务工作表"}需要唯一的“${name}”列`);
  }
  const versions =
    options.includeVersions === false
      ? []
      : headers.flatMap((name, index) => (/^版本[1-9]\d*$/.test(name) ? [index] : []));
  if (new Set(versions.map((index) => headers[index])).size !== versions.length)
    throw new Error("版本列不能重复");
  return {
    title: headers.indexOf("剧名"),
    count: headers.indexOf("集数"),
    source: headers.indexOf("原百度链接"),
    result: headers.indexOf(resultColumn),
    note: headers.indexOf("备注"),
    versions,
  };
}
export function sourceInput(
  table: TableSnapshot,
  values: string[],
  options: TaskTableOptions = {},
): RecreationInput {
  const columns = tableColumns(table, options);
  return {
    originalTitle: normalizeRecreationTitle(values[columns.title] || ""),
    episodeCount: Number(values[columns.count]),
    shareText: values[columns.source] || "",
    versions: columns.versions.map((index) => normalizeRecreationTitle(values[index] || "")).filter(Boolean),
  };
}
export function sourceKey(table: TableSnapshot, values: string[], options: TaskTableOptions = {}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        table.spreadsheet,
        table.sheet.sheet_id,
        sourceInput(table, values, options),
      ]),
    )
    .digest("hex");
}
type Journal = { get(key: string): RecreationTask | undefined; save(task: RecreationTask): void };
export type FeishuTaskTransfer = (input: {
  title: string;
  versionTitle: string;
  shareText: string;
  episodeCount: number;
  onProgress: (progress: { stage: string; completed: number; total?: number }) => void;
}) => Promise<{ path: string; shareUrl: string }>;

export class FeishuTaskRunner {
  private state: FeishuRunnerState = {
    running: false,
    stopping: false,
    phase: "idle",
    message: "点击开始处理，读取飞书中的待处理剧目",
    completed: 0,
    failed: 0,
  };
  private timer?: ReturnType<typeof setTimeout>;
  private cycle?: Promise<void>;
  constructor(
    private options: TaskTableOptions & {
      tables: FeishuTables;
      url: string;
      sheet: string;
      pollSeconds: number;
      journal: Journal;
      transfer: FeishuTaskTransfer;
      changed: () => void;
    },
  ) {}
  status() {
    return structuredClone(this.state);
  }
  private update(fields: Partial<FeishuRunnerState>) {
    Object.assign(this.state, fields);
    this.options.changed();
  }
  start() {
    if (this.state.running || this.cycle) return;
    this.update({ running: true, stopping: false, error: undefined });
    this.tick();
  }
  async stop() {
    clearTimeout(this.timer);
    this.update({ running: false, stopping: !!this.cycle, nextReadAt: undefined });
    await this.cycle;
    this.update({ stopping: false, phase: "idle", message: "已停止读取，当前剧目结果已保留" });
  }
  private tick() {
    this.cycle = this.scan()
      .catch((error) =>
        this.update({
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
          message: "读取或回写失败，稍后自动重试",
        }),
      )
      .finally(() => {
        this.cycle = undefined;
        if (this.state.running) {
          this.update({
            nextReadAt: new Date(Date.now() + this.options.pollSeconds * 1000).toISOString(),
          });
          this.timer = setTimeout(() => this.tick(), this.options.pollSeconds * 1000);
        }
      });
  }
  private async currentRow(key: string, occurrence = 0) {
    const table = await this.options.tables.read(this.options.url, this.options.sheet);
    const matches = table.rows
      .filter((row) => sourceKey(table, row.values, this.options) === key)
      .sort((a, b) => a.number - b.number);
    if (!matches[occurrence])
      throw new Error("来源行已被修改或删除，已停止本次回写，请恢复原始任务行");
    return { table, row: matches[occurrence], columns: tableColumns(table, this.options) };
  }
  private async writeBack(key: string, link: string | undefined, failure?: string, occurrence = 0) {
    const { table, row, columns } = await this.currentRow(key, occurrence);
    if (row.values[columns.result]) return; // Never overwrite a human or another worker's result.
    await this.options.tables.markError(table, row.number, columns.note, !!failure);
    // Re-resolve after styling, rather than assuming the row stayed in the same position.
    const fresh = await this.currentRow(key, occurrence);
    if (fresh.row.values[fresh.columns.result]) return;
    await this.options.tables.writeCells(fresh.table, fresh.row.number, [
      ...(link === undefined ? [] : [{ column: fresh.columns.result, value: link }]),
      { column: fresh.columns.note, value: failure ? `失败：${failure}` : "" },
    ]);
  }
  private async scan() {
    this.update({
      phase: "reading",
      error: undefined,
      nextReadAt: undefined,
      message: "正在读取任务表",
    });
    const table = await this.options.tables.read(this.options.url, this.options.sheet);
    const columns = tableColumns(table, this.options);
    this.update({ lastReadAt: new Date().toISOString() });
    const occurrences = new Map<string, number>();
    // Sheets have no stable row IDs. Keep the first matching source row as the
    // checkpoint owner; later occurrences only receive a duplicate error.
    for (const row of [...table.rows].sort((a, b) => a.number - b.number)) {
      if (!this.state.running) break;
      const key = sourceKey(table, row.values, this.options);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      if (!row.values.some(Boolean) || row.values[columns.result]) continue;
      // A row may be observed while the user is still entering it cell by cell.
      if (
        [columns.title, columns.count, columns.source].some((index) => !row.values[index]?.trim())
      )
        continue;
      const input = sourceInput(table, row.values, this.options);
      if (!input.originalTitle && !input.shareText) continue;
      if (occurrence > 0) {
        if (row.values[columns.note]) continue;
        try {
          await this.writeBack(
            key,
            undefined,
            `“${input.originalTitle}”存在重复任务行，已跳过此新增行，请保留最早的任务行`,
            occurrence,
          );
          this.update({ failed: this.state.failed + 1 });
        } catch (error) {
          // Retry reporting on the next poll without blocking unrelated tasks.
          this.update({ error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      let task = this.options.journal.get(key);
      if (task?.state === "failed" && task.feishuWritebackPending) {
        await this.writeBack(key, undefined, task.message);
        task.feishuWritebackPending = false;
        this.options.journal.save(task);
        this.update({ failed: this.state.failed + 1 });
        continue;
      }
      if (
        task?.state === "completed" &&
        task.results.every((version) => version.shareLayout === "directory")
      ) {
        this.update({ phase: "writing", current: task, message: "补写已完成任务的分享链接" });
        await this.writeBack(key, this.links(task));
        task.message = "链接已回写飞书";
        this.options.journal.save(task);
        this.update({ current: task });
        this.update({ completed: this.state.completed + 1 });
        continue;
      }
      if (row.values[columns.note]) continue; // Clearing a failure note explicitly opts into retry.
      const latest = await this.currentRow(key);
      if (latest.row.values[latest.columns.result] || latest.row.values[latest.columns.note])
        continue;
      if (!task) {
        const now = new Date().toISOString();
        task = {
          ...input,
          id: key,
          state: "queued",
          results: [input.originalTitle, ...input.versions].map((title) => ({ title })),
          downloadCount: Math.ceil(input.episodeCount * (this.options.episodeRatio ?? 0.6)),
          createdAt: now,
          updatedAt: now,
        };
      }
      // A cleared result cell explicitly requests regeneration. Legacy flat links
      // are rebuilt by re-verifying cloud files, rather than reusing the old URL.
      for (const version of task.results) {
        if (version.shareUrl && version.shareLayout !== "directory") {
          version.shareUrl = undefined;
          version.extractionCode = undefined;
        }
      }
      this.update({
        phase: "processing",
        current: task,
        message: `正在处理：${input.originalTitle}`,
      });
      const save = () => {
        this.options.journal.save(task!);
        this.update({ current: task });
      };
      try {
        validateRecreationInput(input);
        task.state = "checking";
        save();
        for (const version of task.results) {
          if (version.shareUrl) continue;
          task.state = "uploading";
          task.progress = undefined;
          task.message = `转存版本：${version.title}`;
          save();
          const result = await this.options.transfer({
            title: input.originalTitle,
            versionTitle: version.title,
            shareText: input.shareText,
            episodeCount: input.episodeCount,
            onProgress: (progress) => {
              task!.progress = { ...progress, total: progress.total ?? task!.downloadCount };
              task!.message = `${version.title}：${progress.stage} ${progress.completed}/${task!.downloadCount}`;
              save();
            },
          });
          Object.assign(version, {
            shareLayout: "directory",
            remotePath: result.path,
            shareUrl: result.shareUrl,
            extractionCode: new URL(result.shareUrl).searchParams.get("pwd") || "",
          });
          task.progress = undefined;
          save();
        }
        task.state = "completed";
        task.message = "转存完成，准备回写飞书";
        save();
      } catch (error) {
        task.state = "failed";
        task.feishuWritebackPending = true;
        task.message = error instanceof Error ? error.message : String(error);
        save();
        this.update({ phase: "writing", message: "回写失败原因并标记备注" });
        await this.writeBack(key, undefined, task.message);
        task.feishuWritebackPending = false;
        save();
        this.update({ failed: this.state.failed + 1 });
        continue;
      }
      this.update({ phase: "writing", message: "正在回写二创百度链接" });
      await this.writeBack(key, this.links(task)); // Deliberately outside transfer catch: retry writes, never transfer.
      task.message = "链接已回写飞书";
      save();
      this.update({ completed: this.state.completed + 1 });
    }
    if (this.state.running)
      this.update({ phase: "waiting", message: "本轮读取完成，等待新增任务" });
  }
  private links(task: RecreationTask) {
    if (this.options.plainLink) return task.results[0]?.shareUrl ?? "";
    return task.results
      .map(
        (version) =>
          `${version.title}\n${version.shareUrl}${version.extractionCode ? `\n提取码：${version.extractionCode}` : ""}`,
      )
      .join("\n\n");
  }
}
