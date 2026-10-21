import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  tiktokDramaCenterService,
  type TiktokDramaCenterConfig,
} from "@/platforms/tiktok-drama/service"

const emptyConfig: TiktokDramaCenterConfig = {
  headless: "false",
  localEpisodeVideoRoot: "",
  operationDelaySeconds: "0.02",
  runDataDir: ".drama-runs/tiktok-drama",
}

const sections: ConfigSectionDefinition<TiktokDramaCenterConfig>[] = [
  {
    title: "浏览器",
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

export function TiktokDramaCenterConfigurationPage() {
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
    getConfig: () => tiktokDramaCenterService.getConfig(),
    saveConfig: (config) => tiktokDramaCenterService.saveConfig(config),
  })

  return (
    <ConfigurationPageFrame
      hasChanges={hasChanges}
      loading={loading}
      restartRequired={restartRequired}
      title="TikTok 配置"
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
