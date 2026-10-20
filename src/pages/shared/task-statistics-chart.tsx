import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

import {
  getTaskAnalytics,
  type TaskAnalyticsPlatform,
  type TaskAnalyticsResult,
} from "@/platforms/task-analytics/service";

echarts.use([
  BarChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const EMPTY_RESULT: TaskAnalyticsResult = { days: [] };

function shortDate(value: string) {
  const [, month, day] = value.split("-");
  return `${month}/${day}`;
}

export function TaskStatisticsChart({ platform }: { platform: TaskAnalyticsPlatform }) {
  const chartElementRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<TaskAnalyticsResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const nextResult = await getTaskAnalytics(platform, 30);
        if (active) setResult(nextResult);
      } catch (error) {
        if (active) {
          setResult({
            days: [],
            unavailableReason: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    const refreshInterval = window.setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      window.clearInterval(refreshInterval);
    };
  }, [platform]);

  const hasData = useMemo(
    () => result.days.some((day) => day.succeeded || day.failed),
    [result.days],
  );

  useEffect(() => {
    const element = chartElementRef.current;
    if (!element || loading || result.unavailableReason || !hasData) return;

    const dark = document.documentElement.classList.contains("dark");
    const ink = dark ? "#fafafa" : "#18181b";
    const muted = dark ? "#a1a1aa" : "#71717a";
    const hairline = dark ? "#3f3f46" : "#e4e4e7";
    const splitLine = dark ? "#27272a" : "#f4f4f5";
    const warning = dark ? "#fbbf24" : "#f5a623";
    const option: echarts.EChartsCoreOption = {
      animationDuration: 600,
      animationEasing: "cubicOut",
      color: [ink, warning],
      title: {
        text: "近30天上传统计",
        left: 0,
        top: 0,
        textStyle: {
          color: ink,
          fontFamily: "Geist Variable, sans-serif",
          fontSize: 14,
          fontWeight: 600,
        },
      },
      legend: {
        top: 2,
        right: 0,
        icon: "roundRect",
        itemHeight: 8,
        itemWidth: 8,
        itemGap: 16,
        textStyle: { color: muted, fontSize: 11 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "shadow",
          shadowStyle: { color: dark ? "rgba(250,250,250,0.06)" : "rgba(24,24,27,0.05)" },
        },
        backgroundColor: dark ? "#27272a" : "#ffffff",
        borderColor: hairline,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: ink, fontSize: 11 },
        extraCssText: "border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.12);",
      },
      grid: { left: 4, right: 4, top: 44, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: result.days.map((day) => shortDate(day.date)),
        axisLine: { lineStyle: { color: hairline } },
        axisTick: { show: false },
        axisLabel: {
          color: muted,
          fontSize: 10,
          interval: 4,
          margin: 10,
        },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { color: muted, fontSize: 10 },
        splitLine: { lineStyle: { color: splitLine, type: [4, 4] } },
      },
      series: [
        {
          name: "成功任务",
          type: "bar",
          barMaxWidth: 12,
          barGap: "40%",
          data: result.days.map((day) => day.succeeded),
          itemStyle: { borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { opacity: 0.75 } },
        },
        {
          name: "失败任务",
          type: "bar",
          barMaxWidth: 12,
          data: result.days.map((day) => day.failed),
          itemStyle: { borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { opacity: 0.75 } },
        },
      ],
    };

    let chart: echarts.ECharts | null = null;
    const renderChart = () => {
      if (element.clientWidth <= 0 || element.clientHeight <= 0) return;
      chart ??= echarts.init(element, undefined, { renderer: "canvas" });
      chart.setOption(option);
      chart.resize();
    };
    const resizeObserver = new ResizeObserver(() => renderChart());
    resizeObserver.observe(element);
    const animationFrame = window.requestAnimationFrame(renderChart);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      chart?.dispose();
    };
  }, [hasData, loading, result]);

  const stateText = result.unavailableReason
    ? "任务统计暂不可用，请检查桌面服务连接。"
    : loading
      ? "正在加载任务统计…"
      : !hasData
        ? "近30天暂无任务统计数据"
        : null;

  return (
    <section aria-label="近30天任务统计图" className="mt-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium">发布统计</h2>
        <span className="text-xs text-muted-foreground">最近 30 天</span>
      </div>
      {stateText ? (
        <div className="py-6 text-xs text-muted-foreground">{stateText}</div>
      ) : (
        <div
          ref={chartElementRef}
          className="h-56 w-full"
          role="img"
          aria-label="最近30天发布成功和失败数量"
        />
      )}
    </section>
  );
}
