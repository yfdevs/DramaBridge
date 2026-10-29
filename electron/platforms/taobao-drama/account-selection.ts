export function selectTaobaoAccounts<T extends { accountId: string }>(accounts: T[], selectedIds: unknown): T[] {
  if (!Array.isArray(selectedIds) || !selectedIds.length ||
    selectedIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("请至少选择一个淘宝账号后再启动服务。");
  }
  const selected = new Set<string>(selectedIds);
  const available = new Set(accounts.map((account) => account.accountId));
  if ([...selected].some((id) => !available.has(id))) {
    throw new Error("所选淘宝账号已停用或不存在，请刷新账号列表后重新选择。");
  }
  return accounts.filter((account) => selected.has(account.accountId));
}
