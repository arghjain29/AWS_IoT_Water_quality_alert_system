"""
Virtual water-quality monitoring stations -> AWS IoT Core (MQTT over TLS).

All readings are SIMULATED by software. No physical sensors are involved.

Run from the simulator/ folder:
    uv run simulator.py              # connect the 4 stations to AWS IoT Core
    uv run simulator.py --dry-run    # print readings only; nothing is sent to AWS
    uv run simulator.py --quiet      # hide the per-reading lines, show only events

While it runs, type commands and press Enter (type "help" for the list).
The dashboard's Simulation page can send the same commands through a small
local control endpoint (127.0.0.1 only, protected by CONTROL_TOKEN).
"""

import argparse
import hmac
import json
import math
import os
import random
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

# =============================================================================
# 1. Settings (from simulator/.env) and shared config (from ../config)
# =============================================================================
HERE = Path(__file__).resolve().parent
CONFIG_DIR = HERE.parent / "config"
load_dotenv(HERE / ".env")

IOT_ENDPOINT = os.getenv("IOT_ENDPOINT", "")
CERTS_DIR = (HERE / os.getenv("CERTS_DIR", "../certs")).resolve()
INTERVAL = float(os.getenv("PUBLISH_INTERVAL", "5"))
SEED = int(os.getenv("SIM_SEED", "42"))
CONTROL_PORT = int(os.getenv("CONTROL_PORT", "8765"))
CONTROL_TOKEN = os.getenv("CONTROL_TOKEN", "")

THRESHOLDS = json.loads((CONFIG_DIR / "thresholds.json").read_text(encoding="utf-8"))["parameters"]
STATION_CONFIG = json.loads((CONFIG_DIR / "stations.json").read_text(encoding="utf-8"))["stations"]
PARAMS = ["ph", "turbidity", "tds", "temperature"]
TOPIC = "water-quality/stations/{}/telemetry"
DASHBOARD_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

lock = threading.Lock()  # station state is shared by several threads
dry_run = False
quiet = False


def log(message):
    print(f"{datetime.now():%H:%M:%S}  {message}", flush=True)


# =============================================================================
# 2. A virtual station: generates realistic readings
# =============================================================================
class Station:
    def __init__(self, cfg):
        self.id = cfg["deviceId"]
        self.location = cfg["location"]
        self.profile = cfg["profile"]  # baseline / noise / diurnal per parameter
        self.connection = None  # MQTT connection; None means not connected
        self.sent = 0
        self.last_reading = None
        self.target = {}  # where each value is heading
        self.mode = {}  # "normal", "warning", "critical" or "manual" per parameter
        self.reset()

    def reset(self):
        """Back to normal and re-seed the random numbers, so a demo always replays the same way."""
        self.rng = random.Random(f"{SEED}:{self.id}")
        self.value = {p: self.profile[p]["baseline"] for p in PARAMS}
        self.seq = 0
        self.restore()

    def restore(self):
        """All parameters back to normal and the station back online."""
        self.set_normal()
        self.online = True

    def set_normal(self, param=None):
        for p in [param] if param else PARAMS:
            self.target[p] = self.profile[p]["baseline"]
            self.mode[p] = "normal"

    def next_reading(self, now):
        """Each value moves 30% of the way toward its goal plus a small random wobble.
        This gives smooth, believable changes instead of independent random numbers."""
        hour = now.hour + now.minute / 60
        reading = {}
        for p in PARAMS:
            goal = self.target[p]
            if self.mode[p] == "normal":
                # small daily cycle (e.g. water is warmest around 15:00)
                goal += self.profile[p]["diurnal"] * math.sin(2 * math.pi * (hour - 9) / 24)
            self.value[p] += (goal - self.value[p]) * 0.3 + self.rng.gauss(0, self.profile[p]["noise"])

            valid = THRESHOLDS[p]["validRange"]
            self.value[p] = min(max(self.value[p], valid["min"]), valid["max"])
            decimals = THRESHOLDS[p]["decimals"]
            reading[p] = round(self.value[p]) if decimals == 0 else round(self.value[p], decimals)
        self.last_reading = reading
        return reading


