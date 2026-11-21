import { ExternalLinkIcon as ExternalLink } from "@/components/ui/solar-icons";
import { useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "@/components/ui/notifications";

import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { returnRouteFromLocationState, routePath } from "@/config/navigation";
import {
  ConfigSection,
  ConfigPanelSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page";
import { globalAppConfigService, type AppTheme, type GlobalAppConfig } from "@/platforms/app-config/service";
import { ExternalApiConfiguration } from "./external-api";
import { BaiduAutoCleanupStatus } from "./baidu-auto-cleanup";
import { FeishuGlobalConfiguration, type FeishuConfigFields } from "@/pages/feishu/tables";
import { feishuService } from "@/platforms/feishu/service";
import { cn } from "@/lib/utils";

const emptyConfig: GlobalAppConfig = {
  theme: "system",
  aiApiKey: "",
  aiBaseURL: "https://ark.cn-beijing.volces.com/api/v3",
  aiModel: "doubao-seed-2-0-pro-260215",
  aiImageModel: "doubao-seedream-4-0-250828",
  aiCoverGenerationRetryAttempts: "3",
  aiPosterFallbackEnabled: true,
  ownershipLocalOcrEnabled: false,
  baiduNetdiskDownloadTimeoutMinutes: "60",
  baiduNetdiskCleanupPlayletAfterTaskSuccess: false,
  baiduNetdiskAutoCleanupEnabled: false,
  runDataRoot: "",
  localMaterialRoot: "",
};

const sections = {
  storage: {
    title: "文件存储",
    description: "两个目录须位于同一磁盘。保存后各平台共用这些目录，留空时已有平台可能沿用原目录",
    fields: [
      {
        key: "runDataRoot",
        label: "运行数据目录",
        description: "存放登录信息、日志和缓存",
        directory: true,
      },
      {
        key: "localMaterialRoot",
        label: "素材目录",
        description: "按剧名存放视频、封面和权属材料",
        directory: true,
      },
    ],
  },
  baidu: {
    title: "百度网盘",
    description: "",
    fields: [
      {
        key: "baiduNetdiskDownloadTimeoutMinutes",
        label: "下载时限",
        description: "单个资源下载超时后，任务失败",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
      {
        kind: "switch",
        key: "baiduNetdiskCleanupPlayletAfterTaskSuccess",
        label: "任务成功后清理文件",
        description: "仅清理本次任务的网盘文件。开启容量自动清理后，由容量规则接管",
        activeLabel: "自动清理",
        inactiveLabel: "保留文件",
      },
      {
        kind: "switch",
        key: "baiduNetdiskAutoCleanupEnabled",
        label: "按容量自动清理",
        description: "用量超过 80% 时，清理所有符合条件的旧目录，直至本轮清理完成。当天素材、使用中的目录和回收站内容会保留",
        activeLabel: "已开启",
        inactiveLabel: "已关闭",
      },
    ],
  },
  ocr: {
    title: "本机图片识别",
    description: "用于区分剪映和 AI 剧创工程截图",
    fields: [
      {
        kind: "switch",
        key: "ownershipLocalOcrEnabled",
        label: "优先使用本机识别",
        description: "本机识别不了时，改用 AI",
        activeLabel: "已开启",
        inactiveLabel: "已关闭",
      },
    ],
  },
  ai: {
    title: "AI 服务",
    description: "各平台共用的识图和封面生成服务",
    fields: [
      {
        key: "aiBaseURL",
        label: "接口地址",
        description: "服务商提供的 OpenAI 兼容地址",
        type: "url",
      },
      {
        key: "aiApiKey",
        label: "API 密钥",
        description: "密钥加密保存在本机",
        type: "password",
      },
      {
        key: "aiModel",
        label: "图文识别模型",
        description: "用于识图和处理文本的模型 ID",
      },
      {
        key: "aiImageModel",
        label: "封面生成模型",
        description: "支持图片生成的模型 ID",
      },
      {
        kind: "switch",
        key: "aiPosterFallbackEnabled",
        label: "自动补全封面",
        description: "缺少封面时，按剧名和简介生成",
        activeLabel: "已开启",
        inactiveLabel: "已关闭",
      },
      {
        key: "aiCoverGenerationRetryAttempts",
        label: "封面生成重试次数",
        description: "填 0 时，生成失败后不重试",
        type: "number",
        suffix: "次",
        min: 0,
        max: 10,
      },
    ],
  },
} satisfies Record<string, ConfigSectionDefinition<GlobalAppConfig>>;

const themeOptions = [
  { value: "system", label: "跟随系统", previews: ["light", "dark"] },
  { value: "light", label: "浅色", previews: ["light"] },
  { value: "dark", label: "深色", previews: ["dark"] },
] as const;

function ThemeConfiguration({
  theme,
  disabled,
  onChange,
}: {
  theme: AppTheme;
  disabled: boolean;
  onChange: (theme: AppTheme) => void;
}) {
  return (
    <ConfigPanelSection title="外观与主题" description="保存后生效">
      <RadioGroup
        aria-label="界面主题"
        aria-description="保存后生效"
        className="max-w-[25rem] grid-cols-[repeat(auto-fit,minmax(min(100%,5.5rem),1fr))] gap-3"
        disabled={disabled}
        value={theme}
        onValueChange={(value) => {
          if (value === "system" || value === "light" || value === "dark") onChange(value);
        }}
      >
        {themeOptions.map((option) => (
          <label key={option.value} className="block cursor-pointer rounded-sm has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
            <span className="flex h-12 overflow-hidden rounded-sm border border-black/10 bg-white dark:border-white/15" aria-hidden="true">
              {option.previews.map((preview) => (
                <span
                  key={preview}
                  className={cn(
                    "grid min-w-0 flex-1 grid-cols-[24%_1fr]",
                    preview === "dark" ? "bg-neutral-900 text-white" : "bg-white text-black",
                  )}
                >
                  <span className="flex min-w-0 flex-col gap-[3px] border-r border-current/10 bg-current/5 px-1 py-[7px]">
                    <span className="size-[5px] rounded-[1px] bg-current/35" />
                    <span className="h-0.5 w-full rounded-full bg-current/20" />
                    <span className="h-0.5 w-2/3 rounded-full bg-current/15" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1 px-1.5 py-[7px]">
                    <span className="h-[3px] w-1/2 rounded-full bg-current/40" />
                    <span className="h-2.5 rounded-[2px] border border-current/10 bg-current/5" />
                    <span className="h-2.5 rounded-[2px] border border-current/10 bg-current/5" />
                  </span>
                </span>
              ))}
            </span>
            <span className="flex items-center justify-between gap-1.5 pt-1.5 text-xs">
              {option.label}
              <RadioGroupItem value={option.value} className="size-3.5" />
            </span>
          </label>
        ))}
      </RadioGroup>
    </ConfigPanelSection>
  );
}

function ConfigurationCategory({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2 not-first:border-t not-first:border-border/60 not-first:pt-3">
      <p aria-hidden="true" className="text-xs text-muted-foreground">{title}</p>
      <div className="grid gap-3.5">{children}</div>
    </section>
  );
}

const globalConfigurationStyles = cn(
  "[&_[data-slot=field-content]]:min-w-0 [&_[data-slot=field-content]]:gap-1",
  "[&_[data-slot=field-description]]:mt-0 [&_[data-slot=field-description]]:text-xs [&_[data-slot=field-description]]:leading-[1.55]",
  "[&_[data-slot=config-section-footer]:not(:empty)]:mt-1 [&_[data-slot=config-section-footer]:not(:empty)]:border-t [&_[data-slot=config-section-footer]:not(:empty)]:border-border/60 [&_[data-slot=config-section-footer]:not(:empty)]:pt-2",
);

export function GlobalConfigurationPage() {
  const [defaultDirectories, setDefaultDirectories] = useState<
    Pick<GlobalAppConfig, "runDataRoot" | "localMaterialRoot">
  >({ runDataRoot: "", localMaterialRoot: "" });
  const location = useLocation();
  const navigate = useNavigate();
  const [testing, setTesting] = useState(false);
  const [testingOcr, setTestingOcr] = useState(false);
  const [ocrMessage, setOcrMessage] = useState("");
  const testLocalOcr = async () => {
    setTestingOcr(true);
    setOcrMessage("");
    try {
      const result = await globalAppConfigService.testLocalOcr();
      setOcrMessage(result.message);
    } catch {
      setOcrMessage("测试未完成，请稍后重试。任务会自动使用 AI");
    } finally {
      setTestingOcr(false);
    }
  };
  const returnRoute = returnRouteFromLocationState(location.state);
  const savedConfig = useRef<GlobalAppConfig & FeishuConfigFields>({
    ...emptyConfig,
    feishuAppId: "",
    feishuAppSecret: "",
    feishuTableUrl: "",
    feishuHasSecret: false,
  });
  const configState = usePlatformConfig({
    emptyConfig: {
      ...emptyConfig,
      feishuAppId: "",
      feishuAppSecret: "",
      feishuTableUrl: "",
      feishuHasSecret: false,
    } as GlobalAppConfig & FeishuConfigFields,
    getConfig: async () => {
      const [result, feishu] = await Promise.all([
        globalAppConfigService.getConfig(),
        feishuService.settings(),
      ]);
      return {
        ...result,
        config: {
          ...result.config,
          feishuAppId: feishu.appId,
          feishuAppSecret: "",
          feishuTableUrl: feishu.tableUrl,
          feishuHasSecret: feishu.hasSecret,
        },
      };
    },
    saveConfig: async (config: GlobalAppConfig & FeishuConfigFields) => {
      const {
        feishuAppId,
        feishuAppSecret,
        feishuTableUrl,
        feishuHasSecret: _hasSecret,
        ...globalConfig
      } = config;
      const saved = savedConfig.current;
      const feishuChanged =
        feishuAppId !== saved.feishuAppId ||
        feishuTableUrl !== saved.feishuTableUrl ||
        !!feishuAppSecret;
      const feishu = feishuChanged
        ? await feishuService.save({
            appId: feishuAppId,
            appSecret: feishuAppSecret || undefined,
            tableUrl: feishuTableUrl,
          })
        : { appId: feishuAppId, tableUrl: feishuTableUrl, hasSecret: saved.feishuHasSecret };
      const globalChanged = (Object.keys(globalConfig) as Array<keyof GlobalAppConfig>).some(
        (key) => globalConfig[key] !== saved[key],
      );
      const result = globalChanged
        ? await globalAppConfigService.saveConfig(globalConfig)
        : await globalAppConfigService.getConfig();
      return {
        ...result,
        config: {
          ...result.config,
          feishuAppId: feishu.appId,
          feishuAppSecret: "",
          feishuTableUrl: feishu.tableUrl,
          feishuHasSecret: feishu.hasSecret,
        },
      };
    },
    onApplyResult: (result) => {
      setDefaultDirectories(result.defaultDirectories);
      savedConfig.current = result.config;
    },
  });
  const testConnection = async () => {
    setTesting(true);
    try {
      const result = await globalAppConfigService.testConfig(configState.config);
      toast.success("AI 服务连接成功", {
        description: `${result.model}，${result.latencyMs} ms，${result.responseText}`,
      });
    } catch (error) {
      toast.error("AI 服务连接失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const selectDirectory = async (key: keyof GlobalAppConfig | keyof FeishuConfigFields) => {
    if (key !== "runDataRoot" && key !== "localMaterialRoot") return;

    try {
      const selected = await globalAppConfigService.selectDirectory(key, configState.config[key]);
      if (selected) configState.updateConfig(key, selected);
    } catch (error) {
      toast.error("目录选择失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const renderSection = (key: keyof typeof sections) => {
    const section: ConfigSectionDefinition<GlobalAppConfig> = sections[key];
    return (
      <ConfigSection
        config={configState.config}
        fields={section.fields.map((field) =>
          field.key === "runDataRoot" || field.key === "localMaterialRoot"
            ? { ...field, placeholder: defaultDirectories[field.key] }
            : field,
        )}
        footer={
          key === "baidu" ? <BaiduAutoCleanupStatus enabled={String(configState.config.baiduNetdiskAutoCleanupEnabled) === "true"} /> : key === "ai" ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                className="w-fit"
                onClick={() => {
                  void globalAppConfigService.openArkApiKeyPage();
                }}
                size="sm"
                variant="ghost"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" data-icon="inline-start" />
                <span className="leading-none">获取火山方舟密钥</span>
              </Button>
              <Button
                className="w-fit"
                disabled={configState.loading || testing}
                onClick={() => {
                  void testConnection();
                }}
                size="sm"
                variant="outline"
              >
                {testing ? "连接中…" : "测试连接"}
              </Button>
            </div>
          ) : key === "ocr" ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <p role="status" className="text-sm text-muted-foreground">
                {ocrMessage}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={configState.loading || testingOcr}
                onClick={() => {
                  void testLocalOcr();
                }}
              >
                {testingOcr ? "测试中…" : "测试本机识别"}
              </Button>
            </div>
          ) : undefined
        }
        section={section}
        onChange={configState.updateConfig}
        onSelectDirectory={selectDirectory}
      />
    );
  };

  return (
    <ConfigurationPageFrame
      className={globalConfigurationStyles}
      hasChanges={configState.hasChanges}
      loading={configState.loading}
      title="全局配置"
      onClose={() => {
        void navigate(routePath(returnRoute));
      }}
      onDiscard={configState.discardChanges}
      onSave={configState.persistConfig}
    >
      <ConfigurationCategory title="通用设置">
        <ThemeConfiguration
          theme={configState.config.theme}
          disabled={configState.loading}
          onChange={(theme) => configState.updateConfig("theme", theme)}
        />
        {renderSection("storage")}
      </ConfigurationCategory>
      <ConfigurationCategory title="下载与网盘">
        {renderSection("baidu")}
        <ExternalApiConfiguration />
      </ConfigurationCategory>
      <ConfigurationCategory title="识别与生成">
        {renderSection("ocr")}
        {renderSection("ai")}
      </ConfigurationCategory>
      <ConfigurationCategory title="数据连接">
        <FeishuGlobalConfiguration
          config={configState.config}
          onChange={configState.updateConfig}
          disabled={configState.loading}
          hasChanges={configState.hasChanges}
        />
      </ConfigurationCategory>
    </ConfigurationPageFrame>
  );
}
