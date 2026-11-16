import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppData } from "@/components/DataProvider";
import { PageHeader } from "@/components/PageHeader";
import { SensorValue } from "@/components/SensorValue";
import { AlertStatusBadge, ConnectionBadge, SeverityBadge, WaterStatusBadge } from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/States";
import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { api } from "@/lib/api";
import { PARAMETERS, POLL_MS, stationColor } from "@/lib/config";
import { formatTime, formatValue, paramLabel, timeAgo } from "@/lib/format";
import { RANGES, bucketFor, loadHistory, seriesFor } from "@/lib/history";
import { usePolling } from "@/lib/usePolling";

export default function StationDetail() {
  const { deviceId } = useParams();
  const { thresholds } = useAppData();
  const [range, setRange] = useState("1h");
  const seconds = RANGES.find((r) => r.key === range).seconds;

  const device = usePolling(() => api.device(deviceId), [deviceId], POLL_MS);
  const history = usePolling(() => {
    const to = new Date();
    return loadHistory([deviceId], new Date(to - seconds * 1000), to);
  }, [deviceId, range], seconds <= 3600 ? 15_000 : 60_000);

  if (device.error?.status === 404) {
    return <EmptyState title="Station not found">There is no station called {deviceId}. <Link className="underline" to="/stations">Back to stations</Link></EmptyState>;
  }
  if (device.error && !device.data) return <ErrorState error={device.error} onRetry={device.refresh} />;
  if (!device.data) return <LoadingBlock rows={3} />;

  const d = device.data;
  const meta = { [deviceId]: { name: d.name, color: stationColor(deviceId) } };
  const resolution = history.data?.resolution;

  return (
    <>
      <Button variant="ghost" size="sm" className="w-fit" asChild>
        <Link to="/stations"><ArrowLeft /> All stations</Link>
      </Button>
      <PageHeader title={d.name} description={`${d.deviceId} · ${d.location}`}>
        <ConnectionBadge connection={d.connection} />
        <WaterStatusBadge status={d.waterStatus} online={d.online} />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Latest readings</CardTitle>
          <CardDescription className="tabular">
            Last communication {timeAgo(d.lastSeen)} ({formatTime(d.lastSeen, true)}) · {d.messageCount.toLocaleString()} messages received
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {PARAMETERS.map((p) => <SensorValue key={p} size="lg" param={p} value={d.latestReadings?.[p]} thresholds={thresholds} muted={!d.online} />)}
          </div>
          {d.latestViolations?.length > 0 && (
            <ul className="grid gap-1 text-sm">
              {d.latestViolations.map((v) => (
                <li key={v.parameter} className="flex items-center gap-2"><SeverityBadge severity={v.severity} /> {v.message}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">History</h2>
        <Tabs value={range} onValueChange={setRange}>
          <TabsList>{RANGES.map((r) => <TabsTrigger key={r.key} value={r.key}>{r.label}</TabsTrigger>)}</TabsList>
        </Tabs>
      </div>
      {resolution && resolution !== "raw" && (
        <p className="-mt-4 text-xs text-muted-foreground">Showing {resolution === "hour" ? "hourly" : "daily"} averages for this range.</p>
      )}
      {history.error ? <ErrorState error={history.error} onRetry={history.refresh} /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {PARAMETERS.map((p) => (
            <Card key={p} className="gap-2">
              <CardHeader><CardTitle className="text-base">{paramLabel(p)}</CardTitle></CardHeader>
              <CardContent>
                {!history.data ? <LoadingBlock rows={1} height="h-56" /> : (
                  <TimeSeriesChart param={p} thresholds={thresholds} height={220} showDate={resolution !== "raw"}
                    bucketMs={bucketFor(resolution)} series={seriesFor(p, [deviceId], history.data.byDevice, meta)} />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Recent alerts</CardTitle><CardDescription>Last 10 for this station</CardDescription></CardHeader>
        <CardContent>
          {d.recentAlerts.length === 0 ? <EmptyState title="No alerts for this station" /> : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Severity</TableHead><TableHead>Parameter</TableHead><TableHead>Description</TableHead>
                  <TableHead className="text-right">First value</TableHead><TableHead>Created</TableHead><TableHead>Status</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {d.recentAlerts.map((a) => (
                  <TableRow key={a.alertId}>
                    <TableCell><SeverityBadge severity={a.severity} /></TableCell>
                    <TableCell>{paramLabel(a.parameter)}</TableCell>
                    <TableCell className="max-w-xs truncate" title={a.message}>{a.message}</TableCell>
                    <TableCell className="text-right tabular">{formatValue(a.parameter, a.value)}</TableCell>
                    <TableCell className="tabular">{formatTime(a.createdAt, true)}</TableCell>
                    <TableCell><AlertStatusBadge status={a.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
