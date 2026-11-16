// One sensor reading with its normal range, flagged when outside the thresholds.
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { formatValue, paramLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export function classify(param, value, thresholds) {
  const t = thresholds?.[param];
  if (!t || value === null || value === undefined) return "NORMAL";
  if ((t.critical.min !== null && value < t.critical.min) || (t.critical.max !== null && value > t.critical.max)) return "CRITICAL";
  if (value < t.normal.min || value > t.normal.max) return "WARNING";
  return "NORMAL";
}

export function normalRangeText(param, thresholds) {
  const t = thresholds?.[param];
  if (!t) return "";
  return `${formatValue(param, t.normal.min, false)}–${formatValue(param, t.normal.max)}`;
}

export function SensorValue({ param, value, thresholds, size = "md", muted = false }) {
  const level = classify(param, value, thresholds);
  const Icon = level === "CRITICAL" ? OctagonAlert : level === "WARNING" ? TriangleAlert : null;
  return (
    <div className={cn(
      "rounded-md border px-3 py-2",
      level === "CRITICAL" && "border-status-critical/40 bg-status-critical/5",
      level === "WARNING" && "border-status-warning/50 bg-status-warning/10",
      muted && "opacity-60",
    )}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
        <span>{paramLabel(param)}</span>
        {Icon && (
          <span className={cn("inline-flex items-center gap-0.5 font-medium",
            level === "CRITICAL" ? "text-status-critical-ink" : "text-status-warning-ink")}>
            <Icon className="size-3.5" aria-hidden />{level === "CRITICAL" ? "Critical" : "Warning"}
          </span>
        )}
      </div>
      <p className={cn("font-semibold tabular", size === "lg" ? "text-2xl" : "text-lg")}>{formatValue(param, value)}</p>
      {thresholds && <p className="text-xs text-muted-foreground">Normal {normalRangeText(param, thresholds)}</p>}
    </div>
  );
}
