import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { YoutubeSearchField } from "./filter-controls";
import { ListFilterMenu } from "@/components/list-filter-menu";
import { YoutubeListPagination } from "./list-controls";
import { useYoutubePagination } from "./use-youtube-pagination";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { youtubeService, isYoutubeWeb, type YoutubeOauth } from "@/platforms/youtube-drama/service";
import {
  YoutubeServiceActions,
  YoutubeServiceRequired,
  YoutubePageContent,
} from "./shared";

export function YoutubeAccountsPage() {
  const model = useYoutubeRuntime();
  const { status, accounts, oauth, locked, run, setNotice } = model;
  const [callbackUrl, setCallbackUrl] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [authorization, setAuthorization] = useState("all");
  const filtered = accounts.filter(
    (account) =>
      account.name.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()) &&
      (authorization === "all" || account.authorized === (authorization === "authorized")),
  );
  const list = useYoutubePagination(filtered);
  const disabled = locked || model.loading || !status.running;
  const saveName = (id: string) => {
    if (disabled || !editedName.trim()) return;
    void run(async () => {
      await youtubeService.request(`/api/accounts/${id}`, { name: editedName.trim() });
      setEditing(null);
      setNotice("账号名称已更新");
    });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await youtubeService.request("/api/accounts", { name: name.trim() });
      setName("");
      setNotice("账号已添加，请授权");
    });
  };
  return (
    <main
      aria-label="YouTube 账号管理"
      className="youtube-theme flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <YoutubeServiceActions model={model} title="YouTube 账号管理" />
      <YoutubePageContent variant="accounts">
        <YoutubeServiceRequired model={model} />
        {oauth?.status === "pending" && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-xs"
          >
            <span className="min-w-0 break-words">
              {oauth.message || "等待 Google 授权"}
            </span>
            {oauth.status === "pending" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => void run(() => youtubeService.request("/api/oauth/cancel", {}))}
              >
                结束当前授权
              </Button>
            )}
          </div>
        )}
        {isYoutubeWeb && oauth?.status === "pending" && (
          <section
            aria-label="完成 Google 授权"
            className="grid min-w-0 gap-3 rounded-lg border p-4"
          >
            <h3 className="text-sm font-semibold">完成浏览器授权</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              在其他电脑授权后，最后的跳转页面可能无法打开。请复制地址栏的完整地址，粘贴到下方提交
            </p>
            {authorizationUrl && (
              <a
                href={authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline underline-offset-4"
              >
                打开 Google 授权
              </a>
            )}
            <label className="grid gap-2 text-sm font-medium">
              授权回调地址
              <Input
                className="h-7 rounded-md"
                aria-label="授权回调地址"
                value={callbackUrl}
                onChange={(event) => setCallbackUrl(event.target.value)}
                placeholder="粘贴授权后的完整地址"
              />
            </label>
            <Button
              size="sm"
              className="w-fit"
              disabled={disabled || !callbackUrl.trim()}
              onClick={() =>
                void run(async () => {
                  await youtubeService.request("/api/oauth/complete", { callbackUrl });
                  setCallbackUrl("");
                  setNotice("授权已保存");
                })
              }
            >
              提交授权
            </Button>
          </section>
        )}
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 pb-2">
          <label className="grid min-w-0 basis-full gap-2 text-sm font-medium sm:max-w-96 sm:flex-1 sm:basis-auto">
            账号名称
            <Input
              className="h-7 rounded-md"
              aria-label="新账号名称"
              required
              maxLength={60}
              disabled={disabled}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：短剧频道"
            />
          </label>
          <Button size="sm" disabled={disabled || !name.trim()} type="submit">
            添加账号
          </Button>
        </form>
        <section aria-label="YouTube 账号列表" aria-busy={model.loading} className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 pb-4">
            <YoutubeSearchField
              label="搜索账号"
              placeholder="搜索账号名称"
              value={keyword}
              onChange={(value) => {
                setKeyword(value);
                list.reset();
              }}
            />
            <ListFilterMenu
              label="筛选账号"
              groups={[
                {
                  key: "authorization",
                  label: "授权状态",
                  value: authorization,
                  defaultValue: "all",
                  onChange: (value) => {
                    setAuthorization(value);
                    list.reset();
                  },
                  options: [
                    { value: "all", label: "全部状态" },
                    { value: "authorized", label: "已保存授权" },
                    { value: "unauthorized", label: "未保存授权" },
                  ],
                },
              ]}
            />
            <span className="ml-auto text-xs text-muted-foreground">
              已保存授权 {accounts.filter((account) => account.authorized).length} / {accounts.length}
            </span>
          </div>
          {model.loading && (
            <p role="status" className="py-12 text-center text-sm text-muted-foreground">
              正在读取账号…
            </p>
          )}
          {!model.loading && !filtered.length && (
            <p className="p-8 text-center text-xs text-muted-foreground">
              {keyword || authorization !== "all"
                ? "没有符合筛选条件的账号"
                : status.running
                  ? "暂无账号，请先添加上传账号"
                  : "还没有账号"}
            </p>
          )}
          {list.items.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-md px-3 py-4 hover:bg-muted"
            >
              <div className="min-w-0 flex-1 space-y-2">
                {editing === account.id ? (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      aria-label="修改账号名称"
                      autoFocus
                      value={editedName}
                      maxLength={60}
                      onChange={(e) => setEditedName(e.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveName(account.id);
                        } else if (event.key === "Escape") setEditing(null);
                      }}
                      className="h-7 max-w-72 rounded-md"
                    />
                    <Button
                      size="sm"
                      disabled={disabled || !editedName.trim()}
                      onClick={() => saveName(account.id)}
                    >
                      保存名称
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-all text-sm font-medium">{account.name}</h3>
                    <Badge
                      variant="secondary"
                      className={`text-xs ${account.authorized ? "bg-[var(--youtube-success-bg)] text-[var(--youtube-success-text)]" : "bg-[var(--youtube-warning-bg)] text-[var(--youtube-warning-text)]"}`}
                    >
                      {account.authorized ? "已保存授权" : "未保存授权"}
                    </Badge>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void run(async () => {
                      const result = await youtubeService.request<{ url: string }>(
                        "/api/oauth/start",
                        { accountId: account.id },
                      );
                      setAuthorizationUrl(result.url);
                      setCallbackUrl("");
                      setNotice("请在浏览器完成 Google 授权");
                    })
                  }
                >
                  {account.authorized ? "重新授权" : "授权"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || !account.authorized}
                  onClick={() =>
                    void run(async () => {
                      const result = await youtubeService.request<YoutubeOauth>("/api/oauth/test", {
                        accountId: account.id,
                      });
                      if (result.status !== "valid") throw new Error(result.message ?? "授权检查未通过");
                      setNotice(result.message ?? "授权有效");
                    })
                  }
                >
                  检查授权
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setEditing(account.id);
                    setEditedName(account.name);
                  }}
                >
                  重命名
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={disabled}
                      />
                    }
                  >
                    删除
                  </AlertDialogTrigger>
                  <AlertDialogContent className="youtube-theme">
                    <AlertDialogHeader>
                      <AlertDialogTitle>删除账号“{account.name}”？</AlertDialogTitle>
                      <AlertDialogDescription>
                        将移除账号及本地授权。有未完成任务时无法删除
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          void run(async () => {
                            await youtubeService.request(`/api/accounts/${account.id}/delete`, {});
                            setNotice("账号已删除");
                          })
                        }
                      >
                        删除账号
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
          <YoutubeListPagination list={list} />
        </section>
        {!isYoutubeWeb && (
          <p className="text-xs leading-5 text-muted-foreground">
            共用的 Google 凭据可在{" "}
            <Link
              to="/youtube-drama/config"
              className="text-foreground underline underline-offset-4"
            >
              配置管理
            </Link>{" "}
            中更换
          </p>
        )}
      </YoutubePageContent>
    </main>
  );
}
