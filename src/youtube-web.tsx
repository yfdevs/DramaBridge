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
          <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b bg-background p-3">
            <span className="px-1 text-sm font-semibold">YouTube</span>
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
                    `rounded-lg px-3 py-1.5 text-xs ${isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
            <WorkspaceActionHost />
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
