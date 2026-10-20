import { useState, type ComponentProps } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Cog, Folder, SpinnerOne, Refresh } from "@mynaui/icons-react";
import { toast } from "sonner";
import { AppUpdateControl } from "@/components/app-update-control";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const runningCount = Object.values(entries).filter(
    (entry) => entry.result?.platform.running,
  ).length;
  const connected = Boolean(window.ipcRenderer);
  const errorCount = Object.values(entries).filter((entry) => entry.error).length;
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
          AutoDrama
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
                      isActive={active && route !== globalConfigRoute}
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
                          <SpinnerOne
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
        <div className="flex h-8 items-center justify-between gap-2">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="工作空间状态"
                  className="h-8 min-w-0 gap-2 px-2 text-xs font-normal text-muted-foreground transition-none"
                />
              }
            >
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${errorCount ? "bg-amber-600" : runningCount ? "bg-emerald-600" : "bg-muted-foreground/50"}`}
              />
              <span className="truncate">
                {!connected
                  ? "未连接"
                  : errorCount
                    ? `${errorCount} 个异常`
                    : runningCount
                      ? `${runningCount} 个运行中`
                      : "就绪"}
              </span>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={10} className="w-64 gap-3 p-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold">AutoDrama</span>
                <span className="text-xs text-muted-foreground">
                  {entries[platform.id]?.result?.appVersion
                    ? `v${entries[platform.id]?.result?.appVersion}`
                    : "桌面工作空间"}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">发布平台</span>
                <span>
                  {platformNavigation.length} 个 · {runningCount} 个运行中
                </span>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {!connected
                  ? "请在桌面应用中连接服务。"
                  : errorCount
                    ? `${errorCount} 个平台状态读取失败，请查看平台日志。`
                    : runningCount
                      ? "服务正在后台运行，运行时长显示在对应菜单右侧。"
                      : "所有平台已就绪，选择平台后可启动服务。"}
              </p>
            </PopoverContent>
          </Popover>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="工作空间工具">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground transition-none"
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
                    className="text-muted-foreground transition-none"
                    aria-label="全局配置"
                    onClick={() => {
                      navigate(routePath(globalConfigRoute), {
                        state: {
                          returnRoute: route === globalConfigRoute ? platform.serviceRoute : route,
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
            {connected ? (
              <AppUpdateControl iconOnly />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground transition-none"
                      aria-label="应用更新"
                      disabled
                    />
                  }
                >
                  <Refresh className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>在桌面应用中检查更新</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
