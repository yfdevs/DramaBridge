import { createElement, Fragment, isValidElement, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

function plainText(value: ReactNode): string | undefined {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(plainText);
    return parts.some(part => part === undefined) ? undefined : parts.join("");
  }
  if (isValidElement<{children?: ReactNode}>(value) && value.type === Fragment) return plainText(value.props.children);
  return undefined;
}

export function OverflowText({ as = "span", children, title, className = "", ...props }: Omit<ComponentProps<"button">, "ref"> & { as?: "span" | "div" | "p" | "button" }) {
  const ref = useRef<HTMLElement | null>(null);
  const full = plainText(children);
  const [clipped, setClipped] = useState(false);
  const [focusable, setFocusable] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || full === undefined) return;
    let active = true;
    const update = () => {
      if (!active) return;
      setClipped(element.clientWidth > 0 && element.scrollWidth > element.clientWidth);
      setFocusable(!element.closest("button, a, [role=button]"));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const fontsChanged = () => update();
    void document.fonts.ready.then(fontsChanged);
    document.fonts.addEventListener("loadingdone", fontsChanged);
    return () => { active = false; observer.disconnect(); document.fonts.removeEventListener("loadingdone", fontsChanged); };
  }, [full]);
  const element = createElement(as, {
    ...props,
    ref,
    "data-slot": "overflow-text",
    className: `block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${className}`,
    tabIndex: props.tabIndex ?? (clipped && focusable ? 0 : undefined),
  }, children);
  return <Tooltip disabled={!clipped}>
    <TooltipTrigger render={element} />
    {clipped && <TooltipContent className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{title || full}</TooltipContent>}
  </Tooltip>;
}
