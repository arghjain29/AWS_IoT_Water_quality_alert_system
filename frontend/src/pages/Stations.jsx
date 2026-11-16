import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppData } from "@/components/DataProvider";
import { PageHeader } from "@/components/PageHeader";
import { ConnectionBadge, WaterStatusBadge } from "@/components/StatusBadge";
import { classify } from "@/components/SensorValue";
import { ErrorState, LoadingBlock } from "@/components/States";
import { PARAMETERS, stationColor } from "@/lib/config";
import { formatTime, formatValue, paramLabel, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function Stations() {
  const { summary, thresholds } = useAppData();
  const stations = summary.data?.stations;

  return (
    <>
      <PageHeader title="Monitoring Stations" description="Virtual IoT stations registered in AWS IoT Core (software-simulated sensors)." />
      {summary.error && !stations && <ErrorState error={summary.error} onRetry={summary.refresh} />}
      {!stations && !summary.error && <LoadingBlock rows={4} height="h-12" />}
      {stations && (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Station</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Water status</TableHead>
                  {PARAMETERS.map((p) => <TableHead key={p} className="text-right">{paramLabel(p)}</TableHead>)}
                  <TableHead>Last communication</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                  <TableHead className="pr-4"><span className="sr-only">Open</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stations.map((s) => (
                  <TableRow key={s.deviceId}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2">
                        <span className="size-2.5 rounded-full" style={{ background: stationColor(s.deviceId) }} aria-hidden />
                        <div>
                          <p className="font-medium">{s.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">{s.deviceId}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{s.location}</TableCell>
                    <TableCell><ConnectionBadge connection={s.connection} /></TableCell>
                    <TableCell><WaterStatusBadge status={s.waterStatus} online={s.online} /></TableCell>
                    {PARAMETERS.map((p) => {
                      const level = classify(p, s.latestReadings?.[p], thresholds);
                      return (
                        <TableCell key={p} className={cn("text-right tabular",
                          level === "CRITICAL" && "font-semibold text-status-critical-ink",
                          level === "WARNING" && "font-semibold text-status-warning-ink")}>
                          {formatValue(p, s.latestReadings?.[p])}
                        </TableCell>
                      );
                    })}
                    <TableCell className="tabular">
                      <p>{timeAgo(s.lastSeen)}</p>
                      <p className="text-xs text-muted-foreground">{formatTime(s.lastSeen, true)}</p>
                    </TableCell>
                    <TableCell className="text-right tabular">{s.messageCount.toLocaleString()}</TableCell>
                    <TableCell className="pr-4">
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/stations/${s.deviceId}`} aria-label={`Open ${s.name}`}>Details <ArrowRight /></Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
