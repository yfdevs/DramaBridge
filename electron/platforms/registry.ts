import { logMain } from "../main-logger";
import {
  getBaiduDramaBrowserInstanceCount,
  getBaiduDramaPlatformRuntimeSummary,
  getBaiduDramaRunningPlatformCount,
  openBaiduDramaLogDir,
  registerBaiduDramaPlatformHandlers,
  stopBaiduDramaPlatformRuntime,
  stopBaiduDramaPlatformService,
} from "./baidu-drama";
import { registerBaiduNetdiskPlatformHandlers } from "./baidu-netdisk";
import {
  getDouyinDramaBrowserInstanceCount,
  getDouyinDramaPlatformRuntimeSummary,
  getDouyinDramaRunningPlatformCount,
  openDouyinDramaLogDir,
  registerDouyinDramaPlatformHandlers,
  stopDouyinDramaPlatformRuntime,
  stopDouyinDramaPlatformService,
} from "./douyin-drama";
import {
  getIqiyiDramaBrowserInstanceCount,
  getIqiyiDramaPlatformRuntimeSummary,
  getIqiyiDramaRunningPlatformCount,
  openIqiyiDramaLogDir,
  registerIqiyiDramaPlatformHandlers,
  stopIqiyiDramaPlatformRuntime,
  stopIqiyiDramaPlatformService,
} from "./iqiyi-drama";
import {
  getKuaishouDramaBrowserInstanceCount,
  getKuaishouDramaPlatformRuntimeSummary,
  getKuaishouDramaRunningPlatformCount,
  openKuaishouDramaLogDir,
  registerKuaishouDramaPlatformHandlers,
  stopKuaishouDramaPlatformRuntime,
  stopKuaishouDramaPlatformService,
} from "./kuaishou-drama";
import {
  getMeituanCreationBrowserInstanceCount,
  getMeituanCreationPlatformRuntimeSummary,
  getMeituanCreationRunningPlatformCount,
  openMeituanCreationLogDir,
  registerMeituanCreationPlatformHandlers,
  stopMeituanCreationPlatformRuntime,
  stopMeituanCreationPlatformService,
} from "./meituan-drama";
import {
  getPinduoduoDramaBrowserInstanceCount,
  getPinduoduoDramaPlatformRuntimeSummary,
  getPinduoduoDramaRunningPlatformCount,
  openPinduoduoDramaLogDir,
  registerPinduoduoDramaPlatformHandlers,
  stopPinduoduoDramaPlatformRuntime,
  stopPinduoduoDramaPlatformService,
} from "./pinduoduo-drama";
import {
  getQqDramaBrowserInstanceCount,
  getQqDramaPlatformRuntimeSummary,
  getQqDramaRunningPlatformCount,
  openQqDramaLogDir,
  registerQqDramaPlatformHandlers,
  stopQqDramaPlatformRuntime,
  stopQqDramaPlatformService,
} from "./qq-drama";
import {
  getTaobaoDramaBrowserInstanceCount,
  getTaobaoDramaPlatformRuntimeSummary,
  getTaobaoDramaRunningPlatformCount,
  openTaobaoDramaLogDir,
  registerTaobaoDramaPlatformHandlers,
  stopTaobaoDramaPlatformRuntime,
  stopTaobaoDramaPlatformService,
} from "./taobao-drama";
import {
  getTencentHuolongDramaBrowserInstanceCount,
  getTencentHuolongDramaPlatformRuntimeSummary,
  getTencentHuolongDramaRunningPlatformCount,
  openTencentHuolongDramaLogDir,
  registerTencentHuolongDramaPlatformHandlers,
  stopTencentHuolongDramaPlatformRuntime,
  stopTencentHuolongDramaPlatformService,
} from "./tencent-huolong-drama";
import {
  getTiktokDramaCenterBrowserInstanceCount,
  getTiktokDramaCenterPlatformRuntimeSummary,
  getTiktokDramaCenterRunningPlatformCount,
  openTiktokDramaCenterLogDir,
  registerTiktokDramaCenterPlatformHandlers,
  stopTiktokDramaCenterPlatformRuntime,
  stopTiktokDramaCenterPlatformService,
} from "./tiktok-drama";
import {
  getWechatVideoBrowserInstanceCount,
  getWechatVideoPlatformRuntimeSummary,
  getWechatVideoRunningPlatformCount,
  openWechatVideoLogDir,
  registerWechatVideoPlatformHandlers,
  stopWechatVideoPlatformRuntime,
  stopWechatVideoPlatformService,
} from "./wechat-drama";
import {
  getWechatMiniProgramBrowserInstanceCount,
  getWechatMiniProgramPlatformRuntimeSummary,
  getWechatMiniProgramRunningPlatformCount,
  openWechatMiniProgramLogDir,
  registerWechatMiniProgramPlatformHandlers,
  stopWechatMiniProgramPlatformRuntime,
  stopWechatMiniProgramPlatformService,
} from "./wechat-miniprogram-drama";

