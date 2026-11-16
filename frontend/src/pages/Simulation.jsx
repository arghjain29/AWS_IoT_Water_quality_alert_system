// Demo control panel. Talks to the simulator's LOCAL control endpoint
// (http://127.0.0.1:8765, token-protected) — the same commands you can type in
// the simulator terminal. It only works on the computer running the simulator.
import { useEffect, useState } from "react";
import { KeyRound, Play, PlugZap, RotateCcw, Square, Terminal, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { ConnectionBadge } from "@/components/StatusBadge";
import { LoadingBlock } from "@/components/States";
import { PARAMETERS, SIM_CONTROL_URL, stationColor } from "@/lib/config";
import { formatValue, paramLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const TOKEN_KEY = "wq-sim-control-token";
const readToken = () => {
  // The token is pasted on this page and kept only in this browser; it is never built into the site.
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
};

async function control(path, token, body) {
  let res;
  try {
    res = await fetch(SIM_CONTROL_URL + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body && { "Content-Type": "application/json" }) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error("Simulator not reachable"), { kind: "offline" });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("Wrong control token"), { kind: "auth" });
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

function Command({ children }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

function Instructions() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Terminal className="size-4" /> Running the simulator</CardTitle>
        <CardDescription>The virtual stations are a Python program on your computer that publishes over MQTT to AWS IoT Core.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <ol className="grid list-decimal gap-2 pl-5">
          <li>Open a terminal in the <Command>simulator</Command> folder and run <Command>uv run simulator.py</Command></li>
          <li>Copy <Command>CONTROL_TOKEN</Command> from <Command>simulator/.env</Command> into the token box on this page.</li>
          <li>Use the buttons, or type commands into the simulator terminal:</li>
        </ol>
        <div className="grid gap-1 overflow-x-auto whitespace-pre rounded-md border bg-muted/40 p-3 font-mono text-xs">
          <span>critical 3 ph low      <span className="text-muted-foreground"># station 3 pH falls below 6.0</span></span>
          <span>warning 2 turbidity    <span className="text-muted-foreground"># station 2 turbidity ~7.5 NTU</span></span>
          <span>set 1 tds 1180         <span className="text-muted-foreground"># exact value</span></span>
          <span>disconnect 4           <span className="text-muted-foreground"># station 4 goes OFFLINE after ~20 s</span></span>
          <span>restore all            <span className="text-muted-foreground"># everything back to normal</span></span>
          <span>demo                   <span className="text-muted-foreground"># 3-minute scripted demo</span></span>
        </div>
        <p className="text-xs text-muted-foreground">
          The control endpoint only listens on 127.0.0.1 and accepts requests from the local dashboard (localhost:5173), so the
          buttons work when you run the dashboard on the same computer as the simulator. All readings are simulated.
        </p>
      </CardContent>
    </Card>
  );
}

function StationControls({ station, run, busy }) {
  const [param, setParam] = useState("ph");
  const [direction, setDirection] = useState("high");
  const [value, setValue] = useState("");
  const n = Number(station.deviceId.slice(-2));
  const abnormal = Object.entries(station.modes ?? {}).filter(([, m]) => m !== "normal");

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="size-2.5 rounded-full" style={{ background: stationColor(station.deviceId) }} aria-hidden />
          Station {String(n).padStart(2, "0")}
        </CardTitle>
        <CardDescription className="font-mono text-xs">{station.deviceId} · {station.messagesSent} sent</CardDescription>
        <CardAction><ConnectionBadge connection={station.online ? "ONLINE" : "OFFLINE"} /></CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 gap-1 text-xs tabular">
          {PARAMETERS.map((p) => (
            <div key={p} className={cn("flex justify-between rounded px-2 py-1 bg-muted/50",
              station.modes?.[p] === "critical" && "bg-status-critical/10 text-status-critical-ink",
              station.modes?.[p] === "warning" && "bg-status-warning/15 text-status-warning-ink",
              station.modes?.[p] === "manual" && "bg-primary/10 text-primary")}>
              <span>{paramLabel(p)}</span>
              <span className="font-medium">{formatValue(p, station.lastReading?.[p])}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {abnormal.length ? `Simulating: ${abnormal.map(([p, m]) => `${paramLabel(p)} ${m}`).join(", ")}` : "All parameters normal"}
        </p>

        <div className="flex flex-wrap gap-2">
          <Select value={param} onValueChange={setParam}>
            <SelectTrigger className="w-32" aria-label="Parameter"><SelectValue /></SelectTrigger>
            <SelectContent>{PARAMETERS.map((p) => <SelectItem key={p} value={p}>{paramLabel(p)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={direction} onValueChange={setDirection}>
            <SelectTrigger className="w-28" aria-label="Direction"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="high">Too high</SelectItem><SelectItem value="low">Too low</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} className="border-status-warning/60 text-status-warning-ink"
            onClick={() => run(`warning ${n} ${param}${direction === "low" ? " low" : ""}`)}>Warning</Button>
          <Button size="sm" variant="outline" disabled={busy} className="border-status-critical/50 text-status-critical-ink"
            onClick={() => run(`critical ${n} ${param}${direction === "low" ? " low" : ""}`)}>Critical</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(`normal ${n} ${param}`)}>Normal</Button>
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (value !== "") run(`set ${n} ${param} ${value}`); }}>
          <Input type="number" step="any" placeholder={`Set ${paramLabel(param)}`} value={value} onChange={(e) => setValue(e.target.value)} className="h-8" aria-label={`Exact ${paramLabel(param)} value`} />
          <Button size="sm" type="submit" variant="secondary" disabled={busy || value === ""}>Set</Button>
        </form>
        <div className="flex gap-2">
          {station.online
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => run(`disconnect ${n}`)}><Unplug /> Disconnect</Button>
            : <Button size="sm" disabled={busy} onClick={() => run(`restore ${n}`)}><PlugZap /> Reconnect</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(`restore ${n}`)}><RotateCcw /> Restore</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Simulation() {
  const [token, setToken] = useState(readToken);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await control("/status", token);
        if (!cancelled) { setStatus(s); setError(null); }
      } catch (e) {
        if (!cancelled) { setError(e); setStatus(null); }
      }
    };
    poll();
    const timer = setInterval(() => { if (!document.hidden) poll(); }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [token]);

  function saveToken(e) {
    e.preventDefault();
    try { localStorage.setItem(TOKEN_KEY, draft.trim()); } catch { /* private mode: keep in memory only */ }
    setToken(draft.trim());
    setDraft("");
  }

  async function run(command) {
    setBusy(true);
    try {
      const res = await control("/command", token, { command });
      toast.success(res.message || command);
      setStatus(await control("/status", token));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Simulation Control" description="Drive the virtual stations for demonstrations: trigger warnings, critical conditions and disconnections.">
        {status && (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run("restore all")}><RotateCcw /> Restore all</Button>
            {status.demoRunning
              ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => run("demo stop")}><Square /> Stop demo</Button>
              : <Button size="sm" disabled={busy} onClick={() => run("demo")}><Play /> Run 3-min demo</Button>}
          </>
        )}
      </PageHeader>

      {!token || error?.kind === "auth" ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> Connect to the local simulator</CardTitle>
            <CardDescription>
              {error?.kind === "auth" ? "That token was rejected. " : ""}Paste the <Command>CONTROL_TOKEN</Command> from <Command>simulator/.env</Command>. It is stored only in this browser.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex max-w-lg gap-2" onSubmit={saveToken}>
              <Label htmlFor="token" className="sr-only">Control token</Label>
              <Input id="token" type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Control token" />
              <Button type="submit" disabled={!draft.trim()}>Connect</Button>
            </form>
          </CardContent>
        </Card>
      ) : error?.kind === "offline" ? (
        <Alert>
          <PlugZap />
          <AlertTitle>Simulator not running on this computer</AlertTitle>
          <AlertDescription>
            Start it with <Command>uv run simulator.py</Command> in the <Command>simulator</Command> folder. This page reconnects automatically.
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } setToken(""); }}>
              Change token
            </Button>
          </AlertDescription>
        </Alert>
      ) : !status ? <LoadingBlock rows={1} /> : (
        <>
          <Alert>
            <PlugZap />
            <AlertTitle>Connected to the simulator ({status.mode === "aws" ? "publishing to AWS IoT Core" : "dry-run: not sending to AWS"})</AlertTitle>
            <AlertDescription>Changes take a few readings (5 s apart) to show on the dashboard; values move gradually like real sensors.</AlertDescription>
          </Alert>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Station controls">
            {status.stations.map((s) => <StationControls key={s.deviceId} station={s} run={run} busy={busy} />)}
          </section>
        </>
      )}

      <Instructions />
    </>
  );
}
