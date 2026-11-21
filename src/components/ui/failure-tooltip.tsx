import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export function FailureTooltip({ reason, children }: { reason?: string | null; children: ReactNode }) {
  if (!reason?.trim()) return <>{children}</>;
  return <Tooltip>
    <TooltipTrigger render={<span tabIndex={0} className="inline-flex max-w-full items-center whitespace-nowrap rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />}>
      {children}
    </TooltipTrigger>
    <TooltipContent className="max-h-[50vh] max-w-[min(36rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {reason}
    </TooltipContent>
  </Tooltip>;
}
