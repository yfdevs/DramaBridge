import { AccountSelection } from "@/pages/shared/account-selection";
import { ManualTaskCleanupButton } from "@/pages/shared/manual-task-cleanup-button";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import {
  type WechatVideoServiceStatus,
  wechatVideoService,
} from "@/platforms/wechat-drama/service";

const initialStatus: WechatVideoServiceStatus = {
  running: false,
  pid: null,
  contractSubjects: [],
  videoAccounts: [],
};

function successMessage(status: WechatVideoServiceStatus) {
  return status.running ? "微信视频号服务已启动" : "微信视频号服务已停止";
}

export function WechatServiceControlPage() {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const result = await wechatVideoService.listAccounts();
      setAccounts(result.accounts);
      setSelectedIds(
        result.selectedAccountIds.filter((id) =>
          result.accounts.some((account) => account.id === id && account.status === "ON"),
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
  const service = useMemo(
    () => ({
      ...wechatVideoService,
      start: async () => {
        await wechatVideoService.selectAccounts(selectedIds);
        return wechatVideoService.start();
      },
    }),
    [selectedIds],
  );
  const { loading, pendingAction, refreshStatus, status, toggleService } = useServiceControl({
    initialStatus,
    service,
    successMessage,
  });

  useEffect(() => {
    return wechatVideoService.onConfigChanged(() => {
      void refreshStatus(true);
    });
  }, [refreshStatus]);

  return (
    <ServiceControlButtonPage
      analyticsPlatform="wechat-drama"
      loading={loading}
      pendingAction={pendingAction}
      running={status.running}
      startDisabled={accountsLoading || accountsError !== null || selectedIds.length === 0}
      onToggle={() => void toggleService()}
      beforeBrowserInstances={
        <AccountSelection controls={wechatVideoService.accountControl} runtimes={status.videoAccounts.map(a => ({ ...a, accountId: a.videoAccountId }))}
          locked={loading || status.running}
          selection={{
            accounts: accounts.map(account => ({ accountId: account.id, accountName: account.name, status: account.status })),
            selected: selectedIds,
            setSelected: setSelectedIds,
            fetching: accountsLoading,
            error: accountsError ?? "",
            refresh: loadAccounts,
          }}
          actions={<ManualTaskCleanupButton disabled={loading} onCleanup={wechatVideoService.cleanupTasks} onComplete={() => refreshStatus(true)} />}
        />
      }
    />
  );
}
