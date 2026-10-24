import { ExternalLink } from "@mynaui/icons-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { returnRouteFromLocationState, routePath } from "@/config/navigation";
import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page";
import { globalAppConfigService, type GlobalAppConfig } from "@/platforms/app-config/service";
import { ExternalApiConfiguration } from "./external-api";

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
  runDataRoot: "",
  localMaterialRoot: "",
};

const sections: ConfigSectionDefinition<GlobalAppConfig>[] = [
  {
    title: "外观与主题",
    description: "保存后立即生效，可随系统自动切换浅色和深色。",
    layout: "compact",
    fields: [
      {
        kind: "select",
        key: "theme",
        label: "外观与主题",
        description: "保存后立即生效，可随系统自动切换浅色和深色。",
        options: [
          { value: "system", label: "跟随系统" },
          { value: "light", label: "浅色" },
          { value: "dark", label: "深色" },
        ],
      },
    ],
  },
  {
    title: "文件存储",
    description: "所有平台共用，两个目录需在同一磁盘",
    fields: [
      {
        key: "runDataRoot",
        label: "运行数据目录",
        description: "保存各平台的登录信息、日志和缓存。",
        directory: true,
      },
      {
        key: "localMaterialRoot",
        label: "素材目录",
        description: "按剧名存放视频、封面和权属材料。",
        directory: true,
      },
    ],
  },
  {
    title: "百度网盘",
    description: "下载时限与网盘文件清理",
    fields: [
      {
        key: "baiduNetdiskDownloadTimeoutMinutes",
        label: "下载时限",
        description: "单个资源的最长下载时间，超时则任务失败。",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
      {
        kind: "switch",
        key: "baiduNetdiskCleanupPlayletAfterTaskSuccess",
        label: "成功后清理网盘文件",
        description: "任一平台完成任务并保存结果后，清理本次网盘文件，保留本地文件。",
        activeLabel: "自动清理",
        inactiveLabel: "保留目录",
      },
    ],
  },
  {
    title: "本机图片识别",
    description: "用于区分剪映和 AI 剧创工程截图",
    fields: [{
      kind: "switch",
      key: "ownershipLocalOcrEnabled",
      label: "优先使用本机识别",
      description: "需要识别截图内容时先在电脑上处理，无法确认时自动使用 AI。",
      activeLabel: "已开启",
      inactiveLabel: "已关闭",
    }],
  },
  {
    title: "AI 服务",
    description: "所有平台共用的图片识别与封面生成服务",
    fields: [
      {
        key: "aiApiKey",
        label: "API 密钥",
        description: "用于连接 AI 服务，加密保存在本机。",
        type: "password",
      },
      {
        key: "aiModel",
        label: "图文识别模型",
        description: "填写模型 ID，用于识别图片和处理文本。",
      },
      {
        key: "aiImageModel",
        label: "封面生成模型",
        description: "填写用于生成封面的模型 ID。",
      },
      {
        kind: "switch",
        key: "aiPosterFallbackEnabled",
        label: "自动补全封面",
        description: "缺少封面时，根据剧名和简介用 AI 生成。",
        activeLabel: "已开启",
        inactiveLabel: "已关闭",
      },
      {
        key: "aiCoverGenerationRetryAttempts",
        label: "封面生成重试次数",
        description: "生成失败后的额外重试次数，填 0 不重试。",
        type: "number",
        suffix: "次",
        min: 0,
        max: 10,
      },
      {
        key: "aiBaseURL",
        label: "接口地址",
        description: "填写服务商提供的 OpenAI 兼容接口地址。",
        type: "url",
      },
    ],
  },
];

export function GlobalConfigurationPage() {
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
      setOcrMessage("测试未完成，请稍后重试。任务会自动使用 AI。");
    } finally { setTestingOcr(false); }
  };
  const returnRoute = returnRouteFromLocationState(location.state);
  const configState = usePlatformConfig({
    emptyConfig,
    getConfig: globalAppConfigService.getConfig,
    saveConfig: globalAppConfigService.saveConfig,
  });
  const testConnection = async () => {
    setTesting(true);
    try {
      const result = await globalAppConfigService.testConfig(configState.config);
      toast.success("AI 服务连接成功", {
        description: `${result.model} · ${result.latencyMs} ms · ${result.responseText}`,
      });
    } catch (error) {
      toast.error("AI 服务连接失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const selectDirectory = async (key: keyof GlobalAppConfig) => {
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

  return (
    <ConfigurationPageFrame
      hasChanges={configState.hasChanges}
      loading={configState.loading}
      restartRequired={configState.restartRequired}
      title="全局配置"
      onClose={() => {
        void navigate(routePath(returnRoute));
      }}
      onDiscard={configState.discardChanges}
      onSave={configState.persistConfig}
    >
      {sections.map((section) => (
        <ConfigSection
          key={section.title}
          config={configState.config}
          fields={section.fields}
          footer={
            section.title === "AI 服务" ? (
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
            ) : section.title === "本机图片识别" ? (
              <div className="flex flex-wrap items-center justify-end gap-3">
                <p role="status" className="text-sm text-muted-foreground">{ocrMessage}</p>
                <Button size="sm" variant="outline" disabled={configState.loading || testingOcr}
                  onClick={() => { void testLocalOcr(); }}>
                  {testingOcr ? "测试中…" : "测试是否可用"}
                </Button>
              </div>
            ) : undefined
          }
          section={section}
          onChange={configState.updateConfig}
          onSelectDirectory={selectDirectory}
        />
      ))}
      <ExternalApiConfiguration />
    </ConfigurationPageFrame>
  );
}
