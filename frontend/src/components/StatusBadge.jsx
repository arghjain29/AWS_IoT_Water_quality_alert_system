// Status is never shown by color alone: every badge has an icon and a text label.
import { CircleCheck, CircleHelp, OctagonAlert, TriangleAlert, WifiOff, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

const WATER = {
  NORMAL: { label: "Normal", icon: CircleCheck, cls: "bg-status-normal/10 text-status-normal-ink border-status-normal/30" },
  WARNING: { label: "Warning", icon: TriangleAlert, cls: "bg-status-warning/15 text-status-warning-ink border-status-warning/40" },
  CRITICAL: { label: "Critical", icon: OctagonAlert, cls: "bg-status-critical/10 text-status-critical-ink border-status-critical/30" },
  OFFLINE: { label: "Offline", icon: WifiOff, cls: "bg-muted text-muted-foreground border-border" },
  UNKNOWN: { label: "No data", icon: CircleHelp, cls: "bg-muted text-muted-foreground border-border" },
};

function Pill({ config, className }) {
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", config.cls, className)}>
      <Icon className="size-3.5" aria-hidden />
      {config.label}
    </span>
  );
}

// Water status of a station or reading. Pass online=false to show "Offline" instead.
export function WaterStatusBadge({ status, online = true, className }) {
  const key = online === false ? "OFFLINE" : WATER[status] ? status : "UNKNOWN";
  return <Pill config={WATER[key]} className={className} />;
}

export function SeverityBadge({ severity, className }) {
  return <Pill config={WATER[severity] ?? WATER.UNKNOWN} className={className} />;
}

export function ConnectionBadge({ connection, className }) {
  const config = {
    ONLINE: { label: "Online", icon: Wifi, cls: "bg-primary/10 text-primary border-primary/25" },
    OFFLINE: WATER.OFFLINE,
    NEVER_SEEN: { ...WATER.UNKNOWN, label: "Never seen" },
  }[connection] ?? WATER.UNKNOWN;
  return <Pill config={config} className={className} />;
}

export function AlertStatusBadge({ status }) {
  return status === "ACTIVE"
    ? <span className="inline-flex items-center rounded-full bg-status-critical/10 px-2 py-0.5 text-xs font-medium text-status-critical-ink">Active</span>
    : <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Acknowledged</span>;
}
