import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  iqiyiDramaService,
  type IqiyiDramaConfig,
} from "@/platforms/iqiyi-drama/service"

const emptyConfig: IqiyiDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localMaterialRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  closeFailedTaskPages: "false",
  runDataDir: "D:\\.drama-runs\\iqiyi-drama",
  logRetentionDays: "3",
}

const sections: ConfigSectionDefinition<IqiyiDramaConfig>[] = [
  {
    title: "任务与素材",
    description: "短剧与漫剧共用任务队列，缺少权属文件时用封面代替。",
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
        kind: "switch",
        key: "closeFailedTaskPages",
        label: "自动关闭失败页",
        description: "任务失败后自动关闭页面，关闭此项可保留现场。",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        description: "正片和封面下载失败时重试，缺少权属材料不影响完成。",
        type: "number",
        suffix: "次",
        min: 0,
      },
    ],
  },
  {
    title: "浏览器与日志",
    description: "账号登录信息独立保存，目录和 AI 服务在全局配置中设置。",
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
    ],
  },
]

export function IqiyiDramaConfigurationPage() {
  const state = usePlatformConfig({
    emptyConfig,
    getConfig: iqiyiDramaService.getConfig,
    saveConfig: iqiyiDramaService.saveConfig,
  })

  return (
    <ConfigurationPageFrame
      hasChanges={state.hasChanges}
      loading={state.loading}
      restartRequired={state.restartRequired}
      title="爱奇艺配置"
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