def anomaly_value(param, level, direction="high"):
    """A value that sits clearly inside the WARNING or CRITICAL band of a parameter.
    Example for pH (normal 6.5-8.5, critical 6.0-9.0): warning high = 8.75, critical high = 9.5."""
    normal, critical = THRESHOLDS[param]["normal"], THRESHOLDS[param]["critical"]
    if direction == "low" and critical["min"] is not None:
        gap = normal["min"] - critical["min"]
        return normal["min"] - gap / 2 if level == "warning" else critical["min"] - gap / 2
    gap = critical["max"] - normal["max"]
    return normal["max"] + gap / 2 if level == "warning" else critical["max"] + gap / 2


def make_message(station, reading, now):
    """The JSON payload sent over MQTT (timestamp in ISO-8601 UTC)."""
    station.seq += 1
    return {
        "schemaVersion": 1,
        "deviceId": station.id,
        "location": station.location,
        "timestamp": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
        "seq": station.seq,
        "simulated": True,
        "readings": reading,
    }


# =============================================================================
# 3. MQTT: talking to AWS IoT Core
# =============================================================================
def connect(station):
    if dry_run:
        station.connection = "dry-run"
        return
    from awsiot import mqtt_connection_builder  # imported here so --dry-run needs no AWS setup

    folder = CERTS_DIR / station.id
    connection = mqtt_connection_builder.mtls_from_path(
        endpoint=IOT_ENDPOINT,
        port=8883,
        cert_filepath=str(folder / "certificate.pem.crt"),  # this device's certificate
        pri_key_filepath=str(folder / "private.pem.key"),  # this device's private key
        ca_filepath=str(CERTS_DIR / "AmazonRootCA1.pem"),  # proves we're talking to real AWS
        client_id=station.id,  # the IoT policy only lets a device use its own id
        clean_session=True,
        keep_alive_secs=30,
        # The SDK reconnects automatically; these just tell us about it.
        on_connection_interrupted=lambda connection, error, **kw: log(f"{station.id} connection lost ({error}), reconnecting..."),
        on_connection_resumed=lambda connection, return_code, session_present, **kw: log(f"{station.id} reconnected"),
    )
    connection.connect().result(timeout=15)
    station.connection = connection
    log(f"{station.id} connected to AWS IoT Core")


def disconnect(station):
    if station.connection is None:
        return
    if station.connection != "dry-run":
        try:
            station.connection.disconnect().result(timeout=10)
        except Exception as error:
            log(f"{station.id} disconnect error: {error}")
    station.connection = None
    log(f"{station.id} disconnected")


def publish(station, message):
    if not dry_run:
        from awscrt import mqtt

        future, _ = station.connection.publish(
            topic=TOPIC.format(station.id),
            payload=json.dumps(message),
            qos=mqtt.QoS.AT_LEAST_ONCE,
        )
        future.result(timeout=10)  # wait until AWS confirms it received the message
    station.sent += 1
    if not quiet:
        r = message["readings"]
        tag = "  [dry-run, not sent]" if dry_run else ""
        log(f"{station.id} #{message['seq']:<4} pH={r['ph']:<5} turb={r['turbidity']:<5} "
            f"tds={r['tds']:<5} temp={r['temperature']}{tag}")


def station_loop(station, stop, interval, start_delay):
    """Runs in its own thread: one per station."""
    stop.wait(start_delay)  # stagger the stations so they don't all publish at once
    while not stop.is_set():
        if not station.online:
            disconnect(station)  # simulated sensor/network failure
        else:
            try:
                if station.connection is None:
                    connect(station)
                now = datetime.now(timezone.utc)
                with lock:
                    message = make_message(station, station.next_reading(now), now)
                publish(station, message)
            except Exception as error:
                log(f"{station.id} error: {error} (will retry)")
        stop.wait(interval)
    disconnect(station)


STATIONS = [Station(cfg) for cfg in STATION_CONFIG]


# =============================================================================
# 4. Commands (typed in the terminal or sent from the dashboard)
# =============================================================================
HELP = """Commands  (station = 1-4, a full id like WATER_STATION_03, or 'all')
  status                              show all stations
  warning  <station> [param] [low]    push a parameter into WARNING   (default param: turbidity)
  critical <station> [param] [low]    push a parameter into CRITICAL  (default param: ph)
  set      <station> <param> <value>  set an exact value, e.g.  set 1 tds 1180
  normal   <station> [param]          parameter(s) back to normal
  disconnect <station>                simulate a sensor/network failure (stops sending)
  restore  <station>                  everything back to normal and online
  demo  |  demo stop                  run / stop the 3-minute scripted demo
  quit                                stop all stations and exit
params: ph, turbidity, tds, temperature    'low' = go below the limit instead of above (ph, temperature)"""

