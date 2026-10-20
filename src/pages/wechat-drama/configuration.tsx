import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { ConfigurationToolbar } from "@/pages/shared/configuration-page";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  wechatVideoService,
  type WechatVideoConfig,
  type WechatVideoConfigResult,
} from "@/platforms/wechat-drama/service";

const emptyConfig: WechatVideoConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  videoAccountContractSubjects:
    "MINGXINGSHUO,MISU,WEITAO,HUANZOU,XIAOSHILIU,YOUDIANNIU,ZHENCUIYIHAO,RUIXIAODOU",
  localEpisodeVideoRoot: "",
  closeFailedTaskPages: "false",
  runDataDir: ".drama-runs/wechat-drama",
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
  jianyingOwnershipProofCount: "4",
  juchuangOwnershipProofCount: "4",
  materialPreparationConcurrency: "3",
  taskPrefetchPerAccount: "2",
  videoTranscodeConcurrency: "2",
  videoTranscodeThreadsPerJob: "2",
  imageCompressionThresholdMegabytes: "10",
  imageCompressionTargetMegabytes: "9",
  episodeVideoMaxFileMegabytes: "490",
  episodeVideoTargetFileMegabytes: "480",
  episodeUploadWaitTimeoutSeconds: "7200",
  episodeUploadFailedRetryAttempts: "3",
  feishuBotWebhookUrl: "",
};

type TextField = {
  kind?: "text";
  key: keyof WechatVideoConfig;
  label: string;
  description?: string;
  type?: "text" | "number" | "url";
  suffix?: string;
  min?: number;
  step?: number;
};

type SelectField = {
  kind: "select";
  key: keyof WechatVideoConfig;
  label: string;
  description?: string;
  options: Array<{ value: string; label: string }>;
};

type SwitchField = {
  kind: "switch";
  key: keyof WechatVideoConfig;
  label: string;
  description?: string;
  activeLabel: string;
  inactiveLabel: string;
};

type SubjectField = {
  kind: "subjects";
  key: "videoAccountContractSubjects";
  label: string;
  description?: string;
  options: Array<{ value: string; label: string }>;
};

type ConfigField = TextField | SelectField | SwitchField | SubjectField;

