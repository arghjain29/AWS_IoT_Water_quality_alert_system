import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppData } from "@/components/DataProvider";
import { PageHeader } from "@/components/PageHeader";
import { WaterStatusBadge } from "@/components/StatusBadge";
import { classify } from "@/components/SensorValue";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/States";
import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { PARAMETERS, shortStation, stationColor } from "@/lib/config";
import { downloadCsv, formatTime, formatValue, paramLabel } from "@/lib/format";
import { RANGES, bucketFor, loadHistory, seriesFor } from "@/lib/history";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";

// <input type="datetime-local"> works in local time without seconds
const toLocalInput = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export default function Monitoring() {
  const { summary, thresholds } = useAppData();
  const stations = summary.data?.stations ?? [];
  const [station, setStation] = useState("all");
  const [param, setParam] = useState("ph");
  const [range, setRange] = useState("1h");
  const [custom, setCustom] = useState(() => ({ from: toLocalInput(new Date(Date.now() - 3600_000)), to: toLocalInput(new Date()) }));
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);

  const ids = station === "all" ? stations.map((s) => s.deviceId) : [station];
  const isCustom = range === "custom";
  const customValid = isCustom && custom.from && custom.to && new Date(custom.from) < new Date(custom.to);

  const history = usePolling(() => {
    if (!ids.length) return Promise.resolve(null);
    if (isCustom) {
      if (!customValid) return Promise.reject(new Error("'From' must be before 'To'."));
      return loadHistory(ids, new Date(custom.from), new Date(custom.to));
    }
    const to = new Date();
    return loadHistory(ids, new Date(to - RANGES.find((r) => r.key === range).seconds * 1000), to);
  }, [ids.join(","), range, isCustom ? `${custom.from}|${custom.to}` : ""], isCustom ? 0 : 15_000);

  const meta = Object.fromEntries(stations.map((s) => [s.deviceId, { name: station === "all" ? shortStation(s.deviceId) : s.name, color: stationColor(s.deviceId) }]));
  const resolution = history.data?.resolution;

  // Flat list of readings for the table + CSV (newest first)
  const rows = useMemo(() => {
    if (!history.data) return [];
    const out = [];
    for (const id of ids) {
      for (const p of history.data.byDevice[id] ?? []) {
        const levels = PARAMETERS.map((k) => classify(k, p.values?.[k], thresholds));
        const status = levels.includes("CRITICAL") ? "CRITICAL" : levels.includes("WARNING") ? "WARNING" : "NORMAL";
        out.push({ deviceId: id, ...p, status: p.status ?? status });
      }
    }
    return out.sort((a, b) => b.t - a.t);
  }, [history.data, ids.join(","), thresholds]); // eslint-disable-line react-hooks/exhaustive-deps

  const tableRows = onlyAbnormal ? rows.filter((r) => r.status !== "NORMAL") : rows;
  const abnormalCount = rows.filter((r) => r.status !== "NORMAL").length;

  const exportCsv = () => downloadCsv(`readings-${station}-${new Date().toISOString().slice(0, 16)}.csv`, [
    { header: "deviceId", value: (r) => r.deviceId },
    { header: "timestamp", value: (r) => r.timestamp },
    ...PARAMETERS.map((p) => ({ header: p, value: (r) => r.values?.[p] })),
    { header: "status", value: (r) => r.status },
    { header: "resolution", value: () => resolution },
  ], tableRows);

  const paramsToChart = station === "all" ? [param] : PARAMETERS;

  return (
    <>
      <PageHeader title="Sensor Monitoring" description="Current and historical pH, turbidity, TDS and temperature, with abnormal readings highlighted." />

      <Card className="py-4">
        <CardContent className="flex flex-wrap items-end gap-4 px-4">
          <div className="grid gap-1.5">
            <Label htmlFor="station">Station</Label>
            <Select value={station} onValueChange={setStation}>
              <SelectTrigger id="station" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stations (compare)</SelectItem>
                {stations.map((s) => <SelectItem key={s.deviceId} value={s.deviceId}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {station === "all" && (
            <div className="grid gap-1.5">
              <Label htmlFor="param">Parameter</Label>
              <Select value={param} onValueChange={setParam}>
                <SelectTrigger id="param" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>{PARAMETERS.map((p) => <SelectItem key={p} value={p}>{paramLabel(p)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="range">Time range</Label>
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger id="range" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => <SelectItem key={r.key} value={r.key}>Last {r.label}</SelectItem>)}
                <SelectItem value="custom">Custom dates…</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {isCustom && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="from">From</Label>
                <Input id="from" type="datetime-local" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="to">To</Label>
                <Input id="to" type="datetime-local" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {resolution && resolution !== "raw" && (
        <p className="-mt-2 text-xs text-muted-foreground">Long range: showing {resolution === "hour" ? "hourly" : "daily"} averages (raw 5-second readings are used for ranges up to 6 hours).</p>
      )}

      {history.error ? <ErrorState error={history.error} onRetry={history.refresh} /> : (
        <div className={cn("grid gap-4", paramsToChart.length > 1 && "lg:grid-cols-2")}>
          {paramsToChart.map((p) => (
            <Card key={p} className="gap-2">
              <CardHeader>
                <CardTitle className="text-base">{paramLabel(p)}{station === "all" ? " · all stations" : ""}</CardTitle>
              </CardHeader>
              <CardContent>
                {!history.data ? <LoadingBlock rows={1} height="h-60" /> : (
                  <TimeSeriesChart param={p} thresholds={thresholds} height={station === "all" ? 320 : 220}
                    showDate={resolution !== "raw"} bucketMs={bucketFor(resolution)} series={seriesFor(p, ids, history.data.byDevice, meta)} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Readings</CardTitle>
          <CardDescription className="tabular">
            {rows.length.toLocaleString()} {resolution === "raw" ? "readings" : `${resolution}ly averages`} · {abnormalCount.toLocaleString()} abnormal
          </CardDescription>
          <CardAction className="flex gap-2">
            <Button variant={onlyAbnormal ? "default" : "outline"} size="sm" onClick={() => setOnlyAbnormal((v) => !v)} aria-pressed={onlyAbnormal}>
              Abnormal only
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!tableRows.length}><Download /> CSV</Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {!history.data ? <LoadingBlock rows={3} height="h-8" /> : tableRows.length === 0 ? (
            <EmptyState title={onlyAbnormal ? "No abnormal readings in this range" : "No readings in this range"}>
              {onlyAbnormal ? "Every reading was within the configured limits." : "Start the simulator to send telemetry."}
            </EmptyState>
          ) : (
            <div className="max-h-[28rem] overflow-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Time</TableHead>
                    {station === "all" && <TableHead>Station</TableHead>}
                    {PARAMETERS.map((p) => <TableHead key={p} className="text-right">{paramLabel(p)}</TableHead>)}
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tableRows.slice(0, 500).map((r) => (
                    <TableRow key={`${r.deviceId}-${r.t}`}>
                      <TableCell className="tabular whitespace-nowrap">{formatTime(r.timestamp, true)}</TableCell>
                      {station === "all" && <TableCell>{shortStation(r.deviceId)}</TableCell>}
                      {PARAMETERS.map((p) => {
                        const level = classify(p, r.values?.[p], thresholds);
                        return (
                          <TableCell key={p} className={cn("text-right tabular",
                            level === "CRITICAL" && "font-semibold text-status-critical-ink",
                            level === "WARNING" && "font-semibold text-status-warning-ink")}>
                            {formatValue(p, r.values?.[p])}
                          </TableCell>
                        );
                      })}
                      <TableCell><WaterStatusBadge status={r.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {tableRows.length > 500 && (
                <p className="p-3 text-center text-xs text-muted-foreground">Showing the newest 500 rows. Use CSV export for all {tableRows.length.toLocaleString()}.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
