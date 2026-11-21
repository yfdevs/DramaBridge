import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page";
import {
  type PinduoduoDramaConfig,
  type PinduoduoDramaConfigResult,
  pinduoduoDramaService,
} from "@/platforms/pinduoduo-drama/service";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/notifications";
import { PINDUODUO_DEFAULT_SOURCE_TABLE_URL } from "@/platforms/pinduoduo-drama/defaults";

const emptyConfig: PinduoduoDramaConfig = {
  sourceTableUrl: PINDUODUO_DEFAULT_SOURCE_TABLE_URL,
  accountProfileName: "default",
  creatorName: "",
  browserExecutablePath: "",
  headless: "false",
  runDataDir: ".drama-runs/pinduoduo-drama",
  logRetentionDays: "3",
  taskPollIntervalMinutes: "120",
  videoUploadTimeoutMinutes: "60",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
};

const sections: ConfigSectionDefinition<PinduoduoDramaConfig>[] = [
  {
    title: "素材来源",
    description: "",
    fields: [{
      key: "sourceTableUrl",
      label: "飞书表格链接",
      description: "按剧名查找全集链接，表格只需可读权限。",
    }],
  },
  {
    title: "浏览器",
    description: "",
    fields: [
      {
        key: "browserExecutablePath",
        label: "浏览器路径",
        description: "留空使用系统 Chrome",
      },
      {
        kind: "switch",
        key: "headless",
        label: "隐藏浏览器窗口",
        description: "登录账号时请关闭",
        activeLabel: "已隐藏",
        inactiveLabel: "显示窗口",
      },
    ],
  },
  {
    title: "任务与上传",
    description: "",
    fields: [
      {
        key: "taskPollIntervalMinutes",
        label: "任务检查间隔",
        type: "number",
        description: "多久检查一次新任务和审核结果",
        suffix: "分钟",
        min: 1,
        step: 1,
      },
      {
        key: "videoUploadTimeoutMinutes",
        label: "上传时限",
        type: "number",
        description: "整部剧上传的最长等待时间",
        suffix: "分钟",
        min: 1,
        step: 1,
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        type: "number",
        description: "下载失败后的重试次数",
        suffix: "次",
        min: 0,
        step: 1,
      },
    ],
  },
  {
    title: "日志",
    description: "",
    fields: [
      {
        key: "logRetentionDays",
        label: "日志保留天数",
        type: "number",
        description: "到期自动清理",
        suffix: "天",
        min: 1,
        step: 1,
      },
    ],
  },
];

export function PinduoduoDramaConfigurationPage() {
  const {
    config,
    discardChanges,
    hasChanges,
    loading,
    persistConfig,
    restartRequired,
    updateConfig,
  } = usePlatformConfig<PinduoduoDramaConfig, PinduoduoDramaConfigResult>({
    emptyConfig,
    getConfig: () => pinduoduoDramaService.getConfig(),
    saveConfig: (nextConfig) => pinduoduoDramaService.saveConfig(nextConfig),
  });

  const testBrowserPath = async () => {
    try {
      const result = await pinduoduoDramaService.testBrowserPath(config.browserExecutablePath);
      if (result.ok) {
        toast.success("浏览器路径测试通过", { description: result.message });
      } else {
        toast.error("浏览器路径测试失败", { description: result.message });
      }
    } catch (error) {
      toast.error("浏览器路径测试失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <ConfigurationPageFrame
      hasChanges={hasChanges}
      loading={loading}
      restartRequired={restartRequired}
      title="拼多多配置"
      onDiscard={discardChanges}
      onSave={persistConfig}
    >
      {sections.map((section) => (
        <ConfigSection
          key={section.title}
          config={config}
          fields={section.fields}
          section={section}
          footer={
            section.title === "浏览器" ? (
              <Button disabled={loading} onClick={() => void testBrowserPath()} variant="outline">
                测试浏览器路径
              </Button>
            ) : undefined
          }
          onChange={updateConfig}
        />
      ))}
    </ConfigurationPageFrame>
  );
}
