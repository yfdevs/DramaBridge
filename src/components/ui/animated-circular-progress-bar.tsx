// Adapted from Magic UI's Animated Circular Progress Bar (MIT).
// https://github.com/magicuidesign/magicui
import { cn } from "@/lib/utils";

export function AnimatedCircularProgressBar({
  value = 0, min = 0, max = 100, gaugePrimaryColor, gaugeSecondaryColor, className,
}: {
  value?: number | null;
  min?: number;
  max?: number;
  gaugePrimaryColor: string;
  gaugeSecondaryColor: string;
  className?: string;
}) {
  const known = value !== null && Number.isFinite(value) && max > min;
  const percent = known ? Math.round(Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))) : 0;
  const circumference = 2 * Math.PI * 45;
  return (
    <div role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={known ? percent : undefined} aria-valuetext={known ? `${percent}%` : "正在获取下载大小"}
      className={cn("relative size-24 shrink-0 text-xl font-semibold tabular-nums", className)}>
      <svg aria-hidden="true" fill="none" viewBox="0 0 100 100" className={cn("size-full", !known && "animate-spin motion-reduce:animate-none")}>
        <circle cx="50" cy="50" r="45" strokeWidth="10" stroke={gaugeSecondaryColor}
          strokeDasharray={`${circumference * (known ? Math.max(0, 90 - percent) : 65) / 100} ${circumference}`}
          strokeLinecap="round" transform="rotate(-108 50 50) scale(1 -1) translate(0 -100)"
          className="transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none" />
        <circle cx="50" cy="50" r="45" strokeWidth="10" stroke={gaugePrimaryColor}
          strokeDasharray={`${circumference * (known ? percent : 20) / 100} ${circumference}`}
          strokeLinecap="round" transform="rotate(-90 50 50)"
          className="transition-[stroke-dasharray,stroke] duration-700 ease-out motion-reduce:transition-none" />
      </svg>
      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">{known ? `${percent}%` : "—"}</span>
    </div>
  );
}
