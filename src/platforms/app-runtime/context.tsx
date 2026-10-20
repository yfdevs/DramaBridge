import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { platformNavigation, type PlatformId } from "@/config/navigation";
import { getAppPlatformRuntime, type AppPlatformRuntimeResult } from "./service";

type RuntimeEntry = { result?: AppPlatformRuntimeResult; error?: string };
const RuntimeContext = createContext<{
  entries: Partial<Record<PlatformId, RuntimeEntry>>;
  now: number;
}>({ entries: {}, now: Date.now() });

export function AppRuntimeProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Partial<Record<PlatformId, RuntimeEntry>>>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!window.ipcRenderer) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const results = await Promise.all(
        platformNavigation.map(async ({ id }) => {
          try {
            return [id, { result: await getAppPlatformRuntime(id) }] as const;
          } catch (error) {
            return [id, { error: error instanceof Error ? error.message : String(error) }] as const;
          }
        }),
      );
      if (!disposed) setEntries(Object.fromEntries(results));
      inFlight = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    window.addEventListener("app:service-changed", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("app:service-changed", refresh);
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <RuntimeContext.Provider value={{ entries, now }}>{children}</RuntimeContext.Provider>;
}

export function useAppRuntime() {
  return useContext(RuntimeContext);
}

export function formatRuntimeDuration(startedAt: number | null | undefined, now: number) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours > 0
    ? `${hours}时${String(minutes).padStart(2, "0")}分`
    : `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
}