type PlatformDefinition = {
  id: string;
  label: string;
  registerHandlers: () => void;
  stopRuntime: () => void;
  stopService: () => Promise<unknown>;
  getBrowserInstanceCount: () => number;
  getRunningPlatformCount: () => number;
  getRuntimeSummary: () => unknown;
  openLogDir: () => unknown;
};

const platformDefinitions = [
  {
    id: "wechat-drama",
    label: "微信视频号",
    registerHandlers: registerWechatVideoPlatformHandlers,
    stopRuntime: stopWechatVideoPlatformRuntime,
    stopService: stopWechatVideoPlatformService,
    getBrowserInstanceCount: getWechatVideoBrowserInstanceCount,
    getRunningPlatformCount: getWechatVideoRunningPlatformCount,
    getRuntimeSummary: getWechatVideoPlatformRuntimeSummary,
    openLogDir: openWechatVideoLogDir,
  },
  {
    id: "wechat-miniprogram-drama",
    label: "微信小程序",
    registerHandlers: registerWechatMiniProgramPlatformHandlers,
    stopRuntime: stopWechatMiniProgramPlatformRuntime,
    stopService: stopWechatMiniProgramPlatformService,
    getBrowserInstanceCount: getWechatMiniProgramBrowserInstanceCount,
    getRunningPlatformCount: getWechatMiniProgramRunningPlatformCount,
    getRuntimeSummary: getWechatMiniProgramPlatformRuntimeSummary,
    openLogDir: openWechatMiniProgramLogDir,
  },
  {
    id: "meituan-drama",
    label: "美团短剧",
    registerHandlers: registerMeituanCreationPlatformHandlers,
    stopRuntime: stopMeituanCreationPlatformRuntime,
    stopService: stopMeituanCreationPlatformService,
    getBrowserInstanceCount: getMeituanCreationBrowserInstanceCount,
    getRunningPlatformCount: getMeituanCreationRunningPlatformCount,
    getRuntimeSummary: getMeituanCreationPlatformRuntimeSummary,
    openLogDir: openMeituanCreationLogDir,
  },
  {
    id: "taobao-drama",
    label: "淘宝短剧",
    registerHandlers: registerTaobaoDramaPlatformHandlers,
    stopRuntime: stopTaobaoDramaPlatformRuntime,
    stopService: stopTaobaoDramaPlatformService,
    getBrowserInstanceCount: getTaobaoDramaBrowserInstanceCount,
    getRunningPlatformCount: getTaobaoDramaRunningPlatformCount,
    getRuntimeSummary: getTaobaoDramaPlatformRuntimeSummary,
    openLogDir: openTaobaoDramaLogDir,
  },
  {
    id: "kuaishou-drama",
    label: "快手短剧",
    registerHandlers: registerKuaishouDramaPlatformHandlers,
    stopRuntime: stopKuaishouDramaPlatformRuntime,
    stopService: stopKuaishouDramaPlatformService,
    getBrowserInstanceCount: getKuaishouDramaBrowserInstanceCount,
    getRunningPlatformCount: getKuaishouDramaRunningPlatformCount,
    getRuntimeSummary: getKuaishouDramaPlatformRuntimeSummary,
    openLogDir: openKuaishouDramaLogDir,
  },
  {
    id: "qq-drama",
    label: "QQ 短剧",
    registerHandlers: registerQqDramaPlatformHandlers,
    stopRuntime: stopQqDramaPlatformRuntime,
    stopService: stopQqDramaPlatformService,
    getBrowserInstanceCount: getQqDramaBrowserInstanceCount,
    getRunningPlatformCount: getQqDramaRunningPlatformCount,
    getRuntimeSummary: getQqDramaPlatformRuntimeSummary,
    openLogDir: openQqDramaLogDir,
  },
  {
    id: "tencent-huolong-drama",
    label: "腾讯火龙",
    registerHandlers: registerTencentHuolongDramaPlatformHandlers,
    stopRuntime: stopTencentHuolongDramaPlatformRuntime,
    stopService: stopTencentHuolongDramaPlatformService,
    getBrowserInstanceCount: getTencentHuolongDramaBrowserInstanceCount,
    getRunningPlatformCount: getTencentHuolongDramaRunningPlatformCount,
    getRuntimeSummary: getTencentHuolongDramaPlatformRuntimeSummary,
    openLogDir: openTencentHuolongDramaLogDir,
  },
  {
    id: "iqiyi-drama",
    label: "爱奇艺短剧",
    registerHandlers: registerIqiyiDramaPlatformHandlers,
    stopRuntime: stopIqiyiDramaPlatformRuntime,
    stopService: stopIqiyiDramaPlatformService,
    getBrowserInstanceCount: getIqiyiDramaBrowserInstanceCount,
    getRunningPlatformCount: getIqiyiDramaRunningPlatformCount,
    getRuntimeSummary: getIqiyiDramaPlatformRuntimeSummary,
    openLogDir: openIqiyiDramaLogDir,
  },
  {
    id: "baidu-drama",
    label: "百度短剧",
    registerHandlers: registerBaiduDramaPlatformHandlers,
    stopRuntime: stopBaiduDramaPlatformRuntime,
    stopService: stopBaiduDramaPlatformService,
    getBrowserInstanceCount: getBaiduDramaBrowserInstanceCount,
    getRunningPlatformCount: getBaiduDramaRunningPlatformCount,
    getRuntimeSummary: getBaiduDramaPlatformRuntimeSummary,
    openLogDir: openBaiduDramaLogDir,
  },
  {
    id: "douyin-drama",
    label: "抖音短剧",
    registerHandlers: registerDouyinDramaPlatformHandlers,
    stopRuntime: stopDouyinDramaPlatformRuntime,
    stopService: stopDouyinDramaPlatformService,
    getBrowserInstanceCount: getDouyinDramaBrowserInstanceCount,
    getRunningPlatformCount: getDouyinDramaRunningPlatformCount,
    getRuntimeSummary: getDouyinDramaPlatformRuntimeSummary,
    openLogDir: openDouyinDramaLogDir,
  },
  {
    id: "tiktok-drama",
    label: "TikTok 短剧",
    registerHandlers: registerTiktokDramaCenterPlatformHandlers,
    stopRuntime: stopTiktokDramaCenterPlatformRuntime,
    stopService: stopTiktokDramaCenterPlatformService,
    getBrowserInstanceCount: getTiktokDramaCenterBrowserInstanceCount,
    getRunningPlatformCount: getTiktokDramaCenterRunningPlatformCount,
    getRuntimeSummary: getTiktokDramaCenterPlatformRuntimeSummary,
    openLogDir: openTiktokDramaCenterLogDir,
  },
  {
    id: "pinduoduo-drama",
    label: "拼多多短剧",
    registerHandlers: registerPinduoduoDramaPlatformHandlers,
    stopRuntime: stopPinduoduoDramaPlatformRuntime,
    stopService: stopPinduoduoDramaPlatformService,
    getBrowserInstanceCount: getPinduoduoDramaBrowserInstanceCount,
    getRunningPlatformCount: getPinduoduoDramaRunningPlatformCount,
    getRuntimeSummary: getPinduoduoDramaPlatformRuntimeSummary,
    openLogDir: openPinduoduoDramaLogDir,
  },
] as const satisfies readonly PlatformDefinition[];

