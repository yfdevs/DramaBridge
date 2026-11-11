import { createRoot } from "react-dom/client";
import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import {
  WorkspaceToolbarProvider,
  WorkspaceActionHost,
  WorkspacePageActivity,
} from "@/components/workspace-toolbar";
import { YoutubeWorkspacePage } from "@/pages/youtube-drama/workspace";
import { YoutubeCreateTaskPage } from "@/pages/youtube-drama/create-task";
import { YoutubeAccountsPage } from "@/pages/youtube-drama/accounts";
import "./index.css";

export function YoutubeWebApp() {
  return (
    <HashRouter>
      <WorkspaceToolbarProvider>
        <div className="flex min-h-svh flex-col bg-background">
          <header className="sticky top-0 z-20 border-b bg-background">
            <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-sm font-semibold tracking-tight">
                  DramaBridge <span className="mx-2 font-normal text-muted-foreground">/</span>{" "}
                  YouTube
                </span>
                <nav aria-label="YouTube 页面" className="flex gap-1">
                  {[
                    ["service", "任务列表"],
                    ["create", "添加任务"],
                    ["accounts", "账号管理"],
                  ].map(([route, label]) => (
                    <NavLink
                      key={route}
                      to={`/youtube-drama/${route}`}
                      className={({ isActive }) =>
                        `rounded-md px-3 py-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`
                      }
                    >
                      {label}
                    </NavLink>
                  ))}
                </nav>
              </div>
              <WorkspaceActionHost />
            </div>
          </header>
          <WorkspacePageActivity active>
            <Routes>
              <Route path="/youtube-drama/service" element={<YoutubeWorkspacePage />} />
              <Route path="/youtube-drama/create" element={<YoutubeCreateTaskPage />} />
              <Route path="/youtube-drama/accounts" element={<YoutubeAccountsPage />} />
              <Route path="*" element={<Navigate to="/youtube-drama/service" replace />} />
            </Routes>
          </WorkspacePageActivity>
        </div>
        <Toaster richColors />
      </WorkspaceToolbarProvider>
    </HashRouter>
  );
}
createRoot(document.getElementById("root")!).render(<YoutubeWebApp />);
