import { createElement, Fragment, isValidElement, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { measureNaturalWidth, prepare } from "@chenglou/pretext";
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

// Measure with the same font engine used by the renderer. Cache per mounted text,
// not globally: a long-running task/log list must not retain every past message.
export function OverflowText({ as = "span", children, title, className = "", ...props }: Omit<ComponentProps<"button">, "ref"> & { as?: "span" | "div" | "p" | "button" }) {
  const ref = useRef<HTMLElement | null>(null);
  const full = plainText(children);
  const [display, setDisplay] = useState(full);
  const [focusable, setFocusable] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || full === undefined) return;
    let active = true;
    let fontKey = "";
    const widths = new Map<string, number>();
    const update = () => {
      if (!active) return;
      const style = getComputedStyle(element);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
      const key = `${font}:${letterSpacing}`;
      if (key !== fontKey) { widths.clear(); fontKey = key; }
      const measure = (text: string) => {
        if (!widths.has(text)) widths.set(text, measureNaturalWidth(prepare(text, font, {letterSpacing})));
        return widths.get(text)!;
      };
      const width = element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
      if (width <= 0) return;
      const normalized = full.replace(/\s+/g, " ");
      if (measure(normalized) <= width) { setDisplay(full); return; }
      // Keep grapheme clusters intact (Chinese, emoji sequences and combining marks).
      const Segmenter = (Intl as unknown as {Segmenter: new (locale?: string, options?: {granularity: string}) => {segment(text: string): Iterable<{segment: string}>}}).Segmenter;
      const chars = Segmenter ? Array.from(new Segmenter(undefined, {granularity:"grapheme"}).segment(normalized), part => part.segment) : Array.from(normalized);
      const candidate = (count: number) => chars.slice(0, Math.ceil(count / 2)).join("") + "..." + (count > 1 ? chars.slice(-Math.floor(count / 2)).join("") : "");
      let low = 0, high = Math.max(0, chars.length - 1);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (measure(candidate(mid)) <= width - 1) low = mid; else high = mid - 1;
      }
      setDisplay(candidate(low));
      setFocusable(!element.closest("button, a, [role=button]"));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const fontsChanged = () => { widths.clear(); update(); };
    void document.fonts.ready.then(fontsChanged);
    document.fonts.addEventListener("loadingdone", fontsChanged);
    return () => { active = false; observer.disconnect(); document.fonts.removeEventListener("loadingdone", fontsChanged); };
  }, [full]);
  const clipped = full !== undefined && display !== undefined && display !== full;
  const element = createElement(as, {
    ...props,
    ref,
    "data-slot": "overflow-text",
    className: `block min-w-0 overflow-hidden whitespace-nowrap ${className}`,
    tabIndex: props.tabIndex ?? (clipped && focusable ? 0 : undefined),
  }, clipped ? <><span aria-hidden="true">{display}</span><span className="sr-only">{full}</span></> : children);
  return <Tooltip disabled={!clipped}>
    <TooltipTrigger render={element} />
    {clipped && <TooltipContent className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{title || full}</TooltipContent>}
  </Tooltip>;
}
