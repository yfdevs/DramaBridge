import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import { isTaobaoReportRetryable, reportTaobaoAccountTaskApi } from "../api/task.js";
import type { TaobaoDramaHttpClient } from "../api/http-client.js";
import {
  updateTaobaoExecution, type TaobaoExecutionRecord, type TaobaoExecutionStore,
  type TaobaoSubmitCheckpoint, type TaobaoTaskReport,
} from "../shared/task-execution.js";
import type { ClaimedTaobaoDramaTask, TaobaoDramaTaskFailStage } from "../shared/types.js";

export function recoverTaobaoExecutions(store: TaobaoExecutionStore, apiBaseUrl: string, accountId: string) {
  for (const record of store.list(apiBaseUrl, accountId)) {
    if (record.ownerProcessId && record.ownerProcessId !== process.pid) {
      try { process.kill(record.ownerProcessId, 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    if (["claiming", "claimed", "executing"].includes(record.phase)) {
      updateTaobaoExecution(store, record, { phase: "review-required", errorMessage:
        "上次运行在领取或上传过程中中断，结果待核实。已暂停该任务，请先在淘宝和后台确认处理结果。" });
    }
  }
}

export function needsTaobaoSubmissionReview(checkpoints: TaobaoSubmitCheckpoint[]) {
  const latest = new Map<string, TaobaoSubmitCheckpoint>();
  for (const checkpoint of checkpoints) latest.set(
    `${checkpoint.kind}:${checkpoint.startEpisode ?? ""}:${checkpoint.endEpisode ?? ""}`, checkpoint,
  );
  return [...latest.values()].some((item) => item.state === "submitting" || item.kind === "batch");
}

// Publishing and reporting have separate lifecycles. A report failure must never
// enter the publishing failure path or change a successful outcome to failure.
export async function executeTaobaoClaimedTask<T>(options: {
  store: TaobaoExecutionStore; task: ClaimedTaobaoDramaTask;
  publish: (checkpoint: (value: TaobaoSubmitCheckpoint) => void) => Promise<T>;
  failure: (error: unknown) => Promise<{ stage: TaobaoDramaTaskFailStage; message: string }>;
  resultJson: () => Record<string, unknown>;
}): Promise<{ record: TaobaoExecutionRecord; value?: T }> {
  const { store, task } = options;
  const saved = store.get(task.executionId);
  if (!saved || saved.phase !== "claimed" || saved.taskId !== task.accountTaskId ||
      saved.workerId !== task.workerId || saved.attemptCount !== task.attemptCount) {
    throw new Error("TAOBAO_DRAMA_EXECUTION_INVALID: 本地领取记录不匹配，禁止上传");
  }
  let record = updateTaobaoExecution(store, saved, { phase: "executing" });
  const identity = { taskId: task.accountTaskId, workerId: task.workerId, attemptCount: task.attemptCount };
  let value: T;
  try {
    value = await options.publish((checkpoint) => {
      record = updateTaobaoExecution(store, record, { checkpoints: [...record.checkpoints, checkpoint] });
    });
  } catch (error) {
    const { stage, message } = await options.failure(error);
    if (needsTaobaoSubmissionReview(record.checkpoints)) {
      return { record: updateTaobaoExecution(store, record, { phase: "review-required",
        errorMessage: `已点击提交或已有批次发布成功，剩余结果待核实；未自动上报失败或重新上传。${message}` }) };
    }
    const report: TaobaoTaskReport = { ...identity, success: false, failStage: stage,
      errorMessage: message, resultJson: options.resultJson() };
    return { record: updateTaobaoExecution(store, record, { phase: "report-pending", report, errorMessage: message }) };
  }
  const report: TaobaoTaskReport = { ...identity, success: true, resultJson: options.resultJson() };
  // Persist the exact report before any network request, including on success.
  return { record: updateTaobaoExecution(store, record, { phase: "report-pending", report }), value };
}

export async function flushPendingTaobaoReports(options: {
  store: TaobaoExecutionStore; apiBaseUrl: string; accountId: string; client?: TaobaoDramaHttpClient;
  onError?: (message: string) => void;
}) {
  for (const record of options.store.list(options.apiBaseUrl, options.accountId)) {
    if (record.phase !== "report-pending" || !record.report) continue;
    try {
      await reportTaobaoAccountTaskApi({ apiBaseUrl: options.apiBaseUrl, report: record.report, client: options.client });
      updateTaobaoExecution(options.store, record, { phase: "reported", errorMessage: undefined });
    } catch (error) {
      const retryable = isTaobaoReportRetryable(error);
      const message = `${retryable ? "结果已保存，等待自动补报，不会重新上传" : "后台拒绝结果上报，已停止补报，请核实领取身份或任务轮次"}：${formatAutomationErrorReport(error)}`;
      updateTaobaoExecution(options.store, record, { phase: retryable ? "report-pending" : "report-blocked", errorMessage: message });
      options.onError?.(message);
    }
  }
}
