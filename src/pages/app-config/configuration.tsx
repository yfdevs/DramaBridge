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

const emptyConfig: GlobalAppConfig = {
  theme: "system",
  aiApiKey: "",
  aiBaseURL: "https://ark.cn-beijing.volces.com/api/v3",
  aiModel: "doubao-seed-2-0-pro-260215",
  aiImageModel: "doubao-seedream-4-0-250828",
  aiCoverGenerationRetryAttempts: "3",
  aiPosterFallbackEnabled: true,
  baiduNetdiskDownloadTimeoutMinutes: "60",
  baiduNetdiskCleanupPlayletAfterTaskSuccess: false,
  jianyingEpisodeCount: "4",
  runDataRoot: "",
  localMaterialRoot: "",
};

const sections: ConfigSectionDefinition<GlobalAppConfig>[] = [
  {
    title: "外观",
    description: "保存后立即生效，无需重启应用",
    fields: [
      {
        kind: "select",
        key: "theme",
        label: "主题",
        description: "跟随系统会自动切换浅色与深色外观。",
        options: [
          { value: "system", label: "跟随系统" },
          { value: "light", label: "浅色" },
          { value: "dark", label: "深色" },
        ],
      },
    ],
  },
  {
    title: "文件与目录",
    description: "所有平台共用；运行数据与素材需放在同一磁盘",
    fields: [
      {
        key: "runDataRoot",
        label: "运行数据根目录",
        description: "登录态、日志和缓存会按平台写入独立子目录",
        directory: true,
      },
      {
        key: "localMaterialRoot",
        label: "素材根目录",
        description: "所有平台按原始剧名从这里读取或下载视频、封面及权属材料",
        directory: true,
      },
    ],
  },
  {
    title: "百度网盘",
    description: "所有平台共用的百度网盘资源下载限制",
    fields: [
      {
        key: "baiduNetdiskDownloadTimeoutMinutes",
        label: "下载超时",
        description: "单个资源等待下载完成的最长时间；超时后停止下载并上报任务失败。",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
      {
        kind: "switch",
        key: "aiPosterFallbackEnabled",
        label: "缺少封面时用 AI 生成",
        description: "根据剧名和简介自动生成封面。",
        activeLabel: "已开启",
        inactiveLabel: "已关闭",
      },
      {
        kind: "switch",
        key: "baiduNetdiskCleanupPlayletAfterTaskSuccess",
        label: "任务成功后清理网盘剧目",
        description:
          "任一平台任务成功并回写后，删除本次转存到“我的网盘”的剧目目录；本地素材不受影响。",
        activeLabel: "自动清理",
        inactiveLabel: "保留目录",
      },
    ],
  },
  {
    title: "剪映",
    description: "剧集画面截图设置",
    fields: [
      {
        key: "jianyingEpisodeCount",
        label: "处理前几集",
        description: "默认处理前 4 集；多个预设按顺序循环使用。",
        type: "number",
        suffix: "集",
        min: 1,
        max: 100,
      },
    ],
  },
  {
    title: "AI 服务",
    description: "各平台共享的 OpenAI SDK 兼容配置，可接入提供兼容接口的任意模型服务",
    fields: [
      {
        key: "aiApiKey",
        label: "API Key",
        description: "密钥使用系统凭据加密保存在本机，不写入环境变量或日志",
        type: "password",
      },
      {
        key: "aiModel",
        label: "模型 ID",
        description: "可用于封面理解、主体定位、图片分类和文本推理",
      },
      {
        key: "aiImageModel",
        label: "图片生成模型 ID",
        description: "",
      },
      {
        key: "aiCoverGenerationRetryAttempts",
        label: "封面生成失败重试",
        description: "首次生成失败后的额外重试次数；默认 3 次，单张封面最多共尝试 4 次。",
        type: "number",
        suffix: "次",
        min: 0,
        max: 10,
      },
      {
        key: "aiBaseURL",
        label: "API Base URL",
        description: "填写 OpenAI 兼容接口地址",
        type: "url",
      },
    ],
  },
];

export function GlobalConfigurationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [testing, setTesting] = useState(false);
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
                  <span className="leading-none">前往火山方舟获取 API Key</span>
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
                  {testing ? "正在测试 AI 连接…" : "测试 AI 连接"}
                </Button>
              </div>
            ) : undefined
          }
          section={section}
          onChange={configState.updateConfig}
          onSelectDirectory={selectDirectory}
        />
      ))}
    </ConfigurationPageFrame>
  );
}
