import { useEffect, useState, type ComponentProps } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Circle, Cog, Folder, GitBranch, Refresh } from "@mynaui/icons-react";
import { toast } from "sonner";
import { version as bundledVersion } from "../../package.json";
import {
  getAppUpdateStatus,
  onAppUpdateChanged,
  type AppUpdateStatus,
} from "@/platforms/app-runtime/service";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  defaultRoute,
  globalConfigRoute,
  isAppRoute,
  platformContextRoute,
  platformForPath,
  platformNavigation,
  routePath,
} from "@/config/navigation";
import { formatRuntimeDuration, useAppRuntime } from "@/platforms/app-runtime/context";
import { openAppPlatformLogs } from "@/platforms/app-runtime/service";

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.replace(/^\/+/, "");
  const route = isAppRoute(path) ? path : defaultRoute;
  const platform = platformForPath(platformContextRoute(route, location.state));
  const { entries, now } = useAppRuntime();
  const [openingLogs, setOpeningLogs] = useState(false);
  const connected = Boolean(window.ipcRenderer);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    void getAppUpdateStatus()
      .then((status) => {
        if (!disposed) setUpdateStatus(status);
      })
      .catch(() => undefined);
    const unsubscribe = onAppUpdateChanged((status) => {
      if (!disposed) setUpdateStatus(status);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const hasUpdate = Boolean(
    updateStatus &&
    ["available", "downloading", "downloaded", "installing"].includes(updateStatus.state),
  );
  const version =
    updateStatus?.currentVersion ?? entries[platform.id]?.result?.appVersion ?? bundledVersion;
  const returnRoute = route.startsWith("app/") ? platform.serviceRoute : route;
  const openLogs = async () => {
    setOpeningLogs(true);
    try {
      await openAppPlatformLogs(platform.id);
    } catch (error) {
      toast.error("无法打开日志目录", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpeningLogs(false);
    }
  };
  return (
    <Sidebar collapsible="none" className="shrink-0 border-none" {...props}>
      <SidebarHeader className="app-sidebar-brand h-14 justify-center px-6 py-0">
        <NavLink
          to={routePath(defaultRoute)}
          className="w-fit rounded-md text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          DramaBridge
        </NavLink>
      </SidebarHeader>
      <SidebarContent className="app-sidebar-content gap-0 px-3 pb-4">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {platformNavigation.map((item) => {
                const active = platform.id === item.id;
                const entry = entries[item.id];
                const running = entry?.result?.platform.running;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={active && !route.startsWith("app/")}
                      render={<NavLink to={routePath(item.serviceRoute)} />}
                      className="platform-menu-row h-8 gap-2 rounded-lg px-3"
                    >
                      <img
                        className="platform-menu-icon"
                        src={item.logoSrc}
                        alt=""
                        aria-hidden="true"
                        draggable={false}
                        width={16}
                        height={16}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                      {running && (
                        <span
                          className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground"
                          title="运行中"
                        >
                          <span className="sr-only">运行中，已运行</span>
                          <span className="tabular-nums">
                            {formatRuntimeDuration(entry.result?.platform.startedAt, now)}
                          </span>
                          <Circle
                            strokeDasharray="3 3"
                            className="size-3.5 text-foreground motion-safe:animate-spin"
                            aria-hidden="true"
                          />
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-3 py-2">
        <div className="flex h-7 items-center justify-between gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="app-chrome-control h-7 min-w-0 justify-start gap-1.5 rounded-lg px-1.5 text-xs font-normal"
            aria-current={route === "app/updates" ? "page" : undefined}
            aria-label={`版本与更新：v${version ?? "—"}${hasUpdate ? "，有可用更新" : ""}`}
            onClick={() => navigate(routePath("app/updates"), { state: { returnRoute } })}
          >
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              {hasUpdate ? <Refresh className="size-3.5" /> : <GitBranch className="size-3.5" />}
              {hasUpdate && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-500 ring-2 ring-sidebar"
                />
              )}
            </span>
            <span className="truncate tabular-nums">v{version ?? "—"}</span>
          </Button>
          <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="工作空间工具">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="app-chrome-control size-7 rounded-lg"
                    aria-label={`打开${platform.title}日志目录`}
                    disabled={!connected || openingLogs}
                    onClick={() => void openLogs()}
                  />
                }
              >
                <Folder className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>当前平台日志</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="app-chrome-control size-7 rounded-lg"
                    aria-current={route === globalConfigRoute ? "page" : undefined}
                    aria-label="全局配置"
                    onClick={() => {
                      navigate(routePath(globalConfigRoute), {
                        state: {
                          returnRoute,
                        },
                      });
                    }}
                  />
                }
              >
                <Cog className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>全局设置</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
