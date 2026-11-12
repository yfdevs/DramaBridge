import { useNotification } from "@/hooks/use-notification";
import { RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { InstanceStatus } from "./instance-status";
import { toast } from "@/components/ui/notifications";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
type Account = {
  accountId: string;
  accountName: string;
  status?: string;
  loginAccount?: string | null;
  runtimeLabel?: string;
};
export function useAccountSelection<T>(service: {
  listAccounts: () => Promise<Account[]>;
  start: (ids: string[]) => Promise<T>;
  status: () => Promise<T>;
  stop: () => Promise<T>;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setFetching(true);
    setError("");
    try {
      const next = await service.listAccounts();
      setAccounts(next);
      setSelected((ids) => ids.filter((id) => next.some((a) => a.accountId === id && enabled(a))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFetching(false);
    }
  }, [service]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selectedService = useMemo(
    () => ({ ...service, start: () => service.start(selected) }),
    [service, selected],
  );
  return {
    accounts,
    selected,
    setSelected,
    fetching,
    error,
    refresh,
    service: selectedService,
    startDisabled: fetching || !!error || !selected.length,
  };
}
type Selection = Pick<
  ReturnType<typeof useAccountSelection>,
  "accounts" | "selected" | "setSelected" | "fetching" | "error" | "refresh"
>;
type Runtime = {
  accountId: string;
  launched: boolean;
  loginState: string;
  pageCount?: number;
  paused?: boolean;
};
export type AccountControls = {
  start: (id: string) => Promise<void>;
  pause: (id: string, paused: boolean) => Promise<void>;
};
const enabled = (account: Account) => !account.status || account.status === "ON";

export function AccountSelection({
  selection: s,
  locked,
  actions,
  runtimes = [],
  controls,
  selectionMode = "multiple",
  showRuntime = true,
  lockedLabel,
}: {
  selection: Selection;
  locked: boolean;
  actions?: ReactNode;
  runtimes?: Runtime[];
  controls?: AccountControls;
  selectionMode?: "single" | "multiple";
  showRuntime?: boolean;
  lockedLabel?: string;
}) {
  useNotification(s.error, "error", "账号读取失败");
  const radioName = useId();
  const single = selectionMode === "single";
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const controlAccount = async (id: string, action: () => Promise<void>) => {
    if (pending.has(id)) return;
    setPending((current) => new Set(current).add(id));
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  const [search, setSearch] = useState("");
  const [availability, setAvailability] = useState("all");
  const [runtimeFilter, setRuntimeFilter] = useState("all");
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.accountId, runtime]));
  const visible = s.accounts.filter((account) => {
    const runtime = runtimeMap.get(account.accountId);
    return (
      `${account.accountName} ${account.accountId} ${account.loginAccount ?? ""}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()) &&
      (availability === "all" || enabled(account) === (availability === "enabled")) &&
      (runtimeFilter === "all" ||
        (runtimeFilter === "idle"
          ? !runtime?.launched
          : runtimeFilter === "running"
            ? runtime?.launched
            : runtimeFilter === "paused"
              ? runtime?.paused
              : runtime?.launched && runtime.loginState === "login-required"))
    );
  });
  const visibleIds = [...new Set(visible.filter(enabled).map((account) => account.accountId))];
  const selectedCount = s.accounts.filter(
    (account) => enabled(account) && s.selected.includes(account.accountId),
  ).length;
  const visibleSelected = visibleIds.filter((id) => s.selected.includes(id)).length;
  const allSelected = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  const disabled = locked || s.fetching;
  const filtered = Boolean(search || availability !== "all" || runtimeFilter !== "all");
  const reset = () => {
    setSearch("");
    setAvailability("all");
    setRuntimeFilter("all");
  };
  const running = runtimes.filter((runtime) => runtime.launched).length;
  return (
    <section aria-label="账号实例" aria-busy={s.fetching} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-live="polite">
          <span>
            共{" "}
            <strong className="font-medium tabular-nums text-foreground">
              {s.accounts.length}
            </strong>{" "}
            个账号
          </span>
          <span>
            已选{" "}
            <strong className="font-medium tabular-nums text-foreground">{selectedCount}</strong>
          </span>
          {!single && showRuntime && <span>
            运行中 <strong className="font-medium tabular-nums text-foreground">{running}</strong>
          </span>}
        </div>
        {locked && <span>{lockedLabel ?? (single ? "停止同步后可更换账号" : "停止服务后可更换账号")}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-7 w-full min-w-0 rounded-md sm:max-w-80 sm:flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="搜索实例"
            placeholder="搜索账号名称、ID 或登录账号"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="text-xs"
          />
          {search && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="清空搜索" onClick={() => setSearch("")}>
                <XIcon aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <ListFilterMenu
          label="筛选实例"
          groups={[
            {
              key: "availability",
              label: "账号状态",
              value: availability,
              defaultValue: "all",
              onChange: setAvailability,
              options: [
                { value: "all", label: "全部账号" },
                { value: "enabled", label: "已启用" },
                { value: "disabled", label: "已禁用" },
              ],
            },
            ...(!single && showRuntime ? [{
              key: "runtime",
              label: "运行状态",
              value: runtimeFilter,
              defaultValue: "all",
              onChange: setRuntimeFilter,
              options: [
                { value: "all", label: "全部状态" },
                { value: "running", label: "运行中" },
                { value: "waiting", label: "等待登录" },
                { value: "paused", label: "已暂停" },
                { value: "idle", label: "未启动" },
              ],
            }] : []),
          ]}
        />
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="刷新账号"
          title="刷新账号"
          disabled={s.fetching}
          onClick={() => void s.refresh()}
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
        {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
      </div>
      {!s.fetching && !s.error && s.accounts.length > 0 && (!single || filtered) && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {!single && <label className="flex min-h-7 items-center gap-2">
            <Checkbox
              aria-label="全选当前结果中的启用账号"
              checked={allSelected}
              indeterminate={visibleSelected > 0 && !allSelected}
              disabled={disabled || !visibleIds.length}
              onCheckedChange={() =>
                s.setSelected((ids) =>
                  allSelected
                    ? ids.filter((id) => !visibleIds.includes(id))
                    : [...new Set([...ids, ...visibleIds])],
                )
              }
            />
            全选当前结果
          </label>}
          {!single && selectedCount > 0 && (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => s.setSelected([])}>
              取消选择
            </Button>
          )}
          {filtered && (
            <Button size="sm" variant="ghost" onClick={reset}>
              清除筛选
            </Button>
          )}
          {filtered && (
            <span className="ml-auto text-muted-foreground">匹配 {visible.length} 个账号</span>
          )}
        </div>
      )}
      {s.fetching ? (
        <div className="space-y-3" role="status" aria-label="正在读取账号">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-20 rounded-md" />
          ))}
        </div>
      ) : s.error ? (
        <div role="status" className="py-8 text-center">
          <p className="text-sm font-medium">无法加载账号</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-4"
            disabled={s.fetching}
            onClick={() => void s.refresh()}
          >
            重新加载
          </Button>
        </div>
      ) : !visible.length ? (
        <div role="status" className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filtered ? "没有匹配的实例" : "暂无账号"}
          </p>
          {filtered ? (
            <Button size="sm" variant="ghost" className="mt-3" onClick={reset}>
              清除筛选
            </Button>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">在后台添加并启用账号后刷新</p>
          )}
        </div>
      ) : (
        <ul aria-label="实例列表" className="flex min-w-0 flex-col gap-1">
          {visible.map((account) => {
            const runtime = runtimeMap.get(account.accountId);
            const selected = s.selected.includes(account.accountId);
            return (
              <li key={account.accountId} className={`flex min-w-0 items-start rounded-md ${selected ? "bg-muted/60" : "hover:bg-muted/30"}`}>
                <label
                  className="flex min-w-0 flex-1 items-start gap-3 px-3 py-4"
                >
                  {single ? <input
                    type="radio"
                    name={radioName}
                    className="mt-0.5 size-4 shrink-0 accent-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={`选择账号 ${account.accountName || account.accountId}`}
                    checked={selected}
                    disabled={disabled || !enabled(account)}
                    onChange={() => s.setSelected([account.accountId])}
                  /> : <Checkbox
                    className="mt-0.5"
                    aria-label={`选择账号 ${account.accountName || account.accountId}`}
                    checked={selected}
                    disabled={disabled || !enabled(account)}
                    onCheckedChange={(checked) =>
                      s.setSelected((ids) =>
                        checked
                          ? [...new Set([...ids, account.accountId])]
                          : ids.filter((id) => id !== account.accountId),
                      )
                    }
                  />}
                  <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <span className="min-w-0 space-y-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="break-all">
                          {account.accountName || account.accountId}
                        </span>
                        {!enabled(account) && (
                          <span className="text-xs font-normal text-muted-foreground">已禁用</span>
                        )}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        ID {account.accountId}
                        {account.loginAccount ? ` / ${account.loginAccount}` : ""}
                      </span>
                    </span>
                  </span>
                </label>
                {!single && showRuntime && <div className="flex shrink-0 flex-col items-end gap-2 px-3 py-4">
                  <span className="flex shrink-0 flex-wrap items-center gap-2">
                    <InstanceStatus
                      launched={Boolean(runtime?.launched)}
                      loginState={runtime?.loginState}
                      label={account.runtimeLabel}
                      paused={runtime?.paused}
                    />
                    {runtime?.launched && runtime.pageCount !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {runtime.pageCount} 个页面
                      </span>
                    )}
                  </span>
                  {controls && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`${runtime?.launched ? (runtime.paused ? "恢复账号" : "暂停账号") : "启动账号"} ${account.accountName || account.accountId}`}
                      disabled={pending.has(account.accountId) || s.fetching || !enabled(account)}
                      title={
                        runtime?.launched && !runtime.paused
                          ? "停止领取新任务，已领取任务继续完成"
                          : undefined
                      }
                      onClick={() =>
                        void controlAccount(account.accountId, () =>
                          runtime?.launched
                            ? controls.pause(account.accountId, !runtime.paused)
                            : controls.start(account.accountId),
                        )
                      }
                    >
                      {pending.has(account.accountId)
                        ? "处理中…"
                        : runtime?.launched
                          ? runtime.paused
                            ? "恢复"
                            : "暂停"
                          : "启动"}
                    </Button>
                  )}
                </div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
