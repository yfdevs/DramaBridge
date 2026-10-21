import { trpcIpc as ipcMain } from "../../ipc";

export type TaskAnalyticsPlatformOptions = {
  platform: string;
  apiBaseUrl?: () => string;
  apiPrefix?: string;
  accountConfigPath?: string;
  accountTaskPath?: string;
  accountIdField?: string;
  statusField?: string;
  unsupportedReason?: string;
};

type JsonRecord = Record<string, unknown>;

export type TaskAnalyticsDay = {
  date: string;
  succeeded: number;
  failed: number;
};

export type TaskAnalyticsResult = {
  days: TaskAnalyticsDay[];
  unavailableReason?: string;
};

const DEFAULT_API_BASE_URL = "http://180.184.76.232:19090";
const PAGE_SIZE = 200;
const MAX_PAGES_PER_ACCOUNT = 50;
const SUCCESS_STATUSES = new Set(["SUCCESS", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE"]);
const FAILED_STATUSES = new Set(["FAILED", "FAIL", "ERROR"]);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function scalarText(value: unknown, fallback = "") {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "boolean"
    ? String(value)
    : fallback;
}

function asRows(payload: unknown) {
  const response = asRecord(payload);
  const code = Number(response.code ?? 0);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(scalarText(response.msg, `code=${code}`));
  }

  const page = asRecord(response.data);
  return {
    rows: Array.isArray(page.data) ? page.data.map(asRecord) : [],
    total: Number(page.total ?? 0),
  };
}

async function postPage(apiBaseUrl: string, path: string, body: JsonRecord) {
  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return asRows(await response.json());
}

function dateKey(value: Date | number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function recentDateKeys(dayCount: number) {
  const result: string[] = [];
  const now = Date.now();
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    result.push(dateKey(now - offset * 24 * 60 * 60 * 1000));
  }
  return result;
}

function timestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskTimestamp(task: JsonRecord) {
  return (
    timestamp(task.rpaReportTime) ??
    timestamp(task.updateTime) ??
    timestamp(task.modifiedTime) ??
    timestamp(task.createTime)
  );
}

function taskOutcome(task: JsonRecord, statusField: string) {
  const status = scalarText(task[statusField] ?? task.status ?? task.rpaStatus).toUpperCase();
  if (SUCCESS_STATUSES.has(status)) return "succeeded" as const;
  if (FAILED_STATUSES.has(status)) return "failed" as const;
  if (task.lastErrorMessage || task.rpaFailStage) return "failed" as const;
  return null;
}

export function aggregateTaskAnalytics(
  tasks: JsonRecord[],
  dayCount: number,
  statusField = "status",
): TaskAnalyticsDay[] {
  const days = recentDateKeys(dayCount);
  const dayMap = new Map(
    days.map((date) => [date, { date, succeeded: 0, failed: 0 }]),
  );

  for (const task of tasks) {
    const completedAt = taskTimestamp(task);
    const outcome = taskOutcome(task, statusField);
    if (!completedAt || !outcome) continue;
    const day = dayMap.get(dateKey(completedAt));
    if (!day) continue;

    day[outcome] += 1;
  }

  return [...dayMap.values()];
}

async function fetchAccounts(apiBaseUrl: string, path: string, accountIdField: string) {
  const accounts: string[] = [];
  for (let page = 1; ; page += 1) {
    const result = await postPage(apiBaseUrl, path, {
      page,
      pageSize: PAGE_SIZE,
      accountId: null,
      accountName: null,
      status: "ON",
    });
    for (const row of result.rows) {
      const accountId = row[accountIdField];
      if (typeof accountId === "string" && accountId.trim()) accounts.push(accountId.trim());
    }
    if (result.rows.length < PAGE_SIZE || accounts.length >= result.total) break;
  }
  return [...new Set(accounts)];
}

async function fetchTasks(
  apiBaseUrl: string,
  path: string,
  accountIdField: string,
  statusField: string,
  accountIds: string[],
  oldestDate: string,
) {
  const uniqueTasks = new Map<string, JsonRecord>();
  for (const accountId of accountIds) {
    let fetchedCount = 0;
    for (let page = 1; page <= MAX_PAGES_PER_ACCOUNT; page += 1) {
      const body: JsonRecord = {
        page,
        pageSize: PAGE_SIZE,
        dramaId: null,
        originalTitle: null,
        accountId: null,
        accountName: null,
        status: null,
        auditStatus: null,
        [accountIdField]: accountId,
        [statusField]: null,
      };
      const result = await postPage(apiBaseUrl, path, body);
      fetchedCount += result.rows.length;
      for (const task of result.rows) {
        const id = scalarText(task.id, `${accountId}:${page}:${uniqueTasks.size}`);
        uniqueTasks.set(id, task);
      }

      const datedRows = result.rows
        .map(taskTimestamp)
        .filter((value): value is number => value !== undefined);
      const pageIsOlderThanRange =
        datedRows.length === result.rows.length &&
        datedRows.every((value) => dateKey(value) < oldestDate);
      if (
        result.rows.length < PAGE_SIZE ||
        (result.total > 0 && fetchedCount >= result.total) ||
        pageIsOlderThanRange
      ) {
        break;
      }
    }
  }
  return [...uniqueTasks.values()];
}

export function registerTaskAnalyticsHandler(options: TaskAnalyticsPlatformOptions) {
  const channel = `${options.platform}:analytics:get`;
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (_event, request?: { days?: number }): Promise<TaskAnalyticsResult> => {
    const dayCount = Math.min(90, Math.max(7, Math.floor(request?.days ?? 30)));
    if (options.unsupportedReason) {
      return { days: aggregateTaskAnalytics([], dayCount), unavailableReason: options.unsupportedReason };
    }

    try {
      const apiBaseUrl = options.apiBaseUrl?.().trim() || DEFAULT_API_BASE_URL;
      const apiPrefix = options.apiPrefix ?? `/dramaAiRpa/${options.platform.replace(/-drama$/, "")}`;
      const accountIdField = options.accountIdField ?? "accountId";
      const statusField = options.statusField ?? "status";
      const dateKeys = recentDateKeys(dayCount);
      const accounts = await fetchAccounts(
        apiBaseUrl,
        options.accountConfigPath ?? `${apiPrefix}/accountConfig/page`,
        accountIdField,
      );
      const tasks = await fetchTasks(
        apiBaseUrl,
        options.accountTaskPath ?? `${apiPrefix}/accountTask/page`,
        accountIdField,
        statusField,
        accounts,
        dateKeys[0],
      );
      return { days: aggregateTaskAnalytics(tasks, dayCount, statusField) };
    } catch (error) {
      return {
        days: aggregateTaskAnalytics([], dayCount),
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
