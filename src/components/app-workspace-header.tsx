import { WorkspaceActionHost } from "@/components/workspace-toolbar";
import { NavLink, useLocation } from "react-router-dom";
import {
  defaultRoute,
  isAppRoute,
  navigationGroups,
  platformForPath,
  routePath,
  toolNavigation,
} from "@/config/navigation";
import { cn } from "@/lib/utils";

export function AppWorkspaceHeader() {
  const location = useLocation();
  const path = location.pathname.replace(/^\/+/, "");
  const route = isAppRoute(path) ? path : defaultRoute;
  const platform = platformForPath(route);
  const pages = navigationGroups.find((group) => group.title === platform.title)?.items ?? [];
  const tool = toolNavigation.find((item) => item.route === route);
  if (route === "app/updates") return null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
      {route === "app/config" && <h1 className="text-sm font-semibold">全局配置</h1>}
      {tool && route !== "tools/video-separation" && <h1 className="px-2 text-sm font-medium">{tool.title}</h1>}
      {!route.startsWith("app/") && !tool && (
        <nav aria-label="当前平台页面" className="flex shrink-0 items-center gap-0.5">
          {pages.map((page) => (
            <NavLink
              key={page.route}
              to={routePath(page.route)}
              className={({ isActive }) =>
                cn(
                  "inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  isActive && "bg-foreground/5 text-foreground hover:bg-foreground/5",
                )
              }
            >
              {page.title}
            </NavLink>
          ))}
        </nav>
      )}
      <WorkspaceActionHost fullWidth={route === "tools/video-separation"} />
    </header>
  );
}
