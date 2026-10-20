import { lazy, Suspense } from "react";
import { useWorkspacePageActive } from "@/components/workspace-toolbar";
import type { TaskAnalyticsPlatform } from "@/platforms/task-analytics/service";

const TaskStatisticsChart = lazy(() =>
  import("./task-statistics-chart").then((module) => ({ default: module.TaskStatisticsChart })),
);

export function TaskStatisticsPage({ platform }: { platform: TaskAnalyticsPlatform }) {
  const active = useWorkspacePageActive();
  if (!active) return null;
  return (
    <main className="min-h-full px-6 py-6">
      <Suspense fallback={<p className="text-xs text-muted-foreground">正在加载发布统计…</p>}>
        <TaskStatisticsChart platform={platform} />
      </Suspense>
    </main>
  );
}
