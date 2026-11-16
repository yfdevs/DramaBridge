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
    title: "全集素材来源",
    description: "来源表仅需可读权限；任务状态仍写入全局飞书连接中的拼多多传剧任务表。",
    fields: [{
      key: "sourceTableUrl",
      label: "来源表链接",
      description: "读取“拼多多-新剧”，按“剧名”匹配“网盘（拼多多）”；不再使用拼多多后台的前五集链接。",
    }],
  },
  {
    title: "账号与浏览器",
    description: "账号、手机号和主播名称从飞书“拼多多账号实例”读取；将是否启用设为是后启动服务。飞书连接在全局配置中设置。",
    fields: [
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
  const testSourceTable = async () => {
    try {
      const result = await pinduoduoDramaService.testSourceTable(config.sourceTableUrl);
      toast.success("来源表读取成功", { description: `${result.sheetName}：${result.titleCount} 个剧名，仅进行读取` });
    } catch (error) {
      toast.error("来源表读取失败", { description: error instanceof Error ? error.message : String(error) });
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
            section.title === "全集素材来源" ? (
              <Button disabled={loading} onClick={() => void testSourceTable()} variant="outline">测试来源表（只读）</Button>
            ) : section.title === "账号与浏览器" ? (
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
