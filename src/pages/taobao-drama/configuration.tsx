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
    description: "服务读取后台已启用的淘宝账号，并为每个账号启动独立浏览器领取任务。",
    fields: [
      { key: "apiBaseUrl", label: "接口地址", type: "url", description: "淘宝账号、任务领取及结果回写接口根地址。" },
      { key: "taskPollIntervalSeconds", label: "任务轮询间隔", type: "number", suffix: "秒", min: 1, description: "没有可领取任务或单次执行结束后的等待时间。" },
      { key: "browserExecutablePath", label: "浏览器可执行文件路径", type: "text", description: "本机 Chrome 或 Chromium 的 exe 路径；留空使用系统 Chrome。" },
      { key: "baiduNetdiskDownloadRetryAttempts", label: "网盘下载重试", type: "number", suffix: "次", min: 0, description: "百度网盘素材准备失败后的重试次数。" },
    ],
  },
  {
    title: "浏览器与上传",
    description: "每条任务会先自动创建并填写合集，再进入批量发布页面上传视频。素材根目录使用全局配置。",
    fields: [
      { key: "episodeUploadWaitTimeoutMinutes", label: "视频上传等待", type: "number", suffix: "分钟", min: 1, description: "等待全部剧集上传完成的最长时间。" },
      { key: "operationDelaySeconds", label: "操作延迟", type: "number", suffix: "秒", step: "0.01", description: "每一步 Playwright 操作之间的延迟。" },
      { kind: "switch", key: "headless", label: "浏览器窗口", description: "登录和安全校验需要显示浏览器。", activeLabel: "无头运行", inactiveLabel: "显示浏览器" },
    ],
  },
  {
    title: "失败现场",
    description: "成功任务在两次10秒结算与成功校验完成后关闭；失败任务默认保留页面。",
    fields: [
      { kind: "switch", key: "closeFailedTaskPages", label: "失败任务页面", description: "是否在失败结果回写后关闭对应标签页。", activeLabel: "自动关闭失败页", inactiveLabel: "保留失败页" },
      { key: "logRetentionDays", label: "日志保留", type: "number", suffix: "天", min: 1, description: "自动清理超过期限的淘宝运行日志。" },
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
      title="淘宝短剧配置"
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