export type PlatformId = (typeof platformDefinitions)[number]["id"];

const platformDefinitionsById = new Map(
  platformDefinitions.map((definition) => [definition.id, definition] as const),
);

function getPlatformDefinition(platformId: PlatformId) {
  const definition = platformDefinitionsById.get(platformId);
  if (!definition) {
    throw new Error(`未知平台：${String(platformId)}`);
  }
  return definition;
}

function sumPlatformMetric(readMetric: (definition: PlatformDefinition) => number) {
  return platformDefinitions.reduce((total, definition) => {
    try {
      return total + readMetric(definition);
    } catch {
      return total;
    }
  }, 0);
}

export function registerAllPlatformHandlers() {
  for (const definition of platformDefinitions) {
    definition.registerHandlers();
  }
  registerBaiduNetdiskPlatformHandlers();
}

export function stopAllPlatformRuntimes() {
  for (const definition of platformDefinitions) {
    definition.stopRuntime();
  }
}

export function getPlatformRuntimeSummary(platformId: PlatformId) {
  return getPlatformDefinition(platformId).getRuntimeSummary();
}

export function openPlatformLogDir(platformId: PlatformId) {
  return getPlatformDefinition(platformId).openLogDir();
}

export function getPlatformLogDir(platformId: PlatformId) {
  const summary = getPlatformDefinition(platformId).getRuntimeSummary();
  if (
    !summary ||
    typeof summary !== "object" ||
    !("logDir" in summary) ||
    typeof summary.logDir !== "string"
  ) {
    throw new Error(`无法确定${getPlatformDefinition(platformId).label}日志目录。`);
  }
  return summary.logDir;
}

export function getGlobalBrowserInstanceCount() {
  return sumPlatformMetric(({ getBrowserInstanceCount }) => getBrowserInstanceCount());
}

export function getGlobalRunningPlatformStatus() {
  return {
    running: sumPlatformMetric(({ getRunningPlatformCount }) => getRunningPlatformCount()),
    total: platformDefinitions.length,
  };
}

export async function stopAllPlatformServices() {
  const results = await Promise.allSettled(
    platformDefinitions.map(({ stopService }) => stopService()),
  );
  const failures = results.flatMap((result, index) => {
    if (result.status !== "rejected") return [];
    const label = platformDefinitions[index]?.label ?? `平台 ${index + 1}`;
    logMain("error", `Failed to stop ${label} before update installation`, result.reason);
    return [label];
  });

  if (failures.length > 0) {
    throw new Error(`${failures.join("、")}停止失败。`);
  }
}
