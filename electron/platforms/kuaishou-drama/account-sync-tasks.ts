export type SyncSourceAccount = { accountId: string; accountName: string };

export function isPendingSyncTask(task: { source: string; title: string; status: string; note?: string; targets?: string }) {
  return Boolean(task.source.trim() && task.title.trim() && task.status.trim() === "未同步");
}

export function selectSyncSource(value: string, selected: SyncSourceAccount[]) {
  const source = value.trim();
  if (!source) return undefined;
  const byId = selected.find(account => account.accountId === source);
  if (byId) return byId;
  const byName = selected.filter(account => account.accountName === source);
  if (byName.length > 1) throw new Error(`来源账号“${source}”重名，请改填账号 ID`);
  // Rows for unselected accounts are intentionally left for a later run.
  return byName[0];
}
