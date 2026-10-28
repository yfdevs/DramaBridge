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
    "MINGXINGSHUO,MISU,WEITAO,HUANZOU,XIAOSHILIU,YOUDIANNIU,ZHENCUIYIHAO,RUIXIAODOU,YUANMAN,YUNQIMANYING,MENGDONG,CHONGBAO,DOURAN",
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
  { label: "珍萃一号", value: "ZHENCUIYIHAO" },
  { label: "瑞小豆", value: "RUIXIAODOU" },
  { label: "广州元漫科技有限公司", value: "YUANMAN" },
  { label: "北京云起漫影科技有限公司", value: "YUNQIMANYING" },
  { label: "广州梦动科技有限公司", value: "MENGDONG" },
  { label: "广州冲宝科技有限公司", value: "CHONGBAO" },
  { label: "广州豆燃科技有限公司", value: "DOURAN" },
];

const sections: Array<{
  title: string;
  description: string;
  fields: ConfigField[];
}> = [
  {
    title: "接口连接",
    description: "后台连接与任务来源",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        type: "url",
        description: "填写后端服务地址，可使用线上或测试环境。",
      },
      {
        kind: "subjects",
        key: "videoAccountContractSubjects",
        label: "视频号主体",
        description: "选择需要加载的视频号主体。",
        options: contractSubjectOptions,
      },
    ],
  },
  {
    title: "日志",
    description: "素材和运行数据目录在全局配置中设置。",
    fields: [
      {
        key: "logRetentionDays",
        label: "日志保留天数",
        type: "number",
        description: "超过此天数的日志会被清理。",
        suffix: "天",
      },
    ],
  },
  {
    title: "任务调度",
    description: "任务检查、账号同步和素材准备",
    fields: [
      {
        kind: "switch",
        key: "closeFailedTaskPages",
        label: "自动关闭失败页",
        description: "新任务开始前，关闭上次失败的页面。",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
      {
        key: "workerEmptyClaimDelaySeconds",
        label: "无任务检查间隔",
        type: "number",
        description: "暂时没有任务时，两次领取之间的等待时间。",
        suffix: "秒",
      },
      {
        key: "workerSlowEmptyClaimThreshold",
        label: "连续无任务次数",
        type: "number",
        description: "连续无任务达到此次数后，改用较长的检查间隔。",
      },
      {
        key: "workerSlowEmptyClaimDelaySeconds",
        label: "长时间无任务间隔",
        type: "number",
        description: "连续多次没有任务后，两次领取之间的等待时间。",
        suffix: "秒",
      },
      {
        key: "videoAccountSyncIntervalSeconds",
        label: "账号同步间隔",
        type: "number",
        description: "更新后台账号状态的间隔。",
        suffix: "秒",
      },
      {
        key: "materialPreparationConcurrency",
        label: "素材并行任务数",
        type: "number",
        description: "同时下载、校验和整理素材的任务数。",
      },
      {
        key: "taskPrefetchPerAccount",
        label: "每个账号预取任务数",
        type: "number",
        description: "每个账号最多提前领取并准备多少个任务。",
      },
    ],
  },
  {
    title: "超时设置",
    description: "页面操作和素材下载的最长等待时间",
    fields: [
      {
        key: "idlePageRefreshIntervalSeconds",
        label: "空闲刷新间隔",
        type: "number",
        description: "无任务时，定期刷新页面以保持连接。",
        suffix: "秒",
      },
      {
        key: "idlePageRefreshTimeoutSeconds",
        label: "空闲刷新时限",
        type: "number",
        description: "刷新超过此时间视为失败。",
        suffix: "秒",
      },
      {
        key: "idlePageRefreshJitterSeconds",
        label: "刷新随机延迟",
        type: "number",
        description: "为刷新时间增加随机偏移，避免同时刷新。",
        suffix: "秒",
      },
      {
        key: "basicInfoStepTimeoutSeconds",
        label: "信息填写时限",
        type: "number",
        description: "填写标题、简介等信息的最长时间。",
        suffix: "秒",
      },
      {
        key: "remoteFileDownloadTimeoutSeconds",
        label: "素材下载时限",
        type: "number",
        description: "下载远程视频素材的最长时间。",
        suffix: "秒",
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        type: "number",
        description: "下载失败后的额外重试次数，耗尽后任务失败。",
        suffix: "次",
      },
    ],
  },
  {
    title: "权属文件上传",
    description: "用 AI 识别剪映和剧创截图，逐张上传为制作证明。",
    fields: [
      {
        key: "jianyingOwnershipProofCount",
        label: "剪映截图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "需要上传的剪映权属截图数，不足时任务会提示。",
      },
      {
        key: "juchuangOwnershipProofCount",
        label: "剧创截图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "需要上传的剧创权属截图数，与剪映截图分别上传。",
      },
    ],
  },
  {
    title: "上传与通知",
    description: "压缩大小、上传时限、重试和通知",
    fields: [
      {
        key: "imageCompressionThresholdMegabytes",
        label: "图片压缩起点",
        type: "number",
        description: "图片超过此大小时压缩，PDF 等文件不处理。",
        suffix: "MB",
      },
      {
        key: "imageCompressionTargetMegabytes",
        label: "图片压缩目标",
        type: "number",
        description: "压缩后的大小上限，需小于图片压缩起点。",
        suffix: "MB",
      },
      {
        key: "episodeVideoMaxFileMegabytes",
        label: "单集大小上限",
        type: "number",
        description: "单集超过此大小时，下载过程中提前安排压缩。",
        suffix: "MB",
      },
      {
        key: "episodeVideoTargetFileMegabytes",
        label: "视频压缩目标",
        type: "number",
        description: "压缩后的目标大小，需小于单集大小上限。",
        suffix: "MB",
      },
      {
        key: "videoTranscodeConcurrency",
        label: "同时压缩视频数",
        type: "number",
        description: "最多同时压缩多少个视频。",
      },
      {
        key: "videoTranscodeThreadsPerJob",
        label: "每个视频压缩线程数",
        type: "number",
        description: "每个压缩任务使用的线程数。",
      },
      {
        key: "episodeUploadWaitTimeoutSeconds",
        label: "上传时限",
        type: "number",
        description: "等待平台完成剧集上传处理的最长时间。",
        suffix: "秒",
      },
      {
        kind: "select",
        key: "episodeUploadFailedRetryAttempts",
        label: "上传重试次数",
        description: "单集上传失败时，最多重试多少次。",
        options: [
          { value: "0", label: "不重试" },
          { value: "3", label: "最多 3 次" },
          { value: "5", label: "最多 5 次" },
          { value: "8", label: "最多 8 次" },
          { value: "12", label: "最多 12 次" },
        ],
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
