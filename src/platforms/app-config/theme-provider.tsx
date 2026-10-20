import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { globalAppConfigService, onAppThemeChanged, type AppTheme } from "./service";

const ThemeContext = createContext<{ theme: AppTheme; resolvedTheme: "light" | "dark" }>({
  theme: "system",
  resolvedTheme: "light",
});

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<AppTheme>("system");
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let disposed = false;
    let changed = false;
    const unsubscribe = onAppThemeChanged((nextTheme) => {
      changed = true;
      if (!disposed) setTheme(nextTheme);
    });
    void globalAppConfigService
      .getTheme()
      .then((savedTheme) => {
        if (!disposed && !changed) setTheme(savedTheme);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  return <ThemeContext.Provider value={{ theme, resolvedTheme }}>{children}</ThemeContext.Provider>;
}

export function useAppTheme() {
  return useContext(ThemeContext);
}
