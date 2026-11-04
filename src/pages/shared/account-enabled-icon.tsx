import { Ban, CheckCircle } from "@mynaui/icons-react";

export function AccountEnabledIcon({ enabled }: { enabled: boolean }) {
  const label = enabled ? "已启用" : "已停用，请先在后台启用";
  const Icon = enabled ? CheckCircle : Ban;
  return (
    <span className="inline-flex shrink-0" role="img" aria-label={label} title={label}>
      <Icon aria-hidden="true" className={`size-4 ${enabled ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} />
    </span>
  );
}
