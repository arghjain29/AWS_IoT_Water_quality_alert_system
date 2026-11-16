import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import {
  Activity, BarChart3, Bell, Cloud, Droplets, FlaskConical, LayoutDashboard, Menu, RadioTower,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAppData } from "@/components/DataProvider";
import { DATA_MODE } from "@/lib/config";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/stations", label: "Monitoring Stations", icon: RadioTower },
  { to: "/monitoring", label: "Sensor Monitoring", icon: Activity },
  { to: "/alerts", label: "Alerts", icon: Bell, badge: true },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/simulation", label: "Simulation Control", icon: FlaskConical },
];

function NavLinks({ onNavigate }) {
  const { summary } = useAppData();
  const active = summary.data?.activeAlerts ?? 0;
  return (
    <nav className="grid gap-1" aria-label="Main">
      {NAV.map(({ to, label, icon: Icon, end, badge }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) => cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          <span className="flex-1">{label}</span>
          {badge && active > 0 && (
            <span className="rounded-full bg-status-critical px-1.5 text-xs font-semibold text-white tabular" aria-label={`${active} active alerts`}>
              {active}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-3">
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Droplets className="size-4" aria-hidden />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold">AquaWatch IoT</p>
        <p className="text-xs text-muted-foreground">Water quality monitoring</p>
      </div>
    </div>
  );
}

function ModeBanner() {
  const { summary } = useAppData();
  if (DATA_MODE === "mock") {
    return (
      <div className="flex items-center gap-2 border-b border-status-warning/40 bg-status-warning/15 px-4 py-2 text-sm text-status-warning-ink" role="status">
        <FlaskConical className="size-4 shrink-0" aria-hidden />
        <span><strong>Mock data mode.</strong> Sample data generated in the browser. Not connected to AWS. Set <code>VITE_API_BASE_URL</code> to use live data.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-card px-4 py-2 text-xs text-muted-foreground" role="status">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <Cloud className="size-3.5 text-primary" aria-hidden /> Live AWS data
      </span>
      <span>Readings are from <strong>software-simulated</strong> sensors via AWS IoT Core</span>
      <span className="ml-auto tabular">
        {summary.error ? <span className="text-status-critical-ink">API unreachable, retrying…</span>
          : summary.updatedAt ? `Updated ${timeAgo(summary.updatedAt.toISOString())}` : "Connecting…"}
      </span>
    </div>
  );
}

export function Layout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="hidden border-r bg-sidebar lg:flex lg:flex-col lg:gap-6 lg:py-5 lg:px-3 lg:sticky lg:top-0 lg:h-svh">
        <Brand />
        <NavLinks />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b bg-card px-4 py-3 lg:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open navigation"><Menu /></Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 gap-6 p-4">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <Brand />
              <NavLinks onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <Brand />
        </header>

        <ModeBanner />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-6">
            <Outlet />
          </div>
        </main>
        <footer className="border-t px-4 py-3 text-center text-xs text-muted-foreground sm:px-6">
          Indicative monitoring with demonstration thresholds. Not a certified drinking-water safety assessment.
        </footer>
      </div>
    </div>
  );
}
