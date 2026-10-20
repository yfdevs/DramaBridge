import {
  ConfigSection,
  ConfigurationPageFrame,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page"
import {
  taobaoDramaService,
  type TaobaoDramaConfig,
} from "@/platforms/taobao-drama/service"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

const emptyConfig: TaobaoDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  browserExecutablePath: "",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  baiduNetdiskDownloadRetryAttempts: "3",
  episodeUploadWaitTimeoutMinutes: "120",
  closeFailedTaskPages: "false",
  runDataDir: ".drama-runs/taobao-drama",
  logRetentionDays: "3",
}

const sections: ConfigSectionDefinition<TaobaoDramaConfig>[] = [
  {
    title: "账号与素材",
    description: "读取已启用的淘宝账号，分别领取任务。",
    fields: [
      { key: "apiBaseUrl", label: "接口地址", type: "url", description: "用于读取账号、领取任务和提交结果。" },
      { key: "taskPollIntervalSeconds", label: "任务检查间隔", type: "number", suffix: "秒", min: 1, description: "无任务或任务结束后，等待多久再领取任务。" },
      { key: "browserExecutablePath", label: "浏览器路径", type: "text", description: "浏览器启动文件路径，留空使用系统 Chrome。" },
      { key: "baiduNetdiskDownloadRetryAttempts", label: "网盘下载重试次数", type: "number", suffix: "次", min: 0, description: "网盘下载失败时，最多重试多少次。" },
    ],
  },
  {
    title: "浏览器与上传",
    description: "先创建合集，再批量上传视频；素材目录在全局配置中设置。",
    fields: [
      { key: "episodeUploadWaitTimeoutMinutes", label: "上传时限", type: "number", suffix: "分钟", min: 1, description: "等待全部剧集上传完成的最长时间。" },
      { key: "operationDelaySeconds", label: "操作间隔", type: "number", suffix: "秒", step: "0.01", description: "每次浏览器操作之间的等待时间。" },
      { kind: "switch", key: "headless", label: "隐藏浏览器窗口", description: "开启后隐藏窗口，登录或安全验证时请关闭。", activeLabel: "已隐藏", inactiveLabel: "显示窗口" },
    ],
  },
  {
    title: "失败现场",
    description: "成功任务完成两次 10 秒等待和校验后关闭，失败页默认保留。",
    fields: [
      { kind: "switch", key: "closeFailedTaskPages", label: "自动关闭失败页", description: "失败结果提交后，关闭对应任务页。", activeLabel: "自动关闭", inactiveLabel: "保留页面" },
      { key: "logRetentionDays", label: "日志保留天数", type: "number", suffix: "天", min: 1, description: "超过此天数的日志会被清理。" },
    ],
  },
]

export function TaobaoDramaConfigurationPage() {
  const state = usePlatformConfig({
    emptyConfig,
    getConfig: taobaoDramaService.getConfig,
    saveConfig: taobaoDramaService.saveConfig,
  })

  const testBrowserPath = async () => {
    try {
      const result = await taobaoDramaService.testBrowserPath(state.config.browserExecutablePath)
      if (result.ok) {
        toast.success("浏览器路径测试通过", { description: result.message })
      } else {
        toast.error("浏览器路径测试失败", { description: result.message })
      }
    } catch (error) {
      toast.error("浏览器路径测试失败", {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <ConfigurationPageFrame
      hasChanges={state.hasChanges}
      loading={state.loading}
      restartRequired={state.restartRequired}
      title="淘宝配置"
      onDiscard={state.discardChanges}
      onSave={state.persistConfig}
    >
      {sections.map((section, index) => (
        <ConfigSection
          key={section.title}
          config={state.config}
          fields={section.fields}
          section={section}
          footer={index === 0 ? (
            <Button
              disabled={state.loading}
              onClick={() => void testBrowserPath()}
              variant="outline"
            >
              测试浏览器路径
            </Button>
          ) : undefined}
          onChange={state.updateConfig}
        />
      ))}
    </ConfigurationPageFrame>
  )
}
