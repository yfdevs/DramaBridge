import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import { taobaoDramaService, type TaobaoDramaAccount, type TaobaoDramaServiceStatus } from "@/platforms/taobao-drama/service"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

const initialStatus: TaobaoDramaServiceStatus = {
  platform: "taobao-drama",
  running: false,
  collectionCreateUrl: "https://creator.guanghe.taobao.com/page/unify/collect-create",
  batchPublishUrl: "https://creator.guanghe.taobao.com/page/unify/creation-tool/batch-publish?ugc_scene=short_drama_multipublish",
  loginUrl: "https://login.taobao.com/",
  accounts: [],
  executions: [],
  pid: null,
}

export function TaobaoDramaServiceControlPage() {
  const [checking, setChecking] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<TaobaoDramaAccount[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const service = useMemo(() => ({
    ...taobaoDramaService,
    start: () => taobaoDramaService.start(selectedIds),
  }), [selectedIds])
  const state = useServiceControl({
    initialStatus,
    service,
    successMessage: (status) => status.running ? "淘宝合集创建与上传服务已启动" : "淘宝合集创建与上传服务已停止",
  })
  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true)
    setAccountsError(null)
    try {
      const result = await taobaoDramaService.listAccounts()
      setAccounts(result.accounts)
      setSelectedIds(result.selectedAccountIds)
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : String(error))
    } finally { setAccountsLoading(false) }
  }, [])
  useEffect(() => { void loadAccounts() }, [loadAccounts])
  const selectionLocked = state.status.running || state.loading || accountsLoading
  const enabledIds = accounts.filter((account) => account.status === "ON").map((account) => account.accountId)
  const recheck = async (id: string) => {
    if (checking) return
    setChecking(id)
    try {
      await taobaoDramaService.recheckExecution(id)
      await state.refreshStatus()
      toast.success("后台状态已确认，本地暂停记录已解除")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally { setChecking(null) }
  }
  return (
    <ServiceControlButtonPage
      analyticsPlatform="taobao-drama"
      loading={state.loading}
      pendingAction={state.pendingAction}
      running={state.status.running}
      startDisabled={accountsLoading || accountsError !== null || selectedIds.length === 0}
      onToggle={() => void state.toggleService()}
      beforeBrowserInstances={(
        <section aria-label="淘宝账号选择" aria-busy={accountsLoading} className="mt-10 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[13px] font-medium">淘宝账号 <span className="ml-2 font-normal text-muted-foreground">已选 {selectedIds.length} / {accounts.length}</span></h2>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={selectionLocked || !!accountsError || !enabledIds.length}
                onClick={() => setSelectedIds(enabledIds)}>全选</Button>
              <Button size="sm" variant="ghost" disabled={selectionLocked || !selectedIds.length}
                onClick={() => setSelectedIds([])}>清空</Button>
              <Button size="sm" variant="outline" disabled={selectionLocked} onClick={() => void loadAccounts()}>刷新账号</Button>
            </div>
          </div>
          <p className="text-[13px] leading-6 text-muted-foreground">
            {state.status.running ? "服务正在运行，停止后可重新选择账号。" : "勾选本次使用的账号，启动服务时只打开所选账号的浏览器。"}
          </p>
          {accountsLoading ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-label="正在加载账号">
              {[0, 1].map((key) => <Skeleton key={key} className="h-24 rounded-lg" />)}
            </div>
          ) : accountsError ? (
            <p role="alert" className="text-sm text-destructive">账号加载失败：{accountsError}。请检查配置后刷新账号。</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无淘宝账号，请先在后台添加账号，再刷新列表。</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {accounts.map((account) => {
                const selected = selectedIds.includes(account.accountId)
                const disabled = account.status !== "ON"
                const runtime = state.status.accounts.find((item) => item.accountId === account.accountId)
                return (
                  <label key={account.accountId} className={cn(
                    "flex min-w-0 items-start gap-3 rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring",
                    selected ? "border-primary bg-accent/50" : "border-border",
                    selectionLocked || disabled ? "cursor-default" : "cursor-pointer hover:bg-accent/40",
                  )}>
                    <Checkbox className="mt-0.5" checked={selected} disabled={selectionLocked || disabled}
                      aria-label={`选择 ${account.accountName}`}
                      onCheckedChange={(checked) => setSelectedIds((ids) => checked ? [...new Set([...ids, account.accountId])] : ids.filter((id) => id !== account.accountId))} />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium">
                        <span className="break-all">{account.accountName}</span>
                        <span className="shrink-0 text-xs font-normal text-muted-foreground">{disabled ? "已停用" : selected ? "已选择" : "未选择"}</span>
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">账号 ID：{account.accountId}</span>
                      {account.loginAccount && <span className="block break-all text-xs text-muted-foreground">登录账号：{account.loginAccount}</span>}
                      {runtime?.launched && <span className="block text-xs">{runtime.loginState === "logged-in" ? "已登录" : runtime.loginState === "verification-required" ? "等待安全验证" : runtime.loginState === "login-required" ? "等待登录" : "浏览器已打开"}</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </section>
      )}
    >
      {state.status.accounts.filter((account) => account.claimPausedReason).map((account) => (
        <p key={account.accountId} role="status" className="mt-6 text-sm text-destructive">
          {account.accountName}：{account.claimPausedReason}
        </p>
      ))}
      {state.status.executions.length > 0 && (
        <section aria-label="待处理任务" className="mt-10 space-y-4">
          <h2 className="text-sm font-medium">待处理任务</h2>
          <p className="text-xs leading-6 text-muted-foreground">
            待补报的结果会在服务运行时自动重发。结果待核实的任务请先停止服务，在淘宝和后台确认、处理，再点击重新检查。
          </p>
          {state.status.executions.map((record) => (
            <div key={record.id} className="space-y-2 border-t pt-4 text-sm">
              <p className="font-medium">{record.originalTitle || `任务 ${record.taskId}`} · {record.phase === "report-pending" ? "等待补报" : "需要核实"}</p>
              <p className="text-xs text-muted-foreground">账号 {record.accountId} · 任务 {record.taskId} · 轮次 {record.attemptCount ?? "未取得"}</p>
              <p className="break-all text-xs text-muted-foreground">执行器：{record.workerId}</p>
              <p className="text-xs leading-6">{record.errorMessage || "结果已保存，等待后台确认，不会重新上传。"}</p>
              {record.phase !== "report-pending" && (
                <Button size="sm" variant="outline" disabled={state.status.running || checking !== null}
                  onClick={() => void recheck(record.id)}>
                  {checking === record.id ? "正在检查…" : "已在后台处理，重新检查"}
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
    </ServiceControlButtonPage>
  )
}
