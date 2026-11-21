import { toast } from "@/components/ui/notifications";
import {
  ConfigurationPageFrame,
  ConfigSection,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page";
import { wechatVideoService, type WechatVideoConfig } from "@/platforms/wechat-drama/service";

const emptyConfig: WechatVideoConfig = {
  recreationSheetName: "微信二创",
  recreationPollSeconds: "30",
  dataSyncDownloadDirectory: "",
  dataSyncDryRun: "false",
  dataSyncApiBaseUrl: "",
  dataSyncAdminUsername: "",
  dataSyncAdminPassword: "",
  apiBaseUrl: "http://180.184.76.232:19090",
  selectedVideoAccountIds: "",
  videoAccountContractSubjects:
    "MINGXINGSHUO,MISU,WEITAO,HUANZOU,XIAOSHILIU,YOUDIANNIU,ZHENCUIYIHAO,RUIXIAODOU,YUANMAN,YUNQIMANYING,MENGDONG,CHONGBAO,DOURAN",
  localEpisodeVideoRoot: "",
  closeFailedTaskPages: "false",
  runDataDir: ".drama-runs/wechat-drama",
  logRetentionDays: "3",
  workerEmptyClaimDelaySeconds: "5",
  workerSlowEmptyClaimThreshold: "30",
  workerSlowEmptyClaimDelaySeconds: "30",
  videoAccountSyncIntervalSeconds: "600",
  idlePageRefreshIntervalSeconds: "10800",
  idlePageRefreshTimeoutSeconds: "60",
  idlePageRefreshJitterSeconds: "300",
  basicInfoStepTimeoutSeconds: "600",
  remoteFileDownloadTimeoutSeconds: "120",
  baiduNetdiskDownloadRetryAttempts: "3",
  jianyingOwnershipProofCount: "4",
  juchuangOwnershipProofCount: "4",
  materialPreparationConcurrency: "3",
  taskPrefetchPerAccount: "2",
  videoTranscodeConcurrency: "2",
  videoTranscodeThreadsPerJob: "2",
  imageCompressionThresholdMegabytes: "10",
  imageCompressionTargetMegabytes: "9",
  episodeVideoMaxFileMegabytes: "490",
  episodeVideoTargetFileMegabytes: "480",
  episodeUploadWaitTimeoutSeconds: "7200",
  episodeUploadFailedRetryAttempts: "3",
};

const sections: ConfigSectionDefinition<WechatVideoConfig>[] = [
  {
    title: "数据同步后台",
    description: "修改后，下次启动同步任务时生效",
    fields: [
      {
        kind: "switch",
        key: "dataSyncDryRun",
        label: "导入后台",
        description: "开启后自动入库，关闭后仅保存本地",
        activeLabel: "导入后台",
        inactiveLabel: "仅保存本地",
      },
      {
        key: "dataSyncDownloadDirectory",
        label: "文件保存目录",
        directory: true,
        placeholder: "默认使用应用数据目录",
        description: "Excel、JSON 和 CSV 的保存位置",
      },
      {
        key: "dataSyncApiBaseUrl",
        label: "后台导入地址",
        type: "url",
        placeholder: "https://example.com",
      },
      { key: "dataSyncAdminUsername", label: "管理员账号" },
      { key: "dataSyncAdminPassword", label: "管理员密码", type: "password" },
    ],
  },
  {
    title: "二创任务",
    description: "飞书连接在全局配置中设置",
    fields: [
      { key: "recreationSheetName", label: "二创工作表名称" },
      {
        key: "recreationPollSeconds",
        label: "任务检查间隔",
        type: "number",
        min: 10,
        suffix: "秒",
      },
    ],
  },
  {
    title: "发布接口",
    description: "",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        type: "url",
        description: "用于领取和回报发布任务",
      },
    ],
  },
  {
    title: "日志",
    description: "素材和运行数据目录在全局配置中设置",
    fields: [
      {
        key: "logRetentionDays",
        label: "日志保留天数",
        type: "number",
        description: "自动清理超过保留期限的日志",
        suffix: "天",
      },
    ],
  },
  {
    title: "任务调度",
    description: "",
    fields: [
      {
        kind: "switch",
        key: "closeFailedTaskPages",
        label: "自动关闭失败页",
        description: "关闭失败页面；关闭此项可保留排查",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
      {
        key: "workerEmptyClaimDelaySeconds",
        label: "无任务检查间隔",
        type: "number",
        description: "没有任务时的检查频率",
        suffix: "秒",
      },
      {
        key: "workerSlowEmptyClaimThreshold",
        label: "连续无任务次数",
        type: "number",
        description: "达到后降低检查频率",
      },
      {
        key: "workerSlowEmptyClaimDelaySeconds",
        label: "长时间无任务间隔",
        type: "number",
        description: "长时间无任务时的检查频率",
        suffix: "秒",
      },
      {
        key: "videoAccountSyncIntervalSeconds",
        label: "账号同步间隔",
        type: "number",
        description: "定期更新账号状态",
        suffix: "秒",
      },
      {
        key: "materialPreparationConcurrency",
        label: "素材并行任务数",
        type: "number",
        description: "同时准备多少个任务的素材",
      },
      {
        key: "taskPrefetchPerAccount",
        label: "每个账号预取任务数",
        type: "number",
        description: "提前领取的任务数",
      },
    ],
  },
  {
    title: "超时设置",
    description: "",
    fields: [
      {
        key: "idlePageRefreshIntervalSeconds",
        label: "空闲刷新间隔",
        type: "number",
        description: "空闲时定期刷新页面",
        suffix: "秒",
      },
      {
        key: "idlePageRefreshTimeoutSeconds",
        label: "空闲刷新时限",
        type: "number",
        description: "页面刷新超时后判定失败",
        suffix: "秒",
      },
      {
        key: "idlePageRefreshJitterSeconds",
        label: "刷新随机延迟",
        type: "number",
        description: "错开多个账号的刷新时间",
        suffix: "秒",
      },
      {
        key: "basicInfoStepTimeoutSeconds",
        label: "信息填写时限",
        type: "number",
        description: "填写标题、简介等信息的最长时间",
        suffix: "秒",
      },
      {
        key: "remoteFileDownloadTimeoutSeconds",
        label: "素材下载时限",
        type: "number",
        description: "下载远程视频素材的最长时间",
        suffix: "秒",
      },
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        type: "number",
        description: "下载失败后的额外重试次数，填 0 不重试",
        suffix: "次",
      },
    ],
  },
  {
    title: "权属文件上传",
    description: "用 AI 识别剪映和剧创截图，逐张上传为制作证明",
    fields: [
      {
        key: "jianyingOwnershipProofCount",
        label: "剪映截图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "截图不足时停止任务",
      },
      {
        key: "juchuangOwnershipProofCount",
        label: "剧创截图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "与剪映截图分别计算",
      },
    ],
  },
  {
    title: "素材压缩与上传",
    description: "",
    fields: [
      {
        key: "imageCompressionThresholdMegabytes",
        label: "图片压缩阈值",
        type: "number",
        description: "图片超过此大小时压缩，PDF 等文件不处理",
        suffix: "MB",
      },
      {
        key: "imageCompressionTargetMegabytes",
        label: "图片压缩目标",
        type: "number",
        description: "压缩后的大小上限，需小于图片压缩阈值",
        suffix: "MB",
      },
      {
        key: "episodeVideoMaxFileMegabytes",
        label: "单集大小上限",
        type: "number",
        description: "超过此大小时压缩视频",
        suffix: "MB",
      },
      {
        key: "episodeVideoTargetFileMegabytes",
        label: "视频压缩目标",
        type: "number",
        description: "压缩后的目标大小，需小于单集大小上限",
        suffix: "MB",
      },
      {
        key: "videoTranscodeConcurrency",
        label: "同时压缩视频数",
        type: "number",
        description: "最多同时压缩多少个视频",
      },
      {
        key: "videoTranscodeThreadsPerJob",
        label: "每个视频压缩线程数",
        type: "number",
        description: "每个压缩任务使用的线程数",
      },
    ],
  },
  {
    title: "上传与重试",
    description: "",
    fields: [
      {
        key: "episodeUploadWaitTimeoutSeconds",
        label: "上传时限",
        type: "number",
        description: "等待上传完成的最长时间",
        suffix: "秒",
      },
      {
        kind: "select",
        key: "episodeUploadFailedRetryAttempts",
        label: "上传失败重试次数",
        description: "单集上传失败后的额外重试次数，填 0 不重试",
        options: [
          { value: "0", label: "不重试" },
          { value: "3", label: "最多 3 次" },
          { value: "5", label: "最多 5 次" },
          { value: "8", label: "最多 8 次" },
          { value: "12", label: "最多 12 次" },
        ],
      },
    ],
  },
];

