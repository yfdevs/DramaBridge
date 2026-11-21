import { useNotification } from "@/hooks/use-notification";
import { RotateCwIcon, UserSearch, SlidersHorizontal, ListChecks, CheckIcon, XIcon } from "lucide-react";
import { OverflowText } from "@/components/ui/overflow-text";
import type { ReactNode } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { InstanceStatus } from "./instance-status";
import { AccountActions, type AccountControls } from "./account-actions";
export type { AccountControls } from "./account-actions";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
      const normalized = next.map(account => ({ ...account, accountId: String(account.accountId) }));
      setAccounts(normalized);
      setSelected((ids) => ids.filter((id) => normalized.some((a) => a.accountId === id && enabled(a))));
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
  const [search, setSearch] = useState("");
  const [availability, setAvailability] = useState("all");
  const [runtimeFilter, setRuntimeFilter] = useState("all");
  const [selectionFilter, setSelectionFilter] = useState("all");
  const keywords = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.accountId, runtime]));
  const selectedIds = new Set(s.selected);
  const visible = s.accounts.filter((account) => {
    const runtime = runtimeMap.get(account.accountId);
    return (
      keywords.every(keyword => `${account.accountName} ${account.accountId} ${account.loginAccount ?? ""}`
        .toLocaleLowerCase()
        .includes(keyword)) &&
      (selectionFilter === "all" || selectedIds.has(account.accountId) === (selectionFilter === "selected")) &&
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
  const selectableIds = [...new Set(s.accounts.filter(enabled).map(account => account.accountId))];
  const selectedCount = selectableIds.filter(id => selectedIds.has(id)).length;
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));
  const disabled = (locked && (!controls || single)) || s.fetching;
  const filtered = Boolean(search.trim() || availability !== "all" || runtimeFilter !== "all" || selectionFilter !== "all");
  const reset = () => {
    setSearch("");
    setAvailability("all");
    setRuntimeFilter("all");
    setSelectionFilter("all");
  };
  return (
    <section aria-label="账号实例" aria-busy={s.fetching} className="flex min-w-0 flex-col gap-2.5">
      {locked && (!controls || single) && <p className="text-xs text-muted-foreground">{lockedLabel ?? (single ? "停止同步后可更换账号" : "停止服务后可更换账号")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-7 w-full min-w-0 rounded-md sm:max-w-80 sm:flex-1">
          <InputGroupAddon>
            <UserSearch aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="搜索实例"
            placeholder="搜索名称、ID、登录账号"
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
          label="筛选"
          showLabel
          icon={<SlidersHorizontal aria-hidden="true" />}
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
            ...(!single ? [{
              key: "selection",
              label: "选择状态",
              value: selectionFilter,
              defaultValue: "all",
              onChange: setSelectionFilter,
              options: [
                { value: "all", label: "全部账号" },
                { value: "selected", label: "已选账号" },
                { value: "unselected", label: "未选账号" },
              ],
            }] : []),
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
        {!single && <Button type="button" size="sm" variant={allSelected ? "secondary" : "outline"}
          className="h-7 gap-1.5 text-xs" aria-pressed={allSelected}
          title={allSelected ? "取消全部选择" : "全选所有启用账号，包含筛选结果外的账号"}
          disabled={disabled || !selectableIds.length}
          onClick={() => s.setSelected(allSelected
            ? []
            : selectableIds)}>
          {allSelected ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <ListChecks className="size-3.5" aria-hidden="true" />}
          {allSelected ? "已全选" : "全选"}
        </Button>}

        <Button
          variant="outline"
          size="icon-sm"
          aria-label="刷新账号"
          title="刷新账号"
          disabled={s.fetching}
          onClick={() => void s.refresh()}
        >
          <RotateCwIcon aria-hidden="true" className={s.fetching ? "motion-safe:animate-spin" : undefined} />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">已选 {selectedCount} / {s.accounts.length}</span>
        {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
      </div>
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
        <ul aria-label="实例列表" className="flex min-w-0 flex-col divide-y divide-border/50 rounded-lg border border-border/60">
          {visible.map((account) => {
            const runtime = runtimeMap.get(account.accountId);
            const selected = selectedIds.has(account.accountId);
            return (
              <li key={account.accountId} className={`grid min-w-0 grid-cols-1 items-center gap-x-4 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_auto] first:rounded-t-lg last:rounded-b-lg ${selected ? "bg-muted/40" : "hover:bg-muted/20"}`}>
                <label
                  className="flex min-w-0 cursor-pointer items-center gap-3"
                >
                  {single ? <input
                    type="radio"
                    name={radioName}
                    className="size-4 shrink-0 accent-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={`选择账号 ${account.accountName || account.accountId}`}
                    checked={selected}
                    disabled={disabled || !enabled(account)}
                    onChange={() => s.setSelected([account.accountId])}
                  /> : <Checkbox
                    className="shrink-0"
                    aria-label={`选择账号 ${account.accountName || account.accountId}`}
                    checked={selected}
                    disabled={disabled || !enabled(account)}
                    onCheckedChange={(checked) => {
                      s.setSelected((ids) =>
                        checked
                          ? [...new Set([...ids, account.accountId])]
                          : ids.filter((id) => id !== account.accountId),
                      );
                    }}
                  />}
                  <span className="min-w-0 flex-1">
                    <span className="block w-full min-w-0 space-y-1">
                      <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
                        <OverflowText className="min-w-0 flex-1">
                          {account.accountName || account.accountId}
                        </OverflowText>
                        {!enabled(account) && (single || !showRuntime) && (
                          <span className="text-xs font-normal text-muted-foreground">已禁用</span>
                        )}
                      </span>
                      <OverflowText className="text-xs text-muted-foreground">
                        ID {account.accountId}
                        {account.loginAccount ? ` / ${account.loginAccount}` : ""}
                      </OverflowText>
                    </span>
                  </span>
                </label>
                {!single && showRuntime && <div className={`ml-7 mt-2 grid items-center gap-x-3 md:ml-0 md:mt-0 ${controls ? "grid-cols-[7rem_3rem_10.5rem]" : "grid-cols-[7rem_3rem]"}`}>
                  <span className="flex min-w-0 items-center">
                    <InstanceStatus
                      disabled={!enabled(account)}
                      launched={Boolean(runtime?.launched)}
                      loginState={runtime?.loginState}
                      label={account.runtimeLabel}
                      paused={runtime?.paused}
                    />
                  </span>
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {runtime?.launched && runtime.pageCount !== undefined ? `${runtime.pageCount} 页` : "—"}
                  </span>
                  {controls && <AccountActions
                    id={account.accountId} name={account.accountName || account.accountId}
                    launched={Boolean(runtime?.launched)} paused={runtime?.paused}
                    controls={controls} disabled={s.fetching || !enabled(account)}
                  />}
                </div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
