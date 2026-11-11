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
import { Plus } from "@mynaui/icons-react";
import { youtubeService } from "@/platforms/youtube-drama/service";
import {
  YoutubeFeedback,
  YoutubeServiceActions,
  YoutubeEnvironmentWarning,
  YoutubeSelect,
  YoutubeServiceRequired,
} from "./shared";
import { toast } from "sonner";
export function YoutubeCreateTaskPage() {
  const model = useYoutubeRuntime();
  const { status, environment, accounts, locked, run } = model;
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState("default");
  useEffect(() => {
    if (accounts.length && !accounts.some((account) => account.id === accountId))
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await youtubeService.request("/api/tasks", {
        resourceName: name,
        shareText: share,
        title: title || name,
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
      navigate("/youtube-drama/service");
      setShare("");
    });
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <YoutubeServiceActions model={model} title="添加 YouTube 任务" />
      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-6 p-4 sm:p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">添加任务</h2>
          <p className="text-xs text-muted-foreground">填写素材和上传信息，加入处理队列。</p>
        </div>
        <YoutubeFeedback model={model} />
        <YoutubeServiceRequired model={model} />
        <YoutubeEnvironmentWarning model={model} />
        {!accounts.some((account) => account.authorized) && status.running && (
          <p className="text-xs leading-5 text-muted-foreground">
            请先前往{" "}
            <Link
              className="text-foreground underline underline-offset-4"
              to="/youtube-drama/accounts"
            >
              账号管理
            </Link>{" "}
            完成授权。
          </p>
        )}
        <form onSubmit={submit} className="grid content-start gap-5 md:grid-cols-2">
          <label className="grid gap-1.5 text-xs font-medium md:col-span-2">
            剧名
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium md:col-span-2">
            百度网盘分享链接及提取码
            <Textarea
              required
              value={share}
              onChange={(e) => setShare(e.target.value)}
              placeholder="https://pan.baidu.com/s/… 提取码…"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
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
                    }))
                  : [{ value: "default", label: "默认账号" }]
              }
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-xs font-medium">
              处理模式
              <YoutubeSelect
                label="处理模式"
                value={mode}
                onChange={(value) => {
                  setMode(value);
                  setCompress(false);
                }}
                options={[
                  { value: "merge", label: "合并分离" },
                  { value: "mute", label: "合并静音" },
                ]}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium">
              可见性
              <YoutubeSelect
                label="可见性"
                value={privacy}
                onChange={setPrivacy}
                options={[
                  { value: "private", label: "私密" },
                  { value: "unlisted", label: "不公开列出" },
                  { value: "public", label: "公开" },
                ]}
              />
            </label>
          </div>
          {mode === "mute" && (
            <div className="flex items-center justify-between gap-4 border-y py-3 md:col-span-2">
              <div className="space-y-1">
                <label htmlFor="youtube-compress" className="text-xs font-medium">
                  高画质压缩
                </label>
                <p className="text-xs text-muted-foreground">增加处理时间，文件更小时才采用。</p>
              </div>
              <Switch id="youtube-compress" checked={compress} onCheckedChange={setCompress} />
            </div>
          )}
          <label className="grid gap-1.5 text-xs font-medium">
            集数
            <Input
              type="number"
              min={1}
              max={10000}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              placeholder="请输入集数"
            />
          </label>
          <Accordion className="border-y md:col-span-2">
            <AccordionItem value="upload-info">
              <AccordionTrigger className="text-xs">
                上传信息
                <span className="ml-2 mr-auto font-normal text-muted-foreground">
                  标题、描述、标签
                </span>
              </AccordionTrigger>
              <AccordionContent className="h-auto pt-2 pb-3">
                <div className="grid gap-4">
                  <label className="grid gap-1.5 text-xs font-medium">
                    上传标题
                    <Input
                      maxLength={100}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="默认使用剧名"
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs font-medium">
                    描述
                    <Textarea
                      maxLength={5000}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                  <label className="grid gap-1.5 text-xs font-medium">
                    标签
                    <Input
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      placeholder="用逗号分隔"
                    />
                  </label>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          <Button
            size="sm"
            type="submit"
            className="justify-self-end md:col-span-2"
            disabled={
              locked ||
              !status.running ||
              !environment?.ready ||
              !accounts.some((account) => account.id === accountId && account.authorized)
            }
          >
            <Plus className="size-3.5" />
            加入队列
          </Button>
        </form>
      </div>
    </main>
  );
}
