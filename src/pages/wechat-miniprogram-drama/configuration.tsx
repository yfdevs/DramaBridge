import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { ConfigurationToolbar } from "@/pages/shared/configuration-page";
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
  catalogAutoSyncIntervalSeconds: "15",
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
    description: "后台连接与任务来源",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        type: "url",
        description: "填写后端服务地址，可使用线上或测试环境。",
      },
      {
        key: "taskApiPrefix",
        label: "任务接口前缀",
        description: "使用小程序专用前缀，避免领取视频号任务。",
      },
      {
        key: "catalogApiBaseUrl",
        label: "剧目素材接口",
        type: "url",
        description: "用于剧目查询和素材入库，无需访问令牌。",
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
        kind: "select",
        key: "catalogAutoSyncIntervalSeconds",
        label: "入库剧目刷新间隔",
        description: "定时刷新全部剧目，处理队列运行时暂停。",
        options: [
          { value: "15", label: "每 15 秒" },
          { value: "30", label: "每 30 秒" },
          { value: "60", label: "每 1 分钟" },
          { value: "300", label: "每 5 分钟" },
          { value: "0", label: "关闭定时获取" },
        ],
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
      {
        kind: "switch",
        key: "mergeOwnershipMaterials",
        label: "合并权属图片",
        description:
          "将全部图片均分为两组，合并为最多两张图片上传。",
        activeLabel: "合并上传",
        inactiveLabel: "分别上传",
      },
    ],
  },
  {
    title: "上传与通知",
    description: "压缩大小、上传时限、重试和通知",
    fields: [
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
        key: "episodeVideoMinimumDurationSeconds",
        label: "单集时长下限",
        type: "number",
        description:
          "任一集不超过此时长则失败，填 0 不检查；普通上传和网盘直传均生效。",
        suffix: "秒",
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
        description: "等待全部剧集上传和重试完成，超时则任务失败。",
        suffix: "秒",
      },
      {
        kind: "select",
        key: "episodeUploadFailedRetryAttempts",
        label: "上传重试次数",
        description: "单集上传失败时，最多自动重试多少次。",
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
        label: "飞书通知地址",
        type: "url",
        description: "填写机器人 Webhook 地址，留空不通知。",
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
          <section
            aria-labelledby="miniprogram-workflow-title"
            className="rounded-lg border bg-muted/35 p-4"
          >
            <div className="space-y-1">
              <h2 id="miniprogram-workflow-title" className="text-sm font-semibold">
                上传流程
              </h2>
              <p className="text-xs leading-5 text-muted-foreground">
                先下载素材，再上传剧集；仅支持数字真人和漫剧。
              </p>
            </div>
            <ol
              className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs"
              aria-label="微信小程序短剧提交流程"
            >
              {[
                "下载校验素材",
                "批量上传剧集",
                "填写信息和证明",
                "选择剧集并提审",
              ].map((step, index) => (
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
  config: WechatMiniProgramConfig;
  field: ConfigField;
  onChange: (key: keyof WechatMiniProgramConfig, value: string) => void;
}) {
  const value = config[field.key];

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
