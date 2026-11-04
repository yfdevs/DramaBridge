import { ManualTaskCleanupButton } from "@/pages/shared/manual-task-cleanup-button";
import { AccountEnabledIcon } from "@/pages/shared/account-enabled-icon";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [search, setSearch] = useState("");
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
        <section
          aria-label="视频号账号选择"
          aria-busy={accountsLoading}
          className="mt-10 min-w-0 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium">
              视频号账号 · 已选 {selectedIds.length}/{accounts.length}
            </h2>
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={status.running || accountsLoading || pendingAction !== null}
                onClick={() =>
                  setSelectedIds(
                    accounts
                      .filter((account) => account.status === "ON")
                      .map((account) => account.id),
                  )
                }
              >
                全选启用账号
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={status.running || accountsLoading || pendingAction !== null}
                onClick={() => setSelectedIds([])}
              >
                清空
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={status.running || accountsLoading || pendingAction !== null}
                onClick={() => void loadAccounts()}
              >
                刷新账号
              </Button>
              <ManualTaskCleanupButton
                disabled={loading}
                onCleanup={wechatVideoService.cleanupTasks}
                onComplete={() => refreshStatus(true)}
              />
            </div>
          </div>
          <Input
            aria-label="搜索视频号账号"
            placeholder="搜索账号名称或 ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {accountsError && (
            <p role="alert" className="text-sm text-destructive">
              账号加载失败：{accountsError}
            </p>
          )}
          {accountsLoading ? (
            <p className="text-sm text-muted-foreground">正在加载账号…</p>
          ) : accounts.length === 0 && !accountsError ? (
            <p className="text-sm text-muted-foreground">暂无视频号账号，请在后台添加后刷新。</p>
          ) : (
            <div className="grid max-h-[min(50vh,28rem)] min-w-0 auto-rows-max grid-cols-1 gap-3 overflow-y-auto overscroll-contain p-1.5 [scrollbar-gutter:stable] sm:grid-cols-2">
              {accounts
                .filter((account) =>
                  `${account.name} ${account.id}`
                    .toLowerCase()
                    .includes(search.trim().toLowerCase()),
                )
                .map((account) => (
                  <label
                    key={account.id}
                    className="flex h-fit min-w-0 items-start gap-3 rounded-lg border p-4 focus-within:ring-2 focus-within:ring-ring"
                  >
                    <Checkbox
                      aria-label={`选择 ${account.name}`}
                      checked={selectedIds.includes(account.id)}
                      disabled={
                        account.status !== "ON" ||
                        status.running ||
                        accountsLoading ||
                        pendingAction !== null
                      }
                      onCheckedChange={(checked) =>
                        setSelectedIds((ids) =>
                          checked
                            ? [...new Set([...ids, account.id])]
                            : ids.filter((id) => id !== account.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-start justify-between gap-2 text-[13px] font-medium">
                        <span className="min-w-0 flex-1 whitespace-normal break-all">
                          {account.name}
                        </span>
                        <AccountEnabledIcon enabled={account.status === "ON"} />
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {account.id}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          )}
        </section>
      }
    />
  );
}
