import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page";
import { weiboDramaService, type WeiboDramaConfig } from "@/platforms/weibo-drama/service";

const emptyConfig: WeiboDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  episodeUploadFailedRetryAttempts: "3",
  keepFailedTaskPages: "true",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: ".drama-runs/weibo-drama",
  logRetentionDays: "3",
};

const configSections: ConfigSectionDefinition<WeiboDramaConfig>[] = [
  {
    title: "任务接口",
    description: "启动时读取已启用的账号，分别打开浏览器",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        description: "读取账号、领取任务并上报结果",
        type: "url",
      },
      {
        key: "taskPollIntervalSeconds",
        label: "任务检查间隔",
        description: "无任务或任务结束后，再次检查任务的间隔",
        type: "number",
        suffix: "秒",
        min: 1,
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        description: "下载失败后的额外重试次数，填 0 不重试",
        type: "number",
        suffix: "次",
        min: 0,
      },
      {
        key: "episodeUploadWaitTimeoutMinutes",
        label: "上传时限",
        description: "等待全部剧集上传完成的最长时间",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
      {
        key: "episodeUploadFailedRetryAttempts",
        label: "上传失败重试次数",
        description: "单集上传失败后的额外重试次数，填 0 不重试",
        type: "number",
        suffix: "次",
        min: 0,
      },
    ],
  },
  {
    title: "浏览器与日志",
    description: "账号登录信息独立保存，共享目录在全局配置中设置",
    fields: [
      {
        kind: "switch",
        key: "keepFailedTaskPages",
        label: "保留失败页面",
        description: "任务失败后保留页面，便于查看平台提示",
        activeLabel: "保留",
        inactiveLabel: "关闭",
      },
      {
        key: "logRetentionDays",
        label: "日志保留天数",
        description: "启动服务时清理超过保留期限的日志",
        type: "number",
        suffix: "天",
        min: 1,
      },
      {
        key: "operationDelaySeconds",
        label: "操作间隔",
        description: "浏览器操作之间的等待时间",
        type: "number",
        suffix: "秒",
        step: "0.01",
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
];

export function WeiboDramaConfigurationPage() {
  const {
    config,
    discardChanges,
    hasChanges,
    loading,
    persistConfig,
    restartRequired,
    updateConfig,
  } = usePlatformConfig({
    emptyConfig,
    getConfig: () => weiboDramaService.getConfig(),
    saveConfig: (config) => weiboDramaService.saveConfig(config),
  });

  return (
    <ConfigurationPageFrame
      hasChanges={hasChanges}
      loading={loading}
      restartRequired={restartRequired}
      title="微博 配置"
      onDiscard={discardChanges}
      onSave={persistConfig}
    >
      {configSections.map((section) => (
        <ConfigSection
          key={section.title}
          config={config}
          fields={section.fields}
          section={section}
          onChange={updateConfig}
        />
      ))}
    </ConfigurationPageFrame>
  );
}