DEMO_STEPS = [  # (seconds after start, command)
    (0, "restore all"),
    (30, "warning 2 turbidity"),
    (60, "critical 3 ph low"),
    (90, "set 1 tds 1180"),
    (120, "disconnect 4"),
    (180, "restore all"),
]
demo_stop = threading.Event()
demo_thread = None


def find_stations(name):
    if name == "all":
        return STATIONS
    if name.isdigit():
        name = f"water_station_{int(name):02d}"
    matches = [s for s in STATIONS if s.id.lower() == name]
    if not matches:
        raise ValueError(f"unknown station '{name}' (use 1-4 or 'all')")
    return matches


def check_param(param):
    if param not in PARAMS:
        raise ValueError(f"unknown parameter '{param}' (use: {', '.join(PARAMS)})")


def run_command(text):
    """Run one command and return a message for the user. Raises ValueError on bad input."""
    words = text.replace("﻿", "").strip().lower().split()  # ﻿: invisible char some terminals add
    if not words:
        return ""
    cmd, args = words[0], words[1:]

    if cmd == "help":
        return HELP
    if cmd == "status":
        return status_text()
    if cmd == "demo":
        if args[:1] == ["stop"]:
            demo_stop.set()
            return "demo stopped"
        start_demo()
        return "demo started (about 3 minutes). Watch the dashboard."
    if cmd not in ("warning", "critical", "set", "normal", "disconnect", "restore"):
        raise ValueError(f"unknown command '{cmd}'. Type 'help'.")
    if not args:
        raise ValueError(f"usage: {cmd} <station 1-4 | all> ...")

    stations = find_stations(args[0])
    names = ", ".join(s.id for s in stations)
    with lock:
        if cmd in ("warning", "critical"):
            param = args[1] if len(args) > 1 else ("turbidity" if cmd == "warning" else "ph")
            check_param(param)
            value = anomaly_value(param, cmd, "low" if "low" in args[2:] else "high")
            for s in stations:
                s.target[param], s.mode[param] = value, cmd
            return f"{names}: {param} -> {cmd.upper()} (moving toward {value:g})"

        if cmd == "set":
            if len(args) != 3:
                raise ValueError("usage: set <station> <param> <value>")
            param = args[1]
            check_param(param)
            value = float(args[2])
            valid = THRESHOLDS[param]["validRange"]
            if not valid["min"] <= value <= valid["max"]:
                raise ValueError(f"{param} must be between {valid['min']} and {valid['max']}")
            for s in stations:
                s.target[param], s.mode[param] = value, "manual"
            return f"{names}: {param} -> {value:g}"

        if cmd == "normal":
            param = args[1] if len(args) > 1 else None
            if param:
                check_param(param)
            for s in stations:
                s.set_normal(param)
            return f"{names}: {param or 'all parameters'} back to normal"

        if cmd == "disconnect":
            for s in stations:
                s.online = False
            return f"{names}: disconnected (the dashboard shows OFFLINE after ~15s)"

        # restore
        for s in stations:
            s.restore()
        return f"{names}: restored to normal and online"


def start_demo():
    global demo_thread
    demo_stop.set()
    if demo_thread:
        demo_thread.join()
    demo_stop.clear()
    demo_thread = threading.Thread(target=demo_runner, daemon=True)
    demo_thread.start()


def demo_runner():
    with lock:
        for s in STATIONS:
            s.reset()  # same seed -> identical readings every time the demo runs
    start = time.monotonic()
    for at, command in DEMO_STEPS:
        if demo_stop.wait(max(0, at - (time.monotonic() - start))):
            return
        log(f"[demo +{at}s] {command}  ->  {run_command(command)}")
    log("[demo] finished; all stations normal")


def status_json():
    with lock:
        return {
            "mode": "dry-run" if dry_run else "aws",
            "demoRunning": demo_thread is not None and demo_thread.is_alive(),
            "stations": [
                {
                    "deviceId": s.id,
                    "online": s.online,
                    "connected": s.connection is not None,
                    "messagesSent": s.sent,
                    "lastReading": s.last_reading,
                    "modes": dict(s.mode),
                }
                for s in STATIONS
            ],
        }


def status_text():
    data = status_json()
    lines = [f"mode: {data['mode']}   demo running: {data['demoRunning']}"]
    for s in data["stations"]:
        state = "ONLINE " if s["online"] else "OFFLINE"
        changed = " ".join(f"{p}:{m.upper()}" for p, m in s["modes"].items() if m != "normal")
        lines.append(f"  {s['deviceId']}  {state}  sent={s['messagesSent']:<5} {s['lastReading'] or '-'}  {changed}")
    return "\n".join(lines)


