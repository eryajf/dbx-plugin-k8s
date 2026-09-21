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
  cpuAmountQuery,
  cpuUtilizationQuery,
  PodQueryContext,
} from "./monitoring-chart-queries";
import { buildMonitoringSeries } from "./monitoring-chart-series";

interface CpuUsageChartProps {
  data: UsageDataPoint[];
  variant?: "amount" | "percentage";
  isLoading?: boolean;
  error?: Error | null;
  syncId?: string;
  queryContext?: PodQueryContext;
}

const CPU_AMOUNT_COLORS = [
  "hsl(215 78% 48%)",
  "hsl(195 76% 40%)",
  "hsl(230 65% 55%)",
  "hsl(205 72% 34%)",
];
const CPU_UTILIZATION_COLORS = [
  "hsl(28 85% 48%)",
  "hsl(12 78% 52%)",
  "hsl(42 82% 42%)",
  "hsl(350 68% 52%)",
];

const CPUUsageChart = React.memo((prop: CpuUsageChartProps) => {
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
    ? t("monitoring.cpuUtilization", "CPU Utilization")
    : t("monitoring.cpuAmount", "CPU Usage Amount");
  const description = isUtilization
    ? t("monitoring.cpuUtilizationDescription")
    : t("monitoring.cpuAmountDescription");
  const query = isUtilization
    ? cpuUtilizationQuery(queryContext)
    : cpuAmountQuery(queryContext);
  const { series: cpuSeries, points: cpuChartData } = React.useMemo(
    () => buildMonitoringSeries(data || []),
    [data],
  );
  const displaySeries = React.useMemo(() => {
    const colors = isUtilization ? CPU_UTILIZATION_COLORS : CPU_AMOUNT_COLORS;
    return cpuSeries.map((series, index) => ({
      ...series,
      color: colors[index % colors.length],
    }));
  }, [cpuSeries, isUtilization]);
  const cpuChartConfig = React.useMemo(
    () =>
      Object.fromEntries(
        displaySeries.map((series) => [
          series.key,
          { label: series.label, color: series.color },
        ]),
      ) satisfies ChartConfig,
    [displaySeries],
  );

  const isSameDay = React.useMemo(() => {
    if (cpuChartData.length < 2) return true;
    const first = new Date(cpuChartData[0].timestamp);
    const last = new Date(cpuChartData[cpuChartData.length - 1].timestamp);
    return first.toDateString() === last.toDateString();
  }, [cpuChartData]);

  if (isLoading) {
    return (
      <Card className="@container/card">
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
      <Card className="@container/card">
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

  if (cpuChartData.length === 0) {
    return (
      <Card className="@container/card">
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
                    "charts.noCpuUtilizationData",
                    "No CPU utilization data available",
                  )
                : t("charts.noCpuUsageData")}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const renderChart = (heightClass: string, synchronized = true) => (
    <ChartContainer config={cpuChartConfig} className={`${heightClass} w-full`}>
      <AreaChart data={cpuChartData} syncId={synchronized ? syncId : undefined}>
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
            isUtilization ? `${value.toFixed(1)}%` : value.toFixed(3)
          }
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatDate(value)}
              valueFormatter={(value) =>
                isUtilization ? `${value.toFixed(2)}%` : value.toFixed(3)
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
      <Card className="@container/card">
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

export default CPUUsageChart;
