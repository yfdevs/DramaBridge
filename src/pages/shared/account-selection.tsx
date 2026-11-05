import { Spinner } from "@/components/ui/spinner"
import type { ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { AccountEnabledTag } from "@/pages/shared/account-enabled-tag"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
type Account = { accountId: string; accountName: string; status?: string; loginAccount?: string | null; runtimeLabel?: string }
export function useAccountSelection<T>(service: { listAccounts: () => Promise<Account[]>; start: (ids: string[]) => Promise<T>; status: () => Promise<T>; stop: () => Promise<T> }) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [fetching, setFetching] = useState(true)
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    setFetching(true); setError("")
    try { const next = await service.listAccounts(); setAccounts(next); setSelected(ids => ids.filter(id => next.some(a => a.accountId === id))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setFetching(false) }
  }, [service])
  useEffect(() => { void refresh() }, [refresh])
  const selectedService = useMemo(() => ({ ...service, start: () => service.start(selected) }), [service, selected])
  return { accounts, selected, setSelected, fetching, error, refresh, service: selectedService, startDisabled: fetching || !!error || !selected.length }
}
type Selection = Pick<ReturnType<typeof useAccountSelection>, "accounts" | "selected" | "setSelected" | "fetching" | "error" | "refresh">
export function AccountSelection({ selection: s, locked, actions, runtimes = [] }: { selection: Selection; locked: boolean; actions?: ReactNode; runtimes?: Array<{ accountId: string; launched: boolean; loginState: string }> }) {
  const [search, setSearch] = useState("")
  const enabledIds = [...new Set(s.accounts.filter(a => !a.status || a.status === "ON").map(a => a.accountId))]
  const selectedCount = enabledIds.filter(id => s.selected.includes(id)).length
  const allSelected = enabledIds.length > 0 && selectedCount === enabledIds.length
  const partiallySelected = selectedCount > 0 && !allSelected
  const visibleAccounts = s.accounts.filter(a => `${a.accountName} ${a.accountId} ${a.loginAccount ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()))
  const disabled = locked || s.fetching
  return <section aria-label="选择启动账号" aria-busy={s.fetching} className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-medium">选择启动账号 <span className="ml-2 font-normal text-muted-foreground">已选 {s.selected.length} / {s.accounts.length}</span></h2>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox aria-label="全选启用账号" checked={allSelected} indeterminate={partiallySelected} disabled={disabled || !!s.error || !enabledIds.length} onCheckedChange={() => s.setSelected(allSelected ? [] : enabledIds)} />
          <span>全选启用账号</span>
        </label>
        <Button variant="ghost" size="sm" disabled={disabled || !s.selected.length} onClick={() => s.setSelected([])}>清空</Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => void s.refresh()}>刷新账号</Button>
        {actions}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">勾选本次要启动的账号后，再点击启动服务。禁用账号不可选，全选包含搜索结果之外的启用账号。</p>
    <Input aria-label="搜索账号" placeholder="搜索账号名称、ID 或登录账号" value={search} onChange={event => setSearch(event.target.value)} />
    {s.fetching ? <Skeleton className="h-20 w-full rounded-md" /> : s.error ? <p role="alert" className="text-sm text-destructive">账号加载失败：{s.error}，请刷新重试。</p> : !s.accounts.length ? <p className="text-sm text-muted-foreground">暂无已启用账号，请在后台启用账号后刷新。</p> :
      <div className="max-h-[min(50vh,28rem)] overflow-y-auto divide-y rounded-md border">
        {!visibleAccounts.length && <p className="p-4 text-sm text-muted-foreground">没有匹配的账号，请调整搜索内容。</p>}
        {visibleAccounts.map(a => <label key={a.accountId} className="flex min-w-0 items-center gap-3 p-3 hover:bg-accent/40 has-[[data-checked]]:bg-accent/50">
          <Checkbox checked={s.selected.includes(a.accountId)} disabled={disabled || (!!a.status && a.status !== "ON")} onCheckedChange={checked => s.setSelected(ids => checked ? [...new Set([...ids, a.accountId])] : ids.filter(id => id !== a.accountId))} />
          <span className="min-w-0 flex-1 space-y-1 text-sm"><span className="flex items-start justify-between gap-3"><span className="min-w-0 break-all font-medium">{a.accountName || a.accountId}</span><AccountEnabledTag enabled={!a.status || a.status === "ON"} /></span><span className="block break-all text-xs text-muted-foreground">账号 ID：{a.accountId}</span>{a.loginAccount && <span className="block break-all text-xs text-muted-foreground">登录账号：{a.loginAccount}</span>}{runtimes.find(r => r.accountId === a.accountId && r.launched) ? <span className="flex items-center gap-1.5 text-xs" role="status"><Spinner aria-hidden="true" className="size-3 motion-reduce:animate-none" />{runtimes.find(r => r.accountId === a.accountId)?.loginState === "logged-in" ? "已登录 · 运行中" : a.runtimeLabel || "等待登录"}</span> : a.runtimeLabel && <span className="block text-xs">{a.runtimeLabel}</span>}</span>
        </label>)}
      </div>}
  </section>
}
