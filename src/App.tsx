import { HashRouter } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { AppWorkspaceHeader } from "@/components/app-workspace-header";
import { WorkspaceToolbarProvider } from "@/components/workspace-toolbar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppRuntimeProvider } from "@/platforms/app-runtime/context";
import { AppTitlebarMemory } from "@/components/app-titlebar-memory";
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
          <AppRuntimeProvider>
            <SidebarProvider
              open={true}
              keyboardShortcutEnabled={false}
              className="app-desktop-shell h-full min-h-0"
              style={{ "--sidebar-width": "260px" } as React.CSSProperties}
            >
              <AppTitlebarMemory />
              <AppSidebar />
              <WorkspaceToolbarProvider>
                <div className="app-workspace flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
                  <AppWorkspaceHeader />
                  <div className="app-page-scroll min-h-0 flex-1 overflow-auto">
                    <AppRoutes />
                  </div>
                </div>
              </WorkspaceToolbarProvider>
              <Toaster position="bottom-right" closeButton={true} richColors />
            </SidebarProvider>
          </AppRuntimeProvider>
        </JianyingDialogProvider>
      </BaiduNetdiskDialogProvider>
    </TooltipProvider>
  );
}
