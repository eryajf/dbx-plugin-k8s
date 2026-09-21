"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

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
  networkUsageQuery,
  nodeNetworkUsageQuery,
  PodQueryContext,
} from "./monitoring-chart-queries";
import {
  buildMonitoringSeries,
  MonitoringSeries,
} from "./monitoring-chart-series";

interface NetworkUsageChartProps {
  networkIn: UsageDataPoint[];
  networkOut: UsageDataPoint[];
  isLoading?: boolean;
  error?: Error | null;
  syncId?: string;
  scope?: "node" | "pod";
  queryContext?: PodQueryContext;
  nodeName?: string;
}

// Format bytes to human readable format
const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0";

  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const value = bytes / Math.pow(k, i);
  return value >= 10
    ? Math.round(value) + sizes[i]
    : value.toFixed(1) + sizes[i];
};

const NETWORK_OUTBOUND_COLORS = [
  "hsl(202 78% 42%)",
  "hsl(214 72% 52%)",
  "hsl(192 68% 35%)",
  "hsl(226 62% 56%)",
];
const NETWORK_INBOUND_COLORS = [
  "hsl(174 72% 38%)",
  "hsl(158 65% 44%)",
  "hsl(185 62% 46%)",
  "hsl(142 58% 42%)",
];

const NetworkUsageChart = React.memo((prop: NetworkUsageChartProps) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const {
    networkIn,
    networkOut,
    isLoading,
    error,
    syncId,
    scope = "pod",
    queryContext,
    nodeName,
  } = prop;
  const isNodeScope = scope === "node";
  const description = isNodeScope
    ? t("monitoring.nodeNetworkUsageDescription")
    : t("monitoring.networkUsageDescription");
  const query = isNodeScope
    ? nodeNetworkUsageQuery(nodeName)
    : networkUsageQuery(queryContext);
  const { series: incoming, points: incomingPoints } = React.useMemo(
    () => buildMonitoringSeries(networkIn || []),
    [networkIn],
  );
  const { series: outgoing, points: outgoingPoints } = React.useMemo(
    () => buildMonitoringSeries(networkOut || []),
    [networkOut],
  );
  const chartSeries = React.useMemo<MonitoringSeries[]>(
    () => [
      ...outgoing.map((series, index) => ({
        ...series,
        key: `out:${series.key}`,
        label: `${series.label} / ${t("charts.outgoing")}`,
        color: NETWORK_OUTBOUND_COLORS[index % NETWORK_OUTBOUND_COLORS.length],
      })),
      ...incoming.map((series, index) => ({
        ...series,
        key: `in:${series.key}`,
        label: `${series.label} / ${t("charts.incoming")}`,
        color: NETWORK_INBOUND_COLORS[index % NETWORK_INBOUND_COLORS.length],
      })),
    ],
    [incoming, outgoing, t],
  );
  const chartConfig = React.useMemo(
    () =>
      Object.fromEntries(
        chartSeries.map((series) => [
          series.key,
          { label: series.label, color: series.color },
        ]),
      ) satisfies ChartConfig,
    [chartSeries],
  );
  const chartData = React.useMemo(() => {
    const points = new Map<number, Record<string, string | number>>();
    const addPoints = (items: typeof incomingPoints, prefix: string) => {
      for (const point of items) {
        const existing = points.get(point.time) || {
          timestamp: point.timestamp,
          time: point.time,
        };
        for (const [key, value] of Object.entries(point)) {
          if (key !== "timestamp" && key !== "time" && value !== undefined) {
            existing[`${prefix}:${key}`] = value;
          }
        }
        points.set(point.time, existing);
      }
    };
    addPoints(outgoingPoints, "out");
    addPoints(incomingPoints, "in");
    return Array.from(points.values()).sort(
      (a, b) => Number(a.time) - Number(b.time),
    );
  }, [incomingPoints, outgoingPoints]);

  const isSameDay = React.useMemo(() => {
    if (chartData.length < 2) return true;
    const first = new Date(chartData[0].timestamp);
    const last = new Date(chartData[chartData.length - 1].timestamp);
    return first.toDateString() === last.toDateString();
  }, [chartData]);

  // Show loading skeleton
  if (isLoading) {
    return (
      <Card className="@container/card">
        <MonitoringChartHeader
          title={t("monitoring.networkUsage")}
          description={description}
          query={query}
          loading
        />
        <CardContent className="px-2 sm:px-6">
          <div className="space-y-3">
            <Skeleton className="h-[250px] w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show error state
  if (error) {
    return (
      <Card className="@container/card">
        <MonitoringChartHeader
          title={t("monitoring.networkUsage")}
          description={description}
          query={query}
        />
        <CardContent className="px-2 sm:px-6">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // Show empty state
  if (
    !networkIn ||
    !networkOut ||
    (networkIn.length === 0 && networkOut.length === 0)
  ) {
    return (
      <Card className="@container/card">
        <MonitoringChartHeader
          title={t("monitoring.networkUsage")}
          description={description}
          query={query}
        />
        <CardContent className="px-2 sm:px-6">
          <div className="flex h-[250px] w-full items-center justify-center text-muted-foreground">
            <p>{t("charts.noNetworkUsageData")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const renderChart = (heightClass: string, synchronized = true) => (
    <>
      <ChartContainer
        config={chartConfig}
        className={`aspect-auto ${heightClass} w-full`}
      >
        <AreaChart data={chartData} syncId={synchronized ? syncId : undefined}>
          <CartesianGrid strokeDasharray="3 3" />
          <ReferenceLine y={0} stroke="#666" strokeDasharray="2 2" />
          <XAxis
            dataKey="timestamp"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            allowDataOverflow={true}
            tickFormatter={(value) => formatChartXTicks(value, isSameDay)}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(value) => formatBytes(Math.abs(value))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatDate(value)}
                valueFormatter={(value) => formatBytes(Math.abs(value))}
              />
            }
          />
          {chartSeries.map((series) => (
            <Area
              key={series.key}
              isAnimationActive={false}
              dataKey={series.key}
              name={series.label}
              type="monotone"
              fill={series.color}
              fillOpacity={chartSeries.length === 2 ? 0.25 : 0.06}
              stroke={series.color}
              strokeDasharray={series.key.startsWith("in:") ? "4 2" : undefined}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-foreground" />
          {t("charts.outgoing")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-foreground" />
          {t("charts.incoming")}
        </span>
      </div>
    </>
  );

  return (
    <>
      <Card className="@container/card">
        <MonitoringChartHeader
          title={t("monitoring.networkUsage")}
          description={description}
          query={query}
          onExpand={() => setIsExpanded(true)}
        />
        <CardContent className="px-2 sm:px-6">
          {renderChart("h-[250px]")}
        </CardContent>
      </Card>
      <MonitoringChartFullscreen
        open={isExpanded}
        onOpenChange={setIsExpanded}
        title={t("monitoring.networkUsage")}
      >
        {renderChart("h-full min-h-[420px]", false)}
      </MonitoringChartFullscreen>
    </>
  );
});

export default NetworkUsageChart;