export function WechatConfigurationPage() {
  const state = usePlatformConfig({
    emptyConfig,
    getConfig: wechatVideoService.getConfig,
    saveConfig: wechatVideoService.saveConfig,
  });
  const displayedConfig = {
    ...state.config,
    dataSyncDryRun: state.config.dataSyncDryRun === "true" ? "false" : "true",
  };
  const selectDirectory = async (key: keyof WechatVideoConfig) => {
    if (key !== "dataSyncDownloadDirectory") return;
    try {
      const directory = await wechatVideoService.selectDataSyncDirectory(
        state.config.dataSyncDownloadDirectory,
      );
      if (directory) state.updateConfig(key, directory);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <ConfigurationPageFrame
      title="视频号配置"
      hasChanges={state.hasChanges}
      loading={state.loading}
      onDiscard={state.discardChanges}
      onSave={state.persistConfig}
    >
      {sections.map((section) => (
        <ConfigSection
          key={section.title}
          config={displayedConfig}
          fields={section.fields}
          section={section}
          onChange={(key, value) =>
            state.updateConfig(
              key,
              key === "dataSyncDryRun" ? (value === "true" ? "false" : "true") : value,
            )
          }
          onSelectDirectory={(key) => void selectDirectory(key)}
        />
      ))}
    </ConfigurationPageFrame>
  );
}
