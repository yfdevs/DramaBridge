import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  tencentHuolongDramaService,
  type TencentHuolongDramaConfig,
} from "@/platforms/tencent-huolong-drama/service"

const emptyConfig: TencentHuolongDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localMaterialRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  episodeUploadFailedRetryAttempts: "3",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  closeFailedTaskPages: "false",
  runDataDir: ".drama-runs/tencent-huolong-drama",
  logRetentionDays: "3",
}

const sections: ConfigSectionDefinition<TencentHuolongDramaConfig>[] = [
  {
    title: "任务接口",
    description: "读取已启用的账号，自动领取上剧任务。",
    fields: [
      { key: "apiBaseUrl", label: "接口地址", description: "用于读取账号、领取任务和提交结果。", type: "url" },
      { key: "taskPollIntervalSeconds", label: "任务检查间隔", description: "无任务或任务结束后，等待多久再领取任务。", type: "number", suffix: "秒", min: 1 },
      {
        kind: "switch",
        key: "closeFailedTaskPages",
        label: "自动关闭失败页",
        description: "任务失败后自动关闭页面，关闭此项可保留现场。",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
      { key: "baiduNetdiskDownloadRetryAttempts", label: "网盘下载重试次数", description: "网盘下载失败时，最多重试多少次。", type: "number", suffix: "次", min: 0 },
      { key: "episodeUploadWaitTimeoutMinutes", label: "上传时限", description: "等待全部剧集上传完成的最长时间。", type: "number", suffix: "分钟", min: 1 },
      { key: "episodeUploadFailedRetryAttempts", label: "上传重试次数", description: "单集上传失败时，最多重试多少次。", type: "number", suffix: "次", min: 0 },
    ],
  },
  {
    title: "浏览器与日志",
    description: "账号登录信息独立保存，共享目录在全局配置中设置。",
    fields: [
      { key: "logRetentionDays", label: "日志保留天数", description: "超过此天数的日志会被清理。", type: "number", suffix: "天", min: 1 },
      { key: "operationDelaySeconds", label: "操作间隔", description: "每次浏览器操作之间的等待时间。", type: "number", suffix: "秒", step: "0.01" },
      { kind: "switch", key: "headless", label: "隐藏浏览器窗口", description: "开启后隐藏窗口，登录或排查问题时请关闭。", activeLabel: "已隐藏", inactiveLabel: "显示窗口" },
    ],
  },
]

export function TencentHuolongDramaConfigurationPage() {
  const state = usePlatformConfig({
    emptyConfig,
    getConfig: tencentHuolongDramaService.getConfig,
    saveConfig: tencentHuolongDramaService.saveConfig,
  })
  return (
    <ConfigurationPageFrame
      hasChanges={state.hasChanges}
      loading={state.loading}
      restartRequired={state.restartRequired}
      title="火龙漫剧配置"
      onDiscard={state.discardChanges}
      onSave={state.persistConfig}
    >
      {sections.map((section) => (
        <ConfigSection
          key={section.title}
          config={state.config}
          fields={section.fields}
          section={section}
          onChange={state.updateConfig}
        />
      ))}
    </ConfigurationPageFrame>
  )
}
