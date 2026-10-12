import { CheckCircle, DangerTriangle } from "@mynaui/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { routePath } from "@/config/navigation";
import {
  wechatMiniProgramService,
  type WechatMiniProgramConfig,
  type WechatMiniProgramConfigResult,
} from "@/platforms/wechat-miniprogram-drama/service";

const emptyConfig: WechatMiniProgramConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  taskApiPrefix: "/dramaAiRpa/wechatMiniProgram",
  catalogApiBaseUrl: "https://wxmini.xiaoshuo666.cn:8006",
  localEpisodeVideoRoot: "",
  closeFailedTaskPages: "false",
  runDataDir: ".drama-runs/wechat-miniprogram-drama",
  logRetentionDays: "3",
  workerEmptyClaimDelaySeconds: "5",
  workerSlowEmptyClaimThreshold: "30",
  workerSlowEmptyClaimDelaySeconds: "30",
  videoAccountSyncIntervalSeconds: "600",
  idlePageRefreshIntervalSeconds: "10800",
  idlePageRefreshTimeoutSeconds: "60",
  idlePageRefreshJitterSeconds: "300",
  basicInfoStepTimeoutSeconds: "600",
  remoteFileDownloadTimeoutSeconds: "120",
  baiduNetdiskDownloadRetryAttempts: "3",
  mergeOwnershipMaterials: "true",
  materialPreparationConcurrency: "3",
  taskPrefetchPerAccount: "2",
  videoTranscodeConcurrency: "2",
  videoTranscodeThreadsPerJob: "2",
  episodeVideoMaxFileMegabytes: "490",
  episodeVideoTargetFileMegabytes: "480",
  episodeVideoMinimumDurationSeconds: "0",
  episodeUploadWaitTimeoutSeconds: "7200",
  episodeUploadFailedRetryAttempts: "5",
  feishuBotWebhookUrl: "",
};

type TextField = {
  kind?: "text";
  key: keyof WechatMiniProgramConfig;
  label: string;
  description?: string;
  type?: "text" | "number" | "url" | "password";
  suffix?: string;
};

type SelectField = {
  kind: "select";
  key: keyof WechatMiniProgramConfig;
  label: string;
  description?: string;
  options: Array<{ value: string; label: string }>;
};

type SwitchField = {
  kind: "switch";
  key: keyof WechatMiniProgramConfig;
  label: string;
  description?: string;
  activeLabel: string;
  inactiveLabel: string;
};

type ConfigField = TextField | SelectField | SwitchField;

