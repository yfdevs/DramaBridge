import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
} from "@/components/ui/drawer";
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
import { YoutubeServiceActions, YoutubeServiceRequired, YoutubePageContent } from "./shared";

export function YoutubeAccountsPage() {
  const model = useYoutubeRuntime();
  const { status, accounts, oauth, locked, run, setNotice } = model;
  const [callbackUrl, setCallbackUrl] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [addError, setAddError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [authorization, setAuthorization] = useState("all");
  const [checkingBrowser, setCheckingBrowser] = useState("");
  const [loginAccount, setLoginAccount] = useState<{ id: string; name: string } | null>(null);
  const [reuseAccountId, setReuseAccountId] = useState("");
  const [loginOpened, setLoginOpened] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const browserAction = (action: "start" | "save" | "cancel" | "forget") => {
    if (!loginAccount || loginBusy) return;
    const id = loginAccount.id;
    setLoginBusy(true);
    setLoginError("");
    void run(async () => {
      try {
        const result = await youtubeService.request<{ channelId?: string }>(
          `/api/accounts/${id}/browser/${action}`,
          action === "start" && reuseAccountId ? { reuseAccountId } : {},
        );
        if (action === "start") {
          setLoginOpened(true);
          setNotice("浏览器已打开，请在运行 DramaBridge 的电脑上登录并进入目标频道的 Studio");
        } else if (action === "save") {
          setNotice(`浏览器登录已保存，绑定频道：${result.channelId ?? ""}`);
          setLoginAccount(null);
          setLoginOpened(false);
        } else if (action === "cancel") {
          setLoginAccount(null);
          setLoginOpened(false);
        } else {
          setLoginOpened(false);
          setNotice("网页授权已清除，可重新用浏览器登录");
        }
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : "操作失败，请重试");
      }
    }).finally(() => setLoginBusy(false));
  };
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
    if (disabled || creating || !name.trim()) return;
    setCreating(true);
    setAddError("");
    void run(async () => {
      try {
        await youtubeService.request("/api/accounts", { name: name.trim() });
        setName("");
        setAdding(false);
        setNotice("账号已添加");
      } catch (error) {
        setAddError(error instanceof Error ? error.message : "添加失败，请重试");
      }
    }).finally(() => setCreating(false));
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
            <span className="min-w-0 break-words">{oauth.message || "等待 Google 授权"}</span>
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
            <h3 className="text-sm font-semibold">完成视频上传授权</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              若跳转页面无法打开，请粘贴地址栏的完整地址。
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
                  label: "视频上传授权",
                  value: authorization,
                  defaultValue: "all",
                  onChange: (value) => {
                    setAuthorization(value);
                    list.reset();
                  },
                  options: [
                    { value: "all", label: "全部状态" },
                    { value: "authorized", label: "已授权视频上传" },
                    { value: "unauthorized", label: "未授权视频上传" },
                  ],
                },
              ]}
            />
            <span className="ml-auto text-xs text-muted-foreground">
              共 {accounts.length} 个账号
            </span>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                setName("");
                setAddError("");
                toast.dismiss(undefined, { immediate: true });
                setAdding(true);
              }}
            >
              添加账号
            </Button>
          </div>
          <Table aria-label="YouTube 账号列表" className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">账号名称</TableHead>
                <TableHead className="w-[27%]">视频上传授权</TableHead>
                <TableHead className="w-[27%]">网页操作授权</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(model.loading || !filtered.length) && (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                    {model.loading
                      ? "正在读取…"
                      : keyword || authorization !== "all"
                        ? "无匹配账号"
                        : "暂无账号"}
                  </TableCell>
                </TableRow>
              )}
              {list.items.map((account) => (
                <TableRow key={account.id}>
                  <TableCell className="py-3">
                    {editing === account.id ? (
                      <div className="flex items-center gap-2">
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
                      <span
                        title={account.name}
                        className="block max-w-64 truncate text-sm font-medium"
                      >
                        {account.name}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {account.authorized ? "已授权" : "未授权"}
                      </Badge>
                      <div className="flex shrink-0 items-center gap-1">
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
                              const result = await youtubeService.request<YoutubeOauth>(
                                "/api/oauth/test",
                                {
                                  accountId: account.id,
                                },
                              );
                              if (result.status !== "valid")
                                throw new Error(result.message ?? "授权检查未通过");
                              setNotice(result.message ?? "授权有效");
                            })
                          }
                        >
                          检查
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {account.browser?.needsLogin
                          ? "已失效"
                          : account.browser?.saved
                            ? "已保存"
                            : "未授权"}
                      </Badge>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || account.browser?.busy}
                          onClick={() => {
                            setLoginError("");
                            setReuseAccountId("");
                            setLoginOpened(false);
                            setLoginAccount({ id: account.id, name: account.name });
                          }}
                        >
                          浏览器登录
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disabled || account.browser?.busy || !account.browser?.saved}
                          title={
                            !account.browser?.saved
                              ? "请先完成浏览器登录并确认保存"
                              : "验证登录状态及绑定频道"
                          }
                          onClick={() => {
                            setCheckingBrowser(account.id);
                            void run(async () => {
                              await youtubeService.request(
                                `/api/accounts/${account.id}/browser/check`,
                                {},
                              );
                              setNotice("浏览器登录有效，已核对绑定频道");
                            }).finally(() => setCheckingBrowser(""));
                          }}
                        >
                          {checkingBrowser === account.id ? "检查中…" : "检查"}
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="py-3 [&>div]:justify-end">
                    <div className="flex shrink-0 items-center gap-1">
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
                                  await youtubeService.request(
                                    `/api/accounts/${account.id}/delete`,
                                    {},
                                  );
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <YoutubeListPagination list={list} />
        </section>
        {!isYoutubeWeb && (
          <p className="text-xs leading-5 text-muted-foreground">
            Google 凭据：{" "}
            <Link
              to="/youtube-drama/config"
              className="text-foreground underline underline-offset-4"
            >
              配置管理
            </Link>{" "}
          </p>
        )}
      </YoutubePageContent>
      <Drawer
        swipeDirection="right"
        open={adding}
        onOpenChange={(open) => {
          if (!creating) {
            setAdding(open);
            if (!open) {
              setName("");
              setAddError("");
            }
          }
        }}
      >
        <DrawerContent className="youtube-theme duration-250 ease-out data-[swipe-axis=x]:[--drawer-content-width:100%] data-[swipe-axis=x]:sm:[--drawer-content-width:28rem]">
          <DrawerHeader className="px-6 pt-6 pb-5">
            <DrawerTitle>添加账号</DrawerTitle>
          </DrawerHeader>
          <form onSubmit={add} className="flex min-h-0 flex-1 flex-col" aria-busy={creating}>
            <div className="flex-1 space-y-3 overflow-y-auto px-6">
              <label htmlFor="youtube-account-name" className="block text-sm font-medium">
                账号名称
              </label>
              <Input
                id="youtube-account-name"
                autoFocus
                required
                maxLength={60}
                value={name}
                disabled={creating}
                onChange={(event) => {
                  setName(event.target.value);
                  setAddError("");
                }}
                placeholder="输入账号名称"
                aria-invalid={Boolean(addError)}
                aria-describedby={addError ? "youtube-account-error" : undefined}
              />
              {addError && (
                <p id="youtube-account-error" role="alert" className="text-xs text-destructive">
                  {addError}
                </p>
              )}
            </div>
            <DrawerFooter className="flex-row justify-end border-t px-6 py-4">
              <Button
                type="button"
                variant="ghost"
                disabled={creating}
                onClick={() => {
                  setAdding(false);
                  setName("");
                  setAddError("");
                }}
              >
                取消
              </Button>
              <Button type="submit" disabled={disabled || creating || !name.trim()}>
                {creating ? "添加中…" : "添加账号"}
              </Button>
            </DrawerFooter>
          </form>
        </DrawerContent>
      </Drawer>
      <Drawer
        swipeDirection="right"
        open={Boolean(loginAccount)}
        onOpenChange={(open) => {
          if (!open && !loginBusy) browserAction("cancel");
        }}
      >
        <DrawerContent className="youtube-theme overflow-hidden data-[swipe-axis=x]:[--drawer-content-width:100%] data-[swipe-axis=x]:sm:[--drawer-content-width:36rem]">
          <DrawerHeader className="gap-2 px-6 pt-5 pb-4">
            <DrawerTitle>浏览器登录</DrawerTitle>
            <DrawerDescription>
              账号：{loginAccount?.name}。请在运行 DramaBridge
              的电脑上完成登录，登录状态仅保存在该电脑。
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
            <p className="text-sm leading-6 text-muted-foreground">
              电脑需安装 Google Chrome。打开浏览器后，在 Google 页面手动登录，切换到目标频道并进入
              YouTube Studio，再点击“确认保存”。同一 Google 账号下的其他频道可以复用已有登录。
            </p>
            {!accounts.find((account) => account.id === loginAccount?.id)?.browser?.saved && (
              <div className="space-y-2">
                <label htmlFor="youtube-reuse-login" className="text-sm font-medium">
                  使用的浏览器登录
                </label>
                <select
                  id="youtube-reuse-login"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={reuseAccountId}
                  disabled={loginBusy || loginOpened}
                  onChange={(event) => setReuseAccountId(event.target.value)}
                >
                  <option value="">新建专用浏览器登录</option>
                  {accounts
                    .filter(
                      (account) =>
                        account.id !== loginAccount?.id &&
                        account.browser?.saved &&
                        !account.browser?.needsLogin,
                    )
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        复用 {account.name} 的登录
                      </option>
                    ))}
                </select>
              </div>
            )}
            {loginOpened && (
              <p role="status" className="text-sm">
                浏览器已打开。完成登录并进入目标频道的 Studio 后，确认保存。
              </p>
            )}
            {loginError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {loginError}
              </p>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              视频上传仍需单独完成 Google
              官方上传授权。登录失效或遇到安全验证时，请在浏览器内手动处理。
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={loginBusy}
              onClick={() => browserAction("forget")}
            >
              清除网页授权
            </Button>
          </div>
          <DrawerFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
            <Button variant="ghost" disabled={loginBusy} onClick={() => browserAction("cancel")}>
              取消
            </Button>
            <Button
              variant="outline"
              disabled={disabled || loginBusy}
              onClick={() => browserAction("start")}
            >
              {loginBusy ? "处理中…" : "打开登录浏览器"}
            </Button>
            <Button
              disabled={disabled || loginBusy || !loginOpened}
              onClick={() => browserAction("save")}
            >
              确认保存
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </main>
  );
}
