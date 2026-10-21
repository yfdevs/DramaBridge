import { BrowserContextManager } from "../automation/browser-context-manager.js";
import { runPlayletTask } from "../automation/playlet-runner.js";
import type {
  ClaimedAccountTask,
  Config,
  PreparedEpisodeVideo,
  TaskRecord,
  TaskRunOptions,
} from "../shared/types.js";
import { createLogger, type LogContext, runWithLogContext } from "../shared/logger.js";
import { classifyError, ErrorType } from "../shared/errors.js";

const logger = createLogger("task");
const loginCheckTimeoutMs = 60000;

export interface ChannelReservation {
  readonly channelId: string;
  readonly label: string;
  readonly reservedAt: string;
  readonly token: symbol;
  release(): void;
}

export type ChannelBusyState =
  | {
      kind: "reservation";
      label: string;
      busySince: string;
      busyDurationMs: number;
    }
  | {
      kind: "task";
      label: "active-task";
      busySince: string;
      busyDurationMs: number;
      accountTaskId?: number;
      originalTitle?: string;
      status: TaskRecord["status"];
    };

export class TaskService {
  private readonly taskRecordsByKey = new Map<string, TaskRecord>();

  private readonly activeTaskKeyByChannelId = new Map<string, string>();
  private readonly channelReservationsById = new Map<string, ChannelReservation>();

  constructor(private readonly browserContexts: BrowserContextManager) {}

