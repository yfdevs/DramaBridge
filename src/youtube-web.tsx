import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { HashRouter, Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { MoonIcon, SunIcon } from "lucide-react";

import appLogo from "@/assets/dramabridge-logo.png";
import youtubeMark from "@/assets/youtube-mark.svg";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  WorkspaceToolbarProvider,
  WorkspaceActionHost,
  WorkspacePageActivity,
} from "@/components/workspace-toolbar";
import { YoutubeWorkspacePage } from "@/pages/youtube-drama/workspace";
import { YoutubeCreateTaskDrawer } from "@/pages/youtube-drama/create-task-drawer";
import { YoutubeAddTaskButton } from "@/pages/youtube-drama/add-task-button";
import { YoutubeAccountsPage } from "@/pages/youtube-drama/accounts";
import { useYoutubeWebTheme } from "@/platforms/youtube-drama/web-theme";
import "./index.css";

const navigation = [
  { route: "service", label: "任务列表" },
  { route: "accounts", label: "账号管理" },
];

function WebNavigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav
      aria-label="YouTube 页面"
      className={
        mobile ? "grid grid-cols-2 gap-1 px-4 pb-3 md:hidden" : "flex flex-col gap-1 px-3 pt-1 pb-3"
      }
    >
      {navigation.map(({ route, label }) => (
        <NavLink
          key={route}
          to={`/youtube-drama/${route}`}
          className={({ isActive }) =>
            `flex min-h-8 items-center rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${mobile ? "justify-center" : "justify-start"} ${isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function WebBrand({ mobile = false }: { mobile?: boolean }) {
  return (
    <Link
      to="/youtube-drama/service"
      aria-label="DramaBridge & YouTube 首页"
      className={`flex min-w-0 items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring ${mobile ? "md:hidden" : "px-5 py-3"}`}
    >
      <span className="relative block size-10 shrink-0" aria-hidden="true">
        <img src={appLogo} alt="" width={36} height={36} className="size-9 object-contain" />
        <span className="absolute -bottom-0.5 -right-1 rounded-md bg-background p-0.5">
          <img src={youtubeMark} alt="" width={20} height={15} className="h-[15px] w-5" />
        </span>
      </span>
      <span className="min-w-0 text-sm font-semibold leading-5">
        <span className="block">DramaBridge</span>
        <span className="block text-xs font-normal text-muted-foreground">&amp; YouTube</span>
      </span>
    </Link>
  );
}

function WebRouteBehavior() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    if (!document.querySelector('[data-slot="drawer-popup"]')) {
      document.getElementById("youtube-web-content")?.focus({ preventScroll: true });
    }
  }, [pathname]);
  return null;
}

export function YoutubeWebApp() {
  const { dark, toggleTheme } = useYoutubeWebTheme();
  const themeLabel = dark ? "切换浅色主题" : "切换深色主题";
  return (
    <HashRouter>
      <WebRouteBehavior />
      <TooltipProvider delay={120}>
        <WorkspaceToolbarProvider>
          <YoutubeCreateTaskDrawer>
            <div className="youtube-theme grid min-h-svh min-w-0 bg-background text-foreground md:grid-cols-[224px_minmax(0,1fr)]">
              <aside
                aria-label="工作区导航"
                className="sticky top-0 hidden h-svh self-start overflow-y-auto bg-muted/30 md:block"
              >
                <WebBrand />
                <WebNavigation />
              </aside>
              <div className="flex min-w-0 flex-col">
                <header className="sticky top-0 z-20 bg-background">
                  <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
                    <WebBrand mobile />
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      <WorkspaceActionHost />
                      <YoutubeAddTaskButton />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={themeLabel}
                              onClick={toggleTheme}
                            />
                          }
                        >
                          {dark ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="end" sideOffset={8}>
                          {themeLabel}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <WebNavigation mobile />
                </header>
                <a
                  href="#youtube-web-content"
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById("youtube-web-content")?.focus();
                  }}
                  className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:p-3 focus:text-sm"
                >
                  跳至内容
                </a>
                <div
                  id="youtube-web-content"
                  className="flex min-w-0 flex-1 flex-col outline-none"
                  tabIndex={-1}
                >
                  <WorkspacePageActivity active>
                    <Routes>
                      <Route path="/youtube-drama/service" element={<YoutubeWorkspacePage />} />
                      <Route path="/youtube-drama/create" element={null} />
                      <Route path="/youtube-drama/accounts" element={<YoutubeAccountsPage />} />
                      <Route path="*" element={<Navigate to="/youtube-drama/service" replace />} />
                    </Routes>
                  </WorkspacePageActivity>
                </div>
              </div>
            </div>
          </YoutubeCreateTaskDrawer>
          <Toaster theme={dark ? "dark" : "light"} closeButton position="bottom-right" />
        </WorkspaceToolbarProvider>
      </TooltipProvider>
    </HashRouter>
  );
}

createRoot(document.getElementById("root")!).render(<YoutubeWebApp />);
