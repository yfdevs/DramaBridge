import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkspaceActionHost, WorkspaceNavigationHost } from "@/components/workspace-toolbar";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  defaultRoute,
  isAppRoute,
  navigationGroups,
  platformForPath,
  routePath,
  toolNavigation,
} from "@/config/navigation";

export function AppWorkspaceHeader() {
  const location = useLocation();
  const path = location.pathname.replace(/^\/+/, "");
  const route = isAppRoute(path) ? path : defaultRoute;
  const platform = platformForPath(route);
  const pages = navigationGroups.find((group) => group.title === platform.title)?.items ?? [];
  const tool = toolNavigation.find((item) => item.route === route);
  if (route === "app/updates") return null;
  return (
    <header className={cn(
      "flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 font-workspace [&_[data-slot=button]]:text-xs [&_[data-slot=tabs-list][data-orientation=horizontal]]:h-7 [&_[data-slot=tabs-trigger]]:px-2 [&_[data-slot=tabs-trigger]]:text-xs",
      route === "app/config" ? "@container min-h-10 flex-wrap py-1" : "h-10",
    )}>
      {route === "app/config" && <h1 className="shrink-0 text-xs font-medium whitespace-nowrap">全局配置</h1>}
      {tool && route !== "tools/video-separation" && route !== "tools/jianying" && <h1 className="text-xs font-medium">{tool.title}</h1>}
      {!route.startsWith("app/") && !tool && (
        <Tabs value={route} className="shrink-0">
          <TabsList aria-label="当前平台页面" activateOnFocus={false}>
            {pages.map((page) => (
              <TabsTrigger
                key={page.route}
                value={page.route}
                nativeButton={false}
                render={<NavLink to={routePath(page.route)} />}
              >
                {page.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {(route === "tools/jianying" || route === "tools/video-separation") && <WorkspaceNavigationHost />}
      {route === "tools/video-separation" && <Separator orientation="vertical" className="mx-2 h-5 data-vertical:self-center" />}
      <WorkspaceActionHost fullWidth={route === "tools/video-separation"} />
    </header>
  );
}
