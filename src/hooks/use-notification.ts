import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/notifications";

/** Announce changed feedback once, rather than repeating it on every poll. */
export function useNotification(
  message: string | null | undefined,
  type: "error" | "success" | "warning" | "info" = "error",
  title?: string,
  active = true,
) {
  const previous = useRef("");
  useEffect(() => {
    if (!active) return;
    const key = message ? JSON.stringify([type, title, message]) : "";
    if (key === previous.current) return;
    previous.current = key;
    if (message) toast[type](title || message, title ? { description: message } : undefined);
  }, [message, type, title, active]);
}
