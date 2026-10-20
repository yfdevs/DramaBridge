import { platformIcons } from "@/assets/platform-icons";
import type { Icon } from "@mynaui/icons-react";
import { ChartBar, CloudUpload, FineTune, Terminal } from "@mynaui/icons-react";

export type PlatformId =
  | "wechat-drama"
  | "wechat-miniprogram-drama"
  | "meituan-drama"
  | "taobao-drama"
  | "kuaishou-drama"
  | "qq-drama"
  | "tencent-huolong-drama"
  | "iqiyi-drama"
  | "baidu-drama"
  | "douyin-drama"
  | "tiktok-drama"
  | "pinduoduo-drama";

export type AppRoute =
  | `${PlatformId}/statistics`
  | "app/updates"
  | "app/config"
  | "wechat-drama/publish"
  | "wechat-drama/config"
  | "wechat-drama/accounts"
  | "wechat-drama/service"
  | "wechat-miniprogram-drama/service"
  | "wechat-miniprogram-drama/config"
  | "meituan-drama/service"
  | "meituan-drama/config"
  | "taobao-drama/service"
  | "taobao-drama/config"
  | "kuaishou-drama/service"
  | "kuaishou-drama/config"
  | "kuaishou-drama/projects"
  | "kuaishou-drama/schedule"
  | "kuaishou-drama/analytics"
  | "kuaishou-drama/settings"
  | "qq-drama/service"
  | "qq-drama/config"
  | "tencent-huolong-drama/service"
  | "tencent-huolong-drama/config"
  | "iqiyi-drama/service"
  | "iqiyi-drama/config"
  | "baidu-drama/service"
  | "baidu-drama/config"
  | "douyin-drama/service"
  | "douyin-drama/config"
  | "tiktok-drama/service"
  | "tiktok-drama/config"
  | "pinduoduo-drama/service"
  | "pinduoduo-drama/records"
  | "pinduoduo-drama/config";

const appRoutes = [
  "app/updates",
  "app/config",
  "wechat-drama/publish",
  "wechat-drama/config",
  "wechat-drama/statistics",
  "wechat-drama/accounts",
  "wechat-drama/service",
  "wechat-miniprogram-drama/service",
  "wechat-miniprogram-drama/config",
  "wechat-miniprogram-drama/statistics",
  "meituan-drama/service",
  "meituan-drama/config",
  "meituan-drama/statistics",
  "taobao-drama/service",
  "taobao-drama/config",
  "taobao-drama/statistics",
  "kuaishou-drama/service",
  "kuaishou-drama/config",
  "kuaishou-drama/statistics",
  "kuaishou-drama/projects",
  "kuaishou-drama/schedule",
  "kuaishou-drama/analytics",
  "kuaishou-drama/settings",
  "qq-drama/service",
  "qq-drama/config",
  "qq-drama/statistics",
  "tencent-huolong-drama/service",
  "tencent-huolong-drama/config",
  "tencent-huolong-drama/statistics",
  "iqiyi-drama/service",
  "iqiyi-drama/config",
  "iqiyi-drama/statistics",
  "baidu-drama/service",
  "baidu-drama/config",
  "baidu-drama/statistics",
  "douyin-drama/service",
  "douyin-drama/config",
  "douyin-drama/statistics",
  "tiktok-drama/service",
  "tiktok-drama/config",
  "tiktok-drama/statistics",
  "pinduoduo-drama/service",
  "pinduoduo-drama/records",
  "pinduoduo-drama/config",
  "pinduoduo-drama/statistics",
] as const satisfies readonly AppRoute[];

export type NavigationItem = {
  title: string;
  route: AppRoute;
  icon: Icon;
};

export type NavigationGroup = {
  title: string;
  items: NavigationItem[];
};

export type PlatformNavigationItem = {
  id: PlatformId;
  title: string;
  routePrefix: string;
  serviceRoute: AppRoute;
  configRoute: AppRoute;
  logoSrc: string;
};

export const defaultRoute: AppRoute = "wechat-drama/service";
export const globalConfigRoute: AppRoute = "app/config";

export function routePath(route: AppRoute) {
  return `/${route}`;
}

export function returnRouteFromLocationState(state: unknown): AppRoute {
  if (!state || typeof state !== "object" || !("returnRoute" in state)) {
    return defaultRoute;
  }

  const returnRoute = (state as { returnRoute?: unknown }).returnRoute;
  return typeof returnRoute === "string" &&
    !returnRoute.startsWith("app/") &&
    isAppRoute(returnRoute)
    ? returnRoute
    : defaultRoute;
}

export function platformContextRoute(route: AppRoute, state: unknown): AppRoute {
  return route.startsWith("app/") ? returnRouteFromLocationState(state) : route;
}

