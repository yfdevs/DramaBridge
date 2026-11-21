import { randomUUID } from "node:crypto";
import type { WorkbenchRanges } from "./workbench-settings.js";

export type QueueSettings = WorkbenchRanges & { minSeconds: number; maxSeconds: number };
export type JianyingTask = {
  id: string; source: string; name: string; settings: QueueSettings; createdAt: string;
  status: "waiting" | "running" | "success" | "failed" | "cancelled";
  message: string; output?: string; screenshots?: string[];
};
export type JianyingQueueState = { running: boolean; tasks: JianyingTask[] };

/** One desktop editor means exactly one active job, including while pausing. */
export class JianyingTaskQueue {
  private tasks: JianyingTask[];
  private running = false;
  private draining = false;
  constructor(saved: JianyingTask[], private execute: (task: JianyingTask) => Promise<void>,
    private changed: (state: JianyingQueueState) => void) {
    this.tasks = saved.map(task => task.status === "running"
      ? {...task, status: "waiting", message: "应用已重启，等待继续"} : task);
  }
  snapshot(): JianyingQueueState { return structuredClone({running:this.running,tasks:this.tasks}); }
  private publish() { this.changed(this.snapshot()); }
  add(source: string, name: string, settings: QueueSettings) {
    if (this.tasks.some(task=>task.source.toLowerCase()===source.toLowerCase() && ["waiting","running"].includes(task.status)))
      throw new Error("这个文件夹已在队列中");
    this.tasks.push({id:randomUUID(),source,name,settings:{...settings},createdAt:new Date().toISOString(),status:"waiting",message:"等待执行"});
    this.publish(); void this.drain(); return this.snapshot();
  }
  start() { this.running=true; this.publish(); void this.drain(); return this.snapshot(); }
  pause() { this.running=false; this.publish(); return this.snapshot(); }
  update(id: string, update: Partial<Pick<JianyingTask,"message"|"output"|"screenshots">>) {
    const task=this.tasks.find(task=>task.id===id); if (task) { Object.assign(task,update); this.publish(); }
  }
  remove(id: string) {
    if (this.tasks.some(task=>task.id===id && task.status==="running")) throw new Error("请先停止正在处理的任务");
    this.tasks=this.tasks.filter(task=>task.id!==id); this.publish(); return this.snapshot();
  }
  retry(id: string) {
    const task=this.tasks.find(task=>task.id===id);
    if (!task || !["failed","cancelled"].includes(task.status)) throw new Error("只能重试失败或已停止的任务");
    task.status="waiting"; task.message="等待重试"; delete task.output; delete task.screenshots;
    this.publish(); void this.drain(); return this.snapshot();
  }
  private async drain() {
    if (this.draining || !this.running) return;
    this.draining=true;
    try {
      while (this.running) {
        const task=this.tasks.find(task=>task.status==="waiting"); if (!task) break;
        task.status="running"; task.message="正在开始"; this.publish();
        try { await this.execute(structuredClone(task)); task.status="success"; }
        catch (error) {
          task.status=error instanceof Error && error.name==="AbortError" ? "cancelled" : "failed";
          task.message=String(error);
          // A failed desktop action may leave an unexpected dialog open.
          this.running=false;
        }
        this.publish();
      }
    } finally { this.draining=false; if (!this.tasks.some(task=>task.status==="waiting")) this.running=false; this.publish(); }
  }
}