const sections: Array<{
  title: string;
  description: string;
  fields: ConfigField[];
}> = [
  {
    title: "接口连接",
    description: "自动化服务连接的后端地址。",
    fields: [
      {
        key: "apiBaseUrl",
        label: "后端接口地址",
        type: "url",
        description: "默认使用线上服务，必要时改成本地或测试地址。",
      },
      {
        key: "taskApiPrefix",
        label: "小程序任务接口前缀",
        description: "使用独立前缀领取小程序任务，避免与微信视频号任务混用。",
      },
      {
        key: "catalogApiBaseUrl",
        label: "剧目与素材接口地址",
        type: "url",
        description: "前四集与封面入库的剧目列表、素材查询和上传统一使用此接口地址，无需访问令牌。",
      },
    ],
  },
  {
    title: "日志",
    description: "共享素材与运行数据目录在全局配置中统一管理。",
    fields: [
      {
        key: "logRetentionDays",
        label: "日志保留",
        type: "number",
        description: "超过天数的日志会被清理。",
        suffix: "天",
      },
    ],
  },
  {
    title: "任务调度",
    description: "领取任务和账号同步频率。",
    fields: [
      {
        kind: "switch",
        key: "closeFailedTaskPages",
        label: "任务页面处理",
        description: "新任务开始前是否清理上次失败页面。",
        activeLabel: "自动关闭旧页面",
        inactiveLabel: "保留旧页面",
      },
      {
        key: "workerEmptyClaimDelaySeconds",
        label: "空任务短轮询",
        type: "number",
        description: "没有任务时，前几次领取的等待间隔。",
        suffix: "秒",
      },
      {
        key: "workerSlowEmptyClaimThreshold",
        label: "慢轮询切换次数",
        type: "number",
        description: "连续空任务达到此次数后，改用慢轮询。",
      },
      {
        key: "workerSlowEmptyClaimDelaySeconds",
        label: "空任务慢轮询",
        type: "number",
        description: "长时间无任务后的领取间隔。",
        suffix: "秒",
      },
      {
        key: "videoAccountSyncIntervalSeconds",
        label: "账号同步间隔",
        type: "number",
        description: "定时同步小程序账号状态。",
        suffix: "秒",
      },
      {
        key: "materialPreparationConcurrency",
        label: "素材准备并发",
        type: "number",
        description: "同时执行网盘下载、文件校验和材料整理的任务数。",
      },
      {
        key: "taskPrefetchPerAccount",
        label: "单账号预取任务",
        type: "number",
        description: "每个小程序最多提前领取并准备的任务数。",
      },
    ],
  },
  {
    title: "超时设置",
    description: "页面等待和网络操作上限。",
    fields: [
      {
        key: "idlePageRefreshIntervalSeconds",
        label: "空闲保活间隔",
        type: "number",
        description: "浏览器空闲多久后刷新保活。",
        suffix: "秒",
      },
      {
        key: "idlePageRefreshTimeoutSeconds",
        label: "空闲保活超时",
        type: "number",
        description: "保活刷新超过此时间视为失败。",
        suffix: "秒",
      },
      {
        key: "idlePageRefreshJitterSeconds",
        label: "保活随机错峰",
        type: "number",
        description: "给保活时间增加随机偏移，避免同时刷新。",
        suffix: "秒",
      },
      {
        key: "basicInfoStepTimeoutSeconds",
        label: "基础信息填写超时",
        type: "number",
        description: "填写标题、简介等基础信息的最长等待。",
        suffix: "秒",
      },
      {
        key: "remoteFileDownloadTimeoutSeconds",
        label: "远程素材下载超时",
        type: "number",
        description: "下载远程视频素材的最长等待。",
        suffix: "秒",
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "百度网盘下载重试",
        type: "number",
        description: "百度网盘资源准备失败后的额外重试次数，耗尽后上报任务失败。",
        suffix: "次",
      },
      {
        kind: "switch",
        key: "mergeOwnershipMaterials",
        label: "合并权属工程图片",
        description: "将权属目录中的全部图片平均分为两组，纵向合并为最多两张临时图片后上传，默认开启。",
        activeLabel: "合并上传",
        inactiveLabel: "分别上传",
      },
    ],
  },
  {
    title: "上传与通知",
    description: "视频压缩、上传等待、失败重试和飞书通知。",
    fields: [
      {
        key: "episodeVideoMaxFileMegabytes",
        label: "单集视频上限",
        type: "number",
        description: "超过该体积的视频会在百度下载扫描时提前进入转码队列。",
        suffix: "MB",
      },
      {
        key: "episodeVideoTargetFileMegabytes",
        label: "压缩目标体积",
        type: "number",
        description: "为容器开销预留余量，必须小于单集视频上限。",
        suffix: "MB",
      },
      {
        key: "episodeVideoMinimumDurationSeconds",
        label: "单集最小时长",
        type: "number",
        description: "任一集时长不超过该值时任务失败；设为 0 则关闭校验。正常任务和百度网盘直传同时生效。",
        suffix: "秒",
      },
      {
        key: "videoTranscodeConcurrency",
        label: "视频转码并发",
        type: "number",
        description: "同时运行的 FFmpeg 进程数量。",
      },
      {
        key: "videoTranscodeThreadsPerJob",
        label: "单任务转码线程",
        type: "number",
        description: "每个 FFmpeg 转码任务使用的线程数。",
      },
      {
        key: "episodeUploadWaitTimeoutSeconds",
        label: "剧集上传等待",
        type: "number",
        description: "等待平台完成剧集上传及自动重试；超时后任务失败。默认 7200 秒（120 分钟）。",
        suffix: "秒",
      },
      {
        kind: "select",
        key: "episodeUploadFailedRetryAttempts",
        label: "上传失败重试",
        description: "页面显示“上传失败”时自动点击“重试”，单集默认最多 5 次。",
        options: [
          { value: "0", label: "不重试" },
          { value: "3", label: "最多 3 次" },
          { value: "5", label: "最多 5 次" },
          { value: "8", label: "最多 8 次" },
          { value: "12", label: "最多 12 次" },
        ],
      },
      {
        key: "feishuBotWebhookUrl",
        label: "飞书机器人 Webhook",
        type: "url",
        description: "留空不推送运行通知。",
      },
    ],
  },
];

