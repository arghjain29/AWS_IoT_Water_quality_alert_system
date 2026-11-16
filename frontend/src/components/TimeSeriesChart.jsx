// Line chart for one sensor parameter over time, one line per series (station).
//  - normal range drawn as a faint green band, critical limits as dashed red lines
//  - abnormal points get a red marker (with a white ring)
//  - crosshair tooltip, legend, and a Table tab so nothing relies on color alone
import { useMemo, useState } from "react";
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { classify } from "@/components/SensorValue";
import { formatTime, formatValue, paramLabel, paramUnit } from "@/lib/format";

const INK_MUTED = "#898781";
const GRID = "#e8e8e4";

// series: [{ key, name, color, points: [{ t: epochMs, value }] }]
// Points from different series are aligned on `bucketMs` slots so the tooltip lines up.
export function TimeSeriesChart({ param, series, thresholds, bucketMs = 5000, height = 260, showDate = false, emptyText = "No readings in this time range." }) {
  const [view, setView] = useState("chart");
  const t = thresholds?.[param];

  const rows = useMemo(() => {
    const byT = new Map();
    for (const s of series) {
      for (const p of s.points) {
        const slot = Math.round(p.t / bucketMs) * bucketMs;
        const row = byT.get(slot) ?? { t: slot };
        row[s.key] = p.value;
        byT.set(slot, row);
      }
    }
    const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
    // Stations publish a second or two apart, so a slot can miss one station.
    // Fill those tiny holes from the neighbouring slot; real gaps (simulator off,
    // station disconnected) stay empty so the line visibly breaks.
    for (const s of series) {
      for (let i = 1; i < sorted.length - 1; i++) {
        const row = sorted[i];
        if (row[s.key] !== undefined) continue;
        const prev = sorted[i - 1];
        const next = sorted[i + 1];
        if (prev[s.key] !== undefined && next[s.key] !== undefined && next.t - prev.t <= 2 * bucketMs) {
          row[s.key] = prev[s.key];
        }
      }
    }
    // Where no station reported for over 3 intervals, add an empty row so lines break there.
    const withGaps = [];
    for (const row of sorted) {
      const prev = withGaps[withGaps.length - 1];
      if (prev && row.t - prev.t > 3 * bucketMs) withGaps.push({ t: prev.t + bucketMs });
      withGaps.push(row);
    }
    return withGaps;
  }, [series, bucketMs]);

  const domain = useMemo(() => {
    const values = rows.flatMap((r) => series.map((s) => r[s.key]).filter((v) => typeof v === "number"));
    if (!values.length) return ["auto", "auto"];
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (t) { lo = Math.min(lo, t.normal.min); hi = Math.max(hi, t.normal.max); }
    const pad = (hi - lo) * 0.08 || 1;
    return [Math.max(t?.validRange?.min ?? -Infinity, lo - pad), hi + pad];
  }, [rows, series, t]);

  if (!rows.length) {
    return <div className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground" style={{ height }}>{emptyText}</div>;
  }

  const fmtTick = (v) => (showDate
    ? new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })
    : new Date(v).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));

  // Averaged (hourly/daily) charts have few points, so draw every point; raw charts only mark abnormal ones.
  const showPoints = bucketMs >= 3600_000;
  const abnormalDot = (color) => (props) => {
    const { cx, cy, value, index } = props;
    if (cx === undefined || cy === undefined || value === undefined || value === null) return <g key={index} />;
    if (classify(param, value, thresholds) === "NORMAL") {
      return showPoints ? <circle key={index} cx={cx} cy={cy} r={3} fill={color} stroke="#fff" strokeWidth={1.5} /> : <g key={index} />;
    }
    const critical = classify(param, value, thresholds) === "CRITICAL";
    return <circle key={index} cx={cx} cy={cy} r={4} fill={critical ? "#d03b3b" : "#fab219"} stroke="#fff" strokeWidth={2} aria-label="abnormal reading" data-series-color={color} />;
  };

  return (
    <div className="grid gap-2">
      <div className="flex justify-end">
        <Tabs value={view} onValueChange={setView}>
          <TabsList className="h-8">
            <TabsTrigger value="chart" className="text-xs">Chart</TabsTrigger>
            <TabsTrigger value="table" className="text-xs">Table</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {view === "chart" ? (
        <div style={{ height }} role="img" aria-label={`${paramLabel(param)} over time`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              {t && <ReferenceArea y1={t.normal.min} y2={t.normal.max} fill="#0ca30c" fillOpacity={0.06} ifOverflow="hidden" />}
              {t?.critical.min !== null && t?.critical.min !== undefined && (
                <ReferenceLine y={t.critical.min} stroke="#d03b3b" strokeDasharray="4 4" ifOverflow="hidden" />)}
              {t?.critical.max !== null && t?.critical.max !== undefined && (
                <ReferenceLine y={t.critical.max} stroke="#d03b3b" strokeDasharray="4 4" ifOverflow="hidden" />)}
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={fmtTick}
                stroke={INK_MUTED} tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={40} />
              <YAxis domain={domain} stroke={INK_MUTED} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48}
                tickFormatter={(v) => formatValue(param, v, false)}
                label={paramUnit(param) ? { value: paramUnit(param), angle: -90, position: "insideLeft", fontSize: 11, fill: INK_MUTED } : undefined} />
              <Tooltip
                cursor={{ stroke: INK_MUTED, strokeDasharray: "3 3" }}
                labelFormatter={(v) => formatTime(new Date(v).toISOString(), true)}
                formatter={(value, name) => [formatValue(param, value), name]}
                contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: GRID }}
              />
              {series.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, paddingTop: 4 }} />}
              {series.map((s) => (
                <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} isAnimationActive={false}
                  connectNulls={false} dot={abnormalDot(s.color)} activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="overflow-auto rounded-md border" style={{ maxHeight: height }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                {series.map((s) => <TableHead key={s.key} className="text-right">{s.name}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.filter((r) => series.some((s) => r[s.key] !== undefined)).reverse().map((r) => (
                <TableRow key={r.t}>
                  <TableCell className="tabular">{formatTime(new Date(r.t).toISOString(), showDate)}</TableCell>
                  {series.map((s) => {
                    const level = classify(param, r[s.key], thresholds);
                    return (
                      <TableCell key={s.key} className={`text-right tabular ${level === "CRITICAL" ? "font-semibold text-status-critical-ink" : level === "WARNING" ? "font-semibold text-status-warning-ink" : ""}`}>
                        {formatValue(param, r[s.key])}{level !== "NORMAL" && ` (${level.toLowerCase()})`}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {t && (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-status-normal/20" />Normal range {formatValue(param, t.normal.min, false)}–{formatValue(param, t.normal.max)}</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed border-status-critical" />Critical limit</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-status-critical" />Abnormal reading</span>
        </p>
      )}
    </div>
  );
}
