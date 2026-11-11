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
    title: "接口连接",
    description: "",
    fields: [
      {
        key: "apiBaseUrl",
        label: "接口地址",
        type: "url",
        description: "后台服务的完整地址，支持线上和测试环境",
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
        description: "新任务开始前，关闭上次失败的页面",
        activeLabel: "自动关闭",
        inactiveLabel: "保留页面",
      },
      {
        key: "workerEmptyClaimDelaySeconds",
        label: "无任务检查间隔",
        type: "number",
        description: "暂时没有任务时，两次领取之间的等待时间",
        suffix: "秒",
      },
      {
        key: "workerSlowEmptyClaimThreshold",
        label: "连续无任务次数",
        type: "number",
        description: "连续无任务达到此次数后，使用较长的检查间隔",
      },
      {
        key: "workerSlowEmptyClaimDelaySeconds",
        label: "长时间无任务间隔",
        type: "number",
        description: "连续多次没有任务后，两次领取之间的等待时间",
        suffix: "秒",
      },
      {
        key: "videoAccountSyncIntervalSeconds",
        label: "账号同步间隔",
        type: "number",
        description: "更新后台账号状态的间隔",
        suffix: "秒",
      },
      {
        key: "materialPreparationConcurrency",
        label: "素材并行任务数",
        type: "number",
        description: "可同时准备素材的任务数",
      },
      {
        key: "taskPrefetchPerAccount",
        label: "每个账号预取任务数",
        type: "number",
        description: "每个账号可提前领取并准备的任务数",
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
        description: "无任务时，定期刷新页面以保持连接",
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
        description: "为刷新时间增加随机偏移，避免同时刷新",
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
        description: "需要上传的剪映权属截图数，不足时任务会提示",
      },
      {
        key: "juchuangOwnershipProofCount",
        label: "剧创截图数量",
        type: "number",
        min: 1,
        step: 1,
        suffix: "张",
        description: "需要上传的剧创权属截图数，与剪映截图分别上传",
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
        description: "单集超过此大小时，下载过程中提前安排压缩",
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
        description: "等待平台完成剧集上传处理的最长时间",
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
  return (
    <ConfigurationPageFrame
      title="视频号配置"
      hasChanges={state.hasChanges}
      loading={state.loading}
      restartRequired={state.restartRequired}
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
  );
}
