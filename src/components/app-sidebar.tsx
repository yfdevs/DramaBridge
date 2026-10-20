import { useState, type ComponentProps } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Cog, Folder, Search, SpinnerOne, CheckCircle, Info } from "@mynaui/icons-react";
import { toast } from "sonner";
import { AppUpdateControl } from "@/components/app-update-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
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
  const { isMobile, setOpenMobile } = useSidebar();
  const path = location.pathname.replace(/^\/+/, "");
  const route = isAppRoute(path) ? path : defaultRoute;
  const platform = platformForPath(platformContextRoute(route, location.state));
  const { entries, now } = useAppRuntime();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [openingLogs, setOpeningLogs] = useState(false);
  const runningCount = Object.values(entries).filter(
    (entry) => entry.result?.platform.running,
  ).length;
  const connected = Boolean(window.ipcRenderer);
  const errorCount = Object.values(entries).filter((entry) => entry.error).length;
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
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
    <Sidebar collapsible="offcanvas" className="border-none" {...props}>
      <SidebarHeader className="gap-3 px-5 pt-5 pb-6">
        <div className="flex h-7 items-center justify-between">
          <NavLink
            to={routePath(defaultRoute)}
            className="rounded-md text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={closeMobile}
          >
            AutoDrama
          </NavLink>
          <div className="flex items-center gap-1">
            <SidebarTrigger aria-label="收起侧边栏" className="text-muted-foreground" />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="搜索平台"
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen(!searchOpen);
                setQuery("");
              }}
            >
              <Search className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
        {searchOpen && (
          <Input
            autoFocus
            aria-label="搜索平台"
            placeholder="搜索平台…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 border-0 bg-foreground/5 shadow-none"
          />
        )}
      </SidebarHeader>
      <SidebarContent className="gap-0 px-3 pb-4">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="mb-1 flex justify-between px-3 text-[12px] font-medium text-muted-foreground">
            <span>
              发布平台 <span className="ml-1.5 opacity-70">{platformNavigation.length}</span>
            </span>
            <span>{runningCount > 0 ? `${runningCount} 个运行中` : ""}</span>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {platformNavigation
                .filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()))
                .map((item) => {
                  const active = platform.id === item.id;
                  const entry = entries[item.id];
                  const running = entry?.result?.platform.running;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active && route !== globalConfigRoute}
                        render={<NavLink to={routePath(item.serviceRoute)} onClick={closeMobile} />}
                        className="platform-menu-row h-9 gap-2 rounded-[7px] px-3 data-active:font-medium"
                      >
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
              {!platformNavigation.some((item) =>
                item.title.toLowerCase().includes(query.trim().toLowerCase()),
              ) && (
                <li className="px-3 py-8 text-center text-xs text-muted-foreground">
                  没有找到相关平台
                </li>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-0 px-4 pb-4 pt-3">
        <div className="flex items-center justify-between gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-muted-foreground"
                  aria-label={`打开${platform.title}日志目录`}
                  disabled={!connected || openingLogs}
                  onClick={() => void openLogs()}
                />
              }
            >
              <Folder className="size-4" />
              日志
            </TooltipTrigger>
            <TooltipContent>打开{platform.title}日志目录</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-muted-foreground"
                  aria-label="全局配置"
                  onClick={() => {
                    navigate(routePath(globalConfigRoute), {
                      state: {
                        returnRoute: route === globalConfigRoute ? platform.serviceRoute : route,
                      },
                    });
                    closeMobile();
                  }}
                />
              }
            >
              <Cog className="size-4" />
              设置
            </TooltipTrigger>
            <TooltipContent>全局配置</TooltipContent>
          </Tooltip>
          {connected ? (
            <AppUpdateControl />
          ) : (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2 text-muted-foreground"
                  />
                }
              >
                <Info className="size-4" />
                关于
              </PopoverTrigger>
              <PopoverContent side="top" align="end" className="w-60 p-4">
                <span className="font-semibold">AutoDrama</span>
                <span className="text-xs text-muted-foreground">请在桌面应用中连接平台服务。</span>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                className="mt-1 h-7 justify-between px-2 text-[11px] font-normal text-muted-foreground"
              />
            }
          >
            <span className="flex items-center gap-1.5">
              <CheckCircle className="size-3" />
              {connected
                ? errorCount
                  ? `${errorCount} 个平台异常`
                  : runningCount
                    ? `${runningCount} 个平台运行中`
                    : "所有平台待命"
                : "桌面服务未连接"}
            </span>
            <span>
              {entries[platform.id]?.result?.appVersion
                ? `v${entries[platform.id]?.result?.appVersion}`
                : "本地"}
            </span>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-64 p-4">
            <span className="font-medium">工作空间状态</span>
            <span className="text-xs text-muted-foreground">
              {platformNavigation.length} 个发布平台 · {runningCount} 个运行中
            </span>
            <span className="text-xs text-muted-foreground">
              {connected
                ? "运行状态每 3 秒同步，计时来自本次服务启动。"
                : "在桌面应用中启动服务后，可查看运行状态与时长。"}
            </span>
          </PopoverContent>
        </Popover>
      </SidebarFooter>
    </Sidebar>
  );
}