export const platformNavigation: PlatformNavigationItem[] = [
  {
    id: "wechat-drama",
    title: "微信视频号",
    routePrefix: "wechat-drama",
    serviceRoute: "wechat-drama/service",
    configRoute: "wechat-drama/config",
    logoSrc: platformIcons["wechat-drama"],
  },
  {
    id: "wechat-miniprogram-drama",
    title: "微信小程序",
    routePrefix: "wechat-miniprogram-drama",
    serviceRoute: "wechat-miniprogram-drama/service",
    configRoute: "wechat-miniprogram-drama/config",
    logoSrc: platformIcons["wechat-miniprogram-drama"],
  },
  {
    id: "meituan-drama",
    title: "美团短剧",
    routePrefix: "meituan-drama",
    serviceRoute: "meituan-drama/service",
    configRoute: "meituan-drama/config",
    logoSrc: platformIcons["meituan-drama"],
  },
  {
    id: "taobao-drama",
    title: "淘宝短剧",
    routePrefix: "taobao-drama",
    serviceRoute: "taobao-drama/service",
    configRoute: "taobao-drama/config",
    logoSrc: platformIcons["taobao-drama"],
  },
  {
    id: "kuaishou-drama",
    title: "快手短剧",
    routePrefix: "kuaishou-drama",
    serviceRoute: "kuaishou-drama/service",
    configRoute: "kuaishou-drama/config",
    logoSrc: platformIcons["kuaishou-drama"],
  },
  {
    id: "qq-drama",
    title: "QQ短剧",
    routePrefix: "qq-drama",
    serviceRoute: "qq-drama/service",
    configRoute: "qq-drama/config",
    logoSrc: platformIcons["qq-drama"],
  },
  {
    id: "tencent-huolong-drama",
    title: "火龙漫剧",
    routePrefix: "tencent-huolong-drama",
    serviceRoute: "tencent-huolong-drama/service",
    configRoute: "tencent-huolong-drama/config",
    logoSrc: platformIcons["tencent-huolong-drama"],
  },
  {
    id: "iqiyi-drama",
    title: "爱奇艺短剧",
    routePrefix: "iqiyi-drama",
    serviceRoute: "iqiyi-drama/service",
    configRoute: "iqiyi-drama/config",
    logoSrc: platformIcons["iqiyi-drama"],
  },
  {
    id: "baidu-drama",
    title: "百度短剧",
    routePrefix: "baidu-drama",
    serviceRoute: "baidu-drama/service",
    configRoute: "baidu-drama/config",
    logoSrc: platformIcons["baidu-drama"],
  },
  {
    id: "douyin-drama",
    title: "抖音短剧",
    routePrefix: "douyin-drama",
    serviceRoute: "douyin-drama/service",
    configRoute: "douyin-drama/config",
    logoSrc: platformIcons["douyin-drama"],
  },
  {
    id: "tiktok-drama",
    title: "TikTok短剧",
    routePrefix: "tiktok-drama",
    serviceRoute: "tiktok-drama/service",
    configRoute: "tiktok-drama/config",
    logoSrc: platformIcons["tiktok-drama"],
  },
  {
    id: "pinduoduo-drama",
    title: "拼多多短剧",
    routePrefix: "pinduoduo-drama",
    serviceRoute: "pinduoduo-drama/service",
    configRoute: "pinduoduo-drama/config",
    logoSrc: platformIcons["pinduoduo-drama"],
  },
];

export const navigationGroups: NavigationGroup[] = [
  {
    title: "微信视频号",
    items: [
      {
        title: "实例",
        route: "wechat-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "wechat-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "wechat-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "微信小程序",
    items: [
      {
        title: "实例",
        route: "wechat-miniprogram-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "wechat-miniprogram-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "wechat-miniprogram-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "美团短剧",
    items: [
      {
        title: "实例",
        route: "meituan-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "meituan-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "meituan-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "淘宝短剧",
    items: [
      {
        title: "实例",
        route: "taobao-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "taobao-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "taobao-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "快手短剧",
    items: [
      {
        title: "实例",
        route: "kuaishou-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "kuaishou-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "kuaishou-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "QQ短剧",
    items: [
      {
        title: "实例",
        route: "qq-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "qq-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "qq-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "火龙漫剧",
    items: [
      {
        title: "实例",
        route: "tencent-huolong-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "tencent-huolong-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "tencent-huolong-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "爱奇艺短剧",
    items: [
      {
        title: "实例",
        route: "iqiyi-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "iqiyi-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "iqiyi-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "百度短剧",
    items: [
      {
        title: "实例",
        route: "baidu-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "baidu-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "baidu-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "抖音短剧",
    items: [
      {
        title: "实例",
        route: "douyin-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "douyin-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "douyin-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "TikTok短剧",
    items: [
      {
        title: "实例",
        route: "tiktok-drama/service",
        icon: Terminal,
      },
      {
        title: "配置管理",
        route: "tiktok-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "tiktok-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
  {
    title: "拼多多短剧",
    items: [
      {
        title: "实例",
        route: "pinduoduo-drama/service",
        icon: Terminal,
      },
      {
        title: "上传记录",
        route: "pinduoduo-drama/records",
        icon: CloudUpload,
      },
      {
        title: "配置管理",
        route: "pinduoduo-drama/config",
        icon: FineTune,
      },
      {
        title: "发布统计",
        route: "pinduoduo-drama/statistics",
        icon: ChartBar,
      },
    ],
  },
];

export function isAppRoute(route: string): route is AppRoute {
  return appRoutes.includes(route as AppRoute);
}

export function platformForPath(route: string) {
  return (
    platformNavigation.find((platform) => route.startsWith(`${platform.routePrefix}/`)) ??
    platformNavigation[0]
  );
}
