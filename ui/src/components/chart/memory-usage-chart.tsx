"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { UsageDataPoint } from "@/types/api";
import { formatChartXTicks, formatDate } from "@/lib/utils";

import { Alert, AlertDescription } from "../ui/alert";
import { Card, CardContent } from "../ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "../ui/chart";
import { Skeleton } from "../ui/skeleton";

import { MonitoringChartHeader } from "./monitoring-chart-header";
import { MonitoringChartFullscreen } from "./monitoring-chart-fullscreen";
import {
  memoryAmountQuery,
  memoryUtilizationQuery,
  PodQueryContext,
} from "./monitoring-chart-queries";
import { buildMonitoringSeries } from "./monitoring-chart-series";

interface MemoryUsageChartProps {
  data: UsageDataPoint[];
  variant?: "amount" | "percentage";
  isLoading?: boolean;
  error?: Error | null;
  syncId?: string;
  queryContext?: PodQueryContext;
}

const MEMORY_AMOUNT_COLORS = [
  "hsl(151 66% 38%)",
  "hsl(166 68% 35%)",
  "hsl(142 58% 46%)",
  "hsl(180 62% 34%)",
];
const MEMORY_UTILIZATION_COLORS = [
  "hsl(275 67% 50%)",
  "hsl(308 65% 48%)",
  "hsl(252 62% 55%)",
  "hsl(330 62% 51%)",
];

const MemoryUsageChart = React.memo((prop: MemoryUsageChartProps) => {
  const { t } = useTranslation();
  const {
    data,
    variant = "amount",
    isLoading,
    error,
    syncId,
    queryContext,
  } = prop;
  const [isExpanded, setIsExpanded] = React.useState(false);
  const isUtilization = variant === "percentage";
  const title = isUtilization
    ? t("monitoring.memoryUtilization", "Memory Utilization")
    : t("monitoring.memoryAmount", "Memory Usage Amount");
  const description = isUtilization
    ? t("monitoring.memoryUtilizationDescription")
    : t("monitoring.memoryAmountDescription");
  const query = isUtilization
    ? memoryUtilizationQuery(queryContext)
    : memoryAmountQuery(queryContext);

  const { series: memorySeries, points: memoryChartData } = React.useMemo(
    () => buildMonitoringSeries(data || []),
    [data],
  );
  const displaySeries = React.useMemo(() => {
    const colors = isUtilization
      ? MEMORY_UTILIZATION_COLORS
      : MEMORY_AMOUNT_COLORS;
    return memorySeries.map((series, index) => ({
      ...series,
      color: colors[index % colors.length],
    }));
  }, [isUtilization, memorySeries]);

  const isSameDay = React.useMemo(() => {
    if (memoryChartData.length < 2) return true;
    const first = new Date(memoryChartData[0].timestamp);
    const last = new Date(
      memoryChartData[memoryChartData.length - 1].timestamp,
    );
    return first.toDateString() === last.toDateString();
  }, [memoryChartData]);

  const useGB = React.useMemo(() => {
    if (isUtilization || !memoryChartData.length) return false;
    return (
      Math.max(
        ...memoryChartData.flatMap((point) =>
          displaySeries.map((series) => Number(point[series.key] || 0)),
        ),
      ) > 900
    );
  }, [displaySeries, isUtilization, memoryChartData]);

  const processedMemoryChartData = React.useMemo(() => {
    if (!useGB) return memoryChartData;
    return memoryChartData.map((point) => ({
      ...point,
      ...Object.fromEntries(
        displaySeries.map((series) => {
          const value = point[series.key];
          return [series.key, typeof value === "number" ? value / 1024 : value];
        }),
      ),
    }));
  }, [displaySeries, memoryChartData, useGB]);

  const memoryChartConfig = React.useMemo(
    () =>
      Object.fromEntries(
        displaySeries.map((series) => [
          series.key,
          { label: series.label, color: series.color },
        ]),
      ) satisfies ChartConfig,
    [displaySeries],
  );

  if (isLoading) {
    return (
      <Card>
        <MonitoringChartHeader
          title={title}
          description={description}
          query={query}
          loading
        />
        <CardContent>
          <Skeleton className="h-[250px] w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <MonitoringChartHeader
          title={title}
          description={description}
          query={query}
        />
        <CardContent>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (processedMemoryChartData.length === 0) {
    return (
      <Card>
        <MonitoringChartHeader
          title={title}
          description={description}
          query={query}
        />
        <CardContent>
          <div className="flex h-[250px] w-full items-center justify-center text-muted-foreground">
            <p>
              {isUtilization
                ? t(
                    "charts.noMemoryUtilizationData",
                    "No memory utilization data available",
                  )
                : t("charts.noMemoryUsageData")}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const renderChart = (heightClass: string, synchronized = true) => (
    <ChartContainer
      config={memoryChartConfig}
      className={`${heightClass} w-full`}
    >
      <AreaChart
        data={processedMemoryChartData}
        syncId={synchronized ? syncId : undefined}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="timestamp"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={30}
          allowDataOverflow={true}
          tickFormatter={(value) => formatChartXTicks(value, isSameDay)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(value) =>
            isUtilization
              ? `${value.toFixed(1)}%`
              : `${value.toFixed(useGB ? 2 : 1)}${useGB ? "GB" : "MB"}`
          }
          domain={[0, (dataMax: number) => dataMax * 1.1]}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatDate(value)}
              valueFormatter={(value) =>
                isUtilization
                  ? `${value.toFixed(2)}%`
                  : `${value.toFixed(useGB ? 2 : 1)}${useGB ? "GB" : "MB"}`
              }
            />
          }
        />
        {displaySeries.map((series) => (
          <Area
            key={series.key}
            isAnimationActive={false}
            dataKey={series.key}
            name={series.label}
            type="monotone"
            fill={series.color}
            fillOpacity={displaySeries.length === 1 ? 0.35 : 0.08}
            stroke={series.color}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );

  return (
    <>
      <Card>
        <MonitoringChartHeader
          title={title}
          description={description}
          query={query}
          onExpand={() => setIsExpanded(true)}
        />
        <CardContent>{renderChart("h-[250px]")}</CardContent>
      </Card>
      <MonitoringChartFullscreen
        open={isExpanded}
        onOpenChange={setIsExpanded}
        title={title}
      >
        {renderChart("h-full min-h-[420px]", false)}
      </MonitoringChartFullscreen>
    </>
  );
});

export default MemoryUsageChart;