export function WechatMiniProgramConfigurationPage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<WechatMiniProgramConfig>(emptyConfig);
  const [savedConfig, setSavedConfig] = useState<WechatMiniProgramConfig>(emptyConfig);
  const [restartRequired, setRestartRequired] = useState(false);
  const [loading, setLoading] = useState(false);

  const applyResult = (result: WechatMiniProgramConfigResult) => {
    setConfig(result.config);
    setSavedConfig(result.config);
    setRestartRequired(result.restartRequired);
  };

  const hasChanges = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig],
  );

  useEffect(() => {
    setLoading(true);
    wechatMiniProgramService
      .getConfig()
      .then(applyResult)
      .catch((error) => {
        toast.error("配置读取失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const updateConfig = (key: keyof WechatMiniProgramConfig, value: string) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const discardChanges = () => {
    setConfig(savedConfig);
  };

  const cancelConfig = () => {
    discardChanges();
    void navigate(routePath("wechat-miniprogram-drama/service"));
  };

  const saveConfig = async () => {
    setLoading(true);
    try {
      const result = await wechatMiniProgramService.saveConfig(config);
      applyResult(result);
      if (result.restartRequired) {
        toast.warning("配置已保存", {
          description: "服务正在运行，请重启服务后生效。",
        });
      } else {
        toast.success("配置已保存");
      }
    } catch (error) {
      toast.error("配置保存失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-svh flex-1 flex-col bg-background">
      <div className="sticky top-0 z-10 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-215 gap-3 flex-row justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="mr-1 text-lg font-semibold tracking-normal">配置管理</h1>
            <span
              className={
                hasChanges
                  ? "inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 text-xs font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                  : "inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-muted-foreground"
              }
            >
              {hasChanges ? (
                <DangerTriangle className="size-3.5" />
              ) : (
                <CheckCircle className="size-3.5 text-emerald-600" />
              )}
              {hasChanges ? "未保存" : "已保存"}
            </span>
            {restartRequired ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-orange-300 bg-orange-50 px-2 text-xs font-medium text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                <DangerTriangle className="size-3.5" />
                需重启
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 sm:justify-end">
            <Button className="w-fit" disabled={loading} onClick={cancelConfig} variant="outline">
              关闭
            </Button>
            <Button className="w-fit" disabled={loading || !hasChanges} onClick={saveConfig}>
              保存配置
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-190 flex-1 flex-col gap-7 p-6">
        <div className="flex w-full min-w-0 flex-col gap-4">
          <section aria-labelledby="miniprogram-workflow-title" className="rounded-lg border bg-muted/35 p-4">
            <div className="space-y-1">
              <h2 id="miniprogram-workflow-title" className="text-sm font-semibold">
                自动化顺序
              </h2>
              <p className="text-xs leading-5 text-muted-foreground">
                百度网盘资源会先下载到本地；剧集固定使用本地上传。剧目类型仅选择数字真人或漫剧。
              </p>
            </div>
            <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="微信小程序短剧提交流程">
              {["下载并校验资源", "本地批量上传剧集", "填写剧目与证明材料", "勾选已上传剧集并提审"].map((step, index) => (
                <li key={step} className="flex items-center gap-1.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-medium text-background">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>
          {sections.map((section) => (
            <section id={section.title} key={section.title} className="scroll-mt-28 space-y-3">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">{section.title}</h2>
                <p className="text-xs text-muted-foreground sm:text-sm">{section.description}</p>
              </div>
              <Card className="rounded-lg bg-background py-0">
                <CardContent className="py-0">
                  <FieldGroup className="gap-0">
                    {section.fields.map((field, index) => (
                      <div key={field.key}>
                        {index > 0 ? <Separator /> : null}
                        <ConfigFieldControl
                          config={config}
                          field={field}
                          onChange={updateConfig}
                        />
                      </div>
                    ))}
                  </FieldGroup>
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

function ConfigFieldControl({
  config,
  field,
  onChange,
}: {
  config: WechatMiniProgramConfig;
  field: ConfigField;
  onChange: (key: keyof WechatMiniProgramConfig, value: string) => void;
}) {
  const value = config[field.key];

  if (field.kind === "switch") {
    const checked = value === "true";

    return (
      <Field className="gap-2.5 py-3 md:grid md:grid-cols-[minmax(220px,1fr)_280px] md:items-center">
        <FieldContent>
          <FieldLabel className="text-[13px]" htmlFor={field.key}>{field.label}</FieldLabel>
          {field.description ? (
            <FieldDescription className="text-xs">{field.description}</FieldDescription>
          ) : null}
        </FieldContent>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">
            {checked ? field.activeLabel : field.inactiveLabel}
          </span>
          <Switch
            id={field.key}
            checked={checked}
            onCheckedChange={(nextChecked) => onChange(field.key, nextChecked ? "true" : "false")}
          />
        </div>
      </Field>
    );
  }

  return (
    <Field className="gap-2.5 py-3 md:grid md:grid-cols-[minmax(220px,1fr)_280px] md:items-start">
      <FieldContent>
        <FieldLabel className="text-[13px]" htmlFor={field.key}>{field.label}</FieldLabel>
        {field.description ? (
          <FieldDescription className="text-xs">{field.description}</FieldDescription>
        ) : null}
      </FieldContent>
      <div className="w-full min-w-0">
        {field.kind === "select" ? (
          <Select
            value={value}
            onValueChange={(nextValue) => onChange(field.key, String(nextValue ?? ""))}
          >
            <SelectTrigger
              id={field.key}
              className="w-full bg-background text-[13px]"
              size="default"
            >
              <SelectValue placeholder="请选择">
                {field.options.find((option) => option.value === value)?.label ?? "请选择"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {field.options.map((option) => (
                <SelectItem className="text-[13px]" key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <InputGroup>
            <InputGroupInput
              className="text-[13px] md:text-[13px]"
              id={field.key}
              min={field.type === "number" ? 0 : undefined}
              type={field.type ?? "text"}
              value={value}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
            {field.suffix ? (
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs">{field.suffix}</InputGroupText>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        )}
      </div>
    </Field>
  );
}
