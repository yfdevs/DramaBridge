import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import { taobaoDramaService, type TaobaoDramaServiceStatus } from "@/platforms/taobao-drama/service"
import { Button } from "@/components/ui/button"
import { useState } from "react"
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
  const state = useServiceControl({
    initialStatus,
    service: taobaoDramaService,
    successMessage: (status) => status.running ? "淘宝合集创建与上传服务已启动" : "淘宝合集创建与上传服务已停止",
  })
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
      onToggle={() => void state.toggleService()}
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
