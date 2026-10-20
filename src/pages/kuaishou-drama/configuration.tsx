import { useState } from "react";
import { toast } from "sonner";

import { Separator } from "@/components/ui/separator";
import {
  ConfigPanelSection,
  ConfigSection,
  ConfigurationPageFrame,
  StoragePathRow,
  type ConfigSectionDefinition,
  usePlatformConfig,
} from "@/pages/shared/configuration-page";
import {
  kuaishouDramaService,
  type KuaishouDramaConfig,
  type KuaishouDramaConfigResult,
  type KuaishouDramaStoragePathKey,
  type KuaishouDramaStoragePaths,
} from "@/platforms/kuaishou-drama/service";

const emptyConfig: KuaishouDramaConfig = {
  accountProfileName: "default",
  apiBaseUrl: "http://180.184.76.232:19090",
  localEpisodeVideoRoot: "",
  baiduNetdiskDownloadRetryAttempts: "3",
  videoUploadTimeoutMinutes: "120",
  headless: "false",
  operationDelaySeconds: "0",
  taskPollIntervalSeconds: "10",
  runDataDir: ".drama-runs/kuaishou-drama",
  logRetentionDays: "3",
};

const emptyStoragePaths: KuaishouDramaStoragePaths = {
  runDataDir: "",
  accountDir: "",
  userDataDir: "",
  credentialStatePath: "",
  assetDownloadDir: "",
  logDir: "",
  logFilePath: "",
};

const configSections: ConfigSectionDefinition<KuaishouDramaConfig>[] = [
  {
    title: "任务接口",
    description: "按账号领取任务并提交结果。",
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
    ],
  },
  {
    title: "浏览器与上传",
    description: "账号登录信息独立保存，共享目录在全局配置中设置。",
    fields: [
      {
        key: "baiduNetdiskDownloadRetryAttempts",
        label: "网盘下载重试次数",
        description: "下载失败后的额外重试次数，耗尽后任务失败。",
        type: "number",
        suffix: "次",
        min: 0,
      },
      {
        key: "videoUploadTimeoutMinutes",
        label: "上传时限",
        description: "等待全部剧集上传完成的最长时间。",
        type: "number",
        suffix: "分钟",
        min: 1,
      },
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
];

const storagePathRows: Array<{
  key: keyof KuaishouDramaStoragePaths;
  label: string;
  description: string;
}> = [
  {
    key: "runDataDir",
    label: "运行数据目录",
    description: "保存此平台的运行文件。",
  },
  {
    key: "accountDir",
    label: "账号目录",
    description: "保存当前账号的独立数据。",
  },
  {
    key: "userDataDir",
    label: "浏览器数据",
    description: "保存登录信息和浏览器缓存。",
  },
  {
    key: "credentialStatePath",
    label: "登录信息快照",
    description: "用于排查登录问题，不与其他账号共享。",
  },
  {
    key: "logDir",
    label: "日志目录",
    description: "按日期保存运行日志。",
  },
  {
    key: "assetDownloadDir",
    label: "素材缓存",
    description: "临时存放下载的封面、海报和授权材料。",
  },
];

export function KuaishouDramaConfigurationPage() {
  const [storagePaths, setStoragePaths] = useState<KuaishouDramaStoragePaths>(emptyStoragePaths);
  const [configFilePath, setConfigFilePath] = useState("");
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
    getConfig: kuaishouDramaService.getConfig,
    saveConfig: kuaishouDramaService.saveConfig,
    onApplyResult: (result: KuaishouDramaConfigResult) => {
      setStoragePaths(result.storagePaths);
      setConfigFilePath(result.path);
    },
  });

  const openStoragePath = async (key: KuaishouDramaStoragePathKey) => {
    try {
      await kuaishouDramaService.openStoragePath(key);
    } catch (error) {
      toast.error("打开路径失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <ConfigurationPageFrame
      hasChanges={hasChanges}
      loading={loading}
      restartRequired={restartRequired}
      title="快手配置"
      onDiscard={discardChanges}
      onSave={persistConfig}
    >
      {configSections.map((section) => (
        <ConfigSection
          key={section.title}
          config={config}
          fields={section.fields}
          section={section}
          onChange={updateConfig}
        />
      ))}

      <ConfigPanelSection
        description="配置、账号和素材的实际保存位置"
        title="文件位置"
      >
        <StoragePathRow
          description="保存当前平台的设置。"
          label="配置文件"
          pathText={configFilePath}
          onOpen={() => openStoragePath("configFilePath")}
        />
        {storagePathRows.map((row) => (
          <div key={row.key}>
            <Separator />
            <StoragePathRow
              description={row.description}
              label={row.label}
              pathText={storagePaths[row.key] ?? ""}
              onOpen={() => openStoragePath(row.key)}
            />
          </div>
        ))}
        <Separator />
        <StoragePathRow
          description="打开最新日志，没有日志时打开目录。"
          label="最近日志"
          pathText={storagePaths.logFilePath}
          onOpen={() => openStoragePath("latestLog")}
        />
      </ConfigPanelSection>
    </ConfigurationPageFrame>
  );
}
