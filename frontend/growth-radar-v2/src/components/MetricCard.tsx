import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { MetricSummary } from "../types";

interface MetricCardProps {
  metric: MetricSummary;
  icon: LucideIcon;
  onSelect: (view: string) => void;
}

export function MetricCard({ metric, icon: Icon, onSelect }: MetricCardProps) {
  const hasDelta = typeof metric.delta === "number";
  const improving = (metric.delta ?? 0) >= 0;

  return (
    <button
      type="button"
      className="metric-card"
      data-tone={metric.tone}
      onClick={() => onSelect(metric.targetView)}
    >
      <span className="metric-card__icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.9} />
      </span>
      <span className="metric-card__content">
        <span className="metric-card__label">{metric.label}</span>
        <strong className="metric-card__value">{metric.value}</strong>
        <small>{metric.description}</small>
      </span>
      {hasDelta && (
        <span className={`metric-card__delta ${improving ? "is-up" : "is-down"}`}>
          {improving ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          较前日 {improving ? "+" : ""}
          {metric.delta}
        </span>
      )}
    </button>
  );
}
