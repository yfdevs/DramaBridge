import { EmptyStateCard } from "@/components/ui/empty-state-card";
import { ManagementListSkeleton } from "@/pages/shared/management-skeleton";
import { FilterSearchField, FilterToolbar } from "@/components/filter-controls";
import { useNotification } from "@/hooks/use-notification";
import { SearchIcon, ChecklistIcon, ChecklistSelectedIcon } from "@/components/ui/solar-icons";
import { OverflowText } from "@/components/ui/overflow-text";
import type { ReactNode } from "react";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { InstanceStatus } from "./instance-status";
import { AccountActions, type AccountControls } from "./account-actions";
export type { AccountControls } from "./account-actions";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  const [searchInput, setSearchInput] = useState("");
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
    setSearchInput("");
    setAvailability("all");
    setRuntimeFilter("all");
    setSelectionFilter("all");
  };
  return (
    <section aria-label="账号实例" aria-busy={s.fetching} className="flex min-w-0 flex-col gap-2.5">
      {locked && (!controls || single) && <p className="text-xs text-muted-foreground">{lockedLabel ?? (single ? "停止同步后可更换账号" : "停止服务后可更换账号")}</p>}
      <FilterToolbar label="实例筛选">
        <FilterSearchField
          label="搜索实例"
          placeholder="搜索名称、ID、登录账号"
          value={searchInput}
          onChange={(value) => {
            setSearchInput(value);
            if (!value.trim()) setSearch("");
          }}
          onSearch={() => setSearch(searchInput)}
        />
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="搜索账号"
          title="搜索账号"
          disabled={s.fetching}
          onClick={() => setSearch(searchInput)}
        >
          <SearchIcon aria-hidden="true" />
        </Button>
        <ListFilterMenu
          label="筛选"
          groups={[
            {
              key: "availability",
              label: "账号状态",
              value: availability,
              defaultValue: "all",
              onChange: setAvailability,
              options: [
                { value: "all", label: "全部" },
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
                { value: "all", label: "全部" },
                { value: "selected", label: "已选" },
                { value: "unselected", label: "未选" },
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
        {!single && <Button type="button" size="sm" variant="state" data-active={allSelected ? "" : undefined}
          className="h-7 gap-1.5 text-xs"
          aria-label="全选所有启用账号" aria-pressed={allSelected}
          title={allSelected ? "已选中所有启用账号，点击清空选择" : "全选所有启用账号，包含筛选结果外的账号"}
          disabled={disabled || !selectableIds.length}
          onClick={() => s.setSelected(allSelected
            ? []
            : selectableIds)}>
          {allSelected ? <ChecklistSelectedIcon className="size-3.5" aria-hidden="true" /> : <ChecklistIcon className="size-3.5" aria-hidden="true" />}
          {allSelected ? "已选" : "全选"}
        </Button>}
        <span className="text-xs tabular-nums text-muted-foreground">已选 {selectedCount} / {s.accounts.length}</span>
        {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
      </FilterToolbar>
      <div data-skeleton-transition className="@container min-w-0">
        {s.fetching && !s.accounts.length ? (
          <ManagementListSkeleton label="正在读取账号" account rows={4} />
        ) : s.error && !s.accounts.length ? (
          <div role="status" className="py-8 text-center">
            <p className="text-sm font-medium">无法加载账号</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              disabled={s.fetching}
              onClick={() => void s.refresh()}
            >
              重试
            </Button>
          </div>
        ) : !visible.length ? (
          <EmptyStateCard
            title={filtered ? "没有匹配的实例" : "暂无账号"}
            description={filtered ? "调整搜索词或筛选条件后重试" : "请先在后台添加并启用账号"}
            action={filtered && (
              <Button size="sm" variant="outline" onClick={reset}>
                清除筛选
              </Button>
            )}
          />
        ) : (
          <ul aria-label="实例列表" className="flex min-w-0 flex-col divide-y divide-border/50 rounded-lg border border-border/60">
            {visible.map((account) => {
              const runtime = runtimeMap.get(account.accountId);
              const selected = selectedIds.has(account.accountId);
              return (
                <li
                  key={account.accountId}
                  data-selected={selected || undefined}
                  className="grid min-w-0 items-center gap-x-4 gap-y-2 px-3 py-2.5 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-muted/40 data-selected:bg-(--menu-selected) @min-[620px]:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <label
                    className="flex min-w-0 cursor-pointer items-center gap-3 has-[:disabled]:cursor-default"
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
                        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
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
                  {!single && showRuntime && <div className="ml-7 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 @min-[620px]:ml-0 @min-[620px]:flex-nowrap">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 @min-[620px]:w-36">
                      <InstanceStatus
                        disabled={!enabled(account)}
                        launched={Boolean(runtime?.launched)}
                        loginState={runtime?.loginState}
                        label={account.runtimeLabel}
                        paused={runtime?.paused}
                      />
                      {runtime?.launched && runtime.pageCount !== undefined && (
                        <span className="text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                          {runtime.pageCount} 页
                        </span>
                      )}
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
      </div>
    </section>
  );
}
