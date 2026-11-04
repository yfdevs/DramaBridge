import { ManualTaskCleanupButton } from "@/pages/shared/manual-task-cleanup-button";
import { AccountEnabledIcon } from "@/pages/shared/account-enabled-icon";
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control";
import {
  taobaoDramaService,
  type TaobaoDramaAccount,
  type TaobaoDramaServiceStatus,
} from "@/platforms/taobao-drama/service";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
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
  const selectionLocked = state.status.running || state.loading || accountsLoading;
  const enabledIds = accounts
    .filter((account) => account.status === "ON")
    .map((account) => account.accountId);
  return (
    <ServiceControlButtonPage
      analyticsPlatform="taobao-drama"
      loading={state.loading}
      pendingAction={state.pendingAction}
      running={state.status.running}
      startDisabled={accountsLoading || accountsError !== null || selectedIds.length === 0}
      onToggle={() => void state.toggleService()}
      beforeBrowserInstances={
        <section
          aria-label="淘宝账号选择"
          aria-busy={accountsLoading}
          className="mt-10 min-w-0 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium">
              淘宝账号{" "}
              <span className="ml-2 font-normal text-muted-foreground">
                已选 {selectedIds.length} / {accounts.length}
              </span>
            </h2>
            <div className="flex max-w-full flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={selectionLocked || !!accountsError || !enabledIds.length}
                onClick={() => setSelectedIds(enabledIds)}
              >
                全选
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={selectionLocked || !selectedIds.length}
                onClick={() => setSelectedIds([])}
              >
                清空
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={selectionLocked}
                onClick={() => void loadAccounts()}
              >
                刷新账号
              </Button>
              <ManualTaskCleanupButton
                disabled={state.loading}
                onCleanup={taobaoDramaService.cleanupTasks}
                onComplete={() => state.refreshStatus(true)}
              />
            </div>
          </div>
          {accountsLoading ? (
            <div
              className="grid max-h-[min(50vh,28rem)] min-w-0 auto-rows-max grid-cols-1 gap-3 overflow-y-auto overscroll-contain p-1.5 [scrollbar-gutter:stable] sm:grid-cols-2"
              aria-label="正在加载账号"
            >
              {[0, 1].map((key) => (
                <Skeleton key={key} className="h-24 rounded-lg" />
              ))}
            </div>
          ) : accountsError ? (
            <p role="alert" className="text-sm text-destructive">
              账号加载失败：{accountsError}。请检查配置后刷新账号。
            </p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无淘宝账号，请先在后台添加账号，再刷新列表。
            </p>
          ) : (
            <div className="grid max-h-[min(50vh,28rem)] min-w-0 auto-rows-max grid-cols-1 gap-3 overflow-y-auto overscroll-contain p-1.5 [scrollbar-gutter:stable] sm:grid-cols-2">
              {accounts.map((account) => {
                const selected = selectedIds.includes(account.accountId);
                const disabled = account.status !== "ON";
                const runtime = state.status.accounts.find(
                  (item) => item.accountId === account.accountId,
                );
                return (
                  <label
                    key={account.accountId}
                    className={cn(
                      "flex h-fit min-w-0 items-start gap-3 rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring",
                      selected ? "border-primary bg-accent/50" : "border-border",
                      selectionLocked || disabled
                        ? "cursor-default"
                        : "cursor-pointer hover:bg-accent/40",
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={selected}
                      disabled={selectionLocked || disabled}
                      aria-label={`选择 ${account.accountName}`}
                      onCheckedChange={(checked) =>
                        setSelectedIds((ids) =>
                          checked
                            ? [...new Set([...ids, account.accountId])]
                            : ids.filter((id) => id !== account.accountId),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex min-w-0 items-start justify-between gap-2 text-[13px] font-medium">
                        <span className="min-w-0 flex-1 whitespace-normal break-all">
                          {account.accountName}
                        </span>
                        <AccountEnabledIcon enabled={!disabled} />
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        账号 ID：{account.accountId}
                      </span>
                      {account.loginAccount && (
                        <span className="block break-all text-xs text-muted-foreground">
                          登录账号：{account.loginAccount}
                        </span>
                      )}
                      {runtime?.launched && (
                        <span className="block text-xs">
                          {runtime.loginState === "logged-in"
                            ? "已登录"
                            : runtime.loginState === "verification-required"
                              ? "等待安全验证"
                              : runtime.loginState === "login-required"
                                ? "等待登录"
                                : "浏览器已打开"}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
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
