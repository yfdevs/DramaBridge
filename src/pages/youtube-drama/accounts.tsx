import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { YoutubeFilterSelect, YoutubeSearchField } from "./filter-controls";
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
import { Plus, ExternalLink } from "@mynaui/icons-react";
import { youtubeService, isYoutubeWeb, type YoutubeOauth } from "@/platforms/youtube-drama/service";
import { YoutubeFeedback, YoutubeServiceActions, YoutubeServiceRequired } from "./shared";

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
  const disabled = locked || !status.running;
  const add = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await youtubeService.request("/api/accounts", { name });
      setName("");
      setNotice("账号已添加，请授权。");
    });
  };
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <YoutubeServiceActions model={model} title="YouTube 账号管理" />
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 p-4 sm:p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">账号管理</h2>
          <p className="text-xs leading-5 text-muted-foreground">管理上传账号及 Google 授权。</p>
        </div>
        <YoutubeFeedback model={model} />
        <YoutubeServiceRequired model={model} />
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 border-b pb-5">
          <label className="grid min-w-48 max-w-96 flex-1 gap-2 text-xs font-medium">
            账号名称
            <Input
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
            <Plus className="size-3.5" />
            添加账号
          </Button>
        </form>
        <section aria-label="YouTube 账号列表">
          <div className="flex flex-wrap items-center gap-2 border-b pb-4">
            <YoutubeSearchField
              label="搜索账号"
              placeholder="搜索账号名称"
              value={keyword}
              onChange={(value) => {
                setKeyword(value);
                list.reset();
              }}
            />
            <YoutubeFilterSelect
              label="授权状态筛选"
              caption="授权状态"
              value={authorization}
              onChange={(value) => {
                setAuthorization(value);
                list.reset();
              }}
              options={[
                { value: "all", label: "" },
                { value: "authorized", label: "已授权" },
                { value: "unauthorized", label: "未授权" },
              ]}
            />
            {(keyword || authorization !== "all") && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setKeyword("");
                  setAuthorization("all");
                  list.reset();
                }}
              >
                清除筛选
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              已授权 {accounts.filter((account) => account.authorized).length} / {accounts.length}
            </span>
          </div>
          {!filtered.length && (
            <p className="p-8 text-center text-xs text-muted-foreground">
              {keyword || authorization !== "all"
                ? "没有符合筛选条件的账号"
                : status.running
                  ? "暂无账号，请先添加上传账号。"
                  : "启动服务后查看账号。"}
            </p>
          )}
          {list.items.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-4 border-b px-1 py-4 last:border-b-0"
            >
              <div className="min-w-0 flex-1 space-y-2">
                {editing === account.id ? (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      aria-label="修改账号名称"
                      value={editedName}
                      maxLength={60}
                      onChange={(e) => setEditedName(e.target.value)}
                      className="max-w-72"
                    />
                    <Button
                      size="sm"
                      disabled={disabled || !editedName.trim()}
                      onClick={() =>
                        void run(async () => {
                          await youtubeService.request(`/api/accounts/${account.id}`, {
                            name: editedName,
                          });
                          setEditing(null);
                          setNotice("账号名称已更新");
                        })
                      }
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
                    <Badge variant="secondary" className="text-[11px]">
                      {account.authorized ? "已授权" : "未授权"}
                    </Badge>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {account.authorized ? "可用于上传视频。" : "授权后可上传视频。"}
                </p>
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
                      setNotice("请在浏览器完成 Google 授权。");
                    })
                  }
                >
                  <ExternalLink className="size-3.5" />
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
                      setNotice(result.message ?? result.status);
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
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>删除账号“{account.name}”？</AlertDialogTitle>
                      <AlertDialogDescription>
                        将移除账号及本地授权。有未完成任务时无法删除。
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
        {oauth && oauth.status !== "idle" && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-xs"
          >
            <span>{oauth.message || oauth.status}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void run(() => youtubeService.request("/api/oauth/cancel", {}))}
            >
              结束当前授权
            </Button>
          </div>
        )}
        {isYoutubeWeb && oauth?.status === "pending" && (
          <section className="grid gap-3 rounded-lg border p-4">
            <h3 className="text-sm font-semibold">完成浏览器授权</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              在其他电脑授权后，最后的跳转页面可能无法打开。请复制地址栏的完整地址，粘贴到下方提交。
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
            <Input
              aria-label="授权回调地址"
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="粘贴授权后的完整地址"
            />
            <Button
              size="sm"
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
        {!isYoutubeWeb && (
          <p className="text-xs leading-5 text-muted-foreground">
            共用的 Google 凭据可在{" "}
            <Link
              to="/youtube-drama/config"
              className="text-foreground underline underline-offset-4"
            >
              配置管理
            </Link>{" "}
            中更换。
          </p>
        )}
      </div>
    </main>
  );
}
