import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { youtubeService, isYoutubeWeb } from "@/platforms/youtube-drama/service";
import {
  YoutubeFeedback,
  YoutubePageContent,
  YoutubeServiceActions,
  YoutubeEnvironmentWarning,
  YoutubeSelect,
  YoutubeServiceRequired,
} from "./shared";
import { toast } from "sonner";
export function YoutubeCreateTaskPage({
  embedded = false,
  onCancel,
  onCreated,
  onBusyChange,
}: {
  embedded?: boolean;
  onCancel?: () => void;
  onCreated?: () => void;
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const model = useYoutubeRuntime();
  const { status, environment, accounts, locked, run } = model;
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState("default");
  useEffect(() => {
    if (
      accounts.length &&
      !accounts.some((account) => account.id === accountId && account.authorized)
    )
      setAccountId(accounts.find((account) => account.authorized)?.id ?? accounts[0].id);
  }, [accounts, accountId]);
  const [name, setName] = useState("");
  const [share, setShare] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [privacy, setPrivacy] = useState("private");
  const [mode, setMode] = useState("merge");
  const [compress, setCompress] = useState(false);
  const [count, setCount] = useState("");
  useEffect(() => {
    onBusyChange?.(model.busy);
    return () => onBusyChange?.(false);
  }, [model.busy, onBusyChange]);
  const Container = embedded ? "div" : "main";
  const submitReason = !status.running
    ? "请先启动服务"
    : !environment?.ready
      ? "请先完成运行环境配置"
      : !accounts.some((account) => account.id === accountId && account.authorized)
        ? "请选择已授权的上传账号"
        : !name.trim()
          ? "请填写剧名"
          : !share.trim()
            ? "请填写网盘分享链接"
            : "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await youtubeService.request("/api/tasks", {
        resourceName: name.trim(),
        shareText: share.trim(),
        title: title.trim() || name.trim(),
        description,
        tags: tags
          .split(/[,，\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
        privacy,
        mode,
        compress: mode === "mute" && compress,
        noUpload: false,
        accountId,
        episodeCount: count ? Number(count) : null,
        fast: false,
      });
      toast.success("任务已加入 YouTube 队列");
      if (onCreated) onCreated();
      else navigate("/youtube-drama/service");
      setShare("");
    });
  };

  return (
    <Container
      aria-label="添加 YouTube 任务"
      className="youtube-theme flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      {!embedded && <YoutubeServiceActions model={model} title="添加 YouTube 任务" />}
      <YoutubePageContent variant="form">
        <YoutubeFeedback model={model} />
        <YoutubeServiceRequired model={model} />
        <YoutubeEnvironmentWarning model={model} />
        {!accounts.some((account) => account.authorized) && status.running && (
          <p className="text-xs leading-5 text-muted-foreground">
            请先前往{" "}
            <Link
              className="text-foreground underline underline-offset-4"
              to="/youtube-drama/accounts"
              onClick={onCancel}
            >
              账号管理
            </Link>{" "}
            完成授权
          </p>
        )}
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
          <fieldset
            disabled={locked || !status.running}
            className="grid min-w-0 gap-5 sm:grid-cols-2"
          >
            <legend className="mb-4 text-sm font-semibold">剧目素材</legend>
            <label className="grid gap-2 text-sm font-medium sm:col-span-2">
              剧名
              <Input
                className="h-7 rounded-md"
                required
                autoFocus={embedded}
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium sm:col-span-2">
              百度网盘分享链接及提取码
              <Textarea
                required
                value={share}
                onChange={(e) => setShare(e.target.value)}
                placeholder="https://pan.baidu.com/s/… 提取码…"
                className="min-h-24 resize-y"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              集数 <span className="sr-only">（可选）</span>
              <Input
                className="h-7 rounded-md"
                type="number"
                min={1}
                max={10000}
                step={1}
                value={count}
                onChange={(event) => setCount(event.target.value)}
                placeholder="留空自动识别"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              处理方式
              <YoutubeSelect
                label="处理方式"
                value={mode}
                onChange={(value) => {
                  setMode(value);
                  setCompress(false);
                }}
                options={[
                  { value: "merge", label: "合并并分离人声" },
                  { value: "mute", label: "合并并静音" },
                ]}
              />
            </label>
            {mode === "mute" && (
              <div className="flex items-center justify-between gap-4 rounded-md bg-muted px-3 py-3 sm:col-span-2">
                <div className="space-y-1">
                  <label htmlFor="youtube-compress" className="text-sm font-medium">
                    高画质压缩
                  </label>
                  <p
                    id="youtube-compress-description"
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    处理耗时更长，仅在文件变小时采用压缩结果
                  </p>
                </div>
                <Switch
                  id="youtube-compress"
                  aria-describedby="youtube-compress-description"
                  checked={compress}
                  onCheckedChange={setCompress}
                />
              </div>
            )}
          </fieldset>
          <fieldset
            disabled={locked || !status.running}
            className="grid min-w-0 gap-5 pt-2 sm:grid-cols-2"
          >
            <legend className="pr-3 text-sm font-semibold">上传设置</legend>
            <label className="grid gap-2 text-sm font-medium">
              上传账号
              <YoutubeSelect
                label="上传账号"
                value={accountId}
                onChange={setAccountId}
                options={
                  accounts.length
                    ? accounts.map((a) => ({
                        value: a.id,
                        label: `${a.name}${a.authorized ? "" : "（未授权）"}`,
                        disabled: !a.authorized,
                      }))
                    : [{ value: "default", label: "请先添加并授权账号", disabled: true }]
                }
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              可见性
              <YoutubeSelect
                label="可见性"
                value={privacy}
                onChange={setPrivacy}
                options={[
                  { value: "private", label: "私密" },
                  { value: "unlisted", label: "不公开" },
                  { value: "public", label: "公开" },
                ]}
              />
            </label>
            <Accordion className="sm:col-span-2">
              <AccordionItem value="upload-info" className="border-0">
                <AccordionTrigger className="text-sm">
                  自定义视频信息
                  <span className="ml-2 mr-auto font-normal text-muted-foreground">可选</span>
                </AccordionTrigger>
                <AccordionContent className="h-auto pt-2 pb-3">
                  <div className="grid gap-4">
                    <label className="grid gap-2 text-sm font-medium">
                      上传标题
                      <Input
                        className="h-7 rounded-md"
                        maxLength={100}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="默认使用剧名"
                      />
                    </label>
                    <label className="grid gap-2 text-sm font-medium">
                      描述
                      <Textarea
                        maxLength={5000}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </label>
                    <label className="grid gap-2 text-sm font-medium">
                      标签
                      <Input
                        className="h-7 rounded-md"
                        value={tags}
                        onChange={(e) => setTags(e.target.value)}
                        placeholder="用逗号分隔"
                      />
                    </label>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </fieldset>
          <div
            className={`flex flex-wrap items-center justify-between gap-3 ${isYoutubeWeb ? "sticky bottom-0 z-10 bg-background py-4" : "pt-2"}`}
          >
            {embedded ? (
              <Button size="sm" variant="ghost" disabled={model.busy} onClick={onCancel}>
                取消
              </Button>
            ) : (
              <Button size="sm" variant="ghost" render={<Link to="/youtube-drama/service" />}>
                返回任务列表
              </Button>
            )}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
              {submitReason && !model.loading && (
                <p id="youtube-submit-reason" className="text-xs text-muted-foreground">
                  {submitReason}
                </p>
              )}
              <Button
                size="sm"
                type="submit"
                aria-describedby={submitReason ? "youtube-submit-reason" : undefined}
                disabled={locked || Boolean(submitReason)}
              >
                {model.busy ? "正在添加…" : "加入队列"}
              </Button>
            </div>
          </div>
        </form>
      </YoutubePageContent>
    </Container>
  );
}