# =============================================================================
# 5. Local control endpoint for the dashboard buttons
#    127.0.0.1 only (not reachable from the network) + secret token.
# =============================================================================
class DashboardControl(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the terminal clean
        pass

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin in DASHBOARD_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        supplied = self.headers.get("Authorization", "").encode()
        return hmac.compare_digest(supplied, f"Bearer {CONTROL_TOKEN}".encode())

    def do_OPTIONS(self):  # browser CORS pre-flight
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._authorized():
            return self._reply(401, {"error": "unauthorized"})
        if self.path != "/status":
            return self._reply(404, {"error": "not found"})
        self._reply(200, status_json())

    def do_POST(self):
        if not self._authorized():
            return self._reply(401, {"error": "unauthorized"})
        if self.path != "/command":
            return self._reply(404, {"error": "not found"})
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 2048)
            command = json.loads(self.rfile.read(length) or b"{}").get("command", "")
            message = run_command(command)
            if command.strip():
                log(f"[dashboard] {command}  ->  {message.splitlines()[0] if message else ''}")
            self._reply(200, {"ok": True, "message": message})
        except (ValueError, AttributeError) as error:
            self._reply(400, {"ok": False, "error": str(error)})


# =============================================================================
# 6. Main
# =============================================================================
def check_aws_setup():
    problems = []
    if not IOT_ENDPOINT:
        problems.append("IOT_ENDPOINT is empty in simulator/.env")
    for s in STATIONS:
        for f in (CERTS_DIR / s.id / "certificate.pem.crt", CERTS_DIR / s.id / "private.pem.key"):
            if not f.is_file():
                problems.append(f"missing {f}")
    if not (CERTS_DIR / "AmazonRootCA1.pem").is_file():
        problems.append(f"missing {CERTS_DIR / 'AmazonRootCA1.pem'}")
    return problems


def main():
    global dry_run, quiet
    parser = argparse.ArgumentParser(description="Simulated water-quality stations -> AWS IoT Core")
    parser.add_argument("--dry-run", action="store_true", help="don't connect to AWS, just print readings")
    parser.add_argument("--quiet", action="store_true", help="hide per-reading lines")
    parser.add_argument("--interval", type=float, default=INTERVAL, help="seconds between readings (default 5)")
    args = parser.parse_args()
    dry_run, quiet = args.dry_run, args.quiet

    if not dry_run:
        problems = check_aws_setup()
        if problems:
            print("Cannot connect to AWS yet:\n  " + "\n  ".join(problems))
            print("Fix: copy .env.example to .env and run  uv run scripts/provision_certs.py  from the repo root.")
            return 1

    stop = threading.Event()
    threads = []
    for i, station in enumerate(STATIONS):
        delay = i * args.interval / len(STATIONS)
        t = threading.Thread(target=station_loop, args=(station, stop, args.interval, delay), daemon=True)
        t.start()
        threads.append(t)

    server = None
    if CONTROL_TOKEN:
        server = ThreadingHTTPServer(("127.0.0.1", CONTROL_PORT), DashboardControl)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        log(f"dashboard control enabled on http://127.0.0.1:{CONTROL_PORT}")
    else:
        log("dashboard buttons disabled (set CONTROL_TOKEN in simulator/.env to enable)")

    target = "DRY-RUN: nothing is sent to AWS" if dry_run else f"AWS IoT Core {IOT_ENDPOINT}"
    log(f"{len(STATIONS)} simulated stations, every {args.interval:g}s -> {target}")
    log("type 'help' and press Enter for commands; Ctrl+C or 'quit' to stop")

    try:
        while True:
            line = input()
            if line.strip().lower() in ("quit", "exit"):
                break
            try:
                output = run_command(line)
                if output:
                    print(output)
            except ValueError as error:
                print(f"error: {error}")
    except EOFError:  # no keyboard attached (e.g. started in the background)
        log("no keyboard input available; control via the dashboard, stop with Ctrl+C")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    except KeyboardInterrupt:
        pass
    finally:
        log("stopping all stations...")
        demo_stop.set()
        stop.set()
        for t in threads:
            t.join(timeout=15)
        if server:
            server.shutdown()
        log("all stations disconnected, bye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