const contractSubjectOptions = [
  { label: "明星说", value: "MINGXINGSHUO" },
  { label: "米苏", value: "MISU" },
  { label: "微淘", value: "WEITAO" },
  { label: "幻走", value: "HUANZOU" },
  { label: "小石榴", value: "XIAOSHILIU" },
  { label: "有点牛", value: "YOUDIANNIU" },
  { label: "珍萃", value: "ZHENCUIYIHAO" },
  { label: "瑞小豆", value: "RUIXIAODOU" },
];

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
        kind: "subjects",
        key: "videoAccountContractSubjects",
        label: "主体配置",
        description: "选择本次服务需要加载的视频号主体，可按实际业务范围调整。",
        options: contractSubjectOptions,
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
        description: "定时同步视频号账号状态。",
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
        description: "每个视频号最多提前领取并准备的任务数。",
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
    ],
  },
  {
    title: "权属文件上传",
    description: "按云 AI 识别结果选择剪映和剧创工程截图，逐张原图上传到剧目制作证明材料。",
    fields: [
      {
        key: "jianyingOwnershipProofCount",
        label: "剪映权属图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "默认 4 张；不足时任务会提示缺少的数量。",
      },
      {
        key: "juchuangOwnershipProofCount",
        label: "剧创权属图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "默认 4 张；不与剪映截图合并拼接。",
      },
    ],
  },
  {
    title: "上传与通知",
    description: "视频压缩、上传等待、失败重试和飞书通知。",
    fields: [
      {
        key: "imageCompressionThresholdMegabytes",
        label: "图片压缩触发体积",
        type: "number",
        description: "上传图片超过该体积时自动压缩；PDF 等非图片材料保持原样。",
        suffix: "MB",
      },
      {
        key: "imageCompressionTargetMegabytes",
        label: "图片压缩目标体积",
        type: "number",
        description: "压缩后的图片不超过该体积，必须小于触发体积。",
        suffix: "MB",
      },
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
        description: "等待平台完成剧集上传处理。",
        suffix: "秒",
      },
      {
        kind: "select",
        key: "episodeUploadFailedRetryAttempts",
        label: "上传失败重试",
        description: "单集上传失败后的最多重试次数。",
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

export function WechatConfigurationPage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<WechatVideoConfig>(emptyConfig);
  const [savedConfig, setSavedConfig] = useState<WechatVideoConfig>(emptyConfig);
  const [restartRequired, setRestartRequired] = useState(false);
  const [loading, setLoading] = useState(false);

  const applyResult = (result: WechatVideoConfigResult) => {
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
    wechatVideoService
      .getConfig()
      .then(applyResult)
      .catch((error) => {
        toast.error("配置读取失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const updateConfig = (key: keyof WechatVideoConfig, value: string) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const discardChanges = () => {
    setConfig(savedConfig);
  };

  const cancelConfig = () => {
    discardChanges();
    navigate(routePath("wechat-drama/service"));
  };

  const saveConfig = async () => {
    setLoading(true);
    try {
      const result = await wechatVideoService.saveConfig(config);
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
      <ConfigurationToolbar
        title="配置管理"
        hasChanges={hasChanges}
        loading={loading}
        restartRequired={restartRequired}
        onCancel={cancelConfig}
        onSave={() => void saveConfig()}
      />

      <div className="mx-auto flex w-full max-w-190 flex-1 flex-col gap-7 p-6">
        <div className="flex w-full min-w-0 flex-col gap-4">
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
                        <ConfigFieldControl config={config} field={field} onChange={updateConfig} />
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
  config: WechatVideoConfig;
  field: ConfigField;
  onChange: (key: keyof WechatVideoConfig, value: string) => void;
}) {
  const value = config[field.key];

  if (field.kind === "subjects") {
    const selectedSubjects = new Set(
      value
        .split(",")
        .map((subject) => subject.trim())
        .filter(Boolean),
    );

    const toggleSubject = (subject: string, checked: boolean) => {
      const nextSubjects = new Set(selectedSubjects);

      if (checked) {
        nextSubjects.add(subject);
      } else {
        nextSubjects.delete(subject);
      }

      onChange(
        field.key,
        field.options
          .map((option) => option.value)
          .filter((subject) => nextSubjects.has(subject))
          .join(","),
      );
    };

    return (
      <Field className="gap-2.5 py-3 lg:grid lg:grid-cols-[minmax(220px,1fr)_280px] lg:items-start">
        <FieldContent>
          <FieldLabel className="text-[13px]">{field.label}</FieldLabel>
          {field.description ? (
            <FieldDescription className="text-xs">{field.description}</FieldDescription>
          ) : null}
        </FieldContent>
        <div className="flex min-w-0 flex-wrap gap-2">
          {field.options.map((option) => (
            <label
              key={option.value}
              className="flex h-8 w-auto min-w-0 items-center gap-2 bg-background px-2.5 text-[13px]"
            >
              <Checkbox
                checked={selectedSubjects.has(option.value)}
                onCheckedChange={(checked) => toggleSubject(option.value, checked === true)}
                aria-label={option.label}
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))}
        </div>
      </Field>
    );
  }

  if (field.kind === "switch") {
    const checked = value === "true";

    return (
      <Field className="gap-2.5 py-3 lg:grid lg:grid-cols-[minmax(220px,1fr)_280px] lg:items-center">
        <FieldContent>
          <FieldLabel className="text-[13px]" htmlFor={field.key}>
            {field.label}
          </FieldLabel>
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
    <Field className="gap-2.5 py-3 lg:grid lg:grid-cols-[minmax(220px,1fr)_280px] lg:items-start">
      <FieldContent>
        <FieldLabel className="text-[13px]" htmlFor={field.key}>
          {field.label}
        </FieldLabel>
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
              min={field.type === "number" ? (field.min ?? 0) : undefined}
              step={field.type === "number" ? field.step : undefined}
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
