import { useEffect, useLayoutEffect, useState } from "react";

type WebTheme = "system" | "light" | "dark";
const THEME_STORAGE_KEY = "dramabridge.youtube-web.theme";

function parseTheme(value: string | null): WebTheme {
  return value === "light" || value === "dark" ? value : "system";
}

function storedTheme(): WebTheme {
  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function useYoutubeWebTheme() {
  const [theme, setTheme] = useState<WebTheme>(storedTheme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark = theme === "system" ? systemDark : theme === "dark";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) setTheme(parseTheme(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Restricted browser storage should not prevent changing the theme.
    }
  };

  return { dark, toggleTheme };
}
