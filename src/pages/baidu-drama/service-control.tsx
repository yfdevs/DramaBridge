import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { ServiceControlButtonPage, useServiceControl } from "@/pages/shared/service-control"
import { baiduDramaService, type BaiduDramaServiceStatus } from "@/platforms/baidu-drama/service"

const initialStatus: BaiduDramaServiceStatus = {
  platform: "baidu-drama",
  running: false,
  createUrl: "https://duanju.baidu.com/builder/rc/edit?type=playlet&sub_type=create_playlet_type&action=new",
  loginUrl: "https://duanju.baidu.com/builder/theme/playletPlat/product",
  accounts: [],
  pid: null,
}

function successMessage(status: BaiduDramaServiceStatus) {
  const browserCount = status.accounts.filter((account) => account.launched).length
  return status.running
    ? `百度短剧服务已启动 ${browserCount} 个账号浏览器`
    : "百度短剧服务已停止"
}

export function BaiduDramaServiceControlPage() {
  const [accounts, setAccounts] = useState<Array<{ accountId: string; accountName: string }>>([])
  const [selected, setSelected] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState("")
  const refreshAccounts = async () => {
    setFetching(true); setError("")
    try {
      const next = await baiduDramaService.listAccounts()
      setAccounts(next)
      setSelected(previous => previous.filter(id => next.some(account => account.accountId === id)))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setFetching(false) }
  }
  useEffect(() => { void refreshAccounts() }, [])
  const service = useMemo(() => ({ ...baiduDramaService, start: () => baiduDramaService.start(selected) }), [selected])
  const serviceState = useServiceControl({
    initialStatus,
    service,
    successMessage,
  })

  return (
    <ServiceControlButtonPage
      analyticsPlatform="baidu-drama"
      startDisabled={fetching || selected.length === 0}
      beforeBrowserInstances={<section className="space-y-3" aria-label="选择百度账号">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm">选择要启动的账号（已选 {selected.length} 个）</p>
          <Button variant="outline" size="sm" disabled={fetching || serviceState.loading || serviceState.status.running} onClick={() => void refreshAccounts()}>{fetching ? "加载中…" : "刷新账号"}</Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!fetching && !error && !accounts.length && <p className="text-sm text-muted-foreground">暂无已启用账号，请先在后台启用账号后刷新。</p>}
        <div className="flex flex-wrap gap-4">{accounts.map(account => <label key={account.accountId} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(account.accountId)} disabled={serviceState.loading || serviceState.status.running} onChange={event => setSelected(previous => event.target.checked ? [...previous, account.accountId] : previous.filter(id => id !== account.accountId))} />
          {account.accountName || account.accountId}
        </label>)}</div>
      </section>}
      loading={serviceState.loading}
      pendingAction={serviceState.pendingAction}
      running={serviceState.status.running}
      onToggle={() => void serviceState.toggleService()}
    />
  )
}
