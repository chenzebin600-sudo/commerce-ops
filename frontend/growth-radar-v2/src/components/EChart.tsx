import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import {
  BarChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
} from "echarts/charts";
import {
  AriaComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
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
  MarkLineComponent,
  PieChart,
  ScatterChart,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

interface EChartProps {
  option: EChartsOption;
  ariaLabel: string;
  className?: string;
  onPointClick?: (params: unknown) => void;
}

export function EChart({
  option,
  ariaLabel,
  className = "",
  onPointClick,
}: EChartProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!elementRef.current) return;

    const element = elementRef.current;
    element.replaceChildren();
    const chart = echarts.init(element, undefined, {
      renderer: "canvas",
    });
    const observer = new ResizeObserver(() => {
      if (!chart.isDisposed()) {
        chart.resize();
      }
    });
    observer.observe(elementRef.current);
    chartRef.current = chart;

    return () => {
      observer.disconnect();
      chartRef.current = null;
      if (!chart.isDisposed()) {
        chart.dispose();
      }
      element.replaceChildren();
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
      if (!chart.isDisposed()) {
        chart.off("click", onPointClick);
      }
    };
  }, [onPointClick]);

  return (
    <div
      ref={elementRef}
      className={`chart-canvas ${className}`}
      role="img"
      aria-label={ariaLabel}
    />
  );
}
