import type {
  KuaishouExecutionRecord,
  KuaishouExecutionStore,
} from "../../src/shared/task-execution.js";
export function memoryExecutionStore(): KuaishouExecutionStore {
  const records = new Map<string, KuaishouExecutionRecord>();
  return {
    save(record) {
      records.set(record.id, structuredClone(record));
    },
    get(id) {
      return structuredClone(records.get(id));
    },
    list(url, accountId) {
      return structuredClone(
        [...records.values()].filter(
          (item) =>
            item.apiBaseUrl === url.replace(/\/+$/, "") &&
            (accountId === undefined || item.accountId === accountId),
        ),
      );
    },
  };
}
