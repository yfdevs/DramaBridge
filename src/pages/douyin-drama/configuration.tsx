import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  douyinDramaService,
  type DouyinDramaConfig,
} from "@/platforms/douyin-drama/service"

const emptyConfig: DouyinDramaConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadReplaceAttempts: "5",
  episodeUploadBatchSize: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  unitPriceYuan: "0.5",
  paidEpisodeStart: "10",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: ".drama-runs/douyin-drama",
  logRetentionDays: "3",
  closeFailedTaskPages: "false",
}

const sections: ConfigSectionDefinition<DouyinDramaConfig>[] = [
  {
    title: "任务与素材",
    description: "剧目信息由后台提供，售价和付费集数在此设置。",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        description: "用于读取账号、领取任务和提交结果。",
        type: "url",
      },
      {
        key: "taskPollIntervalSeconds",
        label: "任务检查间隔",
        description: "无任务或任务结束后，等待多久再领取任务。",
        type: "number",
        suffix: "秒",
        min: 1,
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        description: "网盘下载失败时，最多重试多少次。",
        type: "number",
        suffix: "次",
        min: 0,
      },
      {
        key: "episodeUploadBatchSize",
        label: "同时上传集数",
        description: "最多同时上传多少集，完成后自动补充下一集。",
        type: "number",
        suffix: "集",
        min: 1,
        max: 50,
      },
      {
        key: "episodeUploadReplaceAttempts",
        label: "重新上传次数",
        description: "上传失败或时长异常时，删除异常条目并重新上传的最多次数。",
        type: "number",
        suffix: "次",
        min: 0,
        max: 20,
      },
      {
        key: "episodeUploadWaitTimeoutMinutes",
        label: "上传时限",
        description: "等待全部剧集上传和处理完成的最长时间。",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
      {
        key: "unitPriceYuan",
        label: "单集售价",
        description: "填写每集的付费价格。",
        type: "number",
        suffix: "元",
        min: 0.1,
        max: 9999,
        step: "0.1",
      },
      {
        key: "paidEpisodeStart",
        label: "付费起始集",
        description: "从此集起收费；第 1 集免费，最早从第 2 集起。",
        type: "number",
        suffix: "集起",
        min: 2,
        max: 300,
      },
    ],
  },
  {
    title: "浏览器与日志",
    description: "账号登录信息独立保存，共享目录在全局配置中设置。",
    fields: [
      {
        key: "logRetentionDays",
        label: "日志保留天数",
        description: "启动服务时，清理超过此天数的日志。",
        type: "number",
        suffix: "天",
        min: 1,
      },
      {
        key: "operationDelaySeconds",
        label: "操作间隔",
        description: "每次浏览器操作之间的等待时间。",
        type: "number",
        suffix: "秒",
        step: "0.01",
      },
      {
        kind: "switch",
        key: "headless",
        label: "隐藏浏览器窗口",
        description: "开启后隐藏窗口，登录或排查问题时请关闭。",
        activeLabel: "已隐藏",
        inactiveLabel: "显示窗口",
      },
      {
        kind: "switch",
        key: "closeFailedTaskPages",
        label: "自动关闭失败页",
        description: "关闭后保留失败页面，便于排查问题。",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
    ],
  },
]

export function DouyinDramaConfigurationPage() {
  const configState = usePlatformConfig({
    emptyConfig,
    getConfig: douyinDramaService.getConfig,
    saveConfig: douyinDramaService.saveConfig,
  })
  return (
    <ConfigurationPageFrame
      hasChanges={configState.hasChanges}
      loading={configState.loading}
      restartRequired={configState.restartRequired}
      title="抖音配置"
      onDiscard={configState.discardChanges}
      onSave={configState.persistConfig}
    >
      {sections.map((section) => (
        <ConfigSection
          key={section.title}
          config={configState.config}
          fields={section.fields}
          section={section}
          onChange={configState.updateConfig}
        />
      ))}
    </ConfigurationPageFrame>
  )
}
