import { cn } from "@/lib/utils";

export function CircularProgress({
  value,
  label,
  failed = false,
}: {
  value: number;
  label: string;
  failed?: boolean;
}) {
  const percent = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(percent)}
      className={cn("relative size-14 shrink-0", failed ? "text-destructive" : "text-primary")}
    >
      <svg viewBox="0 0 56 56" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r="24" fill="none" strokeWidth="4" className="stroke-muted" />
        <circle
          cx="28"
          cy="28"
          r="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - percent}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-medium tabular-nums">
        {Math.floor(percent)}%
      </span>
    </div>
  );
}
