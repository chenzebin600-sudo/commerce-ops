import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  AriaComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption, EChartsType } from "echarts";

echarts.use([
  AriaComponent,
  BarChart,
  DatasetComponent,
  GridComponent,
  HeatmapChart,
  LegendComponent,
  LineChart,
  ScatterChart,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
]);

export function EChart({
  option,
  ariaLabel,
  className = "",
  onPointClick
}: {
  option: EChartsOption;
  ariaLabel: string;
  className?: string;
  onPointClick?: (params: unknown) => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!elementRef.current) return;
    const element = elementRef.current;
    const chart = echarts.init(element, undefined, { renderer: "canvas" });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    chartRef.current = chart;
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onPointClick) return;
    chart.on("click", onPointClick);
    return () => {
      chart.off("click", onPointClick);
    };
  }, [onPointClick]);

  return <div ref={elementRef} className={`chart ${className}`} role="img" aria-label={ariaLabel} />;
}
