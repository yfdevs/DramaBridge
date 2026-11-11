import { AccountSelection } from "@/pages/shared/account-selection";
import { ManualTaskCleanupButton } from "@/pages/shared/manual-task-cleanup-button";
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import {
  taobaoDramaService,
  type TaobaoDramaAccount,
  type TaobaoDramaServiceStatus,
} from "@/platforms/taobao-drama/service";
import { useCallback, useEffect, useMemo, useState } from "react";

const initialStatus: TaobaoDramaServiceStatus = {
  platform: "taobao-drama",
  running: false,
  collectionCreateUrl: "https://creator.guanghe.taobao.com/page/unify/collect-create",
  batchPublishUrl:
    "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish",
  loginUrl: "https://login.taobao.com/",
  accounts: [],
  executions: [],
  pid: null,
};

export function TaobaoDramaServiceControlPage() {
  const [accounts, setAccounts] = useState<TaobaoDramaAccount[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const service = useMemo(
    () => ({
      ...taobaoDramaService,
      start: () => taobaoDramaService.start(selectedIds),
    }),
    [selectedIds],
  );
  const state = useServiceControl({
    initialStatus,
    service,
    successMessage: (status) =>
      status.running ? "淘宝合集创建与上传服务已启动" : "淘宝合集创建与上传服务已停止",
  });
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const result = await taobaoDramaService.listAccounts();
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
      analyticsPlatform="taobao-drama"
      loading={state.loading}
      pendingAction={state.pendingAction}
      running={state.status.running}
      startDisabled={accountsLoading || accountsError !== null || selectedIds.length === 0}
      onToggle={() => void state.toggleService()}
      beforeBrowserInstances={
        <AccountSelection controls={taobaoDramaService.accountControl} runtimes={state.status.accounts}
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
          actions={<ManualTaskCleanupButton disabled={state.loading} onCleanup={taobaoDramaService.cleanupTasks} onComplete={() => state.refreshStatus(true)} />}
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
