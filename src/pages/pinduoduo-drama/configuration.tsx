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
import { toast } from "sonner";

const emptyConfig: PinduoduoDramaConfig = {
  accountProfileName: "default",
  creatorUid: "7735796497358",
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
    title: "账号与浏览器",
    description: "账号登录信息独立保存；共享目录在全局配置中设置",
    fields: [
      {
        key: "creatorUid",
        label: "创作者 UID",
        description: "用于定位当前创作者的视频上传页",
      },
      {
        key: "accountProfileName",
        label: "账号标识",
        description: "用于区分账号，分别保存登录信息",
      },
      {
        key: "browserExecutablePath",
        label: "浏览器路径",
        description: "浏览器启动文件路径，留空使用系统 Chrome",
      },
      {
        kind: "switch",
        key: "headless",
        label: "隐藏浏览器窗口",
        description: "登录或排查问题时请关闭此项，显示浏览器窗口",
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
        description: "检查新任务和审核结果的间隔",
        suffix: "分钟",
        min: 1,
        step: 1,
      },
      {
        key: "videoUploadTimeoutMinutes",
        label: "上传时限",
        type: "number",
        description: "等待全部剧集上传完成的最长时间",
        suffix: "分钟",
        min: 1,
        step: 1,
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        type: "number",
        description: "审核通过后下载视频，失败时最多重试多少次",
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
        description: "自动清理超过保留期限的日志",
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
            section.title === "账号与浏览器" ? (
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
