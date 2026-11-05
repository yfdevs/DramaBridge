import { AccountSelection } from "@/pages/shared/account-selection";
import { ManualTaskCleanupButton } from "@/pages/shared/manual-task-cleanup-button";
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import {
  kuaishouDramaService,
  type KuaishouDramaAccount,
  type KuaishouDramaServiceStatus,
} from "@/platforms/kuaishou-drama/service";
import { useCallback, useEffect, useMemo, useState } from "react";

const initialStatus: KuaishouDramaServiceStatus = {
  platform: "kuaishou-drama",
  running: false,
  accounts: [],
  executions: [],
  pid: null,
};

export function KuaishouDramaServiceControlPage() {
  const [accounts, setAccounts] = useState<KuaishouDramaAccount[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const service = useMemo(
    () => ({
      ...kuaishouDramaService,
      start: () => kuaishouDramaService.start(selectedIds),
    }),
    [selectedIds],
  );
  const state = useServiceControl({
    initialStatus,
    service,
    successMessage: (status) => (status.running ? "快手短剧服务已启动" : "快手短剧服务已停止"),
  });
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const result = await kuaishouDramaService.listAccounts();
      setAccounts(result.accounts);
      setSelectedIds(
        result.selectedAccountIds.filter((id) =>
          result.accounts.some((account) => account.accountId === id && account.status === "ON"),
        ),
      );
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : String(error));
    } finally {
      setAccountsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);
  return (
    <ServiceControlButtonPage
      analyticsPlatform="kuaishou-drama"
      loading={state.loading}
      pendingAction={state.pendingAction}
      running={state.status.running}
      startDisabled={accountsLoading || accountsError !== null || selectedIds.length === 0}
      onToggle={() => void state.toggleService()}
      beforeBrowserInstances={
        <AccountSelection runtimes={state.status.accounts}
          locked={state.loading || state.status.running}
          selection={{
            accounts: accounts.map(account => {
            const runtime = state.status.accounts.find(item => item.accountId === account.accountId);
            return { ...account, runtimeLabel: runtime?.launched ? (runtime.loginState === "logged-in" ? "已登录" : runtime.loginState === "login-required" ? "等待登录" : "浏览器已打开") : undefined };
          }),
            selected: selectedIds,
            setSelected: setSelectedIds,
            fetching: accountsLoading,
            error: accountsError ?? "",
            refresh: loadAccounts,
          }}
          actions={<ManualTaskCleanupButton disabled={state.loading} onCleanup={kuaishouDramaService.cleanupTasks} onComplete={() => state.refreshStatus(true)} />}
        />
      }
    >
      {state.status.accounts
        .filter((account) => account.claimPausedReason)
        .map((account) => (
          <p key={account.accountId} role="status" className="mt-6 text-sm text-destructive">
            {account.accountName}：{account.claimPausedReason}
          </p>
        ))}
    </ServiceControlButtonPage>
  );
}