  list(): TaskRecord[] {
    return Array.from(this.taskRecordsByKey.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(accountTaskId: string | number): TaskRecord | undefined {
    return this.taskRecordsByKey.get(this.formatAccountTaskKey(accountTaskId));
  }

  isBusy(channelId?: string): boolean {
    return channelId
      ? this.getChannelBusyState(channelId) !== null
      : this.activeTaskKeyByChannelId.size > 0 || this.channelReservationsById.size > 0;
  }

  getChannelBusyState(channelId: string): ChannelBusyState | null {
    const activeTaskKey = this.activeTaskKeyByChannelId.get(channelId);
    if (activeTaskKey) {
      const taskRecord = this.taskRecordsByKey.get(activeTaskKey);
      if (
        !taskRecord
        || taskRecord.status === "succeeded"
        || taskRecord.status === "failed"
        || taskRecord.status === "interrupted"
      ) {
        this.activeTaskKeyByChannelId.delete(channelId);
        logger.warn("cleared stale active task lock", {
          videoAccountId: channelId,
          videoAccountName: this.browserContexts.getVideoAccountName(channelId),
          taskKey: activeTaskKey,
          taskStatus: taskRecord?.status ?? "missing",
        });
      } else {
        const busySince = taskRecord.startedAt ?? taskRecord.createdAt;
        return {
          kind: "task",
          label: "active-task",
          busySince,
          busyDurationMs: Math.max(0, Date.now() - Date.parse(busySince)),
          accountTaskId: taskRecord.accountTaskId,
          originalTitle: taskRecord.originalTitle,
          status: taskRecord.status,
        };
      }
    }

    const reservation = this.channelReservationsById.get(channelId);
    if (!reservation) return null;
    return {
      kind: "reservation",
      label: reservation.label,
      busySince: reservation.reservedAt,
      busyDurationMs: Math.max(0, Date.now() - Date.parse(reservation.reservedAt)),
    };
  }

  tryReserveChannel(channelId: string, label: string): ChannelReservation | null {
    if (!this.browserContexts.has(channelId)) {
      throw new Error(`Unknown channelId: ${channelId}`);
    }
    if (this.getChannelBusyState(channelId)) {
      return null;
    }

    const token = Symbol(label);
    const reservedAt = new Date().toISOString();
    const reservation: ChannelReservation = {
      channelId,
      label,
      reservedAt,
      token,
      release: () => {
        if (this.channelReservationsById.get(channelId)?.token === token) {
          this.channelReservationsById.delete(channelId);
          logger.info("released channel reservation", {
            reservationLabel: label,
            videoAccountId: channelId,
            videoAccountName: this.browserContexts.getVideoAccountName(channelId),
          });
        }
      },
    };
    this.channelReservationsById.set(channelId, reservation);
    logger.info("reserved channel", {
      reservationLabel: label,
      reservedAt,
      videoAccountId: channelId,
      videoAccountName: this.browserContexts.getVideoAccountName(channelId),
    });
    return reservation;
  }

  async createManualTask(
    mode: TaskRunOptions["mode"],
    channelId = this.browserContexts.getDefaultChannelId(),
    dramaAiRpaId?: string,
  ): Promise<TaskRecord> {
    this.assertChannelAvailable(channelId);

    if (mode === "run" && !dramaAiRpaId) {
      throw new Error("id is required to start a run task.");
    }
    if (mode === "run") {
      const loggedIn = await this.browserContexts.refreshLoginStateInTemporaryPage(
        channelId,
        loginCheckTimeoutMs,
      );
      if (!loggedIn) {
        throw Object.assign(
          new Error(`微信视频号账号未登录，不能创建上剧任务：${this.browserContexts.getVideoAccountName(channelId)}`),
          { errorType: ErrorType.Authentication },
        );
      }
    }

    const task: TaskRecord = {
      mode,
      channelId,
      dramaAiRpaId,
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    runWithLogContext(this.createLogContext(task), () => {
      this.enqueueTaskRecord(task, "queued manual task");
    });
    void this.runTaskRecord(task).catch(() => undefined);
    return task;
  }

  async createTaskFromClaim(
    channelId: string,
    claimedAccountTask: ClaimedAccountTask,
    playletConfig: Config,
    reservation?: ChannelReservation,
    preparedEpisodeVideos?: PreparedEpisodeVideo[],
  ): Promise<{ taskRecord: TaskRecord; taskFinished: Promise<void> }> {
    this.assertChannelAvailable(channelId, reservation);

    const taskRecord: TaskRecord = {
      mode: "run",
      channelId,
      accountTaskId: claimedAccountTask.accountTaskId,
      dramaId: claimedAccountTask.dramaId,
      originalTitle: claimedAccountTask.originalTitle,
      videoAccountId: claimedAccountTask.videoAccountId,
      videoAccountName: claimedAccountTask.videoAccountName,
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    runWithLogContext(this.createLogContext(taskRecord), () => {
      this.enqueueTaskRecord(taskRecord, "queued claimed task");
    });
    return {
      taskRecord,
      taskFinished: this.runTaskRecord(taskRecord, playletConfig, preparedEpisodeVideos),
    };
  }

  private assertChannelAvailable(channelId: string, reservation?: ChannelReservation): void {
    if (!this.browserContexts.has(channelId)) {
      throw new Error(`Unknown channelId: ${channelId}`);
    }
    if (this.activeTaskKeyByChannelId.has(channelId)) {
      throw new Error(`Another task is already running for channelId: ${channelId}`);
    }
    const existingReservation = this.channelReservationsById.get(channelId);
    if (existingReservation && existingReservation.token !== reservation?.token) {
      throw new Error(`Channel is reserved by ${existingReservation.label} for channelId: ${channelId}`);
    }
  }

  private enqueueTaskRecord(taskRecord: TaskRecord, logMessage: string): void {
    logger.info(logMessage, this.createTaskLogFields(taskRecord));
    const taskKey = this.getTaskRecordKey(taskRecord);
    this.taskRecordsByKey.set(taskKey, taskRecord);
    this.activeTaskKeyByChannelId.set(taskRecord.channelId, taskKey);
  }

  private createLogContext(taskRecord: TaskRecord): LogContext {
    return {
      videoAccountId: taskRecord.videoAccountId ?? taskRecord.channelId,
      videoAccountName: taskRecord.videoAccountName ?? this.browserContexts.getVideoAccountName(taskRecord.channelId),
      accountTaskId: taskRecord.accountTaskId,
    };
  }

  private createTaskLogFields(taskRecord: TaskRecord): Record<string, string | number | undefined> {
    return {
      mode: taskRecord.mode,
      status: taskRecord.status,
      accountTaskId: taskRecord.accountTaskId,
      dramaId: taskRecord.dramaId,
      originalTitle: taskRecord.originalTitle,
      videoAccountId: taskRecord.videoAccountId ?? taskRecord.channelId,
      videoAccountName: taskRecord.videoAccountName ?? this.browserContexts.getVideoAccountName(taskRecord.channelId),
      dramaAiRpaId: taskRecord.dramaAiRpaId,
    };
  }

  private formatAccountTaskKey(accountTaskId: string | number): string {
    return `accountTaskId:${accountTaskId}`;
  }

  private getTaskRecordKey(taskRecord: TaskRecord): string {
    return taskRecord.accountTaskId !== undefined
      ? this.formatAccountTaskKey(taskRecord.accountTaskId)
      : `manual:${taskRecord.mode}:${taskRecord.channelId}`;
  }

  private async runTaskRecord(
    taskRecord: TaskRecord,
    playletConfig?: Config,
    preparedEpisodeVideos?: PreparedEpisodeVideo[],
  ): Promise<void> {
    return runWithLogContext(this.createLogContext(taskRecord), async () => {
      taskRecord.status = "running";
      taskRecord.startedAt = new Date().toISOString();
      logger.info("task started", this.createTaskLogFields(taskRecord));
      try {
        const browserContext = await this.browserContexts.getOrLaunch(taskRecord.channelId);
        await runPlayletTask({
          accountTaskId: taskRecord.accountTaskId,
          playletConfig,
          preparedEpisodeVideos,
          dramaAiRpaId: taskRecord.dramaAiRpaId,
          mode: taskRecord.mode,
          interactive: false,
          channelId: taskRecord.channelId,
          videoAccountName: this.browserContexts.getVideoAccountName(taskRecord.channelId),
        }, browserContext);
        taskRecord.status = "succeeded";
        logger.info("task succeeded", this.createTaskLogFields(taskRecord));
      } catch (error) {
        const errorInfo = classifyError(error, ErrorType.TaskExecution);
        if (errorInfo.type === ErrorType.Interrupted) {
          taskRecord.status = "interrupted";
          taskRecord.error = errorInfo.message;
          taskRecord.errorType = errorInfo.type;
          logger.warn("task interrupted", {
            ...this.createTaskLogFields(taskRecord),
            errorType: errorInfo.type,
            errorMessage: errorInfo.message,
          });
          throw error;
        }
        taskRecord.status = "failed";
        taskRecord.error = errorInfo.message;
        taskRecord.errorType = errorInfo.type;
        logger.error("task failed", {
          ...this.createTaskLogFields(taskRecord),
          errorType: errorInfo.type,
          errorMessage: errorInfo.message,
        });
        throw error;
      } finally {
        await this.browserContexts.save(taskRecord.channelId).catch(() => undefined);
        taskRecord.finishedAt = new Date().toISOString();
        this.activeTaskKeyByChannelId.delete(taskRecord.channelId);
      }
    });
  }
}
