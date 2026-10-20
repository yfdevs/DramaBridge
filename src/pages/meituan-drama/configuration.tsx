import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  meituanCreationService,
  type MeituanCreationConfig,
} from "@/platforms/meituan-drama/service"

const emptyConfig: MeituanCreationConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  headless: "false",
  operationDelaySeconds: "0.02",
  episodeUploadFailedRetryAttempts: "5",
  closeTaskPageAfterRun: "true",
  localEpisodeVideoRoot: "",
  runDataDir: ".drama-runs/meituan-drama",
}

const sections: ConfigSectionDefinition<MeituanCreationConfig>[] = [
  {
    title: "账号连接",
    description: "启动时读取已启用的账号，分别打开浏览器。",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        type: "url",
        description: "用于读取后台启用的美团账号。",
      },
    ],
  },
  {
    title: "浏览器与上传",
    description: "账号登录信息独立保存，共享目录在全局配置中设置。",
    fields: [
      {
        key: "operationDelaySeconds",
        label: "操作间隔",
        type: "number",
        description: "每次浏览器操作之间的等待时间。",
        suffix: "秒",
        step: "0.01",
      },
      {
        key: "episodeUploadFailedRetryAttempts",
        label: "上传重试次数",
        type: "number",
        description: "单集上传失败时的重试次数，耗尽后任务失败。",
        suffix: "次",
        min: 0,
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
  {
    title: "任务页面",
    description: "每个任务使用独立页面，互不影响。",
    fields: [
      {
        kind: "switch",
        key: "closeTaskPageAfterRun",
        label: "结束后关闭页面",
        description: "任务成功或失败并提交结果后，关闭任务页。",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
    ],
  },
]

export function MeituanCreationConfigurationPage() {
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
    getConfig: meituanCreationService.getConfig,
    saveConfig: meituanCreationService.saveConfig,
  })

  return (
    <ConfigurationPageFrame
      hasChanges={hasChanges}
      loading={loading}
      restartRequired={restartRequired}
      title="美团配置"
      onDiscard={discardChanges}
      onSave={persistConfig}
    >
      {sections.map((section) => (
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
