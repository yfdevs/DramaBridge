import { Badge } from "@/components/ui/badge";

export function AccountEnabledTag({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      variant={enabled ? "secondary" : "destructive"}
      className={enabled ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : undefined}
      title={enabled ? "启用" : "禁用，请先在后台启用"}
    >
      {enabled ? "启用" : "禁用"}
    </Badge>
  );
}
