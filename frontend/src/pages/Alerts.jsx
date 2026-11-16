import { useEffect, useState } from "react";
import { Check, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppData } from "@/components/DataProvider";
import { PageHeader } from "@/components/PageHeader";
import { AlertStatusBadge, SeverityBadge } from "@/components/StatusBadge";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/States";
import { api } from "@/lib/api";
import { POLL_MS } from "@/lib/config";
import { downloadCsv, formatTime, formatValue, paramLabel, timeAgo } from "@/lib/format";

const PAGE = 25;

function FilterSelect({ id, label, value, onChange, options }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export default function Alerts() {
  const { summary } = useAppData();
  const stations = summary.data?.stations ?? [];
  const [filters, setFilters] = useState({ status: "ACTIVE", severity: "ALL", deviceId: "all" });
  const [state, setState] = useState({ items: [], nextToken: null, loading: true, error: null });
  const [acking, setAcking] = useState(null);

  const params = { status: filters.status, severity: filters.severity, deviceId: filters.deviceId === "all" ? undefined : filters.deviceId, limit: PAGE };

  async function load({ append = false, silent = false } = {}) {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    try {
      const res = await api.alerts({ ...params, nextToken: append ? state.nextToken : undefined });
      setState((s) => ({ items: append ? [...s.items, ...res.items] : res.items, nextToken: res.nextToken, loading: false, error: null }));
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
    }
  }

  // Load on filter change; auto-refresh the first page every 5 s (paused once you load more pages)
  const pagesLoaded = state.items.length > PAGE;
  useEffect(() => {
    load();
  }, [filters.status, filters.severity, filters.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pagesLoaded) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load({ silent: true }); }, POLL_MS);
    return () => clearInterval(timer);
  }, [filters.status, filters.severity, filters.deviceId, pagesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  async function acknowledge(alert) {
    setAcking(alert.alertId);
    try {
      const updated = await api.acknowledge(alert.alertId, { acknowledgedBy: "dashboard-operator" });
      toast.success(`Acknowledged: ${alert.deviceName}, ${paramLabel(alert.parameter)}`);
      setState((s) => ({
        ...s,
        items: filters.status === "ACTIVE" ? s.items.filter((a) => a.alertId !== alert.alertId)
          : s.items.map((a) => (a.alertId === alert.alertId ? updated : a)),
      }));
      summary.refresh();
    } catch (error) {
      toast.error(error.message);
      load({ silent: true });
    } finally {
      setAcking(null);
    }
  }

  const exportCsv = () => downloadCsv(`alerts-${new Date().toISOString().slice(0, 16)}.csv`, [
    { header: "alertId", value: (a) => a.alertId },
    { header: "severity", value: (a) => a.severity },
    { header: "status", value: (a) => a.status },
    { header: "deviceId", value: (a) => a.deviceId },
    { header: "station", value: (a) => a.deviceName },
    { header: "parameter", value: (a) => a.parameter },
    { header: "firstValue", value: (a) => a.value },
    { header: "latestValue", value: (a) => a.lastValue },
    { header: "limit", value: (a) => a.limit },
    { header: "description", value: (a) => a.message },
    { header: "createdAt", value: (a) => a.createdAt },
    { header: "lastAbnormalAt", value: (a) => a.lastAbnormalAt },
    { header: "occurrences", value: (a) => a.occurrences },
    { header: "acknowledgedAt", value: (a) => a.acknowledgedAt },
    { header: "acknowledgedBy", value: (a) => a.acknowledgedBy },
  ], state.items);

  const set = (key) => (value) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <>
      <PageHeader title="Alerts" description="Generated in the cloud when readings leave the configured limits. One alert per station and parameter while the problem continues." />

      <Card className="py-4">
        <CardContent className="flex flex-wrap items-end gap-4 px-4">
          <FilterSelect id="status" label="Status" value={filters.status} onChange={set("status")}
            options={[["ACTIVE", "Active"], ["ACKNOWLEDGED", "Acknowledged"], ["ALL", "All (history)"]]} />
          <FilterSelect id="severity" label="Severity" value={filters.severity} onChange={set("severity")}
            options={[["ALL", "All severities"], ["CRITICAL", "Critical"], ["WARNING", "Warning"]]} />
          <FilterSelect id="station" label="Station" value={filters.deviceId} onChange={set("deviceId")}
            options={[["all", "All stations"], ...stations.map((s) => [s.deviceId, s.name])]} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ ACTIVE: "Active alerts", ACKNOWLEDGED: "Acknowledged alerts", ALL: "Alert history" }[filters.status]}</CardTitle>
          <CardDescription>{state.items.length} shown{state.nextToken ? " · more available" : ""}</CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => load()} aria-label="Refresh"><RefreshCw /></Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!state.items.length}><Download /> CSV</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3">
          {state.error && <ErrorState error={state.error} onRetry={() => load()} />}
          {state.loading && !state.items.length ? <LoadingBlock rows={4} height="h-10" />
            : !state.error && state.items.length === 0 ? (
              <EmptyState title="No alerts match these filters">Trigger a warning or critical condition from the Simulation page to see alerts appear here.</EmptyState>
            ) : state.items.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severity</TableHead><TableHead>Station</TableHead><TableHead>Parameter</TableHead>
                      <TableHead className="text-right">Measured</TableHead><TableHead className="text-right">Limit</TableHead>
                      <TableHead>Description</TableHead><TableHead>Created</TableHead><TableHead className="text-right">Count</TableHead>
                      <TableHead>Status</TableHead><TableHead><span className="sr-only">Action</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.items.map((a) => (
                      <TableRow key={a.alertId}>
                        <TableCell><SeverityBadge severity={a.severity} /></TableCell>
                        <TableCell>
                          <p className="font-medium">{a.deviceName}</p>
                          <p className="font-mono text-xs text-muted-foreground">{a.deviceId}</p>
                        </TableCell>
                        <TableCell>{paramLabel(a.parameter)}</TableCell>
                        <TableCell className="text-right tabular">
                          <p>{formatValue(a.parameter, a.value)}</p>
                          {a.lastValue !== a.value && <p className="text-xs text-muted-foreground">latest {formatValue(a.parameter, a.lastValue, false)}</p>}
                        </TableCell>
                        <TableCell className="text-right tabular">{formatValue(a.parameter, a.limit)}</TableCell>
                        <TableCell className="min-w-[11rem] max-w-[15rem] whitespace-normal">{a.message}</TableCell>
                        <TableCell className="tabular whitespace-nowrap">
                          <p>{formatTime(a.createdAt, true)}</p>
                          <p className="text-xs text-muted-foreground">last abnormal {timeAgo(a.lastAbnormalAt)}</p>
                        </TableCell>
                        <TableCell className="text-right tabular">{a.occurrences}</TableCell>
                        <TableCell>
                          <AlertStatusBadge status={a.status} />
                          {a.acknowledgedAt && <p className="mt-1 text-xs text-muted-foreground">{timeAgo(a.acknowledgedAt)}</p>}
                        </TableCell>
                        <TableCell>
                          {a.status === "ACTIVE" && (
                            <Button size="sm" variant="outline" disabled={acking === a.alertId} onClick={() => acknowledge(a)}>
                              <Check /> Acknowledge
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          {state.nextToken && (
            <Button variant="outline" className="justify-self-center" disabled={state.loading} onClick={() => load({ append: true })}>
              Load more
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}
