import { useNotification } from "@/hooks/use-notification";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AccountSelection } from "@/pages/shared/account-selection";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { kuaishouDramaService, type KuaishouDramaAccount } from "@/platforms/kuaishou-drama/service";
import { kuaishouAccountSyncService as service, type AccountSyncState } from "@/platforms/kuaishou-drama/account-sync-service";
import "./account-sync.css";

export function KuaishouAccountSyncPage() {
  const [accounts, setAccounts] = useState<KuaishouDramaAccount[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [accountsError, setAccountsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<AccountSyncState>({ running: false, stopping: false, message: "选择来源账号后开始同步", completed: 0, failed: 0 });
  const refresh = useCallback(async () => {
    setFetching(true); setAccountsError("");
    try {
      const result = await kuaishouDramaService.listAccounts();
      setAccounts(result.accounts);
      setSelected(ids => ids.filter(id => result.accounts.some(account => account.accountId === id)));
    } catch (cause) { setAccountsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setFetching(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let alive = true; let pending = false;
    const poll = async () => {
      if (pending) return; pending = true;
      try { const next = await service.status(); if (alive) { setState(next); if (next.running && next.accountIds) setSelected(next.accountIds); } }
      catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1500);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const toggle = async () => {
    setBusy(true); setError("");
    try { setState(await (state.running ? service.stop() : service.start(selected))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  useNotification(error || state.error, "error", "账号同步失败");
  const locked = busy || state.running || state.stopping;
  const hasError = Boolean(error || state.error || accountsError);
  const statusLabel = state.stopping ? "正在停止" : hasError ? "连接异常" : state.running ? "同步中" : "未运行";
  return <main className="account-sync-workspace mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
    <WorkspaceActions label="账号同步操作"><Button size="sm" className="account-sync-action h-7 min-w-20 gap-1.5 px-3 text-xs" aria-busy={busy || state.stopping} disabled={busy || state.stopping || (!state.running && (fetching || !!accountsError || !selected.length))} onClick={() => void toggle()}>
      {state.stopping ? "正在停止…" : busy ? "处理中…" : state.running ? "停止同步" : "开始同步"}
    </Button></WorkspaceActions>
    <header className="flex items-center justify-between gap-3"><h1 className="text-sm font-semibold">来源账号</h1>
      <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
    </header>
    <AccountSelection showRuntime={false} lockedLabel="停止同步后可更换账号" locked={locked} selection={{ accounts, selected, setSelected, fetching, error: accountsError, refresh }} />
    <section aria-label="同步进度" className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p role="status" className="text-xs text-muted-foreground">{state.running || state.stopping ? state.message : hasError ? "同步未启动" : selected.length ? "已就绪" : "请选择来源账号"}</p>
        <dl className="flex items-center gap-5 text-xs tabular-nums">
          <div className="flex gap-2"><dt className="text-muted-foreground">已同步</dt><dd className="font-medium">{state.completed}</dd></div>
          <div className="flex gap-2"><dt className="text-muted-foreground">失败</dt><dd className={state.failed ? "font-medium text-destructive" : "font-medium"}>{state.failed}</dd></div>
        </dl>
      </div>
      {state.current && <p className="break-words text-sm text-muted-foreground">{state.currentAccountName && `${state.currentAccountName}：`}{state.current}</p>}
    </section>
  </main>;
}
