import { NavLink, useLocation } from "react-router-dom";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  defaultRoute,
  globalConfigRoute,
  isAppRoute,
  navigationGroups,
  platformContextRoute,
  platformForPath,
  routePath,
} from "@/config/navigation";
import { cn } from "@/lib/utils";

export function AppWorkspaceHeader() {
  const location = useLocation();
  const path = location.pathname.replace(/^\/+/, "");
  const route = isAppRoute(path) ? path : defaultRoute;
  const platform = platformForPath(platformContextRoute(route, location.state));
  const pages = navigationGroups.find((group) => group.title === platform.title)?.items ?? [];
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-border/65 px-6 py-2">
      <div className="flex items-center gap-2">
        <SidebarTrigger aria-label="切换侧边栏" className="text-muted-foreground md:hidden" />
        <span className="text-[14px] font-semibold">
          {route === globalConfigRoute ? "全局配置" : platform.title}
        </span>
      </div>
      {route !== globalConfigRoute && (
        <nav className="flex gap-4" aria-label="当前平台页面">
          {pages.map((page) => (
            <NavLink
              key={page.route}
              to={routePath(page.route)}
              className={({ isActive }) =>
                cn(
                  "rounded py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  isActive && "font-medium text-foreground",
                )
              }
            >
              {page.title}
            </NavLink>
          ))}
        </nav>
      )}
      <SidebarTrigger
        aria-label="切换侧边栏"
        className="ml-auto hidden text-muted-foreground md:inline-flex"
      />
    </header>
  );
}
