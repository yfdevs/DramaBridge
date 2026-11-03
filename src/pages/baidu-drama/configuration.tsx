import { Fragment } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field"
import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import { baiduDramaService, type BaiduDramaConfig } from "@/platforms/baidu-drama/service"

const emptyConfig: BaiduDramaConfig = {
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  supportDistribution: "false",
  distributionMaterial: "",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: ".drama-runs/baidu-drama",
  logRetentionDays: "3",
}

const sections: ConfigSectionDefinition<BaiduDramaConfig>[] = [
  {
    title: "分销设置",
    description: "开启后，在经营模式步骤设置支持分销。",
    fields: [{ kind: "switch", key: "supportDistribution", label: "支持分销",
      activeLabel: "已开启", inactiveLabel: "未开启" }],
  },
  {
    title: "任务接口",
    description: "读取已启用的账号，领取待处理任务并提交结果。",
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
        key: "episodeUploadWaitTimeoutMinutes",
        label: "上传时限",
        description: "等待全部剧集上传完成的最长时间。",
        type: "number",
        suffix: "分钟",
        min: 1,
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
    ],
  },
]

export function BaiduDramaConfigurationPage() {
  const configState = usePlatformConfig({
    emptyConfig,
    getConfig: baiduDramaService.getConfig,
    saveConfig: baiduDramaService.saveConfig,
  })

  return (
    <ConfigurationPageFrame
      hasChanges={configState.hasChanges}
      loading={configState.loading}
      restartRequired={configState.restartRequired}
      title="百度配置"
      onDiscard={configState.discardChanges}
      onSave={configState.persistConfig}
    >
      {sections.map((section) => (
        <Fragment key={section.title}>
        <ConfigSection
          key={section.title}
          config={configState.config}
          fields={section.fields}
          section={section}
          onChange={configState.updateConfig}
        />
      {section.title === "分销设置" && configState.config.supportDistribution === "true" && (
        <Field>
          <FieldLabel htmlFor="baidu-distribution-material">分销素材（选填）</FieldLabel>
          <Textarea id="baidu-distribution-material" rows={4} maxLength={1000}
            placeholder="请输入分销素材的下载链接或获取方法"
            value={configState.config.distributionMaterial}
            onChange={(event) => configState.updateConfig("distributionMaterial", event.target.value)} />
          <FieldDescription>最多 1000 字符，可留空。</FieldDescription>
        </Field>
      )}
        </Fragment>
      ))}
    </ConfigurationPageFrame>
  )
}
