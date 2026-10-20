import { WorkspaceActionHost } from "@/components/workspace-toolbar";
import { NavLink, useLocation } from "react-router-dom";
import {
  defaultRoute,
  globalConfigRoute,
  isAppRoute,
  navigationGroups,
  platformForPath,
  routePath,
} from "@/config/navigation";
import { cn } from "@/lib/utils";

export function AppWorkspaceHeader() {
  const location = useLocation();
  const path = location.pathname.replace(/^\/+/, "");
  const route = isAppRoute(path) ? path : defaultRoute;
  const platform = platformForPath(route);
  const pages = navigationGroups.find((group) => group.title === platform.title)?.items ?? [];
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
      {route !== globalConfigRoute && (
        <nav aria-label="当前平台页面" className="flex shrink-0 items-center gap-0.5">
          {pages.map((page) => (
            <NavLink
              key={page.route}
              to={routePath(page.route)}
              className={({ isActive }) =>
                cn(
                  "inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  isActive && "bg-muted/70 text-foreground",
                )
              }
            >
              {page.title}
            </NavLink>
          ))}
        </nav>
      )}
      <WorkspaceActionHost />
    </header>
  );
}
