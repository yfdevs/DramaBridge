import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  qqDramaService,
  type QqDramaConfig,
} from "@/platforms/qq-drama/service"

const emptyConfig: QqDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  episodeUploadFailedRetryAttempts: "3",
  acceptSecondVersion: "true",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: ".drama-runs/qq-drama",
  logRetentionDays: "3",
}

const configSections: ConfigSectionDefinition<QqDramaConfig>[] = [
  {
    title: "任务接口",
    description: "服务启动时读取 ON 账号，并为每个账号创建独立浏览器。",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        description: "后端 RPA 任务接口根地址。",
        type: "url",
      },
      {
        key: "taskPollIntervalSeconds",
        label: "任务轮询间隔",
        description: "没有可领取任务或单次执行结束后再次请求接口的间隔。",
        type: "number",
        suffix: "秒",
        min: 1,
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试",
        description: "任务包含百度网盘链接时，下载失败后的重试次数。",
        type: "number",
        suffix: "次",
        min: 0,
      },
      {
        key: "episodeUploadWaitTimeoutMinutes",
        label: "上传等待时间",
        description: "批量视频开始上传后，等待全部剧集完成的最长时间。",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
      {
        key: "episodeUploadFailedRetryAttempts",
        label: "上传失败重试",
        description: "单集视频出现“重试”按钮时的最多重试次数。",
        type: "number",
        suffix: "次",
        min: 0,
      },
      {
        kind: "switch",
        key: "acceptSecondVersion",
        label: "接收第二版本",
        description: "关闭后，即使任务要求发布第二版本，也只上传主版本。",
        activeLabel: "接收",
        inactiveLabel: "不接收",
      },
    ],
  },
  {
    title: "浏览器与日志",
    description: "QQ 短剧使用独立 Chromium 登录态；共享目录在全局配置中统一管理。",
    fields: [
      {
        key: "logRetentionDays",
        label: "日志保留",
        description: "超过天数的日志文件会在服务启动时清理。",
        type: "number",
        suffix: "天",
        min: 1,
      },
      {
        key: "operationDelaySeconds",
        label: "操作延迟",
        description: "每一步 Playwright 操作之间的延迟。",
        type: "number",
        suffix: "秒",
        step: "0.01",
      },
      {
        kind: "switch",
        key: "headless",
        label: "浏览器窗口",
        description: "首次登录和排查问题时建议显示浏览器。",
        activeLabel: "无头运行",
        inactiveLabel: "显示浏览器",
      },
    ],
  },
]

export function QqDramaConfigurationPage() {
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
    getConfig: qqDramaService.getConfig,
    saveConfig: qqDramaService.saveConfig,
  })

  return (
    <ConfigurationPageFrame
      hasChanges={hasChanges}
      loading={loading}
      restartRequired={restartRequired}
      title="QQ 短剧配置"
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
  )
}
