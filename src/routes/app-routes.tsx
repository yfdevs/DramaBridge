import { AppUpdateControl } from "@/components/app-update-control";
import { TaskStatisticsPage } from "@/pages/shared/task-statistics-page";
import { WorkspacePageActivity } from "@/components/workspace-toolbar";
import { useEffect, useState, type ComponentType } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { defaultRoute, isAppRoute, routePath, type AppRoute } from "@/config/navigation";
import { GlobalConfigurationPage } from "@/pages/app-config/configuration";
import { KuaishouAnalyticsPage } from "@/pages/kuaishou-drama/analytics";
import { KuaishouDramaConfigurationPage } from "@/pages/kuaishou-drama/configuration";
import { KuaishouDramaServiceControlPage } from "@/pages/kuaishou-drama/service-control";
import { KuaishouProjectsPage } from "@/pages/kuaishou-drama/projects";
import { KuaishouSchedulePage } from "@/pages/kuaishou-drama/schedule";
import { KuaishouSettingsPage } from "@/pages/kuaishou-drama/settings";
import { QqDramaConfigurationPage } from "@/pages/qq-drama/configuration";
import { QqDramaServiceControlPage } from "@/pages/qq-drama/service-control";
import { TencentHuolongDramaConfigurationPage } from "@/pages/tencent-huolong-drama/configuration";
import { TencentHuolongDramaServiceControlPage } from "@/pages/tencent-huolong-drama/service-control";
import { IqiyiDramaConfigurationPage } from "@/pages/iqiyi-drama/configuration";
import { IqiyiDramaServiceControlPage } from "@/pages/iqiyi-drama/service-control";
import { BaiduDramaConfigurationPage } from "@/pages/baidu-drama/configuration";
import { BaiduDramaServiceControlPage } from "@/pages/baidu-drama/service-control";
import { DouyinDramaConfigurationPage } from "@/pages/douyin-drama/configuration";
import { DouyinDramaServiceControlPage } from "@/pages/douyin-drama/service-control";
import { WechatAccountsPage } from "@/pages/wechat-drama/accounts";
import { WechatConfigurationPage } from "@/pages/wechat-drama/configuration";
import { WechatPublishTasksPage } from "@/pages/wechat-drama/publish-tasks";
import { WechatServiceControlPage } from "@/pages/wechat-drama/service-control";
import { WechatMiniProgramConfigurationPage } from "@/pages/wechat-miniprogram-drama/configuration";
import { WechatMiniProgramServiceControlPage } from "@/pages/wechat-miniprogram-drama/service-control";
import { MeituanCreationConfigurationPage } from "@/pages/meituan-drama/configuration";
import { MeituanCreationServiceControlPage } from "@/pages/meituan-drama/service-control";
import { TaobaoDramaConfigurationPage } from "@/pages/taobao-drama/configuration";
import { TaobaoDramaServiceControlPage } from "@/pages/taobao-drama/service-control";
import { PinduoduoDramaConfigurationPage } from "@/pages/pinduoduo-drama/configuration";
import { PinduoduoDramaServiceControlPage } from "@/pages/pinduoduo-drama/service-control";
import { PinduoduoDramaUploadRecordsPage } from "@/pages/pinduoduo-drama/upload-records";
import { TiktokDramaCenterConfigurationPage } from "@/pages/tiktok-drama/configuration";
import { TiktokDramaCenterServiceControlPage } from "@/pages/tiktok-drama/service-control";

