import { useCallback, useEffect, useState } from "react";
import { useNotification } from "@/hooks/use-notification";
import { useWorkspacePageActive } from "@/components/workspace-toolbar";
import {
  youtubeService,
  type YoutubeStatus,
  type YoutubeEnvironment,
  type YoutubeTask,
  type YoutubeAccount,
  type YoutubeOauth,
} from "@/platforms/youtube-drama/service";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function useYoutubeRuntime() {
  const active = useWorkspacePageActive();
  const [status, setStatus] = useState<YoutubeStatus>({
    running: false,
    starting: false,
    installing: false,
    logDir: "",
  });
  const [environment, setEnvironment] = useState<YoutubeEnvironment | null>(null);
  const [tasks, setTasks] = useState<YoutubeTask[]>([]);
  const [accounts, setAccounts] = useState<YoutubeAccount[]>([]);
  const [oauth, setOauth] = useState<YoutubeOauth | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  useNotification(error || status.error, "error", "操作失败", active);
  useNotification(notice, "success", undefined, active);
  useNotification(oauth?.status === "error" ? oauth.message || "授权失败" : "", "error", "Google 授权失败", active);
  useNotification(oauth?.status === "success" ? "账号授权已完成" : "", "success", undefined, active);
  const refresh = useCallback(async () => {
    try {
      const next = await youtubeService.status();
      setStatus(next);
      const [taskData, accountData, env, authorization] = await Promise.all([
        youtubeService.request<{ tasks: YoutubeTask[]; settings: { paused: boolean } }>(
          "/api/tasks",
        ),
        youtubeService.request<{ accounts: YoutubeAccount[] }>("/api/accounts"),
        next.running ? youtubeService.request<YoutubeEnvironment>("/api/environment") : Promise.resolve(null),
        next.running ? youtubeService.request<YoutubeOauth>("/api/oauth/status") : Promise.resolve(null),
      ]);
      setTasks(taskData.tasks);
      setPaused(taskData.settings.paused);
      setAccounts(accountData.accounts);
      setEnvironment(env);
      setOauth(authorization);
      setError("");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (polling || disposed) return;
      polling = true;
      try {
        await refresh();
      } catch (e) {
        if (!disposed) setError(errorText(e));
      } finally {
        polling = false;
      }
    };
    void poll();
    window.addEventListener("youtube:tasks-changed", poll);
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      disposed = true;
      window.removeEventListener("youtube:tasks-changed", poll);
      clearInterval(timer);
    };
  }, [refresh, active]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || status.starting || status.installing;
  return {
    status,
    loading,
    environment,
    tasks,
    accounts,
    oauth,
    paused,
    busy,
    locked,
    error,
    notice,
    run,
    refresh,
    setNotice,
  };
}
export type YoutubeModel = ReturnType<typeof useYoutubeRuntime>;
