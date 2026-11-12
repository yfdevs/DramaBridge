import { Toaster as DingToaster, toast } from "@yusufceng1z/ding-react";
import { useEffect, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";

export { toast };

export function Toaster(props: ComponentProps<typeof DingToaster>) {
  const [host, setHost] = useState<HTMLElement>(() => document.body);
  useEffect(() => {
    const updateHost = () => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
        .reverse().find(element => !element.hasAttribute("data-closed") && !element.closest('[aria-hidden="true"]'));
      setHost(dialog ?? document.body);
    };
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  // Keep notifications inside the active modal's interaction and accessibility scope.
  // Ding's nested status/alert regions determine announcement priority.
  return createPortal(<div data-base-ui-portal="" aria-live="off" style={{ position: "fixed", inset: 0, zIndex: 2147483647, pointerEvents: "none" }}>
    <DingToaster position="bottom-right" {...props} labels={{ region: "通知", dismiss: "关闭通知", ...props.labels }} />
  </div>, host);
}