const appRouteComponents: Record<AppRoute, ComponentType> = {
  "app/config": GlobalConfigurationPage,
  "app/updates": () => <AppUpdateControl page />,
  "wechat-drama/publish": WechatPublishTasksPage,
  "wechat-drama/config": WechatConfigurationPage,
  "wechat-drama/accounts": WechatAccountsPage,
  "wechat-drama/service": WechatServiceControlPage,
  "wechat-miniprogram-drama/service": WechatMiniProgramServiceControlPage,
  "wechat-miniprogram-drama/config": WechatMiniProgramConfigurationPage,
  "meituan-drama/service": MeituanCreationServiceControlPage,
  "meituan-drama/config": MeituanCreationConfigurationPage,
  "taobao-drama/service": TaobaoDramaServiceControlPage,
  "taobao-drama/config": TaobaoDramaConfigurationPage,
  "kuaishou-drama/service": KuaishouDramaServiceControlPage,
  "kuaishou-drama/config": KuaishouDramaConfigurationPage,
  "kuaishou-drama/projects": KuaishouProjectsPage,
  "kuaishou-drama/schedule": KuaishouSchedulePage,
  "kuaishou-drama/analytics": KuaishouAnalyticsPage,
  "kuaishou-drama/settings": KuaishouSettingsPage,
  "qq-drama/service": QqDramaServiceControlPage,
  "qq-drama/config": QqDramaConfigurationPage,
  "tencent-huolong-drama/service": TencentHuolongDramaServiceControlPage,
  "tencent-huolong-drama/config": TencentHuolongDramaConfigurationPage,
  "iqiyi-drama/service": IqiyiDramaServiceControlPage,
  "iqiyi-drama/config": IqiyiDramaConfigurationPage,
  "baidu-drama/service": BaiduDramaServiceControlPage,
  "baidu-drama/config": BaiduDramaConfigurationPage,
  "douyin-drama/service": DouyinDramaServiceControlPage,
  "douyin-drama/config": DouyinDramaConfigurationPage,
  "tiktok-drama/service": TiktokDramaCenterServiceControlPage,
  "tiktok-drama/config": TiktokDramaCenterConfigurationPage,
  "pinduoduo-drama/service": PinduoduoDramaServiceControlPage,
  "pinduoduo-drama/records": PinduoduoDramaUploadRecordsPage,
  "pinduoduo-drama/config": PinduoduoDramaConfigurationPage,
  "wechat-drama/statistics": () => <TaskStatisticsPage platform="wechat-drama" />,
  "wechat-miniprogram-drama/statistics": () => (
    <TaskStatisticsPage platform="wechat-miniprogram-drama" />
  ),
  "meituan-drama/statistics": () => <TaskStatisticsPage platform="meituan-drama" />,
  "taobao-drama/statistics": () => <TaskStatisticsPage platform="taobao-drama" />,
  "kuaishou-drama/statistics": () => <TaskStatisticsPage platform="kuaishou-drama" />,
  "qq-drama/statistics": () => <TaskStatisticsPage platform="qq-drama" />,
  "tencent-huolong-drama/statistics": () => <TaskStatisticsPage platform="tencent-huolong-drama" />,
  "iqiyi-drama/statistics": () => <TaskStatisticsPage platform="iqiyi-drama" />,
  "baidu-drama/statistics": () => <TaskStatisticsPage platform="baidu-drama" />,
  "douyin-drama/statistics": () => <TaskStatisticsPage platform="douyin-drama" />,
  "tiktok-drama/statistics": () => <TaskStatisticsPage platform="tiktok-drama" />,
  "pinduoduo-drama/statistics": () => <TaskStatisticsPage platform="pinduoduo-drama" />,
};

export function AppRoutes() {
  const location = useLocation();
  const currentPath = location.pathname.replace(/^\/+/, "");
  const activeRoute = isAppRoute(currentPath) ? currentPath : defaultRoute;
  const [cachedRoutes, setCachedRoutes] = useState<Set<AppRoute>>(() => new Set([activeRoute]));

  useEffect(() => {
    setCachedRoutes((current) => {
      if (current.has(activeRoute)) return current;
      return new Set(current).add(activeRoute);
    });
  }, [activeRoute]);

  return (
    <>
      <Routes>
        <Route index element={<Navigate to={routePath(defaultRoute)} replace />} />
        <Route
          path="*"
          element={
            currentPath && !isAppRoute(currentPath) ? (
              <Navigate to={routePath(defaultRoute)} replace />
            ) : null
          }
        />
      </Routes>
      {Object.entries(appRouteComponents).map(([route, Page]) => {
        const typedRoute = route as AppRoute;
        if (!cachedRoutes.has(typedRoute)) return null;

        const active = activeRoute === typedRoute;

        return (
          <div key={route} className={active ? "contents" : "hidden"}>
            <WorkspacePageActivity active={active}>
              <Page />
            </WorkspacePageActivity>
          </div>
        );
      })}
    </>
  );
}
