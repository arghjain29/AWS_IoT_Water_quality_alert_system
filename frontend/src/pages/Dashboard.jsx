import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Bell, CircleCheck, OctagonAlert, RadioTower, TriangleAlert, Wifi, WifiOff } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppData } from "@/components/DataProvider";
import { PageHeader } from "@/components/PageHeader";
import { ConnectionBadge, SeverityBadge, WaterStatusBadge } from "@/components/StatusBadge";
import { SensorValue } from "@/components/SensorValue";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/States";
import { TimeSeriesChart } from "@/components/TimeSeriesChart";
import { api } from "@/lib/api";
import { PARAMETERS, POLL_MS, shortStation, stationColor } from "@/lib/config";
import { formatTime, formatValue, paramLabel, timeAgo } from "@/lib/format";
import { loadHistory, seriesFor } from "@/lib/history";
import { usePolling } from "@/lib/usePolling";
import { cn } from "@/lib/utils";

function Kpi({ label, value, icon: Icon, tone }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="flex items-center justify-between gap-2 px-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tabular">{value ?? "—"}</p>
        </div>
        <span className={cn("flex size-9 items-center justify-center rounded-full", {
          "bg-primary/10 text-primary": tone === "blue",
          "bg-status-normal/10 text-status-normal-ink": tone === "normal",
          "bg-status-warning/15 text-status-warning-ink": tone === "warning",
          "bg-status-critical/10 text-status-critical-ink": tone === "critical",
          "bg-muted text-muted-foreground": tone === "muted",
        })}>
          <Icon className="size-4" aria-hidden />
        </span>
      </CardContent>
    </Card>
  );
}

function StationCard({ station, thresholds }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="size-2.5 rounded-full" style={{ background: stationColor(station.deviceId) }} aria-hidden />
          <Link to={`/stations/${station.deviceId}`} className="hover:underline">{station.name}</Link>
        </CardTitle>
        <CardDescription className="font-mono text-xs">{station.deviceId}</CardDescription>
        <CardAction className="flex flex-col items-end gap-1">
          <WaterStatusBadge status={station.waterStatus} online={station.online} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 gap-2">
          {PARAMETERS.map((p) => (
            <SensorValue key={p} param={p} value={station.latestReadings?.[p]} thresholds={thresholds} muted={!station.online} />
          ))}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <ConnectionBadge connection={station.connection} />
          <span className="tabular">Last seen {timeAgo(station.lastSeen)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function LiveTrend({ stations, thresholds }) {
  const [param, setParam] = useState("ph");
  const ids = stations.map((s) => s.deviceId);
  const history = usePolling(() => {
    const to = new Date();
    return loadHistory(ids, new Date(to - 30 * 60_000), to);
  }, [ids.join(",")], 15_000);

  const meta = Object.fromEntries(stations.map((s) => [s.deviceId, { name: shortStation(s.deviceId), color: stationColor(s.deviceId) }]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Water quality trend · last 30 minutes</CardTitle>
        <CardDescription>All stations, {paramLabel(param)}. Refreshes every 15 s.</CardDescription>
        <CardAction>
          <Tabs value={param} onValueChange={setParam}>
            <TabsList>
              {PARAMETERS.map((p) => <TabsTrigger key={p} value={p}>{paramLabel(p)}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        {history.error ? <ErrorState error={history.error} onRetry={history.refresh} />
          : !history.data ? <LoadingBlock rows={1} height="h-64" />
          : <TimeSeriesChart param={param} thresholds={thresholds} series={seriesFor(param, ids, history.data.byDevice, meta)} />}
      </CardContent>
    </Card>
  );
}

function ActiveAlerts() {
  const alerts = usePolling(() => api.alerts({ status: "ACTIVE", limit: 5 }), [], POLL_MS);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active alerts</CardTitle>
        <CardDescription>Newest first</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" asChild><Link to="/alerts">All alerts <ArrowRight /></Link></Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {alerts.error ? <ErrorState error={alerts.error} onRetry={alerts.refresh} />
          : !alerts.data ? <LoadingBlock rows={2} height="h-10" />
          : alerts.data.items.length === 0 ? <EmptyState title="No active alerts" icon={CircleCheck}>All acknowledged or no abnormal readings.</EmptyState>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead><TableHead>Station</TableHead><TableHead>Parameter</TableHead>
                  <TableHead className="text-right">Value</TableHead><TableHead>Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.data.items.map((a) => (
                  <TableRow key={a.alertId}>
                    <TableCell><SeverityBadge severity={a.severity} /></TableCell>
                    <TableCell>{a.deviceName}</TableCell>
                    <TableCell>{paramLabel(a.parameter)}</TableCell>
                    <TableCell className="text-right tabular">{formatValue(a.parameter, a.lastValue)}</TableCell>
                    <TableCell className="tabular text-muted-foreground">{formatTime(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { summary, thresholds } = useAppData();
  const s = summary.data;

  return (
    <>
      <PageHeader title="Dashboard" description="Live status of all monitoring stations. Updates every 5 seconds." />

      {summary.error && !s && <ErrorState error={summary.error} onRetry={summary.refresh} />}
      {!s && !summary.error && <LoadingBlock rows={2} />}

      {s && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" aria-label="Key figures">
            <Kpi label="Stations" value={s.totalStations} icon={RadioTower} tone="blue" />
            <Kpi label="Online" value={s.online} icon={Wifi} tone="blue" />
            <Kpi label="Offline" value={s.offline} icon={WifiOff} tone="muted" />
            <Kpi label="Normal" value={s.normal} icon={CircleCheck} tone="normal" />
            <Kpi label="Warning" value={s.warning} icon={TriangleAlert} tone="warning" />
            <Kpi label="Critical" value={s.critical} icon={OctagonAlert} tone="critical" />
            <Kpi label="Active alerts" value={s.activeAlerts} icon={Bell} tone={s.activeAlerts ? "critical" : "muted"} />
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Stations">
            {s.stations.map((st) => <StationCard key={st.deviceId} station={st} thresholds={thresholds} />)}
          </section>

          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <LiveTrend stations={s.stations} thresholds={thresholds} />
            <ActiveAlerts />
          </div>
        </>
      )}
    </>
  );
}
