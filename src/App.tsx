import { HashRouter } from "react-router-dom";

import { AppRuntimeDock } from "@/components/app-runtime-dock";
import { AppTitlebarMemory } from "@/components/app-titlebar-memory";
import { AppTitlebarPlatformNav } from "@/components/app-titlebar-platform-nav";
import { BaiduNetdiskDialogProvider } from "@/platforms/baidu-netdisk/dialog";
import { JianyingDialogProvider } from "@/platforms/jianying/dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppRoutes } from "@/routes/app-routes";
import { WechatMiniProgramBaiduUploadWindow } from "@/pages/wechat-miniprogram-drama/baidu-upload-window";
import { WechatMiniProgramCatalogUploadWindow } from "@/pages/wechat-miniprogram-drama/catalog-upload-window";
import { PinduoduoDramaUploadRecordsPage } from "@/pages/pinduoduo-drama/upload-records";

import "./App.css";

export default function App() {
  const windowMode = new URLSearchParams(window.location.search).get("window");
  if (windowMode === "wechat-miniprogram-baidu-upload") {
    return (
      <TooltipProvider delay={120} closeDelay={0} timeout={250}>
        <WechatMiniProgramBaiduUploadWindow />
        <Toaster position="bottom-right" closeButton={true} theme="dark" richColors />
      </TooltipProvider>
    );
  }
  if (windowMode === "wechat-miniprogram-catalog-upload") {
    return (
      <TooltipProvider delay={120} closeDelay={0} timeout={250}>
        <WechatMiniProgramCatalogUploadWindow />
        <Toaster position="bottom-right" closeButton={true} theme="dark" richColors />
      </TooltipProvider>
    );
  }
  if (windowMode === "pinduoduo-drama-upload-records") {
    return (
      <TooltipProvider delay={120} closeDelay={0} timeout={250}>
        <PinduoduoDramaUploadRecordsPage />
        <Toaster position="bottom-right" closeButton={true} theme="dark" richColors />
      </TooltipProvider>
    );
  }
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

function AppContent() {
  return (
    <TooltipProvider delay={120} closeDelay={0} timeout={250}>
      <BaiduNetdiskDialogProvider>
        <JianyingDialogProvider>
          <div className="flex h-full min-h-0 flex-col bg-transparent">
            <AppTitlebarMemory />
            <AppTitlebarPlatformNav />
            <div className="min-h-0 flex-1 overflow-auto bg-transparent">
              <AppRoutes />
            </div>
            <AppRuntimeDock />
            <Toaster position="bottom-right" closeButton={true} theme="dark" richColors />
          </div>
        </JianyingDialogProvider>
      </BaiduNetdiskDialogProvider>
    </TooltipProvider>
  );
}
