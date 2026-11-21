import { baiduCleanupProtection, type CleanupDirectory, type NetdiskQuota } from "@dramabridge/baidu-netdisk-automation";
import { describeCleanupPause, type CleanupBatch, type CleanupPauseKind } from "./cleanup-errors";

export type AutoCleanupJournal = { pending: CleanupDirectory | null; pausedReason: string; sweepActive?: boolean };
export type AutoCleanupStatus = { phase: "disabled" | "waiting" | "checking" | "cleaning" | "paused"; message: string; used?: number; total?: number; deleted: number; skipped: number; current?: string; checkedAt?: string; pauseKind?: CleanupPauseKind; batch?: CleanupBatch };
type Runtime = Pick<typeof import("@dramabridge/baidu-netdisk-automation"), "readBaiduCleanup" | "deleteBaiduCleanupDirectory">;
export class BaiduAutoCleanup {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private nextCheck = 0;
  private previouslyEnabled = false;
  private preserved = new Map<string, number>();
  private state: AutoCleanupStatus = { phase: "disabled", message: "自动清理已关闭", deleted: 0, skipped: 0 };
  constructor(private deps: {
    enabled: () => boolean; ready: () => Promise<boolean>; occupied: () => boolean;
    port: () => number; runtime: () => Promise<Runtime>;
    exclusive: <T>(action: () => Promise<T>) => Promise<T>;
    protectedPaths: () => string[];
    journal: () => AutoCleanupJournal; saveJournal: (value: AutoCleanupJournal) => void;
    warn: (message: string) => void;
    now?: () => number; delay?: (ms: number) => Promise<void>;
  }) {}
  getStatus(): AutoCleanupStatus {
    if (!this.deps.enabled()) return { ...this.state, phase: "disabled", message: "自动清理已关闭" };
    return this.state.phase === "paused" ? { ...this.state, ...describeCleanupPause(this.state.message) } : { ...this.state };
  }
  start() { this.timer ??= setInterval(() => void this.tick(), 5000); this.timer.unref(); void this.tick(); }
  stop() { this.stopped = true; clearInterval(this.timer); }
  resume() {
    if (!this.deps.enabled()) throw new Error("请先保存并开启自动清理");
    if (this.busy) throw new Error("清理正在进行，请稍后再试");
    this.deps.saveJournal({ ...this.deps.journal(), pending: null, pausedReason: "" });
    this.nextCheck = 0;
    void this.tick();
  }
  async tick() {
    const now = this.deps.now ?? Date.now;
    if (!this.deps.enabled() || this.stopped) {
      if (!this.deps.enabled() && this.deps.journal().sweepActive) this.deps.saveJournal({ ...this.deps.journal(), sweepActive: false });
      this.previouslyEnabled = false; return;
    }
    if (!this.previouslyEnabled) { this.nextCheck = 0; this.previouslyEnabled = true; }
    if (this.busy || now() < this.nextCheck) return;
    const journal = this.deps.journal();
    if (journal.pending || journal.pausedReason) {
      this.state = { ...this.state, phase: "paused", message: journal.pausedReason || "上次删除结果待核对，请先检查网盘后恢复清理", current: journal.pending?.path };
      return;
    }
    this.busy = true;
    this.nextCheck = now() + 60_000;
    const allowed = () => this.deps.enabled() && !this.stopped;
    try {
      if (this.deps.occupied() || !await this.deps.ready()) {
        this.state = { ...this.state, phase: "waiting", message: "等待网盘连接空闲后检查容量" }; return;
      }
      const runtime = await this.deps.runtime();
      const quota = async (): Promise<NetdiskQuota> => {
        const result = await this.deps.exclusive(() => runtime.readBaiduCleanup(this.deps.port(), "quota"));
        if (!result.quota || !Number.isFinite(result.quota.used) || !Number.isFinite(result.quota.total) || result.quota.total <= 0) throw new Error("网盘未返回有效容量，已停止清理");
        this.state = { ...this.state, ...result.quota, checkedAt: new Date(now()).toISOString() };
        return result.quota;
      };
      this.state = { phase: "checking", message: "正在检查网盘容量", deleted: 0, skipped: 0 };
      let currentQuota = await quota();
      if (!journal.sweepActive && currentQuota.used <= currentQuota.total * 0.8) { this.state = { ...this.state, phase: "waiting", message: "容量未超过 80%，无需清理" }; return; }
      if (!allowed() || this.deps.occupied()) return;
      this.deps.saveJournal({ ...this.deps.journal(), sweepActive: true });
      const roots = (await this.deps.exclusive(() => runtime.readBaiduCleanup(this.deps.port(), "roots"))).roots ?? [];
      roots.sort((a, b) => Number(a.server_mtime) - Number(b.server_mtime));
      const deadline = now() + 120_000;
      let completed = true;
      for (const root of roots) {
        if (!allowed() || this.deps.occupied() || this.state.deleted >= 20 || now() >= deadline) { completed = false; break; }
        const key = `${root.fs_id}:${root.path}`;
        if ((this.preserved.get(key) ?? 0) > now()) { this.state.skipped++; continue; }
        const paths = this.deps.protectedPaths();
        if (baiduCleanupProtection(root, now(), paths)) { this.state.skipped++; continue; }
        this.state = { ...this.state, phase: "cleaning", current: root.path, message: "正在检查目录日期和使用状态" };
        const day = new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
        // Keep inspection and deletion in the same client lane; tasks cannot start between them.
        const removed = await this.deps.exclusive(async () => {
          if (!allowed()) return false;
          const result = await runtime.readBaiduCleanup(this.deps.port(), "inspect", root, this.deps.protectedPaths());
          if (result.reason) { this.state.skipped++; this.preserved.set(key, now() + 10 * 60_000); return false; }
          if (!allowed() || day !== new Date(now() + 8 * 3600_000).toISOString().slice(0, 10) || baiduCleanupProtection(root, now(), this.deps.protectedPaths())) return false;
          // A crash or timeout leaves a durable stop marker, not an automatic replay.
          this.deps.saveJournal({ ...this.deps.journal(), pending: root, pausedReason: "删除结果待确认，请先核对该目录" });
          await runtime.deleteBaiduCleanupDirectory(this.deps.port(), root, () => allowed() && !baiduCleanupProtection(root, now(), this.deps.protectedPaths()), result.entries && result.scannedAt !== undefined ? { entries: result.entries, scannedAt: result.scannedAt } : undefined);
          this.deps.saveJournal({ ...this.deps.journal(), pending: null, pausedReason: "" });
          return true;
        });
        if (!removed) continue;
        this.state.deleted++;
        const previousUsed = currentQuota.used;
        for (let check = 0; check < 3; check++) {
          if (!allowed()) return;
          await (this.deps.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
          currentQuota = await quota();
          if (currentQuota.used < previousUsed) break;
        }
        if (currentQuota.used >= previousUsed) throw new Error("删除后容量尚未下降，已暂停；请检查容量或回收站后再恢复，不会自动清空回收站");
      }
      if (completed) this.deps.saveJournal({ ...this.deps.journal(), sweepActive: false });
      this.state = { ...this.state, phase: "waiting", current: undefined, message: `本轮清理 ${this.state.deleted} 个目录，保留 ${this.state.skipped} 个目录；${completed ? "符合条件的旧目录已清理完成" : "稍后继续清理剩余旧目录"}` };
      if (!this.state.deleted) this.nextCheck = now() + 5 * 60_000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.saveJournal({ ...this.deps.journal(), pausedReason: message });
      this.state = { ...this.state, phase: "paused", message };
      this.deps.warn(message);
    } finally {
      this.busy = false;
      if (!allowed()) this.state = { ...this.state, phase: "disabled", message: "自动清理已关闭" };
    }
  }
}
