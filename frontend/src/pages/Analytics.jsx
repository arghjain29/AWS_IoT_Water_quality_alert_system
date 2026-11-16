import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppData } from "@/components/DataProvider";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/States";
import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { api } from "@/lib/api";
import { PARAMETERS, shortStation, stationColor } from "@/lib/config";
import { downloadCsv, formatValue, paramLabel } from "@/lib/format";
import { usePolling } from "@/lib/usePolling";

const INK_MUTED = "#898781";
const GRID = "#e8e8e4";
const PERIODS = {
  daily: { label: "Daily (last 24 h, hourly)", granularity: "hour", seconds: 86400, bucketMs: 3600_000 },
  weekly: { label: "Weekly (last 7 days, daily)", granularity: "day", seconds: 7 * 86400, bucketMs: 86400_000 },
};
const axisProps = { stroke: INK_MUTED, tick: { fontSize: 11 }, tickLine: false };

export default function Analytics() {
  const { thresholds } = useAppData();
  const [period, setPeriod] = useState("daily");
  const [param, setParam] = useState("ph");
  const cfg = PERIODS[period];

  const trends = usePolling(() => {
    const to = new Date();
    return api.trends({ granularity: cfg.granularity, from: new Date(to - cfg.seconds * 1000).toISOString(), to: to.toISOString() });
  }, [period], 60_000);

  const data = trends.data;
  const series = useMemo(() => (data?.series ?? []).map((s) => ({
    key: s.deviceId, name: shortStation(s.deviceId), color: stationColor(s.deviceId),
    points: s.points.map((p) => ({ t: Date.parse(p.timestamp), value: p.avg[param] })),
  })), [data, param]);

  // abnormal readings per time bucket, all stations together. Every bucket in the
  // period is included (zeros where nothing happened) so the time axis is honest.
  const abnormalOverTime = useMemo(() => {
    if (!data) return [];
    const size = cfg.bucketMs;
    const byT = new Map();
    const first = Math.floor(Date.parse(data.from) / size) * size;
    for (let t = first; t <= Date.parse(data.to); t += size) byT.set(t, { t, Warning: 0, Critical: 0 });
    for (const s of data.series) {
      for (const p of s.points) {
        const row = byT.get(Date.parse(p.timestamp));
        if (!row) continue;
        row.Warning += p.warningCount;
        row.Critical += p.criticalCount;
      }
    }
    return [...byT.values()];
  }, [data, cfg.bucketMs]);

  const comparison = (data?.comparison ?? []).map((c) => ({ ...c, short: shortStation(c.deviceId), ratePct: Number((c.abnormalRate * 100).toFixed(1)) }));
  const byParam = PARAMETERS.map((p) => ({ param: paramLabel(p), count: data?.abnormalByParameter?.[p] ?? 0 }));
  const totalReadings = comparison.reduce((a, c) => a + c.readingCount, 0);

  const fmtBucket = (v) => (cfg.granularity === "hour"
    ? new Date(v).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

  const exportCsv = () => {
    const rows = (data?.series ?? []).flatMap((s) => s.points.map((p) => ({ deviceId: s.deviceId, ...p })));
    downloadCsv(`trends-${period}-${new Date().toISOString().slice(0, 10)}.csv`, [
      { header: "deviceId", value: (r) => r.deviceId },
      { header: "bucketStart", value: (r) => r.timestamp },
      { header: "readings", value: (r) => r.count },
      ...PARAMETERS.map((p) => ({ header: `avg_${p}`, value: (r) => r.avg[p] })),
      { header: "warningReadings", value: (r) => r.warningCount },
      { header: "criticalReadings", value: (r) => r.criticalCount },
    ], rows);
  };

  return (
    <>
      <PageHeader title="Analytics" description="Trends and comparisons from the hourly and daily totals computed in the cloud.">
        <Tabs value={period} onValueChange={setPeriod}>
          <TabsList>{Object.entries(PERIODS).map(([k, v]) => <TabsTrigger key={k} value={k}>{v.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data}><Download /> CSV</Button>
      </PageHeader>

      {trends.error && <ErrorState error={trends.error} onRetry={trends.refresh} />}
      {!data && !trends.error && <LoadingBlock rows={3} height="h-64" />}
      {data && totalReadings === 0 && (
        <EmptyState title="No readings in this period yet">Run the simulator for a while; trends are built from the hourly totals.</EmptyState>
      )}

      {data && totalReadings > 0 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Parameter trend by station</CardTitle>
              <CardDescription>{cfg.granularity === "hour" ? "Hourly" : "Daily"} average of {paramLabel(param)}</CardDescription>
              <CardAction>
                <Tabs value={param} onValueChange={setParam}>
                  <TabsList>{PARAMETERS.map((p) => <TabsTrigger key={p} value={p}>{paramLabel(p)}</TabsTrigger>)}</TabsList>
                </Tabs>
              </CardAction>
            </CardHeader>
            <CardContent>
              <TimeSeriesChart param={param} thresholds={thresholds} series={series} bucketMs={cfg.bucketMs} showDate height={300} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Abnormal readings over time</CardTitle>
                <CardDescription>All stations, per {cfg.granularity}</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={abnormalOverTime} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="t" tickFormatter={fmtBucket} {...axisProps} axisLine={{ stroke: GRID }} minTickGap={24} />
                    <YAxis allowDecimals={false} {...axisProps} axisLine={false} width={40} />
                    <Tooltip labelFormatter={(v) => new Date(v).toLocaleString()} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Warning" stackId="a" fill="#fab219" stroke="#fff" strokeWidth={1} isAnimationActive={false} />
                    <Bar dataKey="Critical" stackId="a" fill="#d03b3b" stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Abnormal readings by parameter</CardTitle>
                <CardDescription>Which sensor triggered most often</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byParam} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" allowDecimals={false} {...axisProps} axisLine={false} />
                    <YAxis type="category" dataKey="param" {...axisProps} axisLine={{ stroke: GRID }} width={90} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v) => [v, "abnormal readings"]} />
                    <Bar dataKey="count" fill="#1f6bc4" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false}
                      label={{ position: "right", fontSize: 11, fill: "#52514e" }} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Station comparison</CardTitle>
              <CardDescription>Share of readings outside limits, and average values over the period</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={comparison} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" unit="%" {...axisProps} axisLine={false} domain={[0, (max) => Math.max(10, Math.ceil(max / 10) * 10)]} />
                    <YAxis type="category" dataKey="short" {...axisProps} axisLine={{ stroke: GRID }} width={80} />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v) => [`${v}%`, "abnormal"]} />
                    <Bar dataKey="ratePct" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false}
                      label={{ position: "right", fontSize: 11, fill: "#52514e", formatter: (v) => `${v}%` }}>
                      {comparison.map((c) => <Cell key={c.deviceId} fill={stationColor(c.deviceId)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Station</TableHead><TableHead className="text-right">Readings</TableHead>
                      {PARAMETERS.map((p) => <TableHead key={p} className="text-right">Avg {paramLabel(p)}</TableHead>)}
                      <TableHead className="text-right">Warn</TableHead><TableHead className="text-right">Crit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {comparison.map((c) => (
                      <TableRow key={c.deviceId}>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            <span className="size-2.5 rounded-full" style={{ background: stationColor(c.deviceId) }} aria-hidden />{c.name}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular">{c.readingCount.toLocaleString()}</TableCell>
                        {PARAMETERS.map((p) => <TableCell key={p} className="text-right tabular">{formatValue(p, c.avg[p], false)}</TableCell>)}
                        <TableCell className="text-right tabular">{c.warningCount}</TableCell>
                        <TableCell className="text-right tabular">{c.criticalCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
